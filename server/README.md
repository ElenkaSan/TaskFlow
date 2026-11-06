# TaskFlow — Backend

Backend service for **TaskFlow**, a Human-in-the-Loop Task Assignment System.

Built with Node.js, TypeScript, Express, and SQLite.

## Overview

The backend manages task creation, contributor eligibility, routing attempts, assignment state, and audit history.

Its primary responsibility is to maintain consistent task assignments when automated routing is delayed, unavailable, or superseded by human intervention.

## Technology Stack

- **Runtime:** Node.js 22+
- **Language:** TypeScript
- **API:** Express
- **Database:** SQLite
- **Testing:** Automated API and integration tests

The SQLite driver and runtime compatibility should be verified against the final implementation.

## Architecture

```text
React Frontend
      |
      v
Express REST API
      |
      +---- Task Management
      |
      +---- Contributor Matching
      |
      +---- Routing Worker
      |
      +---- Assignment State Management
      |
      +---- Audit Events
      |
      v
SQLite Database
```

The backend is the source of truth for task and assignment state.

Routing attempts are persisted to SQLite to support recovery across application restarts.

## API

### Implemented in Milestone 1

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Check API availability |
| POST | `/api/tasks` | Create a task and initial routing attempt |
| GET | `/api/tasks` | List tasks |
| GET | `/api/tasks/:taskId` | Retrieve task details, routing attempts, and audit history |

Additional assignment and recovery endpoints will be documented after implementation.

## Persistence

The default local database path is:

`data/taskflow.sqlite`

SQLite is configured with:

- Foreign key enforcement
- Write-Ahead Logging (WAL)
- Transactional updates for related records

Application state is stored outside transient build directories.

The database file is excluded from Git.

## Routing Design

The routing engine simulates an external assignment service.

Expected behavior:

- Routing responses normally arrive after 5–20 seconds.
- Approximately 20% of attempts never return.
- Contributors are matched using normalized expertise tags.
- Unresolved attempts receive a delayed warning after 25 seconds.
- Routing outcomes and due times are persisted for restart consistency.

A delayed request is not automatically treated as a confirmed failure.

### Concurrency and Safety

The intended assignment invariant is:

**A task must never have more than one active assignee.**

Human decisions must take precedence over superseded automated routing results.

Task version checks and transactional updates protect against stale routing responses.

Accepted assignments terminate automatic routing for that task.

These safety properties must be verified by integration tests before final submission.

## Local Development

From the `server` directory:

```bash
npm install
npm run dev
```

Check API availability:

```bash
curl http://localhost:3001/api/health
```

The default port is expected to be 3001; confirm the value in the server configuration.

## Verification

Run the available scripts from the `server` directory:

```bash
npm run typecheck
npm test
```

The test suite should verify API behavior, persistence, routing outcomes, and safe assignment transitions as implementation progresses.

## Implementation Status

| Component | Status |
|---|---|
| Express API | Implemented |
| SQLite persistence | Implemented |
| Task creation and retrieval | Implemented |
| Contributor seed data | Implemented |
| Initial routing attempt persistence | Implemented |
| Background routing worker | In progress |
| Restart recovery | In progress |
| Manual assignment and override | Planned |
| Contributor acceptance, decline, and failure | Planned |
| Final concurrency verification | Planned |

## Engineering Tradeoffs

**Single-process backend:** Avoids unnecessary distributed infrastructure for a time-boxed assessment.

**SQLite persistence:** Provides transactional guarantees and durable local storage without requiring an external database service.

**Database-backed routing:** Allows pending attempts to be recovered without relying exclusively on process-local timers.

**Exact expertise matching:** Keeps contributor selection understandable and deterministic.

**REST and frontend polling:** Reduces complexity compared with WebSockets while remaining suitable for a small operator dashboard.

## Scope

This backend intentionally excludes authentication, external AI APIs, production message queues, and complex recommendation algorithms.

The project prioritizes correctness, recovery, operator control, and maintainability.

For the complete application overview, see the [main README](../README.md).