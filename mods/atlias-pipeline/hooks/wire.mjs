import {
  attachPlannerAdvisory,
  createPlannerRequest,
  createReporterRequest,
  validateReporter,
  verifyPacket,
} from './contract.mjs'

const WIRE_PROTOCOL = 'atlias.local-pipeline.wire.v1'
const PLANNER_CONCISE = ' Keep the optional advisory to at most 24 whitespace-delimited words. If uncertain, say so briefly; never claim authority or evidence.'
const REPORTER_CONCISE = ' Be concise: use at most 40 whitespace-delimited words. If interpretation is uncertain, state that briefly; never claim a check passed unless its supplied evidence status is pass.'

function json(value) {
  return JSON.stringify(value)
}

function countWords(value) {
  return value.trim() === '' ? 0 : value.trim().split(/\s+/u).length
}

function compactAuthority(authority) {
  return {
    original: { text: authority.original.text },
    followups: authority.followups.map(({ text }) => ({ text })),
    skills: authority.skills.map(({ name, version, body }) => ({ name, version, body })),
  }
}

async function requestBinding(packet, role, request, aliases) {
  const material = { protocol: WIRE_PROTOCOL, packetId: packet.packetId, role, request, aliases }
  const bytes = new TextEncoder().encode(json(material))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  const requestKey = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return { protocol: WIRE_PROTOCOL, packetId: packet.packetId, role, requestKey, aliases }
}

async function assertBoundRequest(packet, role, request, binding, expectedRequest, expectedBinding) {
  if (json(request) !== json(expectedRequest)) throw new Error(`${role} request does not match current packet/input`)
  if (json(binding) !== json(expectedBinding)) throw new Error(`${role} binding does not match current packet/request`)
  if (binding.protocol !== WIRE_PROTOCOL || binding.packetId !== packet.packetId || binding.role !== role) {
    throw new Error(`${role} request binding is stale or has the wrong role`)
  }
}

function applyAuthorityView(request, packet, options, role) {
  const user = JSON.parse(request.user)
  if (options.compactAuthority) user.authority = compactAuthority(packet.authority)
  return {
    packetId: request.packetId,
    system: request.system + (options.conciseGuidance ? (role === 'planner' ? PLANNER_CONCISE : REPORTER_CONCISE) : ''),
    user: json(user),
  }
}

export function createWireAdapter({ compactAuthority: compact = false, aliasReceipts: aliasOption, conciseGuidance = false } = {}) {
  const aliasReceipts = aliasOption === undefined ? compact : aliasOption
  for (const [name, value] of [['compactAuthority', compact], ['aliasReceipts', aliasReceipts], ['conciseGuidance', conciseGuidance]]) {
    if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean`)
  }
  const options = Object.freeze({ compactAuthority: compact, aliasReceipts, conciseGuidance })

  async function buildPlannerRequest(packet) {
    await verifyPacket(packet)
    const canonical = await createPlannerRequest(packet)
    const request = applyAuthorityView(canonical, packet, options, 'planner')
    const binding = await requestBinding(packet, 'planner', request, [])
    return { request, binding }
  }

  async function buildReporterRequest(packet, receipts, turn) {
    await verifyPacket(packet)
    const canonical = await createReporterRequest(packet, receipts, turn)
    const user = JSON.parse(canonical.user)
    const aliases = options.aliasReceipts
      ? user.evidence.map((row, index) => ({ alias: `r${index}`, receiptId: row.id }))
      : []
    if (options.aliasReceipts) {
      user.evidence = user.evidence.map((row, index) => ({ ...row, id: `r${index}` }))
    }
    const request = applyAuthorityView({ ...canonical, user: json(user) }, packet, options, 'reporter')
    const binding = await requestBinding(packet, 'reporter', request, aliases)
    return { request, binding }
  }

  return Object.freeze({
    options,

    plannerRequest: buildPlannerRequest,

    async validatePlannerOutput(packet, request, binding, output) {
      await verifyPacket(packet)
      const expected = await buildPlannerRequest(packet)
      await assertBoundRequest(packet, 'planner', request, binding, expected.request, expected.binding)
      if (options.conciseGuidance && (!output || typeof output.advisory !== 'string' || countWords(output.advisory) > 24)) {
        throw new RangeError('planner advisory exceeds the 24-word concise contract')
      }
      return attachPlannerAdvisory(packet, output)
    },

    reporterRequest: buildReporterRequest,

    async validateReporterOutput(packet, receipts, turn, request, binding, output) {
      await verifyPacket(packet)
      const expected = await buildReporterRequest(packet, receipts, turn)
      await assertBoundRequest(packet, 'reporter', request, binding, expected.request, expected.binding)
      if (!output || typeof output !== 'object' || Array.isArray(output)) throw new TypeError('reporter output must be an object')
      for (const key of Object.keys(output)) if (!['text', 'receiptIds'].includes(key)) throw new Error(`unsupported reporter field: ${key}`)
      if (typeof output.text !== 'string') throw new TypeError('reporter text must be a string')
      if (options.conciseGuidance && countWords(output.text) > 40) throw new RangeError('reporter text exceeds the 40-word concise contract')
      if (!Array.isArray(output.receiptIds)) throw new TypeError('reporter receiptIds must be an array')

      let hostReceiptIds = output.receiptIds
      if (options.aliasReceipts) {
        const aliasToReceipt = new Map(expected.binding.aliases.map(item => [item.alias, item.receiptId]))
        const seen = new Set()
        hostReceiptIds = output.receiptIds.map(alias => {
          if (typeof alias !== 'string' || !aliasToReceipt.has(alias)) throw new Error('unknown receipt alias')
          if (seen.has(alias)) throw new Error(`duplicate receipt alias: ${alias}`)
          seen.add(alias)
          return aliasToReceipt.get(alias)
        })
      }
      return validateReporter(packet, receipts, { text: output.text, receiptIds: hostReceiptIds })
    },
  })
}

export { WIRE_PROTOCOL }
