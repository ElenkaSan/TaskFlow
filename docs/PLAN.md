# TaskFlow implementation plan

## Scope

TaskFlow is a small task-assignment system. A newly created task is routed to
an eligible contributor by expertise. While automatic routing is pending, an
operator may assign a contributor manually. Routing is deliberately simulated
with a persisted delay of 5–20 seconds; twenty percent of attempts are
persisted as no-response attempts.

The implementation stays deliberately small: React client, Express JSON API,
SQLite, and client polling while a task has active routing or is awaiting a
contributor response. There is no authentication, real queue, or websocket
layer for this assessment.

## Revised task state model

`task.status` represents the current task lifecycle. Assignment response is
stored separately so that an assignment is never mistaken for acceptance.

| Status | Meaning | Allowed next states |
| --- | --- | --- |
| `routing` | An automatic routing attempt is pending. A human may manually assign. | `offered`, `no_response_warning` |
| `no_response_warning` | The current automated attempt was intentionally simulated to never respond. It remains unresolved; the UI shows a delayed operator warning. | `offered` (manual assignment only) |
| `offered` | A contributor has been selected, by automation or a human, and has not yet responded. | `accepted`, `routing`, `recovery_required` |
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
3. **No response:** an attempt created with `outcome = no_response` is never
   completed or failed. At its persisted `warning_at`, change the task from
   `routing` to `no_response_warning` and write an audit event. It emits no
   error and does not self-retry. A manual assignment may still move it to
   `offered`.
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

`active_assignment_id` should have a foreign-key constraint added after the
`assignments` table is created (or be validated by the transition service).
For a minimal first migration, validating it transactionally in application
code is acceptable.

## Persisted routing and concurrency guarantees

When an attempt is created, the server chooses and writes `outcome`, `due_at`,
`warning_at` (for no-response), `selected_contributor_id` (for success), and
the task version in one transaction. Restarting reads these fields; it never
rerolls the delay, outcome, or contributor.

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

## Remaining ambiguity to resolve

1. **Warning delay:** should the no-response warning appear at the 5–20 second
   due time, or after an additional fixed delay? This plan assumes a separate
   persisted `warning_at`, initially equal to `due_at` unless a product value
   is supplied.
2. **Manual reassignment from an outstanding offer:** this plan permits it and
   marks the old offer `superseded`; confirm whether an operator should instead
   be blocked until the contributor responds.
3. **Retry policy after decline/pre-work failure:** this plan requires an
   explicit operator action, avoids surprise loops, and excludes declined
   contributors only for the immediate retry. Confirm whether failure should
   also permanently exclude that contributor.
4. **Expertise matching:** this plan assumes exact matching of a single
   expertise tag. It needs confirmation if tasks/contributors require multiple
   tags, proficiency levels, or capacity limits.

## Implementation order after approval

1. Add server runtime/configuration, migrations, seed contributors, and task
   read/create APIs.
2. Build the routing-attempt scheduler and startup recovery sweep.
3. Add offers plus accept, decline, pre-work failure, manual intervention, and
   audit APIs with integration tests for races and restarts.
4. Replace the Vite demo with creation, task-detail, actions, warning, and
   audit UI using polling.
