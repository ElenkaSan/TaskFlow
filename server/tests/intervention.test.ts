import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { initializeDatabase, type SqliteDatabase } from "../src/database.js";
import { RoutingWorker } from "../src/routing-worker.js";

type ApiResponse = { status: number; body: unknown };
type TaskBody = {
  id: string;
  status: string;
  version: number;
  activeAssignmentId: string | null;
  acceptedAt: string | null;
  requiredExpertise: string;
};
type AssignmentBody = {
  id: string;
  contributorId: string;
  source: string;
  status: string;
  responseNote: string | null;
};
type DetailBody = {
  task: TaskBody;
  assignments: AssignmentBody[];
  eligibleContributors: Array<{ id: string; expertise: string }>;
  routingAttempts: Array<{
    id: string;
    status: string;
    outcome: string;
    due_at: string;
    warning_at: string | null;
    selected_contributor_id: string | null;
    task_version_at_creation: number;
    completed_at: string | null;
  }>;
  auditEvents: Array<{ id: string; type: string; actor: string }>;
};

function callApi(
  port: number,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers:
          payload === undefined
            ? undefined
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: responseBody ? JSON.parse(responseBody) : {},
          }),
        );
      },
    );
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

const codeOf = (response: ApiResponse) =>
  (response.body as { error: { code: string } }).error.code;
const taskOf = (response: ApiResponse) =>
  (response.body as { task: TaskBody }).task;
const assignmentOf = (response: ApiResponse) =>
  (response.body as { assignment: AssignmentBody }).assignment;

async function detail(port: number, taskId: string): Promise<DetailBody> {
  const response = await callApi(port, "GET", `/api/tasks/${taskId}`);
  assert.equal(response.status, 200);
  return response.body as DetailBody;
}

async function auditTypes(
  db: SqliteDatabase,
  taskId: string,
): Promise<string[]> {
  const rows = await db.all<{ event_type: string }>(
    "SELECT event_type FROM audit_events WHERE task_id = ? ORDER BY rowid",
    [taskId],
  );
  return rows.map((row) => row.event_type);
}

async function activeAssignees(
  db: SqliteDatabase,
  taskId: string,
): Promise<number> {
  const row = await db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM assignments WHERE task_id = ? AND status IN ('offered', 'accepted')`,
    [taskId],
  );
  return row?.count ?? 0;
}

async function createTask(
  port: number,
  title: string,
  requiredExpertise = "frontend",
): Promise<TaskBody> {
  const response = await callApi(port, "POST", "/api/tasks", {
    title,
    requiredExpertise,
  });
  assert.equal(response.status, 201);
  return taskOf(response);
}

async function withServer(
  run: (port: number, db: SqliteDatabase) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "taskflow-intervention-"));
  const db = await initializeDatabase(join(directory, "taskflow.sqlite"));
  const server = createApp(db).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(address.port, db);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function interventionApi(
  port: number,
  db: SqliteDatabase,
): Promise<void> {
  await db.run(
    "INSERT INTO contributors (id, name, expertise, active, created_at) VALUES (?, ?, ?, 1, ?)",
    [
      "contributor-linus",
      "Linus Torvalds",
      "frontend",
      "2030-01-01T00:00:00.000Z",
    ],
  );

  const pending = await createTask(port, "Pending override");
  const before = await detail(port, pending.id);
  assert.equal(before.task.status, "routing");
  assert.equal(before.routingAttempts[0].status, "pending");
  assert.deepEqual(
    before.eligibleContributors.map((contributor) => contributor.id),
    ["contributor-ada", "contributor-linus"],
  );
  const retryWhilePending = await callApi(
    port,
    "POST",
    `/api/tasks/${pending.id}/routing`,
    { version: before.task.version },
  );
  assert.equal(retryWhilePending.status, 409);
  assert.equal(codeOf(retryWhilePending), "conflict");
  const ineligible = await callApi(
    port,
    "POST",
    `/api/tasks/${pending.id}/assignments`,
    {
      contributorId: "contributor-grace",
      version: before.task.version,
    },
  );
  assert.equal(ineligible.status, 409);
  assert.equal(codeOf(ineligible), "invalid_assignment");
  const missingVersion = await callApi(
    port,
    "POST",
    `/api/tasks/${pending.id}/assignments`,
    { contributorId: "contributor-ada" },
  );
  assert.equal(missingVersion.status, 400);
  assert.equal(codeOf(missingVersion), "validation_error");

  const [firstAssign, secondAssign] = await Promise.all([
    callApi(port, "POST", `/api/tasks/${pending.id}/assignments`, {
      contributorId: "contributor-ada",
      version: before.task.version,
    }),
    callApi(port, "POST", `/api/tasks/${pending.id}/assignments`, {
      contributorId: "contributor-linus",
      version: before.task.version,
    }),
  ]);
  const assignStatuses = [firstAssign.status, secondAssign.status].sort(
    (left, right) => left - right,
  );
  assert.deepEqual(assignStatuses, [201, 409]);
  assert.equal(await activeAssignees(db, pending.id), 1);
  const overridden = await detail(port, pending.id);
  assert.equal(overridden.task.status, "offered");
  assert.equal(
    overridden.assignments.filter(
      (assignment) => assignment.status === "offered",
    ).length,
    1,
  );
  assert.equal(overridden.routingAttempts[0].status, "superseded");
  assert.equal(
    overridden.task.activeAssignmentId,
    overridden.assignments.find((assignment) => assignment.status === "offered")
      ?.id,
  );
  const auditsBeforeReplay = await auditTypes(db, pending.id);
  const replay = await callApi(
    port,
    "POST",
    `/api/tasks/${pending.id}/assignments`,
    {
      contributorId: "contributor-ada",
      version: before.task.version,
    },
  );
  assert.equal(replay.status, 409);
  assert.equal(codeOf(replay), "conflict");
  assert.deepEqual(await auditTypes(db, pending.id), auditsBeforeReplay);
  const auditsAfterReplay = await auditTypes(db, pending.id);
  assert.equal(
    auditsAfterReplay.filter((type) => type === "manual_assignment_created")
      .length,
    1,
  );

  const replacement = await createTask(port, "Replace offer");
  const adaOffer = await callApi(
    port,
    "POST",
    `/api/tasks/${replacement.id}/assignments`,
    {
      contributorId: "contributor-ada",
      version: 1,
    },
  );
  assert.equal(adaOffer.status, 201);
  const linusOffer = await callApi(
    port,
    "POST",
    `/api/tasks/${replacement.id}/assignments`,
    {
      contributorId: "contributor-linus",
      version: taskOf(adaOffer).version,
    },
  );
  assert.equal(linusOffer.status, 201);
  assert.equal(assignmentOf(linusOffer).contributorId, "contributor-linus");
  assert.equal(assignmentOf(linusOffer).source, "human");
  const replaced = await detail(port, replacement.id);
  assert.deepEqual(
    replaced.assignments.map((assignment) => [
      assignment.contributorId,
      assignment.status,
    ]),
    [
      ["contributor-ada", "superseded"],
      ["contributor-linus", "offered"],
    ],
  );
  assert.equal(replaced.task.activeAssignmentId, assignmentOf(linusOffer).id);
  assert.equal(await activeAssignees(db, replacement.id), 1);
  const staleAccept = await callApi(
    port,
    "POST",
    `/api/tasks/${replacement.id}/assignments/${assignmentOf(adaOffer).id}/accept`,
    {
      contributorId: "contributor-ada",
      version: taskOf(linusOffer).version,
    },
  );
  assert.equal(staleAccept.status, 409);
  assert.equal(codeOf(staleAccept), "invalid_assignment");

  const accepted = await callApi(
    port,
    "POST",
    `/api/tasks/${replacement.id}/assignments/${assignmentOf(linusOffer).id}/accept`,
    {
      contributorId: "contributor-linus",
      version: taskOf(linusOffer).version,
      responseNote: "I can take this.",
    },
  );
  assert.equal(accepted.status, 200);
  assert.equal(taskOf(accepted).status, "accepted");
  assert.ok(taskOf(accepted).acceptedAt);
  assert.equal(assignmentOf(accepted).status, "accepted");
  assert.equal(assignmentOf(accepted).responseNote, "I can take this.");
  assert.equal(await activeAssignees(db, replacement.id), 1);
  const acceptAgain = await callApi(
    port,
    "POST",
    `/api/tasks/${replacement.id}/assignments/${assignmentOf(linusOffer).id}/accept`,
    {
      contributorId: "contributor-linus",
      version: taskOf(accepted).version,
    },
  );
  assert.equal(acceptAgain.status, 409);
  assert.equal(codeOf(acceptAgain), "invalid_transition");
  const assignAfterAccept = await callApi(
    port,
    "POST",
    `/api/tasks/${replacement.id}/assignments`,
    {
      contributorId: "contributor-ada",
      version: taskOf(accepted).version,
    },
  );
  assert.equal(assignAfterAccept.status, 409);
  assert.equal(codeOf(assignAfterAccept), "invalid_transition");
  const retryAfterAccept = await callApi(
    port,
    "POST",
    `/api/tasks/${replacement.id}/routing`,
    { version: taskOf(accepted).version },
  );
  assert.equal(retryAfterAccept.status, 409);
  assert.equal(codeOf(retryAfterAccept), "invalid_transition");
  const auditsBeforeFailure = await auditTypes(db, replacement.id);
  const failed = await callApi(
    port,
    "POST",
    `/api/tasks/${replacement.id}/assignments/${assignmentOf(linusOffer).id}/fail`,
    {
      contributorId: "contributor-linus",
      version: taskOf(accepted).version,
      responseNote: "Environment was not ready.",
    },
  );
  assert.equal(failed.status, 200);
  assert.equal(taskOf(failed).status, "pre_work_failed");
  assert.equal(taskOf(failed).activeAssignmentId, null);
  assert.equal(taskOf(failed).acceptedAt, taskOf(accepted).acceptedAt);
  assert.equal(assignmentOf(failed).status, "pre_work_failed");
  assert.equal(await activeAssignees(db, replacement.id), 0);
  const failureAudits = await auditTypes(db, replacement.id);
  assert.deepEqual(
    failureAudits.slice(0, auditsBeforeFailure.length),
    auditsBeforeFailure,
  );
  assert.ok(failureAudits.includes("assignment_accepted"));
  assert.ok(failureAudits.includes("assignment_pre_work_failed"));
  const recovered = await callApi(
    port,
    "POST",
    `/api/tasks/${replacement.id}/routing`,
    { version: taskOf(failed).version },
  );
  assert.equal(recovered.status, 201);
  assert.equal(taskOf(recovered).status, "routing");
  assert.equal(taskOf(recovered).acceptedAt, null);
  const recoveredAttempt = (
    recovered.body as { routingAttempt: DetailBody["routingAttempts"][number] }
  ).routingAttempt;
  assert.equal(recoveredAttempt.status, "pending");
  assert.equal(recoveredAttempt.selected_contributor_id, "contributor-ada");
  assert.equal(
    recoveredAttempt.task_version_at_creation,
    taskOf(recovered).version,
  );
  assert.equal(
    (await detail(port, replacement.id)).routingAttempts.at(-1)
      ?.selected_contributor_id,
    "contributor-ada",
  );

  const declinedTask = await createTask(port, "Decline and retry");
  const declinedOffer = await callApi(
    port,
    "POST",
    `/api/tasks/${declinedTask.id}/assignments`,
    {
      contributorId: "contributor-ada",
      version: 1,
    },
  );
  const declined = await callApi(
    port,
    "POST",
    `/api/tasks/${declinedTask.id}/assignments/${assignmentOf(declinedOffer).id}/decline`,
    {
      contributorId: "contributor-ada",
      version: taskOf(declinedOffer).version,
      responseNote: "Not available.",
    },
  );
  assert.equal(declined.status, 200);
  assert.equal(taskOf(declined).status, "recovery_required");
  assert.equal(taskOf(declined).activeAssignmentId, null);
  assert.equal(assignmentOf(declined).status, "declined");
  const acceptAfterDecline = await callApi(
    port,
    "POST",
    `/api/tasks/${declinedTask.id}/assignments/${assignmentOf(declinedOffer).id}/accept`,
    {
      contributorId: "contributor-ada",
      version: taskOf(declined).version,
    },
  );
  assert.equal(acceptAfterDecline.status, 409);
  const manualAfterDecline = await callApi(
    port,
    "POST",
    `/api/tasks/${declinedTask.id}/assignments`,
    {
      contributorId: "contributor-ada",
      version: taskOf(declined).version,
    },
  );
  assert.equal(manualAfterDecline.status, 201);
  assert.equal(
    assignmentOf(manualAfterDecline).contributorId,
    "contributor-ada",
  );
  const declineAgain = await callApi(
    port,
    "POST",
    `/api/tasks/${declinedTask.id}/assignments/${assignmentOf(manualAfterDecline).id}/decline`,
    {
      contributorId: "contributor-ada",
      version: taskOf(manualAfterDecline).version,
    },
  );
  assert.equal(declineAgain.status, 200);
  const retried = await callApi(
    port,
    "POST",
    `/api/tasks/${declinedTask.id}/routing`,
    { version: taskOf(declineAgain).version },
  );
  assert.equal(retried.status, 201);
  const retryAttempt = (
    retried.body as { routingAttempt: DetailBody["routingAttempts"][number] }
  ).routingAttempt;
  assert.equal(retryAttempt.selected_contributor_id, "contributor-linus");
  assert.equal(taskOf(retried).status, "routing");
  const retryAudits = await auditTypes(db, declinedTask.id);
  assert.ok(retryAudits.includes("assignment_declined"));
  assert.ok(retryAudits.includes("routing_retried"));
  assert.equal(
    retryAudits.filter((type) => type === "routing_retried").length,
    1,
  );

  const failureOverride = await createTask(
    port,
    "Manual recovery after failure",
  );
  const failureOffer = await callApi(
    port,
    "POST",
    `/api/tasks/${failureOverride.id}/assignments`,
    {
      contributorId: "contributor-linus",
      version: 1,
    },
  );
  const failureAccepted = await callApi(
    port,
    "POST",
    `/api/tasks/${failureOverride.id}/assignments/${assignmentOf(failureOffer).id}/accept`,
    {
      contributorId: "contributor-linus",
      version: taskOf(failureOffer).version,
    },
  );
  const failureReported = await callApi(
    port,
    "POST",
    `/api/tasks/${failureOverride.id}/assignments/${assignmentOf(failureOffer).id}/fail`,
    {
      contributorId: "contributor-linus",
      version: taskOf(failureAccepted).version,
    },
  );
  assert.equal(failureReported.status, 200);
  const manualRecovery = await callApi(
    port,
    "POST",
    `/api/tasks/${failureOverride.id}/assignments`,
    {
      contributorId: "contributor-linus",
      version: taskOf(failureReported).version,
    },
  );
  assert.equal(manualRecovery.status, 201);
  assert.equal(taskOf(manualRecovery).status, "offered");
  assert.equal(assignmentOf(manualRecovery).contributorId, "contributor-linus");
  assert.equal(await activeAssignees(db, failureOverride.id), 1);

  const repeated = await createTask(port, "Repeated acceptance");
  const repeatedOffer = await callApi(
    port,
    "POST",
    `/api/tasks/${repeated.id}/assignments`,
    {
      contributorId: "contributor-ada",
      version: 1,
    },
  );
  const [firstAccept, secondAccept] = await Promise.all([
    callApi(
      port,
      "POST",
      `/api/tasks/${repeated.id}/assignments/${assignmentOf(repeatedOffer).id}/accept`,
      {
        contributorId: "contributor-ada",
        version: taskOf(repeatedOffer).version,
      },
    ),
    callApi(
      port,
      "POST",
      `/api/tasks/${repeated.id}/assignments/${assignmentOf(repeatedOffer).id}/accept`,
      {
        contributorId: "contributor-ada",
        version: taskOf(repeatedOffer).version,
      },
    ),
  ]);
  assert.deepEqual(
    [firstAccept.status, secondAccept.status].sort(
      (left, right) => left - right,
    ),
    [200, 409],
  );
  assert.equal(await activeAssignees(db, repeated.id), 1);
  assert.equal(
    (await auditTypes(db, repeated.id)).filter(
      (type) => type === "assignment_accepted",
    ).length,
    1,
  );

  const createdAt = "2030-01-01T00:00:00.000Z";
  await db.run(
    `INSERT INTO tasks (id, title, description, required_expertise, status, version, created_at, updated_at)
     VALUES ('stuck-route', 'Stuck route', '', 'frontend', 'routing', 4, ?, ?)`,
    [createdAt, createdAt],
  );
  await db.run(
    `INSERT INTO routing_attempts (
       id, task_id, status, outcome, due_at, warning_at, selected_contributor_id, task_version_at_creation, created_at, completed_at
     ) VALUES ('stuck-attempt', 'stuck-route', 'superseded', 'success', '2030-01-01T00:00:05.000Z', NULL, 'contributor-ada', 1, ?, NULL)`,
    [createdAt],
  );
  const stuckRetry = await callApi(
    port,
    "POST",
    "/api/tasks/stuck-route/routing",
    { version: 4 },
  );
  assert.equal(stuckRetry.status, 201);
  assert.equal(taskOf(stuckRetry).status, "routing");
  assert.equal(taskOf(stuckRetry).version, 5);
  const stuckAttempt = (
    stuckRetry.body as { routingAttempt: DetailBody["routingAttempts"][number] }
  ).routingAttempt;
  assert.equal(stuckAttempt.status, "pending");
  assert.equal(stuckAttempt.task_version_at_creation, 5);
  const stuckDetail = await detail(port, "stuck-route");
  assert.equal(
    stuckDetail.routingAttempts.filter(
      (attempt) => attempt.status === "pending",
    ).length,
    1,
  );

  await db.run(
    `INSERT INTO tasks (id, title, description, required_expertise, status, version, created_at, updated_at)
     VALUES ('stuck-assign', 'Stuck assign', '', 'frontend', 'routing', 2, ?, ?)`,
    [createdAt, createdAt],
  );
  await db.run(
    `INSERT INTO routing_attempts (
       id, task_id, status, outcome, due_at, warning_at, selected_contributor_id, task_version_at_creation, created_at
     ) VALUES ('stuck-assign-attempt', 'stuck-assign', 'superseded', 'success', '2030-01-01T00:00:05.000Z', NULL, 'contributor-ada', 1, ?)`,
    [createdAt],
  );
  const stuckAssign = await callApi(
    port,
    "POST",
    "/api/tasks/stuck-assign/assignments",
    {
      contributorId: "contributor-ada",
      version: 2,
    },
  );
  assert.equal(stuckAssign.status, 201);
  assert.equal(taskOf(stuckAssign).status, "offered");
  assert.equal(await activeAssignees(db, "stuck-assign"), 1);
}

async function lateAutomaticResult(): Promise<void> {
  await withServer(async (port, db) => {
    const created = await createTask(port, "Late automation");
    const initial = await detail(port, created.id);
    const assigned = await callApi(
      port,
      "POST",
      `/api/tasks/${created.id}/assignments`,
      {
        contributorId: "contributor-ada",
        version: initial.task.version,
      },
    );
    assert.equal(assigned.status, 201);
    const assignmentId = assignmentOf(assigned).id;
    await db.run(
      `INSERT INTO routing_attempts (
         id, task_id, status, outcome, due_at, warning_at, selected_contributor_id, task_version_at_creation, created_at
       ) VALUES ('late-attempt', ?, 'pending', 'success', '2030-01-01T00:00:05.000Z', NULL, 'contributor-ada', 1, '2030-01-01T00:00:00.000Z')`,
      [created.id],
    );
    const worker = new RoutingWorker(
      db,
      () => new Date("2030-01-01T00:00:30.000Z"),
    );
    await worker.sweep();
    await worker.sweep();
    const after = await detail(port, created.id);
    assert.equal(after.task.status, "offered");
    assert.equal(after.task.version, taskOf(assigned).version);
    assert.equal(after.task.activeAssignmentId, assignmentId);
    assert.deepEqual(
      after.assignments.map((assignment) => [
        assignment.id,
        assignment.source,
        assignment.status,
      ]),
      [[assignmentId, "human", "offered"]],
    );
    assert.equal(
      after.routingAttempts.filter((attempt) => attempt.status === "pending")
        .length,
      0,
    );
    assert.equal(
      (await auditTypes(db, created.id)).filter(
        (type) => type === "routing_offer_created",
      ).length,
      0,
    );
    assert.equal(
      (await auditTypes(db, created.id)).filter(
        (type) => type === "routing_result_ignored",
      ).length,
      1,
    );
  });
}

async function noResponseRecovery(): Promise<void> {
  await withServer(async (port, db) => {
    const createdAt = new Date(Date.now() - 30000).toISOString();
    const dueAt = new Date(Date.now() - 20000).toISOString();
    const warningAt = new Date(Date.now() - 1000).toISOString();
    for (const id of ["warning-retry", "warning-assign"]) {
      await db.run(
        `INSERT INTO tasks (id, title, description, required_expertise, status, version, created_at, updated_at)
         VALUES (?, ?, '', 'backend', 'routing', 1, ?, ?)`,
        [id, id, createdAt, createdAt],
      );
      await db.run(
        `INSERT INTO routing_attempts (
           id, task_id, status, outcome, due_at, warning_at, selected_contributor_id, task_version_at_creation, created_at
         ) VALUES (?, ?, 'pending', 'no_response', ?, ?, 'contributor-grace', 1, ?)`,
        [`attempt-${id}`, id, dueAt, warningAt, createdAt],
      );
    }
    const worker = new RoutingWorker(db, () => new Date());
    await worker.sweep();
    await worker.sweep();
    const warned = await detail(port, "warning-retry");
    assert.equal(warned.task.status, "no_response_warning");
    assert.equal(warned.routingAttempts.length, 1);
    assert.equal(warned.routingAttempts[0].status, "no_response");
    assert.equal(warned.routingAttempts[0].completed_at, null);
    assert.equal(warned.assignments.length, 0);
    await worker.sweep();
    assert.equal(
      (await detail(port, "warning-retry")).routingAttempts.length,
      1,
    );

    const retried = await callApi(
      port,
      "POST",
      "/api/tasks/warning-retry/routing",
      { version: warned.task.version },
    );
    assert.equal(retried.status, 201);
    assert.equal(taskOf(retried).status, "routing");
    const attempts = (await detail(port, "warning-retry")).routingAttempts;
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].status, "superseded");
    assert.equal(attempts[0].outcome, "no_response");
    assert.equal(attempts[0].completed_at, null);
    assert.equal(attempts[1].status, "pending");
    assert.equal(attempts[1].task_version_at_creation, taskOf(retried).version);

    const warnedAssign = await detail(port, "warning-assign");
    const assigned = await callApi(
      port,
      "POST",
      "/api/tasks/warning-assign/assignments",
      {
        contributorId: "contributor-grace",
        version: warnedAssign.task.version,
      },
    );
    assert.equal(assigned.status, 201);
    assert.equal(taskOf(assigned).status, "offered");
    assert.equal(assignmentOf(assigned).source, "human");
    const assignedDetail = await detail(port, "warning-assign");
    assert.equal(assignedDetail.routingAttempts[0].status, "superseded");
    assert.equal(assignedDetail.routingAttempts[0].completed_at, null);
    assert.equal(await activeAssignees(db, "warning-assign"), 1);
  });
}

async function restartPersistence(): Promise<void> {
  const directory = mkdtempSync(
    join(tmpdir(), "taskflow-intervention-restart-"),
  );
  const databasePath = join(directory, "taskflow.sqlite");
  let db = await initializeDatabase(databasePath);
  let server = createApp(db).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  let address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const created = await createTask(
      address.port,
      "Restart assignment",
      "backend",
    );
    const assigned = await callApi(
      address.port,
      "POST",
      `/api/tasks/${created.id}/assignments`,
      {
        contributorId: "contributor-grace",
        version: 1,
      },
    );
    assert.equal(assigned.status, 201);
    const beforeClose = await detail(address.port, created.id);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.close();

    db = await initializeDatabase(databasePath);
    server = createApp(db).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    address = server.address();
    assert.ok(address && typeof address !== "string");
    const reopened = await detail(address.port, created.id);
    assert.equal(reopened.task.status, "offered");
    assert.equal(reopened.task.version, beforeClose.task.version);
    assert.deepEqual(reopened.assignments, beforeClose.assignments);
    assert.deepEqual(
      reopened.auditEvents.map((event) => event.type),
      beforeClose.auditEvents.map((event) => event.type),
    );
    await new RoutingWorker(
      db,
      () => new Date("2030-01-01T00:00:00.000Z"),
    ).sweep();
    const afterSweep = await detail(address.port, created.id);
    assert.deepEqual(afterSweep.assignments, beforeClose.assignments);
    assert.equal(afterSweep.task.status, "offered");

    const accepted = await callApi(
      address.port,
      "POST",
      `/api/tasks/${created.id}/assignments/${assignmentOf(assigned).id}/accept`,
      {
        contributorId: "contributor-grace",
        version: reopened.task.version,
      },
    );
    assert.equal(accepted.status, 200);
    const acceptedAudits = (
      await detail(address.port, created.id)
    ).auditEvents.map((event) => event.id);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.close();

    db = await initializeDatabase(databasePath);
    await db.run(
      `INSERT INTO routing_attempts (
         id, task_id, status, outcome, due_at, warning_at, selected_contributor_id, task_version_at_creation, created_at
       ) VALUES ('stray-after-accept', ?, 'pending', 'success', '2030-01-01T00:00:05.000Z', NULL, 'contributor-grace', 1, '2030-01-01T00:00:00.000Z')`,
      [created.id],
    );
    await new RoutingWorker(
      db,
      () => new Date("2030-01-01T00:00:30.000Z"),
    ).sweep();
    server = createApp(db).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    address = server.address();
    assert.ok(address && typeof address !== "string");
    const finalDetail = await detail(address.port, created.id);
    assert.equal(finalDetail.task.status, "accepted");
    assert.equal(
      finalDetail.assignments.filter(
        (assignment) => assignment.status === "accepted",
      ).length,
      1,
    );
    assert.equal(await activeAssignees(db, created.id), 1);
    assert.equal(
      finalDetail.routingAttempts.some(
        (attempt) =>
          attempt.id === "stray-after-accept" && attempt.status === "pending",
      ),
      false,
    );
    const finalAuditIds = finalDetail.auditEvents.map((event) => event.id);
    for (const id of acceptedAudits) assert.ok(finalAuditIds.includes(id));
    assert.ok(
      finalDetail.auditEvents.some(
        (event) => event.type === "routing_result_ignored",
      ),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function conflictingWriters(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "taskflow-intervention-race-"));
  const databasePath = join(directory, "taskflow.sqlite");
  const left = await initializeDatabase(databasePath);
  const right = await initializeDatabase(databasePath);
  const server = createApp(left).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const createdAt = "2030-01-01T00:00:00.000Z";
    await left.run(
      `INSERT INTO tasks (id, title, description, required_expertise, status, version, created_at, updated_at)
       VALUES ('race-task', 'Race', '', 'qa', 'routing', 1, ?, ?)`,
      [createdAt, createdAt],
    );
    await left.run(
      `INSERT INTO routing_attempts (
         id, task_id, status, outcome, due_at, warning_at, selected_contributor_id, task_version_at_creation, created_at
       ) VALUES ('race-attempt', 'race-task', 'pending', 'success', '2030-01-01T00:00:05.000Z', NULL, 'contributor-margaret', 1, ?)`,
      [createdAt],
    );
    const worker = new RoutingWorker(
      right,
      () => new Date("2030-01-01T00:00:30.000Z"),
    );
    const [assigned] = await Promise.all([
      callApi(address.port, "POST", "/api/tasks/race-task/assignments", {
        contributorId: "contributor-margaret",
        version: 1,
      }),
      worker.sweep(),
    ]);
    assert.ok(assigned.status === 201 || assigned.status === 409);
    const task = await left.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = ?",
      ["race-task"],
    );
    const assignments = await left.all<{ status: string; source: string }>(
      `SELECT status, source FROM assignments WHERE task_id = 'race-task' AND status IN ('offered', 'accepted')`,
    );
    assert.equal(task?.status, "offered");
    assert.equal(assignments.length, 1);
    const attempts = await left.all<{ status: string }>(
      `SELECT status FROM routing_attempts WHERE task_id = 'race-task' AND status = 'pending'`,
    );
    assert.equal(attempts.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await left.close();
    await right.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

await interventionApiTest();
await lateAutomaticResult();
await noResponseRecovery();
await restartPersistence();
await conflictingWriters();
console.log("Intervention tests passed.");

async function interventionApiTest(): Promise<void> {
  await withServer(interventionApi);
}
