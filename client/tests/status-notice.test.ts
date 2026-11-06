import assert from 'node:assert/strict'
import { manualAssignmentUnavailable, statusNotice } from '../src/format.ts'

const unavailable = manualAssignmentUnavailable

assert.match(statusNotice('routing', 'the contributor', 0) ?? '', new RegExp(unavailable))
assert.doesNotMatch(statusNotice('routing', 'the contributor', 0) ?? '', /You can assign someone now/)
assert.match(statusNotice('routing', 'Ada Lovelace', 1) ?? '', /You can assign someone now/)
assert.doesNotMatch(statusNotice('routing', 'Ada Lovelace', 1) ?? '', new RegExp(unavailable))

assert.match(statusNotice('recovery_required', 'the contributor', 0) ?? '', new RegExp(unavailable))
assert.match(statusNotice('recovery_required', 'the contributor', 0) ?? '', /retry routing/i)
assert.match(statusNotice('recovery_required', 'Ada Lovelace', 1) ?? '', /assign someone/)
assert.doesNotMatch(statusNotice('recovery_required', 'Ada Lovelace', 1) ?? '', new RegExp(unavailable))

const warningWithoutMatch = statusNotice('no_response_warning', 'the contributor', 0) ?? ''
assert.match(warningWithoutMatch, /not a routing failure/)
assert.match(warningWithoutMatch, new RegExp(unavailable))
assert.doesNotMatch(warningWithoutMatch, /failed/i)

const warningWithMatch = statusNotice('no_response_warning', 'Ada Lovelace', 1) ?? ''
assert.match(warningWithMatch, /not a routing failure/)
assert.match(warningWithMatch, /Assign someone or start another attempt/)
assert.doesNotMatch(warningWithMatch, new RegExp(unavailable))

assert.match(statusNotice('offered', 'Ada Lovelace', 1) ?? '', /waiting for a response/)
assert.match(statusNotice('offered', 'Ada Lovelace', 1) ?? '', /has not been accepted/)
assert.match(statusNotice('accepted', 'Ada Lovelace', 1) ?? '', /Accepted by Ada Lovelace/)
assert.equal(statusNotice('unknown', 'Ada Lovelace', 0), null)

console.log('Status notice checks passed.')
