import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.js'
import { initializeDatabase } from '../src/database.js'
import { RoutingWorker } from '../src/routing-worker.js'

const directory = mkdtempSync(join(tmpdir(), 'taskflow-api-'))
const db = await initializeDatabase(join(directory, 'taskflow.sqlite'))
const app = createApp(db)

type ApiResponse = { status: number; body: unknown }

function callApi(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: payload === undefined ? undefined : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (response) => {
      let responseBody = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { responseBody += chunk })
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(responseBody),
      }))
    })
    request.on('error', reject)
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

type AttemptRow = {
  status: string
  outcome: string
  due_at: string
  warning_at: string | null
  selected_contributor_id: string | null
  task_version_at_creation: number
}

type TaskState = { id: string; status: string; version: number }
type AssignmentRow = { contributor_id: string; source: string; status: string }

function attemptsFor(taskId: string): Promise<AttemptRow[]> {
  return db.all<AttemptRow>(
    `SELECT status, outcome, due_at, warning_at, selected_contributor_id, task_version_at_creation
     FROM routing_attempts WHERE task_id = ? ORDER BY created_at`,
    [taskId],
  )
}

function taskState(taskId: string): Promise<TaskState> {
  return db.get<TaskState>('SELECT id, status, version FROM tasks WHERE id = ?', [taskId])
    .then((task) => {
      assert.ok(task)
      return task
    })
}

function assignmentsFor(taskId: string): Promise<AssignmentRow[]> {
  return db.all<AssignmentRow>(
    'SELECT contributor_id, source, status FROM assignments WHERE task_id = ? ORDER BY offered_at',
    [taskId],
  )
}

function assignmentCount(taskId: string): Promise<number> {
  return assignmentsFor(taskId).then((rows) => rows.length)
}

function auditTypes(taskId: string): Promise<string[]> {
  return db.all<{ event_type: string }>(
    'SELECT event_type FROM audit_events WHERE task_id = ? ORDER BY created_at, event_type',
    [taskId],
  ).then((rows) => rows.map((row) => row.event_type))
}

async function insertRoutingTask(options: {
  id: string
  status?: string
  version?: number
  outcome: 'success' | 'no_response'
  dueAt: string
  warningAt: string | null
  contributorId: string | null
  attemptVersion?: number
}): Promise<void> {
  const createdAt = '2030-01-01T00:00:00.000Z'
  const version = options.version ?? 1
  await db.run(
    `INSERT INTO tasks (id, title, description, required_expertise, status, version, created_at, updated_at)
     VALUES (?, ?, '', 'frontend', ?, ?, ?, ?)`,
    [options.id, options.id, options.status ?? 'routing', version, createdAt, createdAt],
  )
  await db.run(
    `INSERT INTO routing_attempts (
       id, task_id, status, outcome, due_at, warning_at, selected_contributor_id, task_version_at_creation, created_at
     ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    [
      `attempt-${options.id}`,
      options.id,
      options.outcome,
      options.dueAt,
      options.warningAt,
      options.contributorId,
      options.attemptVersion ?? 1,
      createdAt,
    ],
  )
}

try {
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port

  const health = await callApi(port, 'GET', '/api/health')
  assert.equal(health.status, 200)
  assert.deepEqual(health.body, { status: 'ok' })

  const invalidTask = await callApi(port, 'POST', '/api/tasks', { title: '   ' })
  assert.equal(invalidTask.status, 400)
  assert.equal((invalidTask.body as { error: { code: string } }).error.code, 'validation_error')

  const created = await callApi(port, 'POST', '/api/tasks', {
    title: 'Fix dashboard filters',
    description: 'The filter state should persist.',
    requiredExpertise: '  Frontend ',
  })
  assert.equal(created.status, 201)
  const createdBody = created.body as { task: { id: string; status: string; requiredExpertise: string } }
  assert.equal(createdBody.task.status, 'routing')
  assert.equal(createdBody.task.requiredExpertise, 'frontend')

  const taskId = createdBody.task.id
  const listed = await callApi(port, 'GET', '/api/tasks')
  assert.equal(listed.status, 200)
  const listedBody = listed.body as { tasks: Array<{ id: string }> }
  assert.equal(listedBody.tasks.length, 1)
  assert.equal(listedBody.tasks[0].id, taskId)

  const detail = await callApi(port, 'GET', `/api/tasks/${taskId}`)
  assert.equal(detail.status, 200)
  const detailBody = detail.body as {
    task: { id: string; createdAt: string }
    routingAttempts: Array<{
      status: string
      outcome: 'success' | 'no_response'
      due_at: string
      warning_at: string | null
      selected_contributor_id: string | null
      task_version_at_creation: number
      created_at: string
    }>
    auditEvents: Array<{ type: string }>
  }
  assert.equal(detailBody.task.id, taskId)
  assert.equal(detailBody.routingAttempts.length, 1)
  const createdAttempt = detailBody.routingAttempts[0]
  assert.equal(createdAttempt.status, 'pending')
  assert.ok(createdAttempt.outcome === 'success' || createdAttempt.outcome === 'no_response')
  assert.equal(createdAttempt.selected_contributor_id, 'contributor-ada')
  assert.equal(createdAttempt.task_version_at_creation, 1)
  const createdMs = Date.parse(createdAttempt.created_at)
  const dueMs = Date.parse(createdAttempt.due_at)
  assert.ok(dueMs >= createdMs + 5000 && dueMs <= createdMs + 20000)
  if (createdAttempt.outcome === 'no_response') {
    assert.equal(createdAttempt.warning_at, new Date(createdMs + 25000).toISOString())
  } else {
    assert.equal(createdAttempt.warning_at, null)
  }
  assert.equal(detailBody.auditEvents.length, 1)
  assert.equal(detailBody.auditEvents[0].type, 'task_created')

  const beforeDue = new RoutingWorker(db, () => new Date(dueMs - 1000))
  await beforeDue.sweep()
  assert.equal((await attemptsFor(taskId))[0].status, 'pending')
  assert.equal((await taskState(taskId)).status, 'routing')
  assert.equal(await assignmentCount(taskId), 0)

  if (createdAttempt.outcome === 'no_response') {
    const atDue = new RoutingWorker(db, () => new Date(dueMs))
    await atDue.sweep()
    assert.equal((await taskState(taskId)).status, 'routing')
    assert.equal((await attemptsFor(taskId))[0].status, 'pending')
    const warningAt = createdAttempt.warning_at ?? ''
    const atWarning = new RoutingWorker(db, () => new Date(warningAt))
    await atWarning.sweep()
    await atWarning.sweep()
    assert.equal((await taskState(taskId)).status, 'no_response_warning')
    const warned = (await attemptsFor(taskId))[0]
    assert.equal(warned.status, 'no_response')
    assert.equal(warned.outcome, 'no_response')
    assert.equal(warned.due_at, createdAttempt.due_at)
    assert.equal(warned.warning_at, createdAttempt.warning_at)
    assert.equal(warned.selected_contributor_id, 'contributor-ada')
    assert.equal(warned.task_version_at_creation, 1)
    assert.equal(await assignmentCount(taskId), 0)
    assert.deepEqual(await auditTypes(taskId), ['task_created', 'routing_no_response_warning'])
  } else {
    const atDue = new RoutingWorker(db, () => new Date(dueMs))
    await atDue.sweep()
    await atDue.sweep()
    const offered = await taskState(taskId)
    assert.equal(offered.status, 'offered')
    assert.equal(offered.version, 2)
    const attempts = await attemptsFor(taskId)
    assert.equal(attempts.length, 1)
    assert.equal(attempts[0].status, 'completed')
    assert.equal(attempts[0].outcome, 'success')
    assert.equal(attempts[0].due_at, createdAttempt.due_at)
    assert.equal(attempts[0].warning_at, null)
    assert.equal(attempts[0].selected_contributor_id, 'contributor-ada')
    assert.equal(attempts[0].task_version_at_creation, 1)
    assert.equal(await assignmentCount(taskId), 1)
    assert.equal((await assignmentsFor(taskId))[0].contributor_id, 'contributor-ada')
    assert.deepEqual(await auditTypes(taskId), ['task_created', 'routing_offer_created'])
  }

  const missing = await callApi(port, 'GET', '/api/tasks/missing')
  assert.equal(missing.status, 404)
  assert.equal((missing.body as { error: { code: string } }).error.code, 'not_found')

  const dueAt = '2030-01-01T00:00:05.000Z'
  const warningAt = '2030-01-01T00:00:25.000Z'
  await insertRoutingTask({ id: 'success', outcome: 'success', dueAt, warningAt: null, contributorId: 'contributor-ada' })
  await insertRoutingTask({ id: 'no-match', outcome: 'success', dueAt, warningAt: null, contributorId: null })
  await insertRoutingTask({ id: 'no-response', outcome: 'no_response', dueAt, warningAt, contributorId: 'contributor-ada' })
  await insertRoutingTask({ id: 'stale', outcome: 'success', dueAt, warningAt: null, contributorId: 'contributor-ada', version: 2, attemptVersion: 1 })
  await insertRoutingTask({ id: 'concurrent-a', outcome: 'success', dueAt, warningAt: null, contributorId: 'contributor-ada' })
  await insertRoutingTask({ id: 'concurrent-b', outcome: 'success', dueAt, warningAt: null, contributorId: 'contributor-ada' })
  await insertRoutingTask({ id: 'delayed', outcome: 'success', dueAt: '2030-01-01T00:02:00.000Z', warningAt: null, contributorId: 'contributor-grace' })
  await insertRoutingTask({ id: 'before-warning', outcome: 'no_response', dueAt, warningAt: '2030-01-01T00:00:40.000Z', contributorId: 'contributor-ada' })
  await insertRoutingTask({ id: 'human-decision', status: 'offered', version: 4, outcome: 'success', dueAt, warningAt: null, contributorId: 'contributor-ada', attemptVersion: 1 })

  const routingNow = new Date('2030-01-01T00:00:30.000Z')
  const worker = new RoutingWorker(db, () => routingNow)
  await worker.sweep()
  await worker.sweep()
  const states = await db.all<TaskState>('SELECT id, status, version FROM tasks WHERE id IN (?,?,?,?,?,?) ORDER BY id', ['success', 'no-match', 'no-response', 'stale', 'concurrent-a', 'concurrent-b'])
  assert.deepEqual(Object.fromEntries(states.map((state) => [state.id, state.status])), { 'concurrent-a': 'offered', 'concurrent-b': 'offered', 'no-match': 'recovery_required', 'no-response': 'no_response_warning', stale: 'routing', success: 'offered' })
  assert.equal((await db.all<{ count: number }>('SELECT COUNT(*) AS count FROM assignments WHERE task_id IN (?,?,?)', ['success', 'concurrent-a', 'concurrent-b']))[0].count, 3)
  assert.equal((await db.all<{ count: number }>('SELECT COUNT(*) AS count FROM audit_events WHERE task_id = ?', ['success']))[0].count, 1)
  assert.equal((await taskState('stale')).version, 2)
  assert.equal((await attemptsFor('stale'))[0].status, 'superseded')
  assert.deepEqual(await auditTypes('stale'), ['routing_result_ignored'])
  assert.equal(await assignmentCount('stale'), 0)
  assert.deepEqual(await auditTypes('success'), ['routing_offer_created'])
  assert.deepEqual(await auditTypes('no-match'), ['routing_no_eligible_contributor'])
  assert.equal(await assignmentCount('no-match'), 0)
  assert.equal((await attemptsFor('no-match'))[0].selected_contributor_id, null)
  const warnedAttempt = (await attemptsFor('no-response'))[0]
  assert.equal(warnedAttempt.status, 'no_response')
  assert.equal(warnedAttempt.outcome, 'no_response')
  assert.equal(warnedAttempt.due_at, dueAt)
  assert.equal(warnedAttempt.warning_at, warningAt)
  assert.equal(warnedAttempt.task_version_at_creation, 1)
  assert.equal(await assignmentCount('no-response'), 0)
  assert.deepEqual(await auditTypes('no-response'), ['routing_no_response_warning'])
  assert.equal((await taskState('delayed')).status, 'routing')
  assert.equal((await attemptsFor('delayed'))[0].status, 'pending')
  assert.equal((await attemptsFor('delayed'))[0].selected_contributor_id, 'contributor-grace')
  assert.equal((await taskState('before-warning')).status, 'routing')
  assert.equal((await attemptsFor('before-warning'))[0].status, 'pending')
  assert.equal((await taskState('human-decision')).status, 'offered')
  assert.equal((await taskState('human-decision')).version, 4)
  assert.equal((await attemptsFor('human-decision'))[0].status, 'superseded')
  assert.equal(await assignmentCount('human-decision'), 0)
  assert.deepEqual(await auditTypes('human-decision'), ['routing_result_ignored'])

  const atWarningBoundary = new RoutingWorker(db, () => new Date('2030-01-01T00:00:40.000Z'))
  await atWarningBoundary.sweep()
  await atWarningBoundary.sweep()
  assert.equal((await taskState('before-warning')).status, 'no_response_warning')
  assert.equal((await attemptsFor('before-warning'))[0].status, 'no_response')
  assert.equal((await attemptsFor('before-warning'))[0].outcome, 'no_response')
  assert.equal(await assignmentCount('before-warning'), 0)
  assert.deepEqual(await auditTypes('before-warning'), ['routing_no_response_warning'])
  assert.equal((await taskState('delayed')).status, 'routing')
  assert.equal((await attemptsFor('delayed'))[0].status, 'pending')

  const atDelay = new RoutingWorker(db, () => new Date('2030-01-01T00:02:00.000Z'))
  await atDelay.sweep()
  await atDelay.sweep()
  assert.equal((await taskState('delayed')).status, 'offered')
  assert.equal((await attemptsFor('delayed')).length, 1)
  assert.equal((await attemptsFor('delayed'))[0].status, 'completed')
  assert.equal((await attemptsFor('delayed'))[0].due_at, '2030-01-01T00:02:00.000Z')
  assert.equal((await attemptsFor('delayed'))[0].selected_contributor_id, 'contributor-grace')
  assert.equal((await attemptsFor('delayed'))[0].task_version_at_creation, 1)
  assert.deepEqual(await assignmentsFor('delayed'), [{ contributor_id: 'contributor-grace', source: 'automation', status: 'offered' }])
  assert.deepEqual(await auditTypes('delayed'), ['routing_offer_created'])

  await insertRoutingTask({ id: 'parallel', outcome: 'success', dueAt, warningAt: null, contributorId: 'contributor-margaret' })
  const parallel = new RoutingWorker(db, () => routingNow)
  await Promise.all([parallel.sweep(), parallel.sweep()])
  await parallel.sweep()
  assert.deepEqual(await assignmentsFor('parallel'), [{ contributor_id: 'contributor-margaret', source: 'automation', status: 'offered' }])
  assert.equal((await attemptsFor('parallel')).length, 1)
  assert.deepEqual(await auditTypes('parallel'), ['routing_offer_created'])

  await recoverPersistedAttempt()
  await overlappingWriters()

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  console.log('API and routing tests passed.')
} finally {
  await db.close()
  rmSync(directory, { recursive: true, force: true })
}

async function recoverPersistedAttempt(): Promise<void> {
  const recoveryDirectory = mkdtempSync(join(tmpdir(), 'taskflow-restart-'))
  const databasePath = join(recoveryDirectory, 'taskflow.sqlite')
  const createdAt = '2030-01-01T00:00:00.000Z'
  const dueAt = '2030-01-01T00:00:12.000Z'
  const clock = () => new Date(dueAt)
  try {
    let recoveryDb = await initializeDatabase(databasePath)
    await recoveryDb.run(
      `INSERT INTO tasks (id, title, description, required_expertise, status, version, created_at, updated_at)
       VALUES ('restart-task', 'Restart task', '', 'backend', 'routing', 1, ?, ?)`,
      [createdAt, createdAt],
    )
    await recoveryDb.run(
      `INSERT INTO routing_attempts (
         id, task_id, status, outcome, due_at, warning_at, selected_contributor_id, task_version_at_creation, created_at
       ) VALUES ('restart-attempt', 'restart-task', 'pending', 'success', ?, NULL, 'contributor-grace', 1, ?)`,
      [dueAt, createdAt],
    )
    await recoveryDb.close()

    recoveryDb = await initializeDatabase(databasePath)
    const stored = await recoveryDb.get<AttemptRow & { status: string }>(
      `SELECT status, outcome, due_at, warning_at, selected_contributor_id, task_version_at_creation
       FROM routing_attempts WHERE id = 'restart-attempt'`,
    )
    assert.deepEqual(stored, {
      status: 'pending',
      outcome: 'success',
      due_at: dueAt,
      warning_at: null,
      selected_contributor_id: 'contributor-grace',
      task_version_at_creation: 1,
    })
    const recovered = new RoutingWorker(recoveryDb, clock)
    await recovered.sweep()
    await recovered.sweep()
    const task = await recoveryDb.get<{ status: string; version: number }>(
      `SELECT status, version FROM tasks WHERE id = 'restart-task'`,
    )
    assert.deepEqual(task, { status: 'offered', version: 2 })
    const assignments = await recoveryDb.all<AssignmentRow>(
      `SELECT contributor_id, source, status FROM assignments WHERE task_id = 'restart-task'`,
    )
    assert.deepEqual(assignments, [{ contributor_id: 'contributor-grace', source: 'automation', status: 'offered' }])
    const attempts = await recoveryDb.all<{ status: string }>(
      `SELECT status FROM routing_attempts WHERE task_id = 'restart-task'`,
    )
    assert.deepEqual(attempts, [{ status: 'completed' }])
    await recoveryDb.close()

    recoveryDb = await initializeDatabase(databasePath)
    await new RoutingWorker(recoveryDb, clock).sweep()
    const afterRestart = await recoveryDb.all<{ id: string }>(
      `SELECT id FROM assignments WHERE task_id = 'restart-task'`,
    )
    assert.equal(afterRestart.length, 1)
    await recoveryDb.close()
  } finally {
    rmSync(recoveryDirectory, { recursive: true, force: true })
  }
}

async function overlappingWriters(): Promise<void> {
  const raceDirectory = mkdtempSync(join(tmpdir(), 'taskflow-race-'))
  const databasePath = join(raceDirectory, 'taskflow.sqlite')
  const createdAt = '2030-01-01T00:00:00.000Z'
  const dueAt = '2030-01-01T00:00:05.000Z'
  const clock = () => new Date('2030-01-01T00:00:30.000Z')
  let left: Awaited<ReturnType<typeof initializeDatabase>> | undefined
  let right: Awaited<ReturnType<typeof initializeDatabase>> | undefined
  try {
    left = await initializeDatabase(databasePath)
    await left.run(
      `INSERT INTO tasks (id, title, description, required_expertise, status, version, created_at, updated_at)
       VALUES ('race-task', 'Race task', '', 'qa', 'routing', 1, ?, ?)`,
      [createdAt, createdAt],
    )
    await left.run(
      `INSERT INTO routing_attempts (
         id, task_id, status, outcome, due_at, warning_at, selected_contributor_id, task_version_at_creation, created_at
       ) VALUES ('race-attempt', 'race-task', 'pending', 'success', ?, NULL, 'contributor-margaret', 1, ?)`,
      [dueAt, createdAt],
    )
    right = await initializeDatabase(databasePath)
    await Promise.all([
      new RoutingWorker(left, clock).sweep(),
      new RoutingWorker(right, clock).sweep(),
    ])
    const assignments = await left.all<AssignmentRow>(
      `SELECT contributor_id, source, status FROM assignments WHERE task_id = 'race-task'`,
    )
    assert.deepEqual(assignments, [{ contributor_id: 'contributor-margaret', source: 'automation', status: 'offered' }])
    const attempts = await left.all<{ status: string; outcome: string; selected_contributor_id: string }>(
      `SELECT status, outcome, selected_contributor_id FROM routing_attempts WHERE task_id = 'race-task'`,
    )
    assert.deepEqual(attempts, [{ status: 'completed', outcome: 'success', selected_contributor_id: 'contributor-margaret' }])
    const audits = await left.all<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE task_id = 'race-task' ORDER BY event_type`,
    )
    assert.deepEqual(audits.map((audit) => audit.event_type), ['routing_offer_created'])
  } finally {
    await left?.close()
    await right?.close()
    rmSync(raceDirectory, { recursive: true, force: true })
  }
}
