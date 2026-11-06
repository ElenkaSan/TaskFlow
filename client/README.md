# TaskFlow — Frontend

React and TypeScript frontend for **TaskFlow**, a Human-in-the-Loop Task Assignment System.

## Technology

- React
- TypeScript
- Vite

## Local Development

From the `client` directory:

```bash
npm install
npm run dev
```

Vite typically serves the frontend at:

`http://localhost:5173`

## Application Responsibilities

The frontend provides the operator interface for:

- Viewing task assignments and routing statuses
- Creating tasks
- Monitoring delayed and unresolved routing attempts
- Manually assigning contributors
- Handling assignment recovery
- Reviewing task history

The Express backend owns routing decisions, assignment state, persistence, and audit history.

## Architecture

The frontend communicates with the backend through its REST API.

Task and assignment state is maintained on the server. The UI displays server-confirmed state rather than treating local React state as authoritative.

For the complete architecture, engineering decisions, tests, and project instructions, see the [main project README](../README.md).

## Status

Frontend implementation in progress.