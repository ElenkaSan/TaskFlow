# TaskFlow — Manual QA Checklist

- [x] 1. Manual override during routing

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

**Result:** PASS

**Engineering note:**

The correction was limited to frontend messaging and did not require changing backend routing logic or assignment eligibility rules.


- [x] 2. Late automated response

### QA-02 — Late Automated Response

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

**Status:** PASS — after acceptance and persistence verification

**Test task:** QA-03
**Expertise:** frontend
**Contributor:** Ada Lovelace

**Observed:**
- The initial routing attempt produced a no-response outcome.
- No assignment was created from the unresolved attempt.
- The operator explicitly initiated Retry routing.
- The previous attempt was superseded.
- The second automatic routing attempt successfully created an offer for Ada Lovelace.
- Assignment source was `Automatic`.
- The contributor accepted the offer.
- Task status changed to `accepted`.
- Further routing and manual reassignment were blocked.
- The accepted assignment persisted after page refresh.

**Result:** PASS


- [ ] 4. Contributor declines
  - Отклонить offer и проверить доступность recovery с исключением отказавшегося исполнителя.
- [ ] 5. Pre-work failure
  - Сымитировать failure до начала работы и проверить возврат задачи в управляемое состояние.
- [ ] 6. No response
  - После 25 секунд проверить предупреждение и возможность ручного вмешательства без ложного статуса failed.
- [ ] 7. Restart recovery
  - Перезапустить backend и проверить сохранение задач, назначений и истории.
- [ ] 8. Duplicate prevention
  - Повторить запрос и проверить, что нет двойного активного назначения.