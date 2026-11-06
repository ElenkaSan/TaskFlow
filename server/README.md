# TaskFlow — Backend

**Human-in-the-Loop Task Assignment System**

TaskFlow's backend implements persistent task routing, contributor assignment, human intervention, and recovery workflows.

The core engineering challenge is maintaining assignment consistency when automated routing responses are delayed, never arrive, or conflict with newer human decisions.

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js |
| Language | TypeScript |
| API | Express |
| Database | SQLite (`sqlite3`) |
| Testing | Node.js `assert` with TypeScript test scripts |

**Verified runtimes:** Node.js 20.20.0 and 22.23.4.

The service uses a single Node.js process with a database-backed routing worker.

## Architecture

```text
        React Operator Dashboard
                 |
                 v
          Express REST API
                 |
    +-----+--------------------+
    |                          |
Task & Assignment       Routing Worker
State Transitions       Startup + Periodic Sweep
    |                          |
    +-------------+------------+
                  |
                  v
           SQLite Database
          (WAL + Transactions)
                  |
        Tasks / Contributors
        Assignments / Attempts
             Audit Events
```

The backend is the authoritative source of task and assignment state.

Routing outcomes and timestamps are persisted before processing so that restarts do not regenerate results or lose outstanding attempts.

## API Reference

### Task Management

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/health` | Check API availability |
| POST | `/api/tasks` | Create a task and initial routing attempt |
| GET | `/api/tasks` | List tasks and current states |
| GET | `/api/tasks/:taskId` | Retrieve task details, routing attempts, assignments, audit history, and eligible contributors |

### Human Intervention & Recovery

| Method | Endpoint | Transition |
|---|---|---|
| POST | `/api/tasks/:taskId/assignments` | Create a manual assignment offer or replace an outstanding offer |
| POST | `/api/tasks/:taskId/assignments/:assignmentId/accept` | `offered` → `accepted` |
| POST | `/api/tasks/:taskId/assignments/:assignmentId/decline` | `offered` → `recovery_required` |
| POST | `/api/tasks/:taskId/assignments/:assignmentId/fail` | `accepted` → `pre_work_failed` |
| POST | `/api/tasks/:taskId/routing` | Explicitly start a new routing attempt from an eligible recovery state |

Task-detail responses include routing attempts, assignments, eligible contributors, and audit events.

Mutation requests require the task version last read by the caller.

## Routing Simulation

The worker simulates an asynchronous assignment service.

- Normal responses arrive after 5–20 seconds.
- Approximately 20% of attempts never return.
- Contributors are matched by normalized expertise tags.
- A no-response request produces a warning after 25 seconds.
- An unresolved request is not automatically classified as failed.
- Automatic retries are not triggered by no-response warnings.

### Routing Outcomes

| Outcome | Result |
|---|---|
| Successful match | Creates an assignment offer |
| No eligible contributor | Transitions to `recovery_required` |
| No response | Remains unresolved with `no_response_warning` |
| Superseded result | Ignored without changing the newer task decision |

Each attempt stores its outcome, due time, warning time, selected contributor, and task version.

A startup sweep and periodic worker processing reconcile persisted attempts. Repeated sweeps must not create duplicate assignments.

## Assignment Lifecycle

The assignment workflow distinguishes between an offer, acceptance, decline, and failure before work begins.

- **Offered:** A contributor has been selected but has not accepted.
- **Accepted:** The contributor accepts; normal routing and manual replacement are blocked.
- **Declined:** The task requires recovery; no automatic retry is started.
- **Pre-work failed:** An accepted assignment failed before work began, allowing explicit recovery.

Operators can manually assign eligible contributors while routing is pending, delayed, or awaiting recovery.

A manual assignment can replace an outstanding offer but cannot replace an accepted assignment through the normal workflow.

Contributors who previously declined or failed are excluded from subsequent automatic matching for the same task. An operator can still select them explicitly.

## Consistency and Concurrency

### Assignment Integrity

**Invariant: Each task has at most one active assignment.**

SQLite transactions and a partial unique index enforce assignment integrity.

### Optimistic Concurrency

Every mutation requires the latest task `version`.

Updates validate the expected version and allowed state inside a transaction.

When the supplied version is stale, the API returns:

`HTTP 409 Conflict`

The caller must refresh task details before attempting another mutation.

### Stale-Response Protection

A routing result is applied only if the task remains in the expected state and its version is still current.

Manual intervention supersedes pending attempts atomically.

Late automated responses cannot overwrite newer operator decisions.

### Idempotent Routing

Repeated worker sweeps, including processing after restart, must not create duplicate offers or duplicate routing-completion events.

## Persistence and Audit History

The default local database location is:

`data/taskflow.sqlite`

SQLite configuration includes:

- Foreign key enforcement
- Write-Ahead Logging (WAL)
- Busy timeout for concurrent writers
- Transactional state updates

Database files are excluded from version control.

Meaningful actions are recorded through append-only audit events.

Events include:

- `routing_offer_created`
- `routing_no_eligible_contributor`
- `routing_no_response_warning`
- `routing_result_ignored`
- `manual_assignment_created`
- `assignment_superseded`
- `routing_attempts_superseded`
- `assignment_accepted`
- `assignment_declined`
- `assignment_pre_work_failed`
- `routing_retried`

This provides a traceable history of automation decisions, human overrides, and recovery actions.

## Running Locally

From the `server` directory:

```bash
npm install
npm run dev
```

Check API availability:

```bash
curl http://localhost:3001/api/health
```

The configured port should be confirmed in `src/server.ts` or the environment configuration.

### Verification

Run TypeScript checks:

```bash
npm run typecheck
```

Run backend tests:

```bash
npm test
```

The current test command executes:

```text
tests/api.test.ts
tests/intervention.test.ts
```

**Milestone 3 verification:** Both test scripts completed successfully in three reported runs on Node.js 20.20.0. TypeScript checking also exited successfully.

The test runner reports completion per script rather than a numeric test count.

Core test coverage includes routing outcomes, restart recovery, repeated worker sweeps, stale task versions, manual overrides, contributor responses, and explicit recovery.

These automated results do not replace manual end-to-end UI verification.

## Implementation Status

| Component | Status |
|---|---|
| Express API and task management | Implemented |
| SQLite persistence | Implemented |
| Contributor matching | Implemented |
| Persisted routing worker | Implemented |
| Delayed/no-response handling | Implemented |
| Restart recovery | Implemented |
| Manual assignment and override | Implemented |
| Contributor accept / decline / fail | Implemented |
| Explicit recovery and retry | Implemented |
| Version-based concurrency protection | Implemented |
| Append-only audit history | Implemented |
| Backend integration tests | Passed in reported runs |
| React operator dashboard | In progress |
| Final manual end-to-end verification | Pending |

## Engineering Tradeoffs

**Single-process architecture:** Keeps the assessment focused on correctness without introducing distributed infrastructure.

**SQLite rather than an external database:** Provides local durability and transactional consistency with minimal setup.

**Persisted routing attempts:** Preserve simulated outcomes across restarts and avoid reliance on in-memory timers alone.

**Optimistic concurrency:** Rejects stale actions rather than silently replacing newer task decisions.

**Exact expertise matching:** Keeps contributor selection transparent and predictable.

**Polling instead of WebSockets:** Simplifies frontend integration for a small operator dashboard.

## Known Limitations

- No authentication or authorization.
- Contributor responses are simulated through API actions.
- Repeated mutations using an outdated task version return `409`, rather than replaying the original successful response.
- The application is designed for a single backend process, not a distributed worker deployment.
- Routing attempt fields and assignment response fields currently use different naming conventions.
- A task with no remaining eligible contributors requires operator intervention.

These limitations are documented rather than hidden.

## Scope

The assessment intentionally excludes external AI services, complex recommendation models, production queues, multi-tenant infrastructure, and deployment requirements.

The implementation prioritizes correctness, recovery, human oversight, and maintainability.

For the complete application overview, see the [main README](../README.md).

For the manual test plan, see [Manual QA Checklist](../docs/QA_CHECKLIST.md).
