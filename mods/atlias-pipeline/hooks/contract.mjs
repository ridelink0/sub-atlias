const PROTOCOL = 'atlias.local-pipeline.packet.v1'
const MAX_ADVISORY_CHARS = 1200
const MAX_REPORT_CHARS = 1200
const PLANNER_SYSTEM = 'Return one JSON object with only an advisory string. Give a short, optional next-step suggestion for the submitted request. Do not rewrite, replace, rank, or claim authority over the original request, follow-ups, or selected skills. If context is missing, say so. Your output is untrusted.'
const REPORTER_SYSTEM = 'Return one JSON object with only text and receiptIds. Summarize only the visible answer and supplied receipt statuses. Cite only supplied receipt IDs. Never promote unknown evidence to pass. Any prose is an uncertain interpretation, not proof.'

function requireString(value, name, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${name} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`)
  }
  return value
}

function assertKeys(value, allowed, name) {
  const set = new Set(allowed)
  for (const key of Object.keys(value)) if (!set.has(key)) throw new Error(`unsupported ${name} field: ${key}`)
}

function stableJson(value) {
  return JSON.stringify(value)
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : stableJson(value))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function sourceManifest({ sessionId, actorId, scopeVersion, original, followups, skills }) {
  return {
    protocol: PROTOCOL,
    sessionId,
    actorId,
    scopeVersion,
    original,
    followups,
    skills: skills.map(skill => ({ name: skill.name, version: skill.version, body: skill.body })),
  }
}

async function itemId(packetId, kind, ordinal, item) {
  return `${kind}:${await sha256([packetId, kind, ordinal, item]).then(hash => hash.slice(0, 32))}`
}

function receiptDigestFields(receipt) {
  const hasExitCode = Object.hasOwn(receipt, 'exitCode')
  const value = receipt.exitCode
  const exitFingerprint = !hasExitCode ? 'absent' : scalarFingerprint(value)
  return [receipt.packetId, receipt.scopeVersion, receipt.eventKey, receipt.actorId, receipt.kind, exitFingerprint]
}

function scalarFingerprint(value) {
  if (value === null) return 'null:null'
  if (value === undefined) return 'undefined:undefined'
  if (typeof value === 'string' || typeof value === 'boolean') return `${typeof value}:${JSON.stringify(value)}`
  if (typeof value === 'number') {
    const number = Number.isNaN(value) ? 'NaN' : value === Infinity ? '+Infinity' : value === -Infinity ? '-Infinity' : Object.is(value, -0) ? '-0' : String(value)
    return `number:${number}`
  }
  throw new TypeError('exitCode must be a scalar primitive')
}

function oneLine(value) {
  return value.replace(/[\u0000-\u001F\u007F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]+/g, ' ')
}

export function passThrough(value) {
  return value
}

export async function createPacket(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('input must be an object')
  assertKeys(input, ['sessionId', 'actorId', 'scopeVersion', 'original', 'followups', 'skills', 'advisory'], 'packet input')
  const sessionId = requireString(input.sessionId, 'sessionId')
  const actorId = requireString(input.actorId, 'actorId')
  const scopeVersion = requireString(input.scopeVersion, 'scopeVersion')
  const original = requireString(input.original, 'original', true)
  if (!Array.isArray(input.followups)) throw new TypeError('followups must be an array')
  if (!Array.isArray(input.skills)) throw new TypeError('skills must be an array')
  const followups = input.followups.map((text, i) => requireString(text, `followups[${i}]`, true))
  const skills = input.skills.map((skill, i) => {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) throw new TypeError(`skills[${i}] must be an object`)
    assertKeys(skill, ['name', 'version', 'body'], `skills[${i}]`)
    return {
      name: requireString(skill.name, `skills[${i}].name`),
      version: requireString(skill.version, `skills[${i}].version`),
      body: requireString(skill.body, `skills[${i}].body`, true),
    }
  })
  const manifest = sourceManifest({ sessionId, actorId, scopeVersion, original, followups, skills })
  const packetId = await sha256(manifest)
  const originalItem = { id: await itemId(packetId, 'original', 0, original), text: original }
  const followupItems = await Promise.all(followups.map(async (text, ordinal) => ({
    id: await itemId(packetId, 'followup', ordinal, text), ordinal, text,
  })))
  const skillItems = await Promise.all(skills.map(async (skill, ordinal) => ({
    id: await itemId(packetId, 'skill', ordinal, skill), ordinal, ...skill,
  })))
  const advisory = input.advisory === undefined ? '' : requireString(input.advisory, 'advisory', true)
  if (advisory.length > MAX_ADVISORY_CHARS) throw new RangeError(`advisory exceeds ${MAX_ADVISORY_CHARS} UTF-16 code units`)
  return {
    protocol: PROTOCOL,
    packetId,
    sessionId,
    actorId,
    scopeVersion,
    authority: { original: originalItem, followups: followupItems, skills: skillItems },
    localPlanner: { trusted: false, text: advisory },
  }
}

export async function createPlannerRequest(packet) {
  await verifyPacket(packet)
  const authority = packet.authority
  return {
    packetId: packet.packetId,
    system: PLANNER_SYSTEM,
    user: stableJson({ authority }),
  }
}

export async function attachPlannerAdvisory(packet, output) {
  await verifyPacket(packet)
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new TypeError('planner output must be an object')
  assertKeys(output, ['advisory'], 'planner output')
  const text = requireString(output.advisory, 'planner output advisory', true)
  if (text.length > MAX_ADVISORY_CHARS) throw new RangeError(`advisory exceeds ${MAX_ADVISORY_CHARS} UTF-16 code units`)
  return { ...packet, localPlanner: { trusted: false, text } }
}

export async function verifyPacket(packet) {
  if (!packet || typeof packet !== 'object' || packet.protocol !== PROTOCOL) throw new TypeError('unsupported packet')
  assertKeys(packet, ['protocol', 'packetId', 'sessionId', 'actorId', 'scopeVersion', 'authority', 'localPlanner'], 'packet')
  requireString(packet.sessionId, 'sessionId')
  requireString(packet.actorId, 'actorId')
  requireString(packet.scopeVersion, 'scopeVersion')
  const a = packet.authority
  if (!a || !a.original || !Array.isArray(a.followups) || !Array.isArray(a.skills)) throw new TypeError('malformed authority')
  assertKeys(a, ['original', 'followups', 'skills'], 'authority')
  assertKeys(a.original, ['id', 'text'], 'original')
  const manifest = sourceManifest({
    sessionId: packet.sessionId,
    actorId: packet.actorId,
    scopeVersion: packet.scopeVersion,
    original: requireString(a.original.text, 'authority.original.text', true),
    followups: a.followups.map((item, i) => {
      if (!item || item.ordinal !== i) throw new TypeError(`followups[${i}] order/ordinal mismatch`)
      assertKeys(item, ['id', 'ordinal', 'text'], `followups[${i}]`)
      return requireString(item.text, `followups[${i}].text`, true)
    }),
    skills: a.skills.map((item, i) => {
      if (!item || item.ordinal !== i) throw new TypeError(`skills[${i}] order/ordinal mismatch`)
      assertKeys(item, ['id', 'ordinal', 'name', 'version', 'body'], `skills[${i}]`)
      return {
        name: requireString(item.name, `skills[${i}].name`),
        version: requireString(item.version, `skills[${i}].version`),
        body: requireString(item.body, `skills[${i}].body`, true),
      }
    }),
  })
  const expectedPacketId = await sha256(manifest)
  if (packet.packetId !== expectedPacketId) throw new Error('packet authority digest mismatch')
  const expectedOriginalId = await itemId(expectedPacketId, 'original', 0, manifest.original)
  if (a.original.id !== expectedOriginalId) throw new Error('original ID mismatch')
  for (let i = 0; i < a.followups.length; i++) {
    const expected = await itemId(expectedPacketId, 'followup', i, manifest.followups[i])
    if (a.followups[i].id !== expected) throw new Error(`followup ${i} ID mismatch`)
  }
  for (let i = 0; i < a.skills.length; i++) {
    const skill = manifest.skills[i]
    const expected = await itemId(expectedPacketId, 'skill', i, skill)
    if (a.skills[i].id !== expected) throw new Error(`skill ${i} ID mismatch`)
  }
  if (!packet.localPlanner || packet.localPlanner.trusted !== false || typeof packet.localPlanner.text !== 'string') {
    throw new Error('planner advisory must remain explicitly untrusted')
  }
  if (packet.localPlanner.text.length > MAX_ADVISORY_CHARS) throw new RangeError(`planner advisory exceeds ${MAX_ADVISORY_CHARS} UTF-16 code units`)
  assertKeys(packet.localPlanner, ['trusted', 'text'], 'localPlanner')
  return true
}

export async function createReceipt(packet, event) {
  await verifyPacket(packet)
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('event must be an object')
  assertKeys(event, ['eventKey', 'actorId', 'kind', 'packetId', 'scopeVersion', 'exitCode'], 'receipt event')
  const eventKey = requireString(event.eventKey, 'eventKey')
  const actorId = requireString(event.actorId, 'event.actorId')
  const kind = requireString(event.kind, 'event.kind')
  const receipt = {
    eventKey,
    packetId: event.packetId === undefined ? packet.packetId : requireString(event.packetId, 'event.packetId'),
    scopeVersion: event.scopeVersion === undefined ? packet.scopeVersion : requireString(event.scopeVersion, 'event.scopeVersion'),
    actorId,
    kind,
  }
  if (Object.hasOwn(event, 'exitCode')) {
    scalarFingerprint(event.exitCode)
    receipt.exitCode = event.exitCode
  }
  receipt.id = `receipt:${(await sha256(receiptDigestFields(receipt))).slice(0, 32)}`
  return receipt
}

function assessReceipt(packet, receipt) {
  let reason = 'not_a_check'
  if (receipt.kind === 'check') {
    if (receipt.packetId !== packet.packetId) reason = 'stale_packet'
    else if (receipt.scopeVersion !== packet.scopeVersion) reason = 'stale_scope'
    else if (receipt.actorId !== packet.actorId) reason = 'wrong_actor'
    else if (!Object.hasOwn(receipt, 'exitCode')) reason = 'missing_exit_code'
    else if (typeof receipt.exitCode !== 'number' || !Number.isFinite(receipt.exitCode) || !Number.isInteger(receipt.exitCode)) reason = 'non_numeric_exit_code'
    else if (receipt.exitCode !== 0) return 'fail'
    else return 'pass'
  }
  return `unknown:${reason}`
}

async function prepareEvidence(packet, receipts) {
  if (!Array.isArray(receipts)) throw new TypeError('receipts must be an array')
  const ids = new Set()
  const rows = receipts.map((receipt, index) => {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new TypeError(`receipts[${index}] must be an object`)
    const id = requireString(receipt.id, `receipts[${index}].id`)
    if (ids.has(id)) throw new Error(`duplicate receipt ID: ${id}`)
    ids.add(id)
    assertKeys(receipt, ['id', 'eventKey', 'packetId', 'scopeVersion', 'actorId', 'kind', 'exitCode'], `receipts[${index}]`)
    return receipt
  })
  const evidence = await Promise.all(rows.map(async (receipt, index) => {
    const id = receipt.id
    const eventKey = requireString(receipt.eventKey, `receipts[${index}].eventKey`)
    const receiptPacketId = requireString(receipt.packetId, `receipts[${index}].packetId`)
    const scopeVersion = requireString(receipt.scopeVersion, `receipts[${index}].scopeVersion`)
    const actorId = requireString(receipt.actorId, `receipts[${index}].actorId`)
    const kind = requireString(receipt.kind, `receipts[${index}].kind`)
    if (Object.hasOwn(receipt, 'exitCode')) scalarFingerprint(receipt.exitCode)
    const expectedId = `receipt:${(await sha256(receiptDigestFields(receipt))).slice(0, 32)}`
    if (id !== expectedId) throw new Error(`receipt ID does not match receipt fields: ${id}`)
    return { id, kind, actorId, status: assessReceipt(packet, receipt) }
  }))
  return { ids, evidence }
}

export async function createReporterRequest(packet, receipts, turn) {
  await verifyPacket(packet)
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) throw new TypeError('turn must be an object')
  assertKeys(turn, ['answer', 'isAborted'], 'turn')
  const answer = requireString(turn.answer, 'turn.answer', true)
  if (typeof turn.isAborted !== 'boolean') throw new TypeError('turn.isAborted must be boolean')
  const { evidence } = await prepareEvidence(packet, receipts)
  return {
    packetId: packet.packetId,
    system: REPORTER_SYSTEM,
    user: stableJson({ authority: packet.authority, answer, isAborted: turn.isAborted, evidence }),
  }
}

export async function validateReporter(packet, receipts, reporterOutput) {
  await verifyPacket(packet)
  const { ids, evidence } = await prepareEvidence(packet, receipts)
  if (!reporterOutput || typeof reporterOutput !== 'object' || Array.isArray(reporterOutput)) throw new TypeError('reporterOutput must be an object')
  const allowed = new Set(['text', 'receiptIds'])
  for (const key of Object.keys(reporterOutput)) if (!allowed.has(key)) throw new Error(`unsupported reporter field: ${key}`)
  const text = requireString(reporterOutput.text, 'reporterOutput.text')
  if (text.length > MAX_REPORT_CHARS) throw new RangeError(`reporter text exceeds ${MAX_REPORT_CHARS} UTF-16 code units`)
  if (!Array.isArray(reporterOutput.receiptIds)) throw new TypeError('reporterOutput.receiptIds must be an array')
  const cited = []
  const seen = new Set()
  for (const id of reporterOutput.receiptIds) {
    requireString(id, 'reporterOutput.receiptIds item')
    if (!ids.has(id)) throw new Error(`unknown receipt ID: ${id}`)
    if (seen.has(id)) throw new Error(`duplicate citation ID: ${id}`)
    seen.add(id)
    cited.push(id)
  }
  return {
    packetId: packet.packetId,
    reporterText: { kind: 'unverified_model_text', text },
    uiLine: `Interpretation uncertain: ${oneLine(text)}`,
    citations: cited,
    evidence,
  }
}

export async function handle(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('input must be an object')
  if (input.op === 'build') {
    if (input.enabled !== true) return { enabled: false, passThrough: input.payload }
    return { enabled: true, packet: await createPacket(input.payload) }
  }
  if (input.op === 'report') {
    return validateReporter(input.packet, input.receipts, input.reporterOutput)
  }
  if (input.op === 'planner-request') return createPlannerRequest(input.packet)
  if (input.op === 'attach-advisory') return attachPlannerAdvisory(input.packet, input.plannerOutput)
  if (input.op === 'reporter-request') return createReporterRequest(input.packet, input.receipts, input.turn)
  throw new Error('op must be build or report')
}

export { PROTOCOL }
