# TaskFlow

**Human-in-the-Loop Task Assignment System**

TaskFlow is a full-stack task assignment system that combines asynchronous automated routing with human oversight, explicit recovery workflows, and persistent audit history.

The central engineering challenge is straightforward: **how do we keep assignments consistent when automated responses are delayed, never arrive, or conflict with a newer human decision?**

TaskFlow addresses this with a database-backed routing state machine, transactional updates, optimistic concurrency control, and operator-driven recovery.

## The Problem

Automated assignment systems operate under uncertainty.

A routing request may take several seconds, return no eligible contributor, or never respond. Meanwhile, an operator may need to intervene.

Without proper coordination, a delayed automated result could overwrite a manual assignment, create conflicting offers, or leave the system in an inconsistent state.

TaskFlow prioritizes assignment correctness and operator control over algorithmic complexity.

## Core Capabilities

- **Automated routing:** Assigns tasks to contributors using normalized expertise matching.
- **Human intervention:** Allows operators to override pending or delayed routing.
- **Assignment lifecycle:** Supports offers, acceptance, decline, and pre-work failure.
- **Explicit recovery:** Enables controlled rerouting and reassignment after unsuccessful outcomes.
- **Concurrency protection:** Prevents stale requests from overwriting newer decisions.
- **Persistent routing:** Preserves routing outcomes and pending attempts across backend restarts.
- **Audit history:** Tracks automated decisions, manual interventions, and recovery actions.

## Architecture

```text
       React + TypeScript Dashboard
                  |
                  v
            Express REST API
                  |
       +----------+------------+
       |                       |
Task & Assignment       Background Routing
State Transitions             Worker
       |                       |
       +-----------+-----------+
                   |
                   v
             SQLite Database
       Tasks / Assignments / Attempts
               Audit Events
```

The application uses a single Express backend with SQLite persistence.

The backend is the authoritative source of task and assignment state. The React frontend displays server-confirmed results.

Routing attempts are persisted with predefined outcomes and timestamps rather than relying exclusively on in-memory timers.

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React, TypeScript, Vite |
| Backend | Node.js, Express, TypeScript |
| Database | SQLite (`sqlite3`) |
| Testing | Node.js `assert`, API and integration tests |
| Version Control | Git |

Backend verification has been reported on Node.js 20.20.0 and 22.23.4.

## Engineering Decisions

### 1. Human Decisions Take Precedence

Manual assignments supersede outstanding automated routing attempts.

Task version checks and transactional updates prevent late routing results from replacing newer operator decisions.

### 2. Unresolved Does Not Mean Failed

Approximately 20% of simulated routing attempts never return a response.

After 25 seconds, the system identifies the request as delayed without incorrectly treating it as a confirmed failure.

The operator may intervene or initiate recovery.

### 3. Assignment Integrity Is Enforced in the Database

Each task can have at most one active assignment.

SQLite transactions, guarded state transitions, and a partial unique index protect this invariant.

A stale mutation returns `409 Conflict` rather than silently overwriting a newer state.

### 4. Persistence Before Infrastructure Complexity

Routing attempts, outcomes, deadlines, assignments, and audit events are persisted in SQLite.

A background worker processes due attempts and reconciles pending work after a backend restart.

This avoids introducing external queues or distributed infrastructure for a small assessment application.

### 5. Explainable Matching

Contributors are selected using normalized expertise tags.

The matching strategy is intentionally simple, making assignment decisions predictable, transparent, and testable.

### 6. Recovery Is Explicit

A declined assignment or pre-work failure does not silently trigger another automated assignment.

The operator controls recovery, and previously declined or failed contributors are excluded from subsequent automatic routing attempts for the same task.

## Running Locally

### Prerequisites

- Node.js 20.20.0 or 22.23.4 (verified backend environments)
- npm

### 1. Clone the Repository

```bash
git clone <repository-url>
cd taskflow-assignment
```

Replace `<repository-url>` with the actual repository URL when available.

### 2. Start the Backend

```bash
cd server
npm install
npm run dev
```

The backend typically runs at:

`http://localhost:3001`

Health check:

```bash
curl http://localhost:3001/api/health
```

### 3. Start the Frontend

Open a separate terminal from the project root:

```bash
cd client
npm install
npm run dev
```

Open:

`http://localhost:5173`

The frontend dashboard is currently under development.

## Testing

Run backend verification from the `server` directory:

```bash
npm run typecheck
npm test
```

The reported backend test suite covers:

- Task creation and retrieval
- Contributor eligibility
- Successful and unsuccessful routing
- Delayed and no-response scenarios
- Routing persistence across restarts
- Repeated worker sweeps
- Manual overrides
- Stale version rejection
- Assignment acceptance and decline
- Pre-work failure and recovery

**Current verification:** Backend TypeScript checks and API/integration test scripts have passed in the reported Milestone 3 runs.

Manual end-to-end verification will be performed after frontend integration.

See [Manual QA Checklist](docs/QA_CHECKLIST.md).

## Implementation Status

| Component | Status |
|---|---|
| Backend API and SQLite persistence | Implemented |
| Task creation and contributor matching | Implemented |
| Persisted automatic routing | Implemented |
| Restart recovery | Implemented |
| Manual assignment and override | Implemented |
| Contributor acceptance, decline, and failure | Implemented |
| Explicit routing recovery | Implemented |
| Audit history | Implemented |
| Backend automated tests | Passed in reported runs |
| React operator dashboard | In progress |
| Final end-to-end QA | Pending |

## Scope and Tradeoffs

TaskFlow focuses on the correctness of assignment workflows rather than building a production-scale scheduling platform.

The following capabilities are intentionally excluded:

- Authentication and role-based access control
- External AI or recommendation APIs
- Complex contributor-ranking algorithms
- Distributed routing queues
- Multi-tenant architecture
- Production hosting

The backend is designed for a single Node.js process and a SQLite database.

These constraints keep the implementation focused on state consistency, human intervention, recovery, and maintainability.

## AI-Assisted Engineering Workflow

AI coding agents were used during architecture review, implementation, debugging, and verification.

Development was organized into focused milestones:

1. Backend foundation and SQLite persistence
2. Persisted automatic routing
3. Human intervention and recovery
4. Operator dashboard
5. Final verification and demonstration

The engineering workflow emphasizes reviewing proposed designs, identifying risks, correcting technical assumptions, and verifying generated changes.

Key decisions included preserving unresolved routing states, separating assignment offers from acceptance, using persistent routing attempts, and enforcing assignment consistency through database transactions.

AI-generated output is treated as implementation work requiring verification, not as proof of correctness.

## Project Documentation

- [Frontend](client/README.md) — React application and local development
- [Backend](server/README.md) — API reference, persistence, and assignment lifecycle
- [Engineering Plan](docs/PLAN.md) — architecture, requirements, and technical decisions
- [Manual QA Checklist](docs/QA_CHECKLIST.md) — end-to-end verification scenarios
- [Demo Walkthrough](docs/DEMO.md) — planned product demonstration

## Project Status

**Backend Milestones 1–3 completed. Frontend integration and final verification in progress.**

TaskFlow is an engineering assessment project demonstrating reliable asynchronous workflows, explicit human oversight, and AI-assisted software development.