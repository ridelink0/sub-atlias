import {
  attachPlannerAdvisory,
  createPlannerRequest,
  createReporterRequest,
  validateReporter,
  verifyPacket,
} from './contract.mjs'

const MAX_OUTPUT_CHARS = 12000
const MAX_TIMEOUT_MS = 120000

function validateLimits(timeoutMs, maxOutputChars) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be an integer from 1 through ${MAX_TIMEOUT_MS}`)
  }
  if (!Number.isInteger(maxOutputChars) || maxOutputChars < 1 || maxOutputChars > MAX_OUTPUT_CHARS) {
    throw new RangeError(`maxOutputChars must be an integer from 1 through ${MAX_OUTPUT_CHARS}`)
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertAuthorityRequest(packet, request) {
  const user = JSON.parse(request.user)
  if (request.packetId !== packet.packetId || !user || !sameJson(user.authority, packet.authority)) {
    throw new Error('local model request authority does not match packet')
  }
}

function validResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false
  for (const key of Object.keys(response)) if (!['text', 'capped'].includes(key)) return false
  if (response.capped !== undefined && typeof response.capped !== 'boolean') return false
  return response.capped === true || typeof response.text === 'string'
}

export function createPipelineRunner({ enabled = false, transport, timeoutMs = 30000, maxOutputChars = 4096 } = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean')
  validateLimits(timeoutMs, maxOutputChars)
  if (enabled && typeof transport !== 'function') throw new TypeError('enabled runner requires an injected transport function')
  const instanceId = enabled ? globalThis.crypto?.randomUUID?.() : null
  if (enabled && (typeof instanceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instanceId))) {
    throw new TypeError('enabled runner requires Web Crypto randomUUID support')
  }
  let sequence = 0

  async function invoke(role, packet, request, decode) {
    await verifyPacket(packet)
    const frozenRequest = Object.freeze({ ...request })
    assertAuthorityRequest(packet, frozenRequest)
    sequence += 1
    const callSequence = sequence
    const startedAt = Date.now()
    const receipt = {
      id: `local-call:${instanceId}:${packet.packetId.slice(0, 16)}:${role}:${callSequence}`,
      role,
      packetId: packet.packetId,
      sequence: callSequence,
      outcome: 'transport_failure',
    }
    const controller = new AbortController()
    let timer
    let timedOut = false
    const timed = new Promise(resolve => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        resolve({ kind: 'timeout' })
      }, timeoutMs)
    })
    const actual = Promise.resolve()
      .then(() => transport({ role, request: frozenRequest, signal: controller.signal, timeoutMs, maxOutputChars }))
      .then(value => ({ kind: 'response', value }), () => ({ kind: 'rejected' }))
    const settled = await Promise.race([actual, timed])
    clearTimeout(timer)
    receipt.elapsedMs = Math.max(0, Date.now() - startedAt)
    if (settled.kind === 'timeout' || timedOut) {
      receipt.outcome = 'timeout'
      return { receipt }
    }
    if (settled.kind === 'rejected') {
      receipt.outcome = 'transport_failure'
      return { receipt }
    }
    const response = settled.value
    if (!validResponse(response)) {
      receipt.outcome = 'transport_failure'
      return { receipt }
    }
    if (response.capped === true || response.text.length > maxOutputChars) {
      receipt.outcome = 'capped'
      return { receipt }
    }
    let parsed
    try {
      parsed = JSON.parse(response.text)
    } catch {
      receipt.outcome = 'invalid_json'
      return { receipt }
    }
    try {
      const value = await decode(parsed)
      receipt.outcome = 'ok'
      return { receipt, value }
    } catch {
      receipt.outcome = 'invalid_output'
      return { receipt }
    }
  }

  return Object.freeze({
    async runPlanner(packet) {
      if (!enabled) return { enabled: false, value: packet, receipts: [] }
      const request = await createPlannerRequest(packet)
      const called = await invoke('planner', packet, request, output => attachPlannerAdvisory(packet, output))
      return { enabled: true, value: called.value ?? packet, receipts: [called.receipt] }
    },
    async runReporter(packet, receipts, turn) {
      if (!enabled) return { enabled: false, value: turn, receipts: [] }
      const request = await createReporterRequest(packet, receipts, turn)
      const called = await invoke('reporter', packet, request, output => validateReporter(packet, receipts, output))
      return { enabled: true, value: called.value ?? turn, receipts: [called.receipt] }
    },
  })
}
