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
│   ├── status-notice.test.ts         # Routing status message checks
│   ├── connection-status.test.ts     # API connection status checks
│   └── routing-attempt-label.test.ts # Pending versus applied routing labels
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

While an attempt is pending, its card says “Awaiting routing response.” and shows elapsed time. It does not show the stored simulation outcome, the preselected contributor, or a no-match result. Those details appear after the worker applies the attempt.

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

The dashboard polls approximately every 1.5 seconds while at least one task is in the `routing` state.

Polling updates task information without discarding the currently selected task.

Other states are refreshed following operator actions or when existing polling activity retrieves newer data.

### Optimistic Concurrency

Every state-changing request includes the task version last received from the backend.

If another action has already changed that task, the backend returns:

`HTTP 409 Conflict`

The dashboard then:

1. Refreshes the latest task details.
2. Displays a conflict message.
3. Asks the operator to review the updated state before retrying.

The frontend does not automatically repeat a conflicting mutation.

### Server-Confirmed Feedback

Success messages are displayed only after the backend confirms an operation.

The interface also provides loading, validation, empty, and error states.

## Responsive Design

The dashboard uses a two-column layout on larger screens and adapts to a single-column layout on narrow viewports.

The interface was checked at a 390px-wide mobile viewport during development.

The design prioritizes readable task information, clear status labels, accessible form controls, and straightforward operator actions over unnecessary visual complexity.

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

Run the standalone frontend checks:

```bash
npx tsx tests/status-notice.test.ts
npx tsx tests/connection-status.test.ts
npx tsx tests/routing-attempt-label.test.ts
```

The latest reported verification, on Node.js 20.20.0 on November 7, 2026, includes:

| Check | Result |
|---|---|
| TypeScript and Vite production build | Passed |
| Oxlint | Passed, with no diagnostic output |
| Connection status check | Passed |
| Status notice check | Passed |
| Routing attempt label check | Passed |
| Manual operator workflow testing | Recorded as passed in `docs/QA_CHECKLIST.md` |

The standalone test scripts are not currently registered under an `npm test` command.

Automated frontend checks do not replace browser-based end-to-end testing.

See the [Manual QA Checklist](../docs/QA_CHECKLIST.md) for scenario-level verification.

## Design Decisions and Limitations

- **Server-authoritative state:** Assignment decisions are enforced by the backend, not React state.
- **Polling over WebSockets:** Keeps the assessment implementation simple without additional real-time infrastructure.
- **Version-aware mutations:** Prevents stale frontend actions from silently overwriting newer decisions.
- **Explicit operator actions:** Recovery is initiated by the operator rather than silently triggered by the interface.
- **Simulated contributor responses:** The dashboard records accept, decline, and failure actions without contributor authentication.
- **Limited background refresh:** Polling primarily operates during active routing; changes made externally in other task states may require another refresh or interaction.

These tradeoffs reflect the project's focus on correctness, clarity, and maintainability within a time-boxed engineering assessment.

## Related Documentation

- [Main Project README](../README.md) — Project overview and engineering decisions
- [Backend Documentation](../server/README.md) — REST API, persistence, and state transitions
- [Engineering Plan](../docs/PLAN.md) — Architecture and implementation decisions
- [Manual QA Checklist](../docs/QA_CHECKLIST.md) — Test scenarios and results

---

The TaskFlow frontend demonstrates how a focused operator interface can make asynchronous routing understandable while preserving backend-enforced assignment consistency.
