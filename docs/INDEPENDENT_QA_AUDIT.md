# TaskFlow — Independent Engineering QA Audit

**Date:** 2026-11-07
**Scope reviewed:** working tree of `taskflow-assignment` (Milestones 1–4)
**Reviewer stance:** independent of prior implementation notes and of the developer’s manual QA record
**Recommendation:** **READY WITH LIMITATIONS**

This is an assessment-scope conclusion. It is not a production-readiness claim.

## 1. Executive summary

No confirmed defect threatens assignment integrity, duplicate active assignments, optimistic concurrency, no-response handling, or restart recovery.

The backend state machine matches the plan. Transactions, the task version, and the partial unique index `assignments_one_active_idx` keep a task to one active (`offered` or `accepted`) assignment. Isolated probes, including 25 concurrent manual-assignment versus worker races and 20 concurrent decline versus replace races, stayed consistent. The project’s own API and intervention tests passed when re-run.

One medium defect is confirmed: the dashboard describes a routing attempt’s stored simulation outcome while that attempt is still pending. Several low defects affect error copy, detail-load failures, and audit-note display.

**Remediation 2026-11-07:** That medium finding was corrected in the client after the audit. The original write-up in section 4 is unchanged. A pending attempt now shows “Awaiting routing response.” and elapsed time. The stored outcome, selected contributor, no-match sentence, and warning time are shown only after the worker has applied the attempt (`completed` or `no_response`). The regression test is `client/tests/routing-attempt-label.test.ts`.

Several low defects remain: error copy, detail-load failures, and audit-note display. Frontend checks exercise formatting helpers, not the React dashboard component.

The developer’s live SQLite database was opened read-only and was not modified. It contained no duplicate active assignments and no dangling `active_assignment_id`.

## 2. Scope and methodology

Reviewed the current sources, not prior agent summaries:

- `server/src/app.ts`, `database.ts`, `routing-worker.ts`, `transitions.ts`, `server.ts`
- `server/tests/api.test.ts`, `server/tests/intervention.test.ts`
- `client/src/App.tsx`, `api.ts`, `format.ts`
- `client/tests/status-notice.test.ts`, `client/tests/connection-status.test.ts`
- Root, server, and client READMEs, `docs/PLAN.md`, `docs/DEMO.md`, and `docs/QA_CHECKLIST.md` (read only)

`docs/QA_CHECKLIST.md`, `docs/PLAN.md`, and existing reports were not modified. Application code was not modified. Passing tests were not treated as proof; assertions were read and the critical gaps were reproduced on temporary databases.

The live file `data/taskflow.sqlite` was queried with `mode=ro` only. Probes used `mkdtemp` databases under the system temp directory and deleted them afterward.

Manual scenarios QA-01 through QA-08 were not repeated in a browser. UI findings below come from the implementation and from API probes.

The working tree already had uncommitted edits in `client/README.md` and `docs/PLAN.md`. Those edits were reviewed as part of the tree and were not changed.

## 3. Commands executed and results

Runtime: Node.js v20.20.0. Node.js 22.23.4 was not re-run in this audit.

| Command | Result |
| --- | --- |
| `server`: `npm run typecheck` | Exit 0 |
| `server`: `npm test` (`tsx tests/api.test.ts` then `tsx tests/intervention.test.ts`) | Exit 0. Printed `API and routing tests passed.` and `Intervention tests passed.` |
| `client`: `npm run lint` (`oxlint`) | Exit 0. No diagnostic output |
| `client`: `npm run build` (`tsc -b && vite build`) | Exit 0. Vite reported a production build in 9.48s |
| `client`: `tsx tests/status-notice.test.ts` | Exit 0. `Status notice checks passed.` |
| `client`: `tsx tests/connection-status.test.ts` | Exit 0. `Connection status checks passed.` |
| `git status --short`, `git check-ignore`, `git ls-files` | See section 5 |
| Read-only queries against `data/taskflow.sqlite` | No integrity violations found. See below |
| Isolated probes in `/tmp` (not part of the repo) | See below |

The frontend package has no `npm test` script (`client/package.json`). The two frontend scripts were run directly with `tsx`.

### Live database, read-only

`journal_mode` is `wal`. `assignments_one_active_idx` is present. Task counts: 3 `accepted`, 5 `offered`, 3 `no_response_warning`, 1 `pre_work_failed`, 9 `recovery_required`. Pending routing attempts: 0.

No task had more than one `offered`/`accepted` assignment. No `offered` or `accepted` task pointed at a missing or wrong-status assignment. No `routing` task had `active_assignment_id` set. The unresolved `no_response_warning` rows have `completed_at` null and no active assignment, which matches the design.

A CLI session reported `foreign_keys = 0` because the `sqlite3` CLI does not run the application pragma. An application connection created by `initializeDatabase` reported `foreign_keys = 1` and `journal_mode = wal`.

### Isolated probes

All of these used a fresh database, not `data/taskflow.sqlite`.

- Inserting a second active assignment (`offered` plus `accepted`) failed with `SQLITE_CONSTRAINT: UNIQUE constraint failed: assignments.task_id`.
- A `healthcare` task stored `outcome = success`, `selected_contributor_id = null`, and snake_case `due_at`. After a sweep at `due_at`, the task was `recovery_required`, with no assignment and audit event `routing_no_eligible_contributor`. A second sweep did not add an assignment.
- A pending `no_response` attempt was still `routing` / `pending` at `due_at`. At `warning_at` it became `no_response_warning`, attempt status `no_response`, `completed_at` null, and zero assignments. The immediate second sweep did not create an assignment.
- An `accepted` task with a still-pending attempt whose `task_version_at_creation` equalled the current task version stayed `accepted`. The stray attempt became `superseded`. Audit recorded `routing_result_ignored`. The version did not change. One accepted assignment remained.
- Wrong-contributor pre-work failure returned HTTP 409 `invalid_assignment` and left the task `accepted`.
- 25 concurrent manual-assign versus due-worker races: 24 human wins (HTTP 201, surviving source `human`), 1 automation win (HTTP 409, surviving source `automation`), 0 inconsistent rows. Each task ended `offered`, with one active assignment and no pending attempt.
- 20 concurrent decline versus replace races: 0 inconsistent results. The winner was either decline (`recovery_required`, no active assignment, replace HTTP 409) or replace (`offered`, the new row active, decline HTTP 409).
- Malformed JSON `POST /api/tasks` with body `{` returned HTTP 400, code `internal_error`, message `Expected property name or '}' in JSON at position 1`.
- After pre-work failure, the assignment `responseNote` was the failure note. The acceptance note remained on the `assignment_accepted` audit event. `acceptedAt` was still set. The following retry returned `acceptedAt: null` and a snake_case `routingAttempt`.

## 4. Confirmed defects

### Medium — Pending routing cards state the outcome before the worker applies it

**Evidence:** `client/src/format.ts:164-168`, rendered for every attempt at `client/src/App.tsx:395-401`. The outcome is chosen when the attempt is inserted (`server/src/transitions.ts:235-249`) and is returned immediately by `GET /api/tasks/:taskId`.

**Reproduction:**

1. Create a task whose expertise matches a seeded contributor.
2. Open it before `due_at` (success) or before `warning_at` (no-response).
3. Read the Routing card.

**Expected:** A pending attempt is described as not yet applied. “Match saved” appears only after an offer exists. No-response copy appears when the task enters `no_response_warning`.

**Actual:** While `attempt.status` is still `pending` and the task is still `routing`, the card already says one of:

- `Match saved for {name}.`
- `No response from {name}. This is not a failure.`
- `No matching contributor was available.`

The status badge can still say Routing, and Retry stays disabled while the attempt is pending. For a no-match task, both Assign and Retry are disabled until `due_at`, while the card already announces that nobody matched.

**Recommended fix:** Base the label on attempt status. For `pending`, say the attempt is still waiting. Show the final outcome sentence only after the worker, or an operator action, has resolved that attempt.

#### Remediation note — 2026-11-07

The finding above is unchanged. The client was then updated, without changes to the simulator, schema, routing worker, or state transitions.

`routingAttemptLines` in `client/src/format.ts` now decides what a routing card may show:

- `pending`: “Awaiting routing response.” and `Elapsed {age}` only. The stored outcome, contributor, no-match sentence, due time, and warning time are omitted. Task age on the queue and the in-progress routing callout stay as they were.
- `completed` or `no_response`: the previous outcome sentence, due time, and, for an applied no-response warning, the warning time.
- `superseded` or `cancelled`: no stored outcome. Those rows do not record whether the worker had already applied a result, so the card does not guess.

`client/src/App.tsx` renders that helper. `client/tests/routing-attempt-label.test.ts` locks the pending versus applied text.

Verification on 2026-11-07, Node.js v20.20.0, from `client`:

| Command | Result |
| --- | --- |
| `tsx tests/routing-attempt-label.test.ts` | Exit 0. `Routing attempt label checks passed.` |
| `tsx tests/status-notice.test.ts` | Exit 0. `Status notice checks passed.` |
| `tsx tests/connection-status.test.ts` | Exit 0. `Connection status checks passed.` |
| `npm run lint` | Exit 0. No diagnostic output |
| `npm run build` | Exit 0. Vite production build completed |

A temporary API on port 3011 and Vite on port 5174 used `/tmp/taskflow-label-ui/taskflow.sqlite`, not `data/taskflow.sqlite`. A pending `no_response` attempt for Ada Lovelace rendered `Waiting / Awaiting routing response. / Elapsed 34m`. The card did not name Ada, a due time, or a warning. After that isolated row was marked `no_response`, the same card rendered `Unresolved / No response from Ada Lovelace. This is not a failure.` plus the due and warning times, and the existing no-response callout.

The other findings in this report were not part of this change. The recommendation remains **READY WITH LIMITATIONS**.

### Low — Every HTTP 409 is presented as a stale-version conflict

**Evidence:** `client/src/App.tsx:218-232`. The server uses 409 for `conflict`, `invalid_transition`, and `invalid_assignment` (`server/src/transitions.ts:104-123` and `302-307`).

**Reproduction:** From the dashboard this is uncommon, because illegal actions are disabled and the client sends the active contributor id. It is reachable if a current-version request fails a business rule, for example assigning an ineligible contributor or retrying while a pending attempt already exists. The API returns 409 with a specific message. The dashboard replaces that message.

**Expected:** `conflict` refreshes and asks the operator to review the new version. `invalid_assignment` and other 409 codes show the server message.

**Actual:** Any 409 shows “This task changed on the server. The latest state is shown below.” The refresh itself is appropriate. The copy is not, when the version was current and the action was rejected for another reason.

**Recommended fix:** Treat `error.code === "conflict"` as the reload case. For other 409 codes, show `error.message` after refreshing.

### Low — A failed detail load stays on “Loading task…”

**Evidence:** `client/src/App.tsx:145-152` ignores a failed `getTask` except when `lostConnection` is true. `client/src/App.tsx:361` renders “Loading task…” whenever a task is selected and `detail.task.id` does not match.

**Reproduction:** Select a task whose detail request fails. A network failure sets the connection badge to Disconnected, and the next successful poll can recover. A non-connection failure, such as HTTP 404, is swallowed.

**Expected:** The detail pane shows an error and a way to retry.

**Actual:** The pane remains “Loading task…” until some later successful `getTask`. There is no delete API, so 404 is not a normal operator path.

**Recommended fix:** If the in-flight detail request fails and is still the current request, store an error for that task id and render it instead of the loading sentence.

### Low — Server and client disagree about what a failed request means

**Evidence:**

- Malformed JSON is passed through the generic handler (`server/src/app.ts:274-294`). Probe result: HTTP 400, code `internal_error`, raw parser text.
- `client/src/format.ts:124-126` treats every status `>= 500` as a connection failure. `client/src/App.tsx:215-217` then says “The server could not be reached.”

**Expected:** Malformed JSON is HTTP 400 `validation_error` with a stable message. An HTTP 500 from a live server is an application error. Connection loss stays status 0, or a gateway status if that is the intended signal.

**Actual:** Parser failures are labeled `internal_error`. HTTP 500 is shown as a disconnect, and the connection badge leaves “Up to date”.

**Recommended fix:** Map JSON parse errors to 400 `validation_error`. In the client, treat only `status === 0` (and, if desired, 502/503/504) as connectivity loss.

### Low — The acceptance note disappears from the operator UI after pre-work failure

**Evidence:** `server/src/transitions.ts:440-451` overwrites `assignments.response_note` and `responded_at` on accept, decline, and failure. `client/src/format.ts:94-98` renders the audit label and contributor name only.

**Reproduction:** Accept with a note, then report pre-work failure with a different note. Confirmed on a temporary database: the assignment note became the failure note; `audit_events.details_json` for `assignment_accepted` still held the acceptance note.

**Expected:** Both notes remain visible. The plan says acceptance and failure stay in the audit history.

**Actual:** The audit row keeps the acceptance note. The dashboard history does not show `details.responseNote`, and the assignment card shows only the latest note.

**Recommended fix:** Include `details.responseNote` in the history line. No schema change is required.

## 5. Security and Git hygiene

No credential, token, or private key was found in tracked source. `server/.env.example` contains only `PORT` and `DATABASE_PATH`. No `.env` file is present. `git ls-files` shows no SQLite database and no `.env` other than the example.

Ignored and untracked, as required:

- `data/taskflow.sqlite`
- `data/taskflow.sqlite-wal`
- `data/taskflow.sqlite-shm`

`client/dist` from the production build is ignored by `client/.gitignore`.

Gaps, all low:

- Rollback journals are not ignored. `data/*.sqlite-journal` does not match a `git check-ignore` rule. WAL mode makes a rollback journal unlikely for the default file.
- Ignore rules are rooted at `data/`. A `DATABASE_PATH` outside `data/` would not match the root patterns. `server/.gitignore` covers `server/data/*.sqlite` only.
- `git status --short` shows pre-existing uncommitted edits in `client/README.md` and `docs/PLAN.md`. Both diffs end without a trailing newline. They are documentation only.

Security posture of the running API, proportionate to the stated no-auth assessment:

- `server/src/app.ts:74` uses open CORS.
- `server/src/server.ts:19` calls `app.listen(port)` without a host, so Node accepts connections on the unspecified address.
- There is no authentication. Any client that can reach the port can create tasks and record accept, decline, or failure.

That matches the documented limitation. It is not safe to expose this process beyond a local demo.

SQL predicates in the reviewed routes use bound parameters. HTTP 500 responses hide the internal message and log it on the server. The malformed-JSON path is the exception noted above: the parser text is returned to the client.

## 6. Remaining risks and coverage limitations

These were not observed as durable data corruption.

**Suspected, not reproduced.** `withTransaction` serializes writers on one connection (`server/src/database.ts:89-123`), but `GET` handlers call the same connection outside that queue. A read submitted between two statements of an open transaction can observe uncommitted rows. The write paths commit task, assignment, attempt, and audit changes together, and the cross-connection races above stayed consistent. Impact, if it occurs, is a transient dirty read, not a committed duplicate assignment.

**Suspected, not reproduced.** `client/src/App.tsx:166-178` holds `monitorLock` until the in-flight poll settles, and `fetch` has no timeout. A request that never completes would stop later polls. A normal failure releases the lock in `finally`.

**Accepted limitation, confirmed in code.** Polling reloads tasks only while some task is `routing`, or while the connection is not `current` (`client/src/App.tsx:160-169`). After every task leaves `routing`, another client’s accept, decline, or manual assign is not pulled until a local action, a new routing task, or a reconnect. The root README and the client README describe this. Disconnect detection waits for the next 1.5s tick.

**Single process.** Two Node processes can write one database. `BEGIN IMMEDIATE`, `busy_timeout = 5000`, and the unique index are the cross-process controls. The implementation is not a distributed worker. A unique-index failure would surface as HTTP 500, because SQLite errors have no `status`. The version check normally returns 409 before that backstop is hit.

**Shutdown.** `server/src/server.ts:23-28` clears the interval and closes SQLite from the HTTP `close` callback without awaiting an in-flight sweep. The next open recovers the WAL file. This was not exercised as a crash test.

**Test gaps and false-positive risks:**

- `server/tests/api.test.ts:318-324` calls `sweep()` twice on one worker via `Promise.all`. `RoutingWorker.sweep` returns immediately when `sweeping` is already true (`server/src/routing-worker.ts:28-30`), so those two calls do not overlap `process()`. The later `sweep()` and the separate two-connection test are what cover duplicate offers. The end-state assertion would still fail if two offers were committed.
- `server/tests/intervention.test.ts:900-909` allows the manual request to finish as either 201 or 409 and does not assert that the surviving assignment source matches the winner. The 25-race probe in this audit did assert that, and found no mismatch.
- No test names `assignments_one_active_idx`. Sequential version conflicts can pass with only the version check. Direct SQL in this audit confirmed the index rejects a second active row.
- The same-version status guard (accepted task, pending attempt stamped with the current version) is not what `lateAutomaticResult` inserts; that test uses creation version 1 after the version has moved. This audit’s probe covered the equal-version case.
- Frontend tests cover pure helpers only. They do not import `App.tsx`, so a regression in polling, 409 handling, or API parsing would not fail those scripts. `npm test` is not wired for the client. No CI workflow is present.
- The suite reports completion text, not a count. That is accurate, and it makes a skipped assertion less obvious than a failed numbered test.

Areas inspected and not found defective: create-task normalization; manual assign, replace, accept, decline, and pre-work failure guards; exclusion of declined and pre-work-failed contributors from retry only; no-match versus no-response; warning delay of 25s versus the 5–20s due time; restart sweep idempotence as asserted by the executed tests; client parsing of both snake_case and camelCase attempt fields (`client/src/api.ts:164-181`).

## 7. Documentation inconsistencies

- Root `README.md` still says manual QA is partially complete and that decline, pre-work failure, no-response, restart, and duplicate prevention remain open (`README.md` around the verification table and the “Manual QA” section). `docs/QA_CHECKLIST.md` marks QA-01 through QA-08 PASS. The checklist’s own limits are narrower: QA-06 did not time the 25-second warning, and QA-08 was a repeated request rather than a simultaneous race. This audit’s probes cover those two limits and agree with the implementation.
- `server/README.md` implementation table still says the React dashboard is “In progress” and final end-to-end verification is “Pending”. The client is implemented, and the checklist records browser passes.
- Root `README.md` lists the status-notice check as “Passed - manually executed” and does not mention `client/tests/connection-status.test.ts`. Both files are automated scripts. The uncommitted `client/README.md` documents both and states that `npm test` is not defined.
- `GET /api/tasks/:taskId` selects routing-attempt columns in snake_case (`server/src/app.ts:180-182`). `POST /api/tasks/:taskId/routing` returns the in-memory attempt the same way (`server/src/app.ts:266`). Tasks and assignments are camelCase. `server/README.md` states this naming split. The client tolerates both spellings and does not read `routingAttempt` from the retry response. The root README does not mention the split.
- `server/README.md`’s audit list omits `task_created`. The route writes that event. The list is not presented as exhaustive.
- The committed plan allows `active_assignment_id` to be checked in application code instead of a foreign key. The schema has no foreign key on that column. Transactions set it in the same commit as the assignment insert. That is consistent with the plan, not a drift bug. The uncommitted plan text says the same thing in different words.

`docs/DEMO.md` is a walkthrough outline. It does not contradict the state machine.

**Documentation follow-up 2026-11-07:** The status sentences in the first three bullets were corrected in the root README, `server/README.md`, `client/README.md`, and `docs/PLAN.md`. Those bullets remain as the audit’s original findings. `task_created` was added to the server README event list. Routing-attempt JSON remains snake_case, as that README already says. `docs/QA_CHECKLIST.md` was not modified. The pending-routing-label remediation in section 4 is unchanged.

## 8. Final recommendation

**READY WITH LIMITATIONS**

For the assessment’s single-process, single-operator scope, the assignment invariants held under code review, the re-run test suite, read-only inspection of the existing database, and isolated race and recovery probes. Nothing confirmed in this audit breaks task, attempt, or assignment transitions, HTTP 409 version checks, duplicate-active prevention, no-response versus no-match handling, contributor recovery, or SQLite restart behavior.

Do not describe the system as production-ready. It has no authentication, binds beyond localhost, uses one process and one SQLite file, and polls task state only while routing is active. The pending-attempt copy can mislead an operator before the worker applies a result. README status sections do not match the checklist.

**Follow-up 2026-11-07:** The pending-attempt sentence above is the original finding. Section 4 records the client fix and `client/tests/routing-attempt-label.test.ts`. The README status mismatch was corrected in the documentation pass described in section 7. The other limitations in this report remain.

No application fix was made. Fixes should wait for approval. The smallest useful code change is the pending-attempt label in `client/src/format.ts`. The other confirmed items are copy, error mapping, and documentation updates.

That closing instruction is the audit’s original stop point. The pending-label change was made afterward and is recorded in section 4. The documentation consistency pass did not change application code again.
