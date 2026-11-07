import assert from 'node:assert/strict'
import { routingAttemptLines } from '../src/format.ts'

const now = Date.parse('2026-11-07T17:00:00.000Z')
const createdAt = '2026-11-07T16:59:30.000Z'
const dueAt = '2026-11-07T17:00:12.000Z'
const warningAt = '2026-11-07T17:00:25.000Z'
const ada = 'Ada Lovelace'

function lines(status: string, outcome: string, contributor: string | null, warning: string | null = warningAt) {
  return routingAttemptLines({ status, outcome, dueAt, warningAt: warning, createdAt }, contributor, now)
}

const pendingMatch = lines('pending', 'success', ada, null)
const pendingSilence = lines('pending', 'no_response', ada, warningAt)
const pendingNoMatch = lines('pending', 'success', null, null)

assert.deepEqual(pendingMatch, ['Awaiting routing response.', 'Elapsed Just now'])
assert.deepEqual(pendingSilence, pendingMatch)
assert.deepEqual(pendingNoMatch, pendingMatch)
for (const text of [pendingMatch, pendingSilence, pendingNoMatch]) {
  const visible = text.join(' ')
  assert.equal(visible.includes(ada), false)
  assert.equal(visible.includes(dueAt), false)
  assert.equal(visible.includes(warningAt), false)
  assert.doesNotMatch(visible, /Match saved|No response|matching contributor|Warning|Due/)
}

const older = routingAttemptLines(
  { status: 'pending', outcome: 'no_response', dueAt, warningAt, createdAt: '2026-11-07T16:50:00.000Z' },
  ada,
  now,
)
assert.deepEqual(older, ['Awaiting routing response.', 'Elapsed 10m'])

const matched = lines('completed', 'success', ada, null)
assert.equal(matched[0], 'Match saved for Ada Lovelace.')
assert.ok(matched[1].startsWith('Due '))
assert.equal(matched.some((line) => line.startsWith('Warning ')), false)

const silent = lines('no_response', 'no_response', ada, warningAt)
assert.match(silent[0], /No response from Ada Lovelace/)
assert.match(silent[0], /not a failure/)
assert.ok(silent[1].startsWith('Due '))
assert.ok(silent.some((line) => line.startsWith('Warning ')))

const unmatched = lines('completed', 'success', null, null)
assert.equal(unmatched[0], 'No matching contributor was available.')
assert.equal(unmatched.some((line) => line.startsWith('Warning ')), false)

assert.deepEqual(lines('superseded', 'no_response', ada, warningAt), [])
assert.deepEqual(lines('cancelled', 'success', ada, null), [])

console.log('Routing attempt label checks passed.')
