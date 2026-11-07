import assert from 'node:assert/strict'
import { connectionLabel, isConnectionFailure, nextConnection, type ConnectionPhase } from '../src/format.ts'

function follow(events: Array<'success' | 'failure' | 'retry'>): ConnectionPhase {
  return events.reduce<ConnectionPhase>((phase, event) => nextConnection(phase, event), 'pending')
}

const current = follow(['success'])
assert.equal(current, 'current')
assert.equal(connectionLabel(current), 'Up to date')
assert.equal(connectionLabel('pending'), '')

const lost = follow(['success', 'failure'])
assert.equal(lost, 'disconnected')
assert.equal(connectionLabel(lost), 'Disconnected')
assert.notEqual(connectionLabel(lost), 'Up to date')

const recovering = nextConnection(lost, 'retry')
assert.equal(recovering, 'reconnecting')
assert.equal(connectionLabel(recovering), 'Reconnecting')

const restored = nextConnection(recovering, 'success')
assert.equal(restored, 'current')
assert.equal(connectionLabel(restored), 'Up to date')

assert.equal(follow(['success', 'failure', 'retry', 'failure']), 'disconnected')
assert.equal(nextConnection('current', 'retry'), 'current')
assert.equal(nextConnection('pending', 'failure'), 'disconnected')
assert.equal(isConnectionFailure(0), true)
assert.equal(isConnectionFailure(502), true)
assert.equal(isConnectionFailure(409), false)
assert.equal(isConnectionFailure(400), false)

console.log('Connection status checks passed.')
