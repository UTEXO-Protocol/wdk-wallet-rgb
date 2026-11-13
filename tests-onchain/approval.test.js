import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkletApproval } from '../onchain.js'

const review = Object.freeze({
  operationId: 'regtest-approval-001',
  plan: Object.freeze({ psbtSha256: '01'.repeat(32) })
})

test('worklet approval admits only its exact live generation and one response', async () => {
  let ticket
  const controller = createWorkletApproval({ generation: 'wallet1-1', onRequest: value => { ticket = value } })
  try {
    const authorization = controller.authorize(review)
    assert.equal(await controller.authorize(review), false)
    assert.equal(controller.respond({ ...ticket, generation: 'wallet1-0', approved: true }), false)
    assert.equal(controller.respond({ ...ticket, digest: '02'.repeat(32), approved: true }), false)
    assert.equal(controller.respond({ ...ticket, approved: true }), true)
    assert.equal(await authorization, true)
    assert.equal(controller.respond({ ...ticket, approved: true }), false)
  } finally {
    controller.close()
  }
})

test('closing, a rejected dispatcher and timeout fail closed', async () => {
  let ticket
  const controller = createWorkletApproval({ generation: 'wallet1-2', onRequest: value => { ticket = value } })
  const authorization = controller.authorize(review)
  controller.close()
  assert.equal(await authorization, false)
  assert.equal(controller.respond({ ...ticket, approved: true }), false)
  assert.equal(await controller.authorize(review), false)

  const failing = createWorkletApproval({ generation: 'wallet1-3', onRequest: async () => { throw new Error('Lost IPC') } })
  assert.equal(await failing.authorize(review), false)
  failing.close()

  const timed = createWorkletApproval({ generation: 'wallet1-4', onRequest: () => {}, timeoutMs: 100 })
  assert.equal(await timed.authorize(review), false)
  timed.close()
})
