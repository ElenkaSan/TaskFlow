# TaskFlow implementation plan

## Scope

TaskFlow is a small task-assignment system. A newly created task is routed to
an eligible contributor by expertise. While automatic routing is pending, an
operator may assign a contributor manually. Routing is deliberately simulated
with a persisted delay of 5–20 seconds; twenty percent of attempts are
persisted as no-response attempts.

The implementation stays deliberately small: React client, Express JSON API,
SQLite, and client polling about every 1.5 seconds while any task is
`routing`. There is no authentication, real queue, or websocket layer for this
assessment.

## Revised task state model

`task.status` represents the current task lifecycle. Assignment response is
stored separately so that an assignment is never mistaken for acceptance.

| Status | Meaning | Allowed next states |
| --- | --- | --- |
| `routing` | An automatic routing attempt is pending, or routing was explicitly retried. A human may manually assign when someone is eligible. | `offered`, `no_response_warning`, `recovery_required` |
| `no_response_warning` | The current automated attempt was intentionally simulated to never respond. It remains unresolved; the UI shows a delayed operator warning. | `offered` (manual assignment), `routing` (explicit retry) |
| `offered` | A contributor has been selected, by automation or a human, and has not yet responded. Replacing the offer stays `offered`. | `accepted`, `recovery_required` |
| `accepted` | The contributor explicitly accepted. Automatic routing is permanently stopped for this task. | `pre_work_failed` |
| `pre_work_failed` | The accepted contributor failed before work began. The operator can start recovery. | `routing`, `offered` |
| `recovery_required` | The offered contributor declined or routing cannot make a valid offer. A human needs to choose the next action. | `routing`, `offered` |

Terminality is intentionally limited for the assessment: `accepted` is the
successful stable state, while `pre_work_failed` is a visible recovery state.
There is no completion workflow unless it is later requested.

### Core transition rules

1. **Create task:** create `routing` with one persisted routing attempt and an
   audit event.
2. **Automated result:** when a successful attempt becomes due, atomically make
   an `offered` assignment only if the task remains `routing` and the attempt
   remains pending.
3. **No response:** an attempt created with `outcome = no_response` and a
   selected contributor is not marked failed. At its persisted `warning_at`
   (25 seconds after creation), change the task from `routing` to
   `no_response_warning`, leave `completed_at` null, and write an audit event.
   It emits no error and does not self-retry. The operator may assign manually
   or explicitly retry. While the attempt remains `pending`, the dashboard shows neutral waiting text and elapsed time. It does not display the stored outcome, the preselected contributor, or a no-match result.
3a. **No match:** an attempt with no selected contributor becomes
   `recovery_required` when its `due_at` arrives. That outcome is `success`
   in storage because no silence was simulated. It is not a no-response warning.
4. **Manual assignment:** from `routing`, `no_response_warning`,
   `offered`, `pre_work_failed`, or `recovery_required`, create an `offered`
   assignment and cancel/supersede every active routing attempt.
5. **Accept:** only the currently offered contributor may accept. Move to
   `accepted`, set `accepted_at`, and cancel/supersede any residual active
   routing attempts in the same transaction. No future automatic route is
   permitted from `accepted`.
6. **Decline:** only the currently offered contributor may decline. Record the
   decline, clear the active assignment, and move to `recovery_required`.
   The operator may explicitly start a new automated attempt or make another
   manual offer. The declined contributor is excluded from that retry.
7. **Pre-work failure:** only an accepted contributor may report it. Move to
   `pre_work_failed`; the operator can explicitly retry routing or make a
   manual offer. This preserves the original acceptance and failure in audit
   history.

`routing` and `no_response_warning` are the only states that represent
automatic routing activity. `no_response_warning` is intentionally unresolved,
not a failure state.

## SQLite schema

All timestamps are UTC ISO-8601 text. SQLite foreign keys and WAL mode are
enabled. JSON detail values are stored as text.

```sql
CREATE TABLE contributors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  expertise TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  required_expertise TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'routing', 'no_response_warning', 'offered', 'accepted',
    'pre_work_failed', 'recovery_required'
  )),
  version INTEGER NOT NULL DEFAULT 1,
  active_assignment_id TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  contributor_id TEXT NOT NULL REFERENCES contributors(id),
  source TEXT NOT NULL CHECK (source IN ('automation', 'human')),
  status TEXT NOT NULL CHECK (status IN (
    'offered', 'accepted', 'declined', 'pre_work_failed', 'superseded'
  )),
  offered_at TEXT NOT NULL,
  responded_at TEXT,
  response_note TEXT
);

CREATE TABLE routing_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'completed', 'no_response', 'superseded', 'cancelled'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'no_response')),
  due_at TEXT NOT NULL,
  warning_at TEXT,
  selected_contributor_id TEXT REFERENCES contributors(id),
  task_version_at_creation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('system', 'operator', 'contributor')),
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX routing_attempts_due_idx
  ON routing_attempts (status, due_at);
CREATE INDEX assignments_task_idx ON assignments (task_id, offered_at);
CREATE INDEX audit_events_task_idx ON audit_events (task_id, created_at);
```

### Schema Integrity

Assignment consistency is enforced through transactional state transitions, task-version checks, and a partial unique index that prevents multiple active offers or accepted assignments for the same task.

The schema above documents the intended data model. The executable database initialization in `server/src/database.ts` is the authoritative source for the implemented schema and constraints.
For a minimal first migration, validating it transactionally in application code is acceptable.

## Persisted routing and concurrency guarantees

When an attempt is created, the server chooses and writes `outcome`, `due_at`,
`warning_at` (for no-response), `selected_contributor_id` when someone
matches, and the task version in one transaction. Restarting reads these
fields; it never rerolls the delay, outcome, or contributor.

A lightweight periodic worker and a startup recovery pass process due records.
They do not use process-local `setTimeout` as the source of truth.

Every state-changing endpoint uses a SQLite transaction and conditional update
against both current task status and `version`. It increments `version` and
appends an audit event in the same transaction. The router can only complete a
matching pending success attempt when the task is still `routing` at the
attempt's creation version. Manual offers, acceptance, decline, and failure
supersede/cancel active attempts as appropriate. A delayed worker that loses
the race updates zero rows, records an ignored/superseded audit event where
useful, and cannot overwrite a human decision or acceptance.

## Decisions recorded in the implementation

1. **Warning delay:** `warning_at` is 25 seconds after the attempt is created,
   not the 5–20 second `due_at`.
2. **Manual reassignment:** an operator may replace an outstanding offer. The
   previous offer becomes `superseded`. An accepted assignment cannot be
   replaced through the normal workflow.
3. **Retry policy:** decline, pre-work failure, no-response, and no-match do
   not start another attempt by themselves. An explicit retry excludes every
   contributor who declined or failed before work on that task. Manual
   assignment can still select those people.
4. **Expertise matching:** one normalized expertise tag, matched exactly.
   There are no proficiency levels or capacity limits.

## Engineering Risks and Mitigations

The implementation focuses on failures that could compromise assignment consistency.

| Risk | Mitigation | Verification |
|---|---|---|
| A delayed automated result overwrites a human assignment | Transactional task-version checks and routing supersession | Integration tests for late results and manual overrides |
| Concurrent operations create conflicting assignments | SQLite transactions and a partial unique index for active assignments | Concurrency and repeated-request tests |
| A backend restart loses pending routing work | Persisted routing outcomes and timestamps, plus startup recovery sweeps | Restart and repeated-sweep tests |
| A request without a response is incorrectly marked as failed | Separate unresolved warning state and explicit operator recovery | No-response routing tests |
| A stale frontend action changes newer server state | Version-aware mutations returning HTTP 409 | API tests and browser conflict handling |
| Routing fails to find an eligible contributor | Transition to `recovery_required` rather than an unresolved no-response warning | API and integration checks |

The main design principle is to enforce assignment consistency in the backend rather than relying on frontend state or timing assumptions.

These safeguards are intended for the implemented single-process architecture; they are not guarantees of distributed-system behavior.

## Implementation Milestones & Verification

Development was organized into small, independently reviewable milestones.

| Milestone | Deliverable | Status |
|---|---|---|
| 1. Backend foundation | Express API, SQLite persistence, task creation, contributor seed data, audit records | Implemented |
| 2. Automatic routing | Persisted routing attempts, simulated delays, no-response handling, startup recovery | Implemented |
| 3. Human intervention | Manual overrides, acceptance, decline, pre-work failure, explicit recovery | Implemented |
| 4. Operator dashboard | React UI, task actions, polling, audit timeline, HTTP 409 handling | Implemented |
| 5. Verification and handoff | Automated checks, manual QA, documentation, walkthrough preparation | Ready for final commit |

### Verification Performed

The following checks were executed successfully on November 7, 2026:

- Backend TypeScript: `npm run typecheck` on Node.js 20.20.0 and 22.23.4
- Backend API and intervention tests: `npm test` on Node.js 20.20.0 and 22.23.4
- Frontend production build: `npm run build` on Node.js 20.20.0
- Frontend lint: `npm run lint` on Node.js 20.20.0, with no diagnostic output
- Frontend checks: `npx tsx tests/status-notice.test.ts`, `npx tsx tests/connection-status.test.ts`, and `npx tsx tests/routing-attempt-label.test.ts`
- Git whitespace check: `git diff --check`

The backend tests use Node.js assertions and report successful completion per script rather than a numerical test count.

Manual end-to-end results are maintained separately in [QA_CHECKLIST.md](QA_CHECKLIST.md). Automated checks are not presented as a substitute for browser-based verification.

### Implementation Corrections

During development and integration, several important adjustments were made:

1. **No-response semantics:** Unresolved routing attempts remain distinct from confirmed failures.
2. **Assignment acceptance:** Offers and accepted assignments use separate lifecycle states.
3. **Restart consistency:** Routing outcomes and due times are persisted instead of regenerated after a restart.
4. **No-match handling:** Routing attempts with no eligible contributor transition to `recovery_required`, rather than incorrectly displaying a no-response warning.
5. **Runtime compatibility:** The implementation uses `sqlite3` and was verified with Node.js 20.20.0 and 22.23.4.

These changes were informed by architectural review, implementation feedback, and integration testing.
