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

The frontend communicates with the backend through its REST API. `npm run dev` proxies `/api` to `http://127.0.0.1:3001`.

Task and assignment state is maintained on the server. The UI displays server-confirmed state rather than treating local React state as authoritative. While any task is routing, the dashboard polls about every 1.5 seconds. A stale mutation that receives HTTP 409 reloads the task and asks the operator to review it before trying again.

For the complete architecture, engineering decisions, tests, and project instructions, see the [main project README](../README.md).

## Status

The operator dashboard is implemented. `npm run build` and `npm run lint` passed in this review. `tests/status-notice.test.ts` checks the status copy and is run with `tsx`; `npm test` is not defined in this package.