# TaskFlow — Manual QA Checklist

- [x] 1. Manual override during routing

### QA-01 —  Manual override during routing

**Status:** PASS

  - Contributor: Ada Lovelace
  - Assignment source: Manual
  - Original routing attempt: Superseded
  - Final task status: Accepted
  - Verified through the dashboard and audit history.

- [x] 2. Late automated response

### QA-02 — Late Automated Response

### UX-01 — Assignment Guidance Without Eligible Contributors

**Status:** PASS — Verified after correction

**Issue identified during manual QA:**

The dashboard initially displayed "You can assign someone now" even when no eligible contributors existed and the Assign button was disabled.

**Correction:**

Updated the status messaging to distinguish between routing with available contributors and routing without eligible contributors.

**Retest:**

Created a healthcare task (`QA-2`) without a matching contributor.

**Actual results:**
- The task transitioned to `recovery_required` after the no-match routing result.
- The interface correctly explained why manual assignment was unavailable.
- The contributor dropdown displayed "No matching contributor."
- The Assign button remained disabled.
- Retry routing was available.
- Audit history recorded "No eligible contributor found."

**Engineering note:**

The correction was limited to frontend messaging and did not require changing backend routing logic or assignment eligibility rules.

**Status:** PASS — Manual UI verification

**Test task:** QA-02
**Expertise:** frontend
**Contributor:** Ada Lovelace

**Observed:**
- Manual assignment remained in `offered` state.
- The assigned contributor remained Ada Lovelace.
- The original routing attempt was marked `superseded`.
- Audit history recorded the manual assignment and routing supersession.
- No duplicate active assignment was visible.

**Additional verification:** Backend integration tests are responsible for validating stale automated result handling and assignment uniqueness under concurrent operations.

- [x] 3. Contributor accepts

### QA-03 — Contributor Accepts

**Status:** PASS — Manual end-to-end verification

**Test task:** QA-03
**Expertise:** frontend
**Contributor:** Ada Lovelace

**Verified:**
- The initial routing attempt produced a no-response outcome.
- The operator explicitly initiated Retry routing.
- The subsequent automatic routing attempt created an offer for Ada Lovelace.
- Assignment source was `Automatic`.
- The contributor accepted the offer.
- Task status changed to `accepted`.
- Further automatic routing and manual reassignment were blocked while the task was accepted.
- The accepted state persisted after page refresh.
- Audit history recorded the acceptance.

**Additional recovery scenario:**
- A pre-work failure was reported after acceptance.
- The operator manually created another assignment for Ada Lovelace.
- The new offer was accepted.
- History preserved both acceptance events and the intervening failure and reassignment.

**Note:** The two acceptance events should belong to separate assignment records; this can be confirmed through API inspection.

- [x] 4. Contributor declines

### QA-04 — Contributor Declines

**Status:** PASS — Manual end-to-end verification

**Test task:** QA-04
**Expertise:** frontend
**Contributor:** Ada Lovelace
**Initial assignment source:** Automatic

**Actual results:**
- Automatic routing successfully created an offer for Ada Lovelace.
- Declining the offer transitioned the task to `recovery_required`.
- The task became unassigned, while the previous assignment remained in history with status `declined`.
- No automatic retry was triggered after the decline.
- The operator explicitly initiated Retry routing.
- The next routing attempt excluded the previously declined contributor.
- With no other eligible contributor available, the attempt returned a no-match result.
- The task remained in `recovery_required`.
- Audit history recorded the automatic offer, decline, explicit retry, and no-match outcome.

**Evidence:** Manual browser verification and the task's routing and audit history.

- [x] 5. Pre-work failure

### QA-05 — Pre-Work Failure

**Status:** PASS — Manual end-to-end verification

**Test task:** QA-05
**Expertise:** frontend
**Contributor:** Ada Lovelace
**Assignment source:** Automatic

**Actual results:**
- Automatic routing created an offer for Ada Lovelace.
- The contributor accepted the assignment.
- A pre-work failure was reported.
- The task transitioned to `pre_work_failed` and became unassigned.
- The operator explicitly initiated Retry routing.
- The previously failed contributor was excluded from automatic matching.
- No alternative eligible contributor was found.
- The task transitioned to `recovery_required`.
- Audit history preserved the offer, acceptance, failure, retry, and no-match events.

**Engineering observation:**
`pre_work_failed` represents the immediate result of an accepted assignment failing before work begins. `recovery_required` is a possible subsequent state when an explicit retry cannot find another eligible contributor.

- [x] 6. No response

### QA-06 — No-Response Warning

**Status:** PASS — Manual UI verification (for the observed UI and intervention workflow)

**Test task:** Probe frontend 1
**Expertise:** frontend
**Contributor:** Ada Lovelace

**Actual results:**
- The task displayed `No response` rather than a confirmed failure.
- The routing attempt remained unresolved until operator intervention.
- The dashboard displayed the no-response warning.
- No automatic retry was triggered.
- Manual assignment was available.
- The operator manually assigned Ada Lovelace.
- The task transitioned to `offered`.
- The previous routing attempt was superseded.
- The assignment persisted after page refresh.

**Verification limitation:**
The 25-second warning transition was not directly timed during this manual test; its timing requires separate verification using a fresh deterministic no-response attempt or backend test.

- [x] 7. Restart recovery

### QA-07 — Backend Restart Recovery

**Status:** PASS — Manual End-to-End Verification (for observed restart recovery and persistence behavior)

**Test task:** QA-07
**Expertise:** frontend
**Contributor:** Ada Lovelace

**Actual results:**
- Created QA-07 and initiated automatic routing.
- Stopped the Express backend while routing was pending.
- Confirmed that the frontend temporarily lost API connectivity.
- Restarted the backend after the original routing due time.
- The dashboard reconnected and loaded all 20 existing tasks.
- QA-07 transitioned to `offered`.
- An automatic assignment offer was created for Ada Lovelace.
- The original routing attempt remained visible with its stored due time.
- Audit history recorded the automatic offer.
- No duplicate assignment or routing attempt was visible.
- Existing tasks, assignments, and history remained accessible.

**Additional verification:**
Backend integration tests should verify that persisted simulation outcomes are not regenerated and that repeated recovery sweeps remain idempotent.

### UX-02 — Connectivity Status

**Status:**: FAIL — Confirmed during manual testing

*Observed*: The dashboard continued to display "Up to date" while the Express backend was offline and API requests were failing.

*Expected*: The connection indicator should reflect actual API connectivity, distinguish disconnected/reconnecting states, and return to "Up to date" only after a successful refresh.

*Impact*: Operators may incorrectly believe task information is current when the backend is unavailable.

**Next step**:
Implement a focused frontend correction and repeat the disconnect/reconnect test.

#### After implementing -
**Status:**: PASS — Retested

- [x] 8. Duplicate prevention

### QA-08 — Duplicate Assignment Prevention

**Status:** PASS — Manual API Integration Verification

**Test task:** QA-08
**Expertise:** frontend
**Contributor:** Ada Lovelace

**Test method:** Repeated POST request using the same task version.

**Actual results:**
- Initial task state: `offered`, version `2`.
- First manual assignment request returned HTTP `201 Created`.
- Task version incremented from `2` to `3`.
- The original automated assignment transitioned to `superseded`.
- A new human assignment was created with status `offered`.
- Repeating the identical request with version `2` returned HTTP `409 Conflict`.
- The API reported `currentVersion: 3`.
- The task retained exactly one active assignment.
- No duplicate assignment or audit event was created by the rejected request.
- Task status remained `offered`.

**Engineering significance:**
The test confirms optimistic concurrency protection against stale repeated mutations. The backend preserves assignment integrity and prevents outdated requests from generating duplicate active assignments.

**Limitation:**
This sequential request test does not independently establish correctness under truly simultaneous competing requests; concurrent-write behavior is covered separately by backend integration tests.