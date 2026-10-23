// SessionStart: the one place atlias speaks unprompted. The brief is short,
// deterministic (no clocks, no counters that tick every turn) so the host can
// cache it as a stable prompt prefix, and it points at data instead of pasting it.
import fs from 'node:fs';
import path from 'node:path';
import { config, exists, readText, clip, claudeMemoryDir, readLines, saveSessionMeta, sessionMeta, HOST_LABEL, ROOT, VERSION, CLAUDE_DIR, readJson, findPython, log, ufsCopies, recordEvent, actorSession, subagentTag } from './core.mjs';
import * as graph from './graph.mjs';
import * as dream from './dream.mjs';
import * as progress from './progress.mjs';
import * as authority from './authority.mjs';
import { visibleCheck } from './gate.mjs';

export function companions(cwd = process.cwd()) {
  const settings = readJson(path.join(CLAUDE_DIR, 'settings.json'), {}) || {};
  const enabled = Object.entries(settings.enabledPlugins || {}).filter(([, v]) => v).map(([k]) => k.split('@')[0]);
  // Any copy Claude Code loads counts, under any of UFS's names or as a
  // skills-only folder, so a renamed install is not reported missing.
  const ufs = ufsCopies({ cwd });
  return {
    ufs: ufs.some((copy) => copy.loaded),
    ufsCopies: ufs,
    computerUse: enabled.includes('computer-use'),
    graphify: Boolean(findPython()),
    graphifySkill: exists(path.join(CLAUDE_DIR, 'skills', 'graphify', 'SKILL.md')),
  };
}

export const PASS_LINE = '"Pass 1: <check> passed. Pass 2: <what the re-read found>."';
export const RULES = [
  'Codebase question: query the graph first (graph_query or `graphify query`), then read only the files it names.',
  'Never repeat an identical call that already failed or already answered; change the input or the approach.',
  `Done means verified: run the smallest real check, re-read each changed file adversarially, and end the reply with ${PASS_LINE} The gate holds a reply without that line, which costs a whole turn.`,
  'Reply with what the reader needs and nothing about how you worked; no restating the prompt.',
  'Mark anything you did not verify as unverified. Never invent a result.',
  'When the plan changes, write the next step with harness_progress so a compaction or crash costs nothing.',
];

// Every tool round re-sends the whole context, so a round saved is the largest
// saving there is. Measured in Claude Code on 2026-09-28 (Sonnet 5, 34 tasks):
// a one-function fix took four rounds, read, edit, check, reply, each about 30k
// prompt tokens. The edit and its check can share one message only where the
// host runs a message's calls in order, which was checked for Claude Code (a
// Write then a PowerShell read of the same file, one message: the read saw the
// write) and not for the other hosts, so only Claude Code is told to.
// With flags.gateRunsCheck and a check the gate can name, the gate runs the
// check a reply left out, so the pairing is no longer asked for.
export function roundsRule(host, { gateRunsCheck = false } = {}) {
  const pair = host === 'claude' && !gateRunsCheck ? ', and send an edit and the command that checks it in the same message (Claude Code runs them in order)' : '';
  return `Every tool round re-sends the whole context: read what you need in one message${pair}.`;
}

// The done rule under round five's flags. leanBrief drops the sentence that
// explains the gate: the line itself is what the model has to write, the
// double-check skill teaches the rest when it is loaded, and the gate says why
// when it holds. gateRunsCheck, where the gate can name the project's check,
// tells the model it need not spend a round on that check itself.
export function doneRule({ lean = false, check = null, doublePass = true, none = false } = {}) {
  // flags.briefNoCheckRule (off by default): the project names no check. "Run the smallest real
  // check" made a 9B write a check of its own (c10 F1: 14 extra shell calls in 16 screen runs, each
  // a whole opening), so say there is none. The pass line says "unverified", which the gate takes
  // as an honest answer rather than a claim.
  if (none && !check) return doublePass ? 'Done means verified as far as this project allows: it names no check, so do not write one; re-read each changed file adversarially and end the reply with "Pass 1: no check exists, so unverified by a run. Pass 2: <what the re-read found>."' : 'This project names no check, so do not write one; done means the requested change is made.';
  // verify.doublePass off: the gate will not ask for a second read, so the brief must not either.
  // Measured 2026-10-13 (subharness trial-02): the re-read and re-run this rule asks for cost a
  // 9B model 44% more calls than the same client without atlias, each one a whole opening.
  if (!doublePass) return check ? `Done means the check passes: if no check ran after your last edit, atlias runs \`${check}\` when you finish and holds the reply only if it fails.` : 'Done means verified: when the project has a check, run it after your last edit.';
  if (!lean && !check) return RULES[2];
  const head = check ? 'Done means verified: re-read each changed file adversarially and end with "Pass 1: <check and result, or: left to atlias>. Pass 2: <what the re-read found>."' : `Done means verified: run the smallest real check, re-read each changed file adversarially, and end the reply with ${PASS_LINE}`;
  const gate = lean ? '' : ' The gate holds a reply without that line, which costs a whole turn.';
  const runs = check ? ` If no check ran after your last edit, atlias runs \`${check}\` when you finish and holds the reply only if it fails.` : '';
  return head + gate + runs;
}

// Cutting a list mid-line and appending an ellipsis tells the reader nothing
// about what is missing. Cut on a line boundary and count the rest.
export function fitLines(text, maxChars) {
  const lines = String(text || '').split(/\r?\n/);
  const kept = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  const omitted = lines.filter((l) => l.trim()).length - kept.filter((l) => l.trim()).length;
  return { text: kept.join('\n'), omitted };
}

export const BRIEF_BUDGET_MS = 12000;
// flags.briefNoCheckRule: true when the project has no check atlias can name. visibleCheck reads only
// the top of the folder and names only check scripts, so a project whose test suite the loop runs
// (lib/loop.mjs detectTestCommand) is not one with no check (council 1013b b08 F1).
const SUITE_FILES = ['Cargo.toml', 'go.mod', 'pytest.ini', 'conftest.py'];
function hasTestSuite(cwd) {
  if (SUITE_FILES.some((f) => exists(path.join(cwd, f)))) return true;
  const pyproject = path.join(cwd, 'pyproject.toml');
  const text = readText(pyproject);
  if ((text === null && exists(pyproject)) || /\[tool\.pytest/.test(text || '')) return true;
  try { return fs.readdirSync(path.join(cwd, 'tests')).some((n) => /^test_.*\.py$/.test(n)); } catch (e) { return e.code !== 'ENOENT'; }
}
function noCheck(flags, cwd) {
  if (!flags.briefNoCheckRule) return false;
  if (hasTestSuite(cwd)) return false;
  const uncertainty = [];
  try { return !visibleCheck(cwd, { uncertainty }) && uncertainty.length === 0; } catch { return false; }
}
// flags.briefAllTools (off by default): the full brief named 8 of the server's 10 tools (c16 F2).
const TOOLS_LISTED = 'harness_recall, harness_remember, harness_progress, harness_verify, harness_digest, graph_query, graph_affected, graph_explain';
const TOOLS_ALL = 'harness_recall, harness_remember, harness_progress, harness_verify, harness_digest, harness_bench, harness_status, graph_query, graph_affected, graph_explain';
export function build(payload, host, given = null) {
  const started = Date.now();
  const cfg = given || config();
  const cwd = payload.cwd || process.cwd();
  const source = payload.source || 'startup';
  if (source === 'clear' && cfg.flags.authorityLedger) authority.clear(actorSession(payload, cfg));
  const flags = cfg.flags || {};
  const lean = Boolean(flags.leanBrief);
  const doublePass = !(cfg.verify && cfg.verify.doublePass === false);
  const lines = [];
  // flags.hooksOnly: atlias works through its hooks alone on this host. No MCP server is
  // registered (lib/hosts.mjs), so the brief names no tool: the handoff note, the exact requests
  // after a compaction or resume, and the rules that need no tool. Measured 2026-10-13 (Codex,
  // subharness trial-02): the server's definitions were most of the 1,900 tokens atlias added
  // to every call, a 9B called a real atlias tool once in 10 tasks, and 12 times it tried to
  // read or list project files through the server.
  if (flags.hooksOnly) {
    lines.push(`[atlias ${VERSION}] sub-harness linked to ${HOST_LABEL[host] || host} through its hooks. It adds no tools here.`);
    const kept = source === 'clear' ? null : progress.read(cwd, subagentTag(payload, cfg).subagent || '');
    if (kept) lines.push(`\n## Handoff from the last stretch of work\n${clip(kept, cfg.brief.progressChars)}`);
    // The only channel for the exact session authority after a compaction: PostCompact prints nothing.
    if (source === 'compact' || source === 'resume') {
      const exact = authority.render(actorSession(payload, cfg), cfg);
      if (exact) lines.push('\n' + exact);
    }
    let named = null;
    if (flags.gateRunsCheck) { try { const found = visibleCheck(cwd); named = found ? found.command : null; } catch { /* no check named */ } }
    const short = [RULES[1], doneRule({ lean, check: named, doublePass, none: noCheck(flags, cwd) }), roundsRule(host, { gateRunsCheck: Boolean(named) }), RULES[3], RULES[4]];
    if (!flags.noWorkingRules) lines.push(`\n## Working rules\n${short.map((r) => `- ${r}`).join('\n')}`);
    return lines.join('\n');
  }
  // Lean: the host lists the MCP server's tools itself (Claude Code loads their
  // names and defers the rest), so the brief only says where they come from.
  if (lean) lines.push(`[atlias ${VERSION}] sub-harness linked to ${HOST_LABEL[host] || host}; its tools are the MCP server "atlias".`);
  else lines.push(`[atlias ${VERSION}] sub-harness linked to ${HOST_LABEL[host] || host}. Tools: MCP server "atlias" (${flags.briefAllTools ? TOOLS_ALL : TOOLS_LISTED}); CLI \`node "${path.join(ROOT, 'bin', 'atlias.mjs')}"\`.`);

  // 1. Handoff note (most valuable after compact or resume).
  const note = source === 'clear' ? null : progress.read(cwd, subagentTag(payload, cfg).subagent || '');
  if (note) lines.push(`\n## Handoff from the last stretch of work\n${clip(note, cfg.brief.progressChars)}`);
  // The exact session authority, unclipped. After a compaction this is the only channel that
  // reaches the model: Claude Code shows PostCompact output to the user alone, so that hook prints nothing.
  if (source === 'compact' || source === 'resume') {
    const exact = authority.render(actorSession(payload, cfg), cfg);
    if (exact) lines.push('\n' + exact);
  }
  // After a compaction: what the summary Claude Code just wrote left out of the
  // note, named, and counted in the session's events so a loss can be seen.
  if (note && source === 'compact' && payload.transcript_path) {
    const summary = progress.compactSummary(payload.transcript_path);
    if (summary) {
      const audit = progress.auditSummary(note, summary);
      if (audit.missing.length) lines.push(`\n## What the compaction summary left out\nThe summary above this session kept ${audit.checked - audit.missing.length} of ${audit.checked} things the handoff note tracks. Not in it:\n${audit.missing.slice(0, 12).map((m) => `- ${m}`).join('\n')}`);
      try { recordEvent(payload.session_id || 'no-session', { kind: 'compact-audit', checked: audit.checked, missing: audit.missing.length }); } catch { /* the brief still stands */ }
    }
  }

  // 2. Shared memory. Claude Code loads its own MEMORY.md; other hosts get the index inline.
  const memDir = claudeMemoryDir(cwd);
  const index = path.join(memDir, 'MEMORY.md');
  if (exists(index)) {
    const n = readLines(index).filter((l) => l.startsWith('- ')).length;
    if (host === 'claude') lines.push(`\n## Memory\n${n} memories indexed at ${index} (already loaded by Claude Code). Bodies on demand: harness_recall.`);
    else {
      const fitted = fitLines(readText(index), cfg.brief.memoryChars);
      const rest = fitted.omitted ? `\n(${fitted.omitted} further memor${fitted.omitted === 1 ? 'y is' : 'ies are'} indexed but not listed here. harness_recall searches all of them.)` : '';
      lines.push(`\n## Memory (shared with Claude Code)\n${fitted.text}${rest}\nFull files: ${memDir}. Write new facts with harness_remember so every host sees them.`);
    }
  } else if (host !== 'claude') {
    lines.push(`\n## Memory\nNo shared memory yet for this project. Save durable facts with harness_remember (they land in ${memDir}).`);
  }

  // 3. Knowledge graph.
  const g = graph.status(cwd);
  if (g.exists) {
    // Past the budget the section still names the graph; only the hubs are dropped.
    const gods = Date.now() - started < BRIEF_BUDGET_MS ? graph.godNodes(cwd, cfg.graph.godNodes) : "";
    lines.push(`\n## Knowledge graph\ngraphify-out/graph.json updated ${g.age}. Hubs: ${gods || '(run graph_query)'}\nAsk graph_query before reading files; an answer costs a few hundred tokens, a file walk costs thousands.`);
  } else if (g.canBuild) {
    // Named apart from the budget clock above: two `started` in one function is
    // a bug waiting for the next edit.
    const kicked = cfg.graph.autoBuild && graph.scheduleUpdate(cwd, { build: true });
    lines.push(`\n## Knowledge graph\nNone yet. ${kicked ? 'atlias started an AST-only build in the background (graphify update); it appears in the next brief.' : 'Build one with /graphify (semantic) or `graphify update .` (AST only).'}`);
  }

  // 4. Dream: digests waiting for consolidation into memory.
  const pending = dream.pending(cwd);
  if (pending.count) lines.push(`\n## Dream pending\n${pending.count} session digest(s) at ${pending.digest}. At a natural pause, fold the durable facts into memory (harness_remember), then run harness_digest ack.`);

  // 5. Companions.
  const c = companions(cwd);
  const comp = [];
  const ufsLoaded = (c.ufsCopies || []).filter((copy) => copy.loaded);
  comp.push(ufsLoaded.length > 1
    ? 'ultimate-frontend-skills loaded ' + ufsLoaded.length + ' times (' + ufsLoaded.map((copy) => copy.where).join(', ') + '): keep one'
    : c.ufs ? 'ultimate-frontend-skills on (use /ultimate-frontend-skills for any page, screen or restyle)' : 'ultimate-frontend-skills off (install: claude plugin marketplace add ridelink0/ultimate-frontend-skills)');
  comp.push(c.graphify ? 'graphify ok' : 'graphify missing (pip install graphifyy)');
  // Lean: the section only when the model needs to know a duplicate skill copy
  // is loaded. What is installed or missing is for the user, and doctor says it.
  const act = comp.filter((line) => /keep one/.test(line));
  if (!lean) lines.push(`\n## Companions\n${comp.join('; ')}.`);
  else if (act.length) lines.push(`\n## Companions\n${act.join('; ')}.`);

  // 6. Working rules, right altitude. flags.noWorkingRules (off by default; Gev 2026-10-16, "Atlias
  // rules shouldn't make the model have more tokens"): none at all, so the model works as it does
  // natively. (A least-work rule set tried before it, Atlias's take on Ponytail, left the 9B at Read,
  // Edit, stop in sprint-lean-s1 and lost 2 of 5 screen tasks; Gev had it removed 2026-10-16.)
  if (flags.noWorkingRules) return lines.join('\n');
  let check = null;
  if (flags.gateRunsCheck) { try { const found = visibleCheck(cwd); check = found ? found.command : null; } catch { /* no check named */ } }
  const rules = [...RULES.slice(0, 2), doneRule({ lean, check, doublePass, none: noCheck(flags, cwd) }), roundsRule(host, { gateRunsCheck: Boolean(check) }), ...RULES.slice(3)];
  lines.push(`\n## Working rules\n${rules.map((r) => `- ${r}`).join('\n')}`);
  return lines.join('\n');
}

export function sessionStart(payload, host) {
  const sid = actorSession(payload);
  const cwd = payload.cwd || process.cwd();
  const meta = sessionMeta(sid);
  saveSessionMeta(sid, { ...meta, host, cwd, source: payload.source || 'startup', started: meta.started || Date.now() });
  try {
    const text = build(payload, host);
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
  } catch (e) { log(`brief failed: ${e.stack || e}`); return null; }
}
