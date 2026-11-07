# TaskFlow — Frontend

**React + TypeScript Operator Dashboard**

The frontend for TaskFlow provides a responsive interface for monitoring automated task routing, managing contributor assignments, and performing human intervention when routing is delayed or unsuccessful.

The dashboard is designed around one principle: **operators should understand the current task state and available actions without needing to understand the routing engine's internal implementation.**

## Technology Stack

| Component | Technology |
|---|---|
| UI | React |
| Language | TypeScript |
| Build Tool | Vite |
| Styling | CSS |
| API | Express REST API |
| State Synchronization | Polling and server-confirmed mutations |
| Linting | Oxlint |

## Project Structure

```text
client/
├── src/
│   ├── App.tsx                # Dashboard, task creation, and operator actions
│   ├── api.ts                 # API client, request handling, and types
│   ├── format.ts              # Formatting and status presentation
│   ├── index.css              # Responsive dashboard styles
│   └── main.tsx               # React entry point
│
├── tests/
│   ├── detail-load-state.test.ts     # Loading, failed, and snapshot rules
│   ├── routing-attempt-label.test.ts # Pending versus applied routing labels
│   ├── status-notice.test.ts         # Routing status message checks
│   └── connection-status.test.ts     # API connection status checks
│
├── public/                    # Static assets
├── index.html                 # HTML entry point
├── vite.config.ts             # Vite configuration and development proxy
├── package.json               # Dependencies and scripts
└── README.md                  # Frontend documentation
```

## Operator Workflows

The dashboard supports the following workflows.

### Task Monitoring

Operators can view:

- Task title and required expertise
- Time since task creation
- Current routing or assignment status
- Assigned contributor, when available
- Summary counts for task states

Summary cards also support filtering the assignment queue.

### Task Creation

Operators can create a task with a title, description, and required expertise.

Submitting the form sends a request to the backend, which creates the task and its initial persisted routing attempt.

The dashboard displays the server-confirmed result.

### Automated Routing

The interface distinguishes between:

- **Routing:** The automated request is pending.
- **Offered:** A contributor has been selected but has not accepted.
- **Accepted:** The contributor has accepted the assignment.
- **No response warning:** The routing request remains unresolved.
- **Recovery required:** Automatic routing could not produce a valid assignment, or a contributor declined.
- **Pre-work failed:** An accepted assignment failed before work began.

A delayed routing request is not incorrectly presented as a confirmed failure.

While an attempt is pending, its card says “Awaiting routing response.” and shows elapsed time, for example `Elapsed Just now` or `Elapsed 10m`. It does not show the stored simulation outcome, the preselected contributor, a due time, or a warning time. Those details appear after the worker applies the attempt (`completed` or `no_response`). Superseded and cancelled attempts do not display a stored outcome.

### Human Intervention

Depending on the current task state, operators can:

- Manually assign an eligible contributor.
- Replace an outstanding offer.
- Record acceptance or decline.
- Report a pre-work failure.
- Explicitly retry routing.
- Review assignment and routing history.

Actions that are invalid for the current task state are disabled.

## API Integration and State Synchronization

The frontend communicates with the Express backend through REST endpoints.

During local development, Vite proxies `/api` requests to:

`http://127.0.0.1:3001`

The backend remains the authoritative source of task and assignment state.

### Polling

The dashboard polls about every 1.5 seconds.

- If any task is `routing`, or the connection is not current, the poll reloads the task list and the selected task’s details.
- Otherwise it calls `GET /api/health`.
- A poll does not start while another poll or an operator action is in flight.
- Selecting a task is preserved across a successful refresh. If that task is no longer in the list, the selection is cleared.

After every task leaves `routing` and the badge is **Up to date**, a change made by another client is not pulled until a local action, a new routing task, or a reconnect. `fetch` has no timeout. A request that never completes would hold the poll lock until it settles. That case was not reproduced.

### Connection badge

| State | Label |
|---|---|
| Current | Up to date |
| Disconnected | Disconnected |
| Reconnecting | Reconnecting |
| Before the first result | No label |

A failed poll or action moves the badge to **Disconnected**. The next poll shows **Reconnecting** while it retries. Success returns to **Up to date**.

Status `0` and every status of `500` or higher are treated as connection failures. The action notice then says “The server could not be reached.” An HTTP 500 from a live server is therefore shown as a disconnect. That is a known limitation. HTTP 404 is not a connection failure.

### Task details

The detail pane has four states:

- **Empty:** nothing is selected. The pane says to select a task.
- **Loading:** a task is selected and there is no successful snapshot for it. The pane says “Loading task…”.
- **Ready:** the selected task’s latest request succeeded. The pane shows that task.
- **Failed:** the selected task’s latest request failed. The pane shows the error and **Try again**.

**Try again** reloads that task’s details. It does not reload the whole page. If the task list itself fails to load, a separate **Try again** reloads the page.

A successful snapshot stays on screen while the same task is refreshed. If that refresh fails, the snapshot is kept in memory and is not presented as the current detail. Switching to another task does not show the previous task as the new selection. A response for a task the operator is no longer viewing is ignored.

### Optimistic concurrency and other errors

Every state-changing request includes the task version last received from the backend.

If the backend returns HTTP 409, the dashboard:

1. Refreshes the latest task details.
2. Shows “This task changed on the server. The latest state is shown below. Review it before trying again.”
3. Does not repeat the mutation.

That same message is used for every HTTP 409, including `invalid_assignment` and `invalid_transition`, not only a stale version. The refresh is still appropriate. The copy is an accepted limitation.

Other failed actions show the server message. Success messages appear only after the backend confirms the operation.

## Layout

The dashboard uses a two-column layout and switches to one column at a viewport width of `900px` or less (`client/src/index.css`).

The design prioritizes readable task information, clear status labels, accessible form controls, and straightforward operator actions.

## Local Development

### Prerequisites

- Node.js and npm
- TaskFlow Express backend

### Start the Backend

From the repository root:

```bash
cd server
npm install
npm run dev
```

### Start the Frontend

In a separate terminal:

```bash
cd client
npm install
npm run dev
```

Open:

`http://localhost:5173`

The backend should be running on port `3001` for the default development proxy.

For an API hosted at another origin, set `VITE_API_BASE` before starting the dev server or building the frontend.

## Build and Verification

Run the production build:

```bash
npm run build
```

Run lint checks:

```bash
npm run lint
```

Run the standalone frontend checks with the server’s `tsx` binary. `client/package.json` does not define `npm test` and does not depend on `tsx`.

```bash
../server/node_modules/.bin/tsx tests/detail-load-state.test.ts
../server/node_modules/.bin/tsx tests/routing-attempt-label.test.ts
../server/node_modules/.bin/tsx tests/status-notice.test.ts
../server/node_modules/.bin/tsx tests/connection-status.test.ts
```

On November 7, 2026, Node.js 20.20.0, those four scripts, `npm run lint`, and `npm run build` exited 0. Oxlint printed no diagnostics. The Vite production build completed.

| Check | Result |
|---|---|
| TypeScript and Vite production build | Passed |
| Oxlint | Passed, with no diagnostic output |
| Detail-load state check | Passed |
| Routing attempt label check | Passed |
| Status notice check | Passed |
| Connection status check | Passed |
| Manual operator workflow testing | Recorded as passed in `docs/QA_CHECKLIST.md` |

These scripts test formatting and state helpers. They do not render `App.tsx`, so browser checks remain the record for polling, clicks, and API parsing.

See the [Manual QA Checklist](../docs/QA_CHECKLIST.md) for scenario-level verification.

## Design Decisions and Limitations

- **Server-authoritative state:** Assignment decisions are enforced by the backend, not React state.
- **Polling over WebSockets:** Keeps the assessment implementation simple without additional real-time infrastructure.
- **Version-aware mutations:** Prevents stale frontend actions from silently overwriting newer decisions.
- **Explicit operator actions:** Recovery is initiated by the operator rather than silently triggered by the interface.
- **Simulated contributor responses:** The dashboard records accept, decline, and failure actions without contributor authentication.
- **Limited background refresh:** After routing finishes and the connection is current, external changes are not polled until the next local action, routing task, or reconnect.
- **One HTTP 409 message:** Business-rule conflicts use the same operator copy as a stale version.
- **HTTP 500 as a disconnect:** A server error of status 500 or higher uses the connection-failure path.
- **Acceptance note in history:** History shows the event label and contributor. It does not show the note stored on the audit event. After pre-work failure, the assignment card shows the latest note only.

These tradeoffs reflect the project's focus on correctness, clarity, and maintainability within a time-boxed engineering assessment.

## Related Documentation

- [Main Project README](../README.md) — Project overview and engineering decisions
- [Backend Documentation](../server/README.md) — REST API, persistence, and state transitions
- [Engineering Plan](../docs/PLAN.md) — Architecture and implementation decisions
- [Manual QA Checklist](../docs/QA_CHECKLIST.md) — Test scenarios and results
- [Independent QA Audit](../docs/INDEPENDENT_QA_AUDIT.md) — READY WITH LIMITATIONS

---

The TaskFlow frontend demonstrates how a focused operator interface can make asynchronous routing understandable while preserving backend-enforced assignment consistency.
