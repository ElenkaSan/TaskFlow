import { randomUUID } from 'node:crypto'
import { withTransaction, type SqliteDatabase } from './database.js'

type Attempt = {
  id: string
  task_id: string
  status: string
  outcome: 'success' | 'no_response'
  due_at: string
  warning_at: string | null
  selected_contributor_id: string | null
  task_version_at_creation: number
}

type Task = { id: string; status: string; version: number }

const attemptColumns = 'id, task_id, status, outcome, due_at, warning_at, selected_contributor_id, task_version_at_creation'

export class RoutingWorker {
  private sweeping = false

  constructor(private readonly db: SqliteDatabase, private readonly now: () => Date = () => new Date()) {}

  async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      const now = this.now().toISOString()
      const attempts = await this.db.all<{ id: string }>(
        `SELECT id FROM routing_attempts
         WHERE status = 'pending'
           AND ((outcome = 'success' AND due_at <= ?)
             OR (outcome = 'no_response' AND warning_at IS NOT NULL AND warning_at <= ?))
         ORDER BY due_at, id`,
        [now, now],
      )
      for (const attempt of attempts) await this.process(attempt.id, now)
    } finally {
      this.sweeping = false
    }
  }

  private async process(attemptId: string, now: string): Promise<void> {
    await withTransaction(this.db, async () => {
      const attempt = await this.db.get<Attempt>(
        `SELECT ${attemptColumns} FROM routing_attempts WHERE id = ? AND status = 'pending'`,
        [attemptId],
      )
      if (!attempt || !this.isDue(attempt, now)) return

      const task = await this.db.get<Task>('SELECT id, status, version FROM tasks WHERE id = ?', [attempt.task_id])
      if (!task) return
      if (task.status !== 'routing' || task.version !== attempt.task_version_at_creation) {
        await this.ignore(attempt, task, now)
        return
      }

      if (attempt.outcome === 'no_response') {
        await this.applyWarning(attempt, task, now)
        return
      }
      if (!attempt.selected_contributor_id) {
        await this.applyNoMatch(attempt, task, now)
        return
      }
      await this.applyOffer(attempt, task, now)
    })
  }

  private isDue(attempt: Attempt, now: string): boolean {
    if (attempt.outcome === 'no_response') return attempt.warning_at !== null && attempt.warning_at <= now
    return attempt.due_at <= now
  }

  private async applyWarning(attempt: Attempt, task: Task, now: string): Promise<void> {
    const changed = await this.db.run(
      `UPDATE tasks SET status = 'no_response_warning', version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'routing' AND version = ?`,
      [now, task.id, task.version],
    )
    if (!changed) {
      await this.ignore(attempt, task, now)
      return
    }
    await this.recordResult(attempt.id, 'no_response', now)
    await this.audit(task.id, 'routing_no_response_warning', { attemptId: attempt.id }, now)
  }

  private async applyNoMatch(attempt: Attempt, task: Task, now: string): Promise<void> {
    const changed = await this.db.run(
      `UPDATE tasks SET status = 'recovery_required', version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'routing' AND version = ?`,
      [now, task.id, task.version],
    )
    if (!changed) {
      await this.ignore(attempt, task, now)
      return
    }
    await this.recordResult(attempt.id, 'completed', now)
    await this.audit(task.id, 'routing_no_eligible_contributor', { attemptId: attempt.id }, now)
  }

  private async applyOffer(attempt: Attempt, task: Task, now: string): Promise<void> {
    const assignmentId = randomUUID()
    const changed = await this.db.run(
      `UPDATE tasks SET status = 'offered', active_assignment_id = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'routing' AND version = ?`,
      [assignmentId, now, task.id, task.version],
    )
    if (!changed) {
      await this.ignore(attempt, task, now)
      return
    }
    await this.db.run(
      `INSERT INTO assignments (id, task_id, contributor_id, source, status, offered_at)
       VALUES (?, ?, ?, 'automation', 'offered', ?)`,
      [assignmentId, task.id, attempt.selected_contributor_id, now],
    )
    await this.recordResult(attempt.id, 'completed', now)
    await this.audit(task.id, 'routing_offer_created', {
      attemptId: attempt.id,
      assignmentId,
      contributorId: attempt.selected_contributor_id,
    }, now)
  }

  private async ignore(attempt: Attempt, task: Task, now: string): Promise<void> {
    const changed = await this.finish(attempt.id, 'superseded', now)
    if (!changed) return
    await this.audit(task.id, 'routing_result_ignored', {
      attemptId: attempt.id,
      taskStatus: task.status,
      taskVersion: task.version,
      attemptVersion: attempt.task_version_at_creation,
    }, now)
  }

  private async recordResult(id: string, status: 'completed' | 'no_response' | 'superseded', now: string): Promise<void> {
    const changed = await this.finish(id, status, now)
    if (!changed) throw new Error('Routing attempt changed before its result could be recorded.')
  }

  private finish(id: string, status: 'completed' | 'no_response' | 'superseded', now: string): Promise<number> {
    return this.db.run(
      `UPDATE routing_attempts SET status = ?, completed_at = ? WHERE id = ? AND status = 'pending'`,
      [status, now, id],
    )
  }

  private audit(taskId: string, type: string, details: unknown, now: string): Promise<number> {
    return this.db.run(
      `INSERT INTO audit_events (id, task_id, event_type, actor, details_json, created_at)
       VALUES (?, ?, ?, 'system', ?, ?)`,
      [randomUUID(), taskId, type, JSON.stringify(details), now],
    )
  }
}
