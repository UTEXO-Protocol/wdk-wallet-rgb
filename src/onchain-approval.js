// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { clearTimer, startTimer } from '#onchain-io'

const HEX_32 = /^[a-f0-9]{64}$/

function reviewIdentity (review) {
  if (review?.kind === 'bip322') {
    if (typeof review.address !== 'string' || !HEX_32.test(review.messageSha256)) throw new TypeError('Invalid message review')
    return ['bip322', review.address, review.messageSha256]
  }
  if (typeof review?.operationId !== 'string' || !HEX_32.test(review.plan?.psbtSha256)) {
    throw new TypeError('Invalid transaction review')
  }
  return ['transaction', review.operationId, review.plan.psbtSha256]
}

/**
 * Correlate an approval across the app's trusted worklet IPC. Create one
 * controller per unlocked wallet generation and close it before shutdown.
 * Only the trusted application approval handler may call respond().
 */
export function createWorkletApproval ({ generation, onRequest, timeoutMs = 60_000 }) {
  if (typeof generation !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(generation) ||
      typeof onRequest !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new TypeError('Invalid worklet approval configuration')
  }
  let closed = false
  let pending

  function finish (request, approved) {
    if (pending !== request) return
    pending = undefined
    clearTimer(request.timer)
    request.resolve(approved)
  }

  function authorize (review) {
    if (closed || pending) return Promise.resolve(false)
    const identity = reviewIdentity(review)
    const token = hex.encode(crypto.getRandomValues(new Uint8Array(16)))
    const digest = hex.encode(sha256(new TextEncoder().encode(JSON.stringify([generation, token, ...identity]))))
    const ticket = Object.freeze({ generation, token, digest })
    return new Promise(resolve => {
      const request = { ticket, resolve, deadline: Date.now() + timeoutMs }
      request.timer = startTimer(() => finish(request, false), timeoutMs)
      pending = request
      try {
        Promise.resolve(onRequest(Object.freeze({ ...ticket, review }))).catch(() => finish(request, false))
      } catch {
        finish(request, false)
      }
    })
  }

  return Object.freeze({
    authorize,
    authorizeMessage: authorize,
    respond (decision) {
      const request = pending
      if (!request || closed || typeof decision?.approved !== 'boolean' ||
          decision.generation !== request.ticket.generation ||
          decision.token !== request.ticket.token || decision.digest !== request.ticket.digest) return false
      if (Date.now() >= request.deadline) {
        finish(request, false)
        return false
      }
      finish(request, decision.approved)
      return true
    },
    close () {
      closed = true
      if (pending) finish(pending, false)
    }
  })
}
