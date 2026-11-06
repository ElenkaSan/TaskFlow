# TaskFlow

**Human-in-the-Loop Task Assignment System**

TaskFlow is a full-stack application that demonstrates automated task routing with human oversight, failure recovery, and persistent assignment history.

The system is designed around a practical operational problem: automated routing is not always immediate or reliable, and operators need a safe way to intervene without creating conflicting assignments.

## The Problem

Automated assignment systems can experience delayed responses, unavailable contributors, and requests that never resolve.

A reliable system must allow human intervention while preserving consistency between automated and manual decisions.

## Approach

TaskFlow combines:

- **Automated routing:** Matches tasks with contributors based on required expertise.
- **Human oversight:** Allows operators to intervene when routing is delayed or unsuccessful.
- **Safe state transitions:** Prevents outdated automated responses from replacing newer decisions.
- **Persistent history:** Records routing attempts and operator actions for traceability.
- **Recovery workflows:** Supports reassignment after declines or pre-work failures.

## Architecture

```text
React + TypeScript
        |
        v
Express REST API
        |
        v
SQLite Database
        ^
        |
Background Routing Worker
```

The application uses a single backend process and a persistent SQLite database.

Routing attempts are stored in the database rather than relying exclusively on in-memory timers.

This supports predictable recovery following application restarts.

## Technology Stack

**Frontend:** React, TypeScript, Vite

**Backend:** Node.js, Express, TypeScript

**Database:** SQLite

**Testing:** Automated API and routing tests

## Engineering Decisions

### 1. Human decisions take precedence

Manual operator actions must not be overwritten by delayed automated responses.

### 2. Unresolved does not mean failed

A routing request that has not responded is not automatically treated as a confirmed failure.

The system distinguishes delayed requests from reported failures.

### 3. Persistence before complexity

SQLite provides durable local storage without requiring external infrastructure.

### 4. Simple matching

Contributors are matched using normalized expertise tags.

The assignment algorithm intentionally avoids unnecessary recommendation scoring.

### 5. Auditability

Meaningful routing transitions and operator actions are recorded as append-only events.

## Implementation Status

| Component | Status |
|---|---|
| Backend API and SQLite persistence | Implemented |
| Task creation and retrieval | Implemented |
| Persisted automatic routing | In progress |
| Manual intervention | Planned |
| Contributor acceptance and decline | Planned |
| Operator dashboard | Planned |
| Final verification | Planned |

## Running Locally

The application contains separate frontend and backend projects.

### Frontend

```bash
cd client
npm install
npm run dev
```

### Backend

```bash
cd server
npm install
npm run dev
```

The frontend typically runs on `http://localhost:5173`.

The backend API is configured separately. Check the server configuration for its port.

## Scope and Tradeoffs

This assessment prioritizes state consistency, recovery behavior, and operator clarity over unnecessary infrastructure.

Intentionally excluded:

- Authentication and role management
- External AI services
- Complex recommendation algorithms
- Distributed background queues
- Production hosting

## AI-Assisted Development

AI coding agents were used to support architecture review, implementation, debugging, and testing.

Technical decisions and generated changes are reviewed and validated by the developer.

Development was divided into focused milestones to keep the implementation inspectable and testable.

## Verification

Automated tests validate the API and core routing behavior.

The final submission will include verified test results and a walkthrough demonstrating critical workflows.

## Project Status

Work in progress — engineering assessment implementation.