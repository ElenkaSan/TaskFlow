import { randomUUID } from "node:crypto";
import { withTransaction, type SqliteDatabase } from "./database.js";

type ApiError = Error & { status?: number; code?: string; details?: unknown };
type TaskRow = {
  id: string;
  title: string;
  description: string;
  required_expertise: string;
  status: string;
  version: number;
  active_assignment_id: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
};
type AssignmentRow = {
  id: string;
  task_id: string;
  contributor_id: string;
  source: string;
  status: string;
  offered_at: string;
  responded_at: string | null;
  response_note: string | null;
};
type AttemptRow = {
  id: string;
  status: string;
  outcome: "success" | "no_response";
  due_at: string;
  warning_at: string | null;
  selected_contributor_id: string | null;
  task_version_at_creation: number;
  created_at: string;
};

const manualStatuses = [
  "routing",
  "no_response_warning",
  "offered",
  "pre_work_failed",
  "recovery_required",
];
const retryStatuses = [
  "routing",
  "no_response_warning",
  "pre_work_failed",
  "recovery_required",
];

const apiError = (
  message: string,
  status: number,
  code: string,
  details?: unknown,
): ApiError => Object.assign(new Error(message), { status, code, details });

const versionOf = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw apiError("Request validation failed.", 400, "validation_error", {
      version: "A positive integer version is required.",
    });
  }
  return value;
};

const contributorIdOf = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw apiError("Request validation failed.", 400, "validation_error", {
      contributorId: "Contributor id is required.",
    });
  }
  return value.trim();
};

const noteOf = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw apiError("Request validation failed.", 400, "validation_error", {
      responseNote: "Response note must be a string.",
    });
  }
  const note = value.trim();
  if (note.length > 500) {
    throw apiError("Request validation failed.", 400, "validation_error", {
      responseNote: "Response note must be 500 characters or fewer.",
    });
  }
  return note || null;
};

async function loadTask(
  db: SqliteDatabase,
  taskId: string,
  version: number,
  allowed: string[],
  action: string,
): Promise<TaskRow> {
  const task = await db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", [
    taskId,
  ]);
  if (!task) throw apiError("Task not found.", 404, "not_found");
  if (task.version !== version) {
    throw apiError(
      "The task changed. Reload it and try again.",
      409,
      "conflict",
      {
        currentVersion: task.version,
      },
    );
  }
  if (!allowed.includes(task.status)) {
    throw apiError(
      `Cannot ${action} while the task is ${task.status}.`,
      409,
      "invalid_transition",
      {
        status: task.status,
      },
    );
  }
  return task;
}

async function reloadTask(
  db: SqliteDatabase,
  taskId: string,
): Promise<TaskRow> {
  const task = await db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", [
    taskId,
  ]);
  if (!task) throw apiError("Task not found.", 404, "not_found");
  return task;
}

async function reloadAssignment(
  db: SqliteDatabase,
  assignmentId: string,
): Promise<AssignmentRow> {
  const assignment = await db.get<AssignmentRow>(
    "SELECT * FROM assignments WHERE id = ?",
    [assignmentId],
  );
  if (!assignment) throw apiError("Assignment not found.", 404, "not_found");
  return assignment;
}

async function audit(
  db: SqliteDatabase,
  taskId: string,
  type: string,
  actor: "operator" | "contributor",
  details: unknown,
  now: string,
): Promise<void> {
  await db.run(
    "INSERT INTO audit_events (id, task_id, event_type, actor, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [randomUUID(), taskId, type, actor, JSON.stringify(details), now],
  );
}

async function supersedeOfferedAssignments(
  db: SqliteDatabase,
  taskId: string,
  now: string,
): Promise<string[]> {
  const existing = await db.all<{ id: string }>(
    "SELECT id FROM assignments WHERE task_id = ? AND status = 'offered' ORDER BY offered_at, rowid",
    [taskId],
  );
  if (!existing.length) return [];
  await db.run(
    "UPDATE assignments SET status = 'superseded', responded_at = ? WHERE task_id = ? AND status = 'offered'",
    [now, taskId],
  );
  await audit(
    db,
    taskId,
    "assignment_superseded",
    "operator",
    {
      assignmentIds: existing.map((assignment) => assignment.id),
    },
    now,
  );
  return existing.map((assignment) => assignment.id);
}

async function supersedeActiveAttempts(
  db: SqliteDatabase,
  taskId: string,
  now: string,
  actor: "operator" | "contributor",
): Promise<string[]> {
  const existing = await db.all<{ id: string; status: string }>(
    "SELECT id, status FROM routing_attempts WHERE task_id = ? AND status IN ('pending', 'no_response') ORDER BY created_at, rowid",
    [taskId],
  );
  if (!existing.length) return [];
  await db.run(
    "UPDATE routing_attempts SET status = 'superseded' WHERE task_id = ? AND status IN ('pending', 'no_response')",
    [taskId],
  );
  await audit(
    db,
    taskId,
    "routing_attempts_superseded",
    actor,
    {
      attempts: existing,
    },
    now,
  );
  return existing.map((attempt) => attempt.id);
}

export async function insertRoutingAttempt(
  db: SqliteDatabase,
  taskId: string,
  requiredExpertise: string,
  now: Date,
  taskVersion: number,
  excludeContributorIds: string[] = [],
): Promise<AttemptRow> {
  const excluded = [...new Set(excludeContributorIds)];
  const placeholders = excluded.map(() => "?").join(", ");
  const contributors = await db.all<{ id: string }>(
    excluded.length
      ? `SELECT id FROM contributors WHERE active = 1 AND expertise = ? AND id NOT IN (${placeholders}) ORDER BY id`
      : "SELECT id FROM contributors WHERE active = 1 AND expertise = ? ORDER BY id",
    excluded.length ? [requiredExpertise, ...excluded] : [requiredExpertise],
  );
  const selected = contributors.length
    ? contributors[Math.floor(Math.random() * contributors.length)].id
    : null;
  const outcome = selected && Math.random() < 0.2 ? "no_response" : "success";
  const delay = 5 + Math.floor(Math.random() * 16);
  const createdAt = now.toISOString();
  const attempt: AttemptRow = {
    id: randomUUID(),
    status: "pending",
    outcome,
    due_at: new Date(now.getTime() + delay * 1000).toISOString(),
    warning_at:
      outcome === "no_response"
        ? new Date(now.getTime() + 25000).toISOString()
        : null,
    selected_contributor_id: selected,
    task_version_at_creation: taskVersion,
    created_at: createdAt,
  };
  await db.run(
    `INSERT INTO routing_attempts (
       id, task_id, status, outcome, due_at, warning_at, selected_contributor_id, task_version_at_creation, created_at
     ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    [
      attempt.id,
      taskId,
      attempt.outcome,
      attempt.due_at,
      attempt.warning_at,
      attempt.selected_contributor_id,
      taskVersion,
      createdAt,
    ],
  );
  return attempt;
}

async function excludedContributorIds(
  db: SqliteDatabase,
  taskId: string,
): Promise<string[]> {
  const rows = await db.all<{ contributor_id: string }>(
    "SELECT DISTINCT contributor_id FROM assignments WHERE task_id = ? AND status IN ('declined', 'pre_work_failed') ORDER BY contributor_id",
    [taskId],
  );
  return rows.map((row) => row.contributor_id);
}

export async function assignManually(
  db: SqliteDatabase,
  taskId: string,
  body: { contributorId?: unknown; version?: unknown },
): Promise<{ task: TaskRow; assignment: AssignmentRow }> {
  const version = versionOf(body.version);
  const contributorId = contributorIdOf(body.contributorId);
  return withTransaction(db, async () => {
    const task = await loadTask(
      db,
      taskId,
      version,
      manualStatuses,
      "assign a contributor",
    );
    const contributor = await db.get<{ id: string }>(
      "SELECT id FROM contributors WHERE id = ? AND active = 1 AND expertise = ?",
      [contributorId, task.required_expertise],
    );
    if (!contributor) {
      throw apiError(
        "Contributor is not eligible for this task.",
        409,
        "invalid_assignment",
      );
    }
    const now = new Date().toISOString();
    const assignmentId = randomUUID();
    await supersedeOfferedAssignments(db, task.id, now);
    const changed = await db.run(
      `UPDATE tasks
       SET status = 'offered', active_assignment_id = ?, accepted_at = NULL, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND status = ?`,
      [assignmentId, now, task.id, task.version, task.status],
    );
    if (!changed)
      throw apiError(
        "The task changed. Reload it and try again.",
        409,
        "conflict",
      );
    await db.run(
      `INSERT INTO assignments (id, task_id, contributor_id, source, status, offered_at)
       VALUES (?, ?, ?, 'human', 'offered', ?)`,
      [assignmentId, task.id, contributorId, now],
    );
    await audit(
      db,
      task.id,
      "manual_assignment_created",
      "operator",
      {
        assignmentId,
        contributorId,
      },
      now,
    );
    await supersedeActiveAttempts(db, task.id, now, "operator");
    return {
      task: await reloadTask(db, task.id),
      assignment: await reloadAssignment(db, assignmentId),
    };
  });
}

async function respond(
  db: SqliteDatabase,
  taskId: string,
  assignmentId: string,
  body: { contributorId?: unknown; version?: unknown; responseNote?: unknown },
  action: "accept" | "decline" | "fail",
): Promise<{ task: TaskRow; assignment: AssignmentRow }> {
  const version = versionOf(body.version);
  const contributorId = contributorIdOf(body.contributorId);
  const note = noteOf(body.responseNote);
  const expectedTaskStatus = action === "fail" ? "accepted" : "offered";
  const expectedAssignmentStatus = action === "fail" ? "accepted" : "offered";
  const nextTaskStatus =
    action === "accept"
      ? "accepted"
      : action === "decline"
        ? "recovery_required"
        : "pre_work_failed";
  const nextAssignmentStatus =
    action === "accept"
      ? "accepted"
      : action === "decline"
        ? "declined"
        : "pre_work_failed";
  const actionLabel =
    action === "accept"
      ? "accept an offer"
      : action === "decline"
        ? "decline an offer"
        : "report pre-work failure";
  const eventType =
    action === "accept"
      ? "assignment_accepted"
      : action === "decline"
        ? "assignment_declined"
        : "assignment_pre_work_failed";
  return withTransaction(db, async () => {
    const task = await loadTask(
      db,
      taskId,
      version,
      [expectedTaskStatus],
      actionLabel,
    );
    const assignment = await db.get<AssignmentRow>(
      "SELECT * FROM assignments WHERE id = ? AND task_id = ?",
      [assignmentId, task.id],
    );
    if (!assignment) throw apiError("Assignment not found.", 404, "not_found");
    if (
      task.active_assignment_id !== assignment.id ||
      assignment.status !== expectedAssignmentStatus
    ) {
      throw apiError(
        "This assignment is no longer active.",
        409,
        "invalid_assignment",
      );
    }
    if (assignment.contributor_id !== contributorId) {
      throw apiError(
        "Only the assigned contributor can respond to this assignment.",
        409,
        "invalid_assignment",
      );
    }
    const now = new Date().toISOString();
    const changed =
      action === "accept"
        ? await db.run(
            `UPDATE tasks SET status = 'accepted', accepted_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND status = 'offered' AND active_assignment_id = ?`,
            [now, now, task.id, task.version, assignment.id],
          )
        : await db.run(
            `UPDATE tasks SET status = ?, active_assignment_id = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND status = ? AND active_assignment_id = ?`,
            [
              nextTaskStatus,
              now,
              task.id,
              task.version,
              expectedTaskStatus,
              assignment.id,
            ],
          );
    if (!changed)
      throw apiError(
        "The task changed. Reload it and try again.",
        409,
        "conflict",
      );
    const assignmentChanged = await db.run(
      `UPDATE assignments SET status = ?, responded_at = ?, response_note = ?
       WHERE id = ? AND task_id = ? AND contributor_id = ? AND status = ?`,
      [
        nextAssignmentStatus,
        now,
        note,
        assignment.id,
        task.id,
        contributorId,
        expectedAssignmentStatus,
      ],
    );
    if (!assignmentChanged)
      throw apiError(
        "This assignment is no longer active.",
        409,
        "invalid_assignment",
      );
    await audit(
      db,
      task.id,
      eventType,
      "contributor",
      {
        assignmentId: assignment.id,
        contributorId,
        ...(note ? { responseNote: note } : {}),
      },
      now,
    );
    await supersedeActiveAttempts(db, task.id, now, "contributor");
    return {
      task: await reloadTask(db, task.id),
      assignment: await reloadAssignment(db, assignment.id),
    };
  });
}

export function acceptAssignment(
  db: SqliteDatabase,
  taskId: string,
  assignmentId: string,
  body: { contributorId?: unknown; version?: unknown; responseNote?: unknown },
): Promise<{ task: TaskRow; assignment: AssignmentRow }> {
  return respond(db, taskId, assignmentId, body, "accept");
}

export function declineAssignment(
  db: SqliteDatabase,
  taskId: string,
  assignmentId: string,
  body: { contributorId?: unknown; version?: unknown; responseNote?: unknown },
): Promise<{ task: TaskRow; assignment: AssignmentRow }> {
  return respond(db, taskId, assignmentId, body, "decline");
}

export function reportPreWorkFailure(
  db: SqliteDatabase,
  taskId: string,
  assignmentId: string,
  body: { contributorId?: unknown; version?: unknown; responseNote?: unknown },
): Promise<{ task: TaskRow; assignment: AssignmentRow }> {
  return respond(db, taskId, assignmentId, body, "fail");
}

export async function retryRouting(
  db: SqliteDatabase,
  taskId: string,
  body: { version?: unknown },
): Promise<{ task: TaskRow; routingAttempt: AttemptRow }> {
  const version = versionOf(body.version);
  return withTransaction(db, async () => {
    const task = await loadTask(
      db,
      taskId,
      version,
      retryStatuses,
      "retry routing",
    );
    if (task.status === "routing") {
      const pending = await db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM routing_attempts WHERE task_id = ? AND status = 'pending'",
        [task.id],
      );
      if ((pending?.count ?? 0) > 0) {
        throw apiError(
          "A routing attempt is already pending. Assign a contributor manually or wait for it to resolve.",
          409,
          "conflict",
        );
      }
    }
    const now = new Date();
    const nowText = now.toISOString();
    const changed = await db.run(
      `UPDATE tasks
       SET status = 'routing', active_assignment_id = NULL, accepted_at = NULL, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND status = ?`,
      [nowText, task.id, task.version, task.status],
    );
    if (!changed)
      throw apiError(
        "The task changed. Reload it and try again.",
        409,
        "conflict",
      );
    const nextVersion = task.version + 1;
    await supersedeActiveAttempts(db, task.id, nowText, "operator");
    const excluded = await excludedContributorIds(db, task.id);
    const routingAttempt = await insertRoutingAttempt(
      db,
      task.id,
      task.required_expertise,
      now,
      nextVersion,
      excluded,
    );
    await audit(
      db,
      task.id,
      "routing_retried",
      "operator",
      {
        attemptId: routingAttempt.id,
        excludedContributorIds: excluded,
        selectedContributorId: routingAttempt.selected_contributor_id,
        outcome: routingAttempt.outcome,
      },
      nowText,
    );
    return { task: await reloadTask(db, task.id), routingAttempt };
  });
}
