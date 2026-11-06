import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { randomUUID } from "node:crypto";
import { withTransaction, type SqliteDatabase } from "./database.js";
import {
  acceptAssignment,
  assignManually,
  declineAssignment,
  insertRoutingAttempt,
  reportPreWorkFailure,
  retryRouting,
} from "./transitions.js";

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
const expertise = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, " ");
const fail = (
  message: string,
  status: number,
  code: string,
  details?: unknown,
): ApiError => Object.assign(new Error(message), { status, code, details });
const taskJson = (task: TaskRow) => ({
  id: task.id,
  title: task.title,
  description: task.description,
  requiredExpertise: task.required_expertise,
  status: task.status,
  version: task.version,
  activeAssignmentId: task.active_assignment_id,
  acceptedAt: task.accepted_at,
  createdAt: task.created_at,
  updatedAt: task.updated_at,
});

const assignmentJson = (assignment: {
  id: string;
  task_id: string;
  contributor_id: string;
  source: string;
  status: string;
  offered_at: string;
  responded_at: string | null;
  response_note: string | null;
}) => ({
  id: assignment.id,
  taskId: assignment.task_id,
  contributorId: assignment.contributor_id,
  source: assignment.source,
  status: assignment.status,
  offeredAt: assignment.offered_at,
  respondedAt: assignment.responded_at,
  responseNote: assignment.response_note,
});

export function createApp(db: SqliteDatabase) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.get("/api/health", (_request, response) =>
    response.json({ status: "ok" }),
  );
  app.post(
    "/api/tasks",
    async (
      request: Request<
        object,
        unknown,
        { title?: unknown; description?: unknown; requiredExpertise?: unknown }
      >,
      response,
      next,
    ) => {
      try {
        const title =
          typeof request.body.title === "string"
            ? request.body.title.trim()
            : "";
        const description =
          typeof request.body.description === "string"
            ? request.body.description.trim()
            : "";
        const requiredExpertise = expertise(
          typeof request.body.requiredExpertise === "string"
            ? request.body.requiredExpertise
            : "",
        );
        const details: Record<string, string> = {};
        if (!title) details.title = "Title is required.";
        else if (title.length > 200)
          details.title = "Title must be 200 characters or fewer.";
        if (description.length > 2000)
          details.description = "Description must be 2000 characters or fewer.";
        if (!requiredExpertise)
          details.requiredExpertise = "Required expertise is required.";
        else if (requiredExpertise.length > 80)
          details.requiredExpertise =
            "Required expertise must be 80 characters or fewer.";
        if (Object.keys(details).length)
          throw fail(
            "Request validation failed.",
            400,
            "validation_error",
            details,
          );
        const now = new Date().toISOString();
        const task: TaskRow = {
          id: randomUUID(),
          title,
          description,
          required_expertise: requiredExpertise,
          status: "routing",
          version: 1,
          active_assignment_id: null,
          accepted_at: null,
          created_at: now,
          updated_at: now,
        };
        await withTransaction(db, async () => {
          await db.run(
            "INSERT INTO tasks (id,title,description,required_expertise,status,version,active_assignment_id,accepted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [
              task.id,
              task.title,
              task.description,
              task.required_expertise,
              task.status,
              task.version,
              null,
              null,
              now,
              now,
            ],
          );
          await insertRoutingAttempt(db, task.id, requiredExpertise, new Date(now), task.version);
          await db.run(
            "INSERT INTO audit_events (id,task_id,event_type,actor,details_json,created_at) VALUES (?,?,'task_created','operator',?,?)",
            [randomUUID(), task.id, JSON.stringify({ requiredExpertise }), now],
          );
        });
        response.status(201).json({ task: taskJson(task) });
      } catch (error) {
        next(error);
      }
    },
  );
  app.get("/api/tasks", async (_request, response, next) => {
    try {
      response.json({
        tasks: (
          await db.all<TaskRow>("SELECT * FROM tasks ORDER BY created_at DESC")
        ).map(taskJson),
      });
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/tasks/:taskId", async (request, response, next) => {
    try {
      const task = await db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", [
        request.params.taskId,
      ]);
      if (!task) throw fail("Task not found.", 404, "not_found");
      const routingAttempts = await db.all(
        "SELECT id,status,outcome,due_at,warning_at,selected_contributor_id,task_version_at_creation,created_at,completed_at FROM routing_attempts WHERE task_id = ? ORDER BY created_at, rowid",
        [task.id],
      );
      const assignments = await db.all<{
        id: string;
        task_id: string;
        contributor_id: string;
        source: string;
        status: string;
        offered_at: string;
        responded_at: string | null;
        response_note: string | null;
      }>(
        "SELECT id, task_id, contributor_id, source, status, offered_at, responded_at, response_note FROM assignments WHERE task_id = ? ORDER BY offered_at, rowid",
        [task.id],
      );
      const eligibleContributors = await db.all<{ id: string; name: string; expertise: string }>(
        "SELECT id, name, expertise FROM contributors WHERE active = 1 AND expertise = ? ORDER BY id",
        [task.required_expertise],
      );
      const events = await db.all<{
        id: string;
        event_type: string;
        actor: string;
        details_json: string;
        created_at: string;
      }>(
        "SELECT id,event_type,actor,details_json,created_at FROM audit_events WHERE task_id = ? ORDER BY created_at, rowid",
        [task.id],
      );
      response.json({
        task: taskJson(task),
        assignments: assignments.map(assignmentJson),
        eligibleContributors,
        routingAttempts,
        auditEvents: events.map((event) => ({
          id: event.id,
          type: event.event_type,
          actor: event.actor,
          details: JSON.parse(event.details_json),
          createdAt: event.created_at,
        })),
      });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/tasks/:taskId/assignments", async (request, response, next) => {
    try {
      const result = await assignManually(db, request.params.taskId, request.body ?? {});
      response.status(201).json({
        task: taskJson(result.task),
        assignment: assignmentJson(result.assignment),
      });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/tasks/:taskId/assignments/:assignmentId/accept", async (request, response, next) => {
    try {
      const result = await acceptAssignment(db, request.params.taskId, request.params.assignmentId, request.body ?? {});
      response.json({ task: taskJson(result.task), assignment: assignmentJson(result.assignment) });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/tasks/:taskId/assignments/:assignmentId/decline", async (request, response, next) => {
    try {
      const result = await declineAssignment(db, request.params.taskId, request.params.assignmentId, request.body ?? {});
      response.json({ task: taskJson(result.task), assignment: assignmentJson(result.assignment) });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/tasks/:taskId/assignments/:assignmentId/fail", async (request, response, next) => {
    try {
      const result = await reportPreWorkFailure(db, request.params.taskId, request.params.assignmentId, request.body ?? {});
      response.json({ task: taskJson(result.task), assignment: assignmentJson(result.assignment) });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/tasks/:taskId/routing", async (request, response, next) => {
    try {
      const result = await retryRouting(db, request.params.taskId, request.body ?? {});
      response.status(201).json({ task: taskJson(result.task), routingAttempt: result.routingAttempt });
    } catch (error) {
      next(error);
    }
  });
  app.use((_request, _response, next) =>
    next(fail("Route not found.", 404, "not_found")),
  );
  app.use(
    (
      error: ApiError,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      const status = error.status ?? 500;
      if (status >= 500) console.error(error);
      response
        .status(status)
        .json({
          error: {
            code: error.code ?? "internal_error",
            message:
              status >= 500 ? "An unexpected error occurred." : error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        });
    },
  );
  return app;
}
