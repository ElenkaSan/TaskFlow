# TaskFlow

**Human-in-the-Loop Task Assignment System**

TaskFlow is a full-stack application for automated task routing with human oversight, explicit recovery workflows, and persistent assignment history.

The central engineering challenge is ensuring that automated routing and human decisions remain consistent when responses are delayed, never arrive, or become outdated.

The system uses a database-backed routing state machine, transactional updates, optimistic concurrency control, and an operator dashboard to manage these scenarios safely.

## The Problem

Automated assignment systems operate under uncertainty.

A routing request may take several seconds, return no eligible contributor, or never respond. Meanwhile, an operator may need to intervene.

Without proper coordination, a late automated response could overwrite a human assignment, create conflicting offers, or leave a task in an inconsistent state.

**TaskFlow prioritizes assignment correctness, operator control, and clear recovery paths over algorithmic complexity.**

## Core Capabilities

- **Automated routing:** Matches tasks with contributors using normalized expertise tags.
- **Human intervention:** Allows manual assignment while routing is pending or delayed.
- **Assignment lifecycle:** Supports offers, acceptance, decline, and pre-work failure.
- **Explicit recovery:** Enables controlled retries and reassignment after unsuccessful outcomes.
- **Concurrency protection:** Prevents stale actions from overwriting newer decisions.
- **Persistent routing:** Preserves routing attempts and outcomes across backend restarts.
- **Audit history:** Tracks automated decisions, operator actions, and recovery events.
- **Operator dashboard:** Provides task monitoring, assignment controls, status updates, and history.

## Architecture

```text
       React + TypeScript Dashboard
                   |
                   v
             Express REST API
                   |
        +----------+----------+
        |                     |
 Task & Assignment      Background Routing
 State Transitions           Worker
        |                     |
        +----------+----------+
                   |
                   v
             SQLite Database
          WAL + Transactions
                   |
        Tasks / Contributors
        Assignments / Attempts
              Audit Events
```

The backend is the authoritative source of task and assignment state.

Routing attempts, simulation outcomes, and timestamps are persisted in SQLite. The worker processes pending attempts and reconciles outstanding work after server restarts.

The frontend communicates with the Express API and displays server-confirmed results. During active routing, it polls for updates instead of maintaining a WebSocket connection.

## Project Structure

```text
taskflow-assignment/
│
├── client/                          # React operator dashboard
│   ├── src/
│   │   ├── App.tsx                  # Dashboard and operator workflows
│   │   ├── api.ts                   # API client and response handling
│   │   ├── format.ts                # Display and status formatting
│   │   ├── index.css                # Application styles
│   │   └── main.tsx                 # React entry point
│   ├── tests/                       # Frontend checks
│   ├── public/                      # Static assets
│   ├── vite.config.ts               # Vite setup and development API proxy
│   └── README.md                    # Frontend documentation
│
├── server/                          # Express backend
│   ├── src/
│   │   ├── app.ts                   # API endpoints and validation
│   │   ├── server.ts                # Server and worker startup
│   │   ├── database.ts              # SQLite initialization and persistence
│   │   ├── routing-worker.ts        # Automatic routing and recovery sweeps
│   │   └── transitions.ts           # Transactional state transitions
│   ├── tests/
│   │   ├── api.test.ts              # API, routing, and persistence tests
│   │   └── intervention.test.ts     # Human intervention and recovery tests
│   └── README.md                    # Backend and API documentation
│
├── docs/
│   ├── PLAN.md                      # Architecture and engineering decisions
│   ├── QA_CHECKLIST.md              # Manual verification results
│   └── DEMO.md                      # Demonstration walkthrough
│
├── data/                             # Local SQLite data (gitignored)
├── .gitignore
└── README.md                         # Project overview
```

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React, TypeScript, Vite |
| Backend | Node.js, Express, TypeScript |
| Database | SQLite (`sqlite3`) |
| Testing | Node.js `assert`, API and integration tests, frontend checks |
| Version Control | Git |

Backend checks have passed on Node.js 20.20.0 and 22.23.4.

## Key Engineering Decisions

### 1. Human Decisions Take Precedence

Manual assignment supersedes outstanding automated routing attempts.

Task version checks and SQLite transactions ensure that a delayed routing response cannot overwrite a newer operator decision.

### 2. Unresolved Does Not Mean Failed

Approximately 20% of simulated routing requests never respond.

After 25 seconds, the system displays a warning without falsely classifying the request as a confirmed failure.

The operator can intervene or explicitly retry.

### 3. Assignment Integrity Is Enforced in the Database

Each task can have at most one active assignment.

Transactional state transitions and a partial unique index enforce this invariant.

Mutations require the latest task version. Stale requests return `HTTP 409 Conflict` rather than silently overwriting newer state.

### 4. Routing State Survives Restarts

Routing outcomes, due times, and task versions are stored before processing.

A background worker performs startup and periodic sweeps to reconcile pending attempts.

Repeated sweeps must not create duplicate offers or assignments.

### 5. Matching Is Explainable

Contributors are selected using normalized expertise tags.

The matching strategy avoids unnecessary scoring and ranking, keeping decisions predictable and testable.

### 6. Recovery Is Explicit

Declined assignments and pre-work failures require deliberate operator action.

Automatic retries exclude contributors who previously declined or failed for the same task, while manual assignment remains available.

## Running Locally

### Prerequisites

- Node.js (backend verified on versions 20.20.0 and 22.23.4)
- npm

### 1. Install and Start the Backend

From the repository root:

```bash
cd server
npm install
npm run dev
```

The default backend address is:

`http://localhost:3001`

Verify the API:

```bash
curl http://localhost:3001/api/health
```

### 2. Start the Frontend

Open a second terminal from the repository root:

```bash
cd client
npm install
npm run dev
```

Open the dashboard:

`http://localhost:5173`

Vite proxies `/api` requests to the local Express server during development.

For environments where the API runs on another origin, configure `VITE_API_BASE`.

## Testing & Verification

TaskFlow combines automated API checks, integration testing, and manual end-to-end verification.

| Verification | Result |
|---|---|
| Backend TypeScript checks | Passed |
| API and automatic routing tests | Passed |
| Human intervention integration tests | Passed |
| Frontend build and lint | Passed |
| Frontend status-notice check | Passed - manually executed |
| Manual end-to-end QA | Partially completed |

Frontend build, lint, connection-status checks, backend typecheck, and backend API/integration tests were executed successfully on November 7, 2026. Manual end-to-end QA is tracked separately and remains partially complete.

### Backend

From the `server` directory:

```bash
npm run typecheck
npm test
```

The backend test scripts cover routing outcomes, restart recovery, repeated worker sweeps, manual overrides, stale versions, acceptance, decline, and recovery.

### Frontend

From the `client` directory:

```bash
npm run build
npm run lint
```

Additional standalone frontend checks are maintained in `client/tests/`.

### Manual QA

The manual checklist covers operator workflows and frontend/backend integration.

Some scenarios remain open, including full verification of decline, pre-work failure, no-response warnings, restart behavior, and duplicate prevention through the UI.

See [Manual QA Checklist](docs/QA_CHECKLIST.md) for recorded results.

Automated success is not treated as proof of complete end-to-end coverage.

## Implementation Status

| Component | Status |
|---|---|
| Backend API and SQLite persistence | Implemented |
| Automated routing and restart recovery | Implemented |
| Human intervention and assignment recovery | Implemented |
| React operator dashboard | Implemented |
| Automated backend and frontend checks | Passed in reported runs |
| Final manual end-to-end QA | Partially completed |

## AI-Assisted Engineering Workflow

TaskFlow was developed using AI coding agents for architectural review, implementation, debugging, and verification.

Development was organized into focused milestones:

1. Backend foundation and SQLite persistence
2. Persisted automatic routing
3. Human intervention and recovery
4. Operator dashboard
5. Engineering review and final verification

The workflow included reviewing proposed designs, identifying edge cases, correcting implementation assumptions, and validating changes through automated and manual checks.

Key engineering decisions included:

- Preserving unresolved routing states instead of treating silence as failure.
- Separating assignment offers from accepted assignments.
- Persisting routing outcomes for restart consistency.
- Protecting human decisions with transactional version checks.
- Correcting no-match handling discovered during frontend integration.

AI-generated implementation was reviewed against the application requirements and test results rather than accepted as proof of correctness.

## Scope & Known Limitations

TaskFlow is an engineering assessment implementation, not a production-scale assignment platform.

The following tradeoffs are intentional:

- **No authentication:** Contributor responses are simulated through operator actions.
- **Single-process architecture:** The worker is not designed for distributed execution across multiple servers.
- **SQLite persistence:** Provides local durability without requiring external database infrastructure.
- **Optimistic concurrency:** Repeated mutations using stale task versions return HTTP 409 rather than replaying a prior success.
- **Polling:** The dashboard polls during active routing, while other states update following operator actions or existing refresh activity.
- **Simple expertise matching:** No recommendation model or contributor-ranking algorithm.
- **Explicit recovery:** Unresolved or unsuccessful routing does not automatically trigger retries.
- **Local-first deployment:** Production hosting and multi-tenant infrastructure are outside the assessment scope.

These limitations are documented to distinguish the implemented guarantees from production features requiring additional infrastructure.

## Documentation

- [Frontend Documentation](client/README.md)
- [Backend API & Architecture](server/README.md)
- [Engineering Plan](docs/PLAN.md)
- [Manual QA Checklist](docs/QA_CHECKLIST.md)
- [Demo Walkthrough](docs/DEMO.md)

---

TaskFlow demonstrates how asynchronous automation, human intervention, and persistent state management can work together without compromising assignment consistency.