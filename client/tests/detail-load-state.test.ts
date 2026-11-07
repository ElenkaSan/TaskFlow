import assert from 'node:assert/strict'
import { detailView, phaseWhileLoadingDetail, settleDetailRequest, type DetailLoad } from '../src/format.ts'

const taskA = 'task-a'
const taskB = 'task-b'

function state(overrides: Partial<DetailLoad> = {}): DetailLoad {
  return {
    phase: 'ready',
    loadedTaskId: taskA,
    failedTaskId: null,
    requestId: 1,
    ...overrides,
  }
}

assert.equal(detailView(null, 'idle', null, null), 'empty')
assert.equal(detailView(taskA, 'loading', null, null), 'loading')
assert.equal(detailView(taskA, 'ready', taskA, null), 'ready')
assert.equal(detailView(taskB, 'ready', taskA, null), 'loading')
assert.equal(detailView(taskA, 'failed', taskA, taskA), 'failed')
assert.equal(detailView(taskA, 'ready', taskA, taskB), 'ready')
assert.equal(detailView(taskB, 'failed', taskA, taskB), 'failed')

assert.equal(phaseWhileLoadingDetail('ready', taskA, null, taskA), 'ready')
assert.equal(phaseWhileLoadingDetail('failed', taskA, taskA, taskA), 'failed')
assert.equal(detailView(taskA, 'failed', taskA, taskA), 'failed')
assert.equal(phaseWhileLoadingDetail('failed', taskA, taskB, taskA), 'ready')
assert.equal(phaseWhileLoadingDetail('ready', taskA, null, taskB), 'loading')

const failed = settleDetailRequest(state(), { requestId: 1, taskId: taskA, selectedId: taskA, ok: false })
assert.deepEqual(failed, { requestId: 1, phase: 'failed', loadedTaskId: taskA, failedTaskId: taskA })
assert.equal(detailView(taskA, failed!.phase, failed!.loadedTaskId, failed!.failedTaskId), 'failed')

const refreshed = settleDetailRequest(state({ requestId: 2 }), { requestId: 2, taskId: taskA, selectedId: taskA, ok: true })
assert.deepEqual(refreshed, { requestId: 2, phase: 'ready', loadedTaskId: taskA, failedTaskId: null })

assert.equal(settleDetailRequest(state({ requestId: 3 }), { requestId: 2, taskId: taskA, selectedId: taskA, ok: false }), null)
assert.equal(settleDetailRequest(state(), { requestId: 1, taskId: taskA, selectedId: taskB, ok: true }), null)

const preserved = settleDetailRequest(state(), { requestId: 1, taskId: taskB, selectedId: taskB, ok: false })
assert.equal(preserved?.loadedTaskId, taskA)
assert.equal(preserved?.failedTaskId, taskB)
assert.equal(detailView(taskB, preserved!.phase, preserved!.loadedTaskId, preserved!.failedTaskId), 'failed')
assert.equal(detailView(taskA, preserved!.phase, preserved!.loadedTaskId, preserved!.failedTaskId), 'ready')

console.log('Detail load state checks passed.')
