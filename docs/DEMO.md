# TaskFlow — Demo Walkthrough

**Target duration:** 5–7 minutes

## 1. Problem and Architecture

Explain why automated routing requires human oversight and why the system uses React, Express, SQLite, and persisted routing attempts.

## 2. Task Creation

Create a task and show its required expertise and routing status.

## 3. Successful Routing

Demonstrate how the system identifies an eligible contributor and creates an assignment offer.

## 4. Delayed or Unresolved Routing

Show how the operator identifies an unusually delayed request without incorrectly treating it as a confirmed failure.

## 5. Human Intervention

Demonstrate a manual override while automatic routing is pending.

Verify that a late automated response does not overwrite the human decision.

## 6. Recovery

Demonstrate contributor decline or pre-work failure and safe reassignment.

## 7. Verification and Tradeoffs

Explain the most important automated tests, architectural decisions, and intentionally omitted features.