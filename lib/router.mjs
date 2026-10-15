// UserPromptSubmit: record the prompt boundary (the gate and the handoff note
// need it) and inject context only when it replaces more expensive work:
// a graph answer to a codebase question, or a one-time companion pointer.
import { config, recordEvent, events, mtime, sessionMeta, saveSessionMeta, sha, clip, exists, graphPath, subagentTag, actorSession } from './core.mjs';
import * as graph from './graph.mjs';
import { companions } from './brief.mjs';
import * as authority from './authority.mjs';

export const CODEBASE_RE = /\b(how (does|do|is|are)|where (is|are|does|do)|what (calls|uses|depends|happens|breaks)|which (file|module|function|component)|trace|walk me through|explain (the )?(flow|architecture|code|module)|architecture|call graph|data flow|entry point|impact of|affected by|depends on|dependenc(y|ies)|relationship between|why does)\b/i;
export const FRONTEND_RE = /\b(landing page|website|web ?page|home ?page|hero section|restyle|redesign the (ui|page|site)|parallax|three\.js|webgl|gsap|tailwind|css animation|start screen)\b/i;

export function classify(prompt) {
  const p = String(prompt || '');
  if (p.length < 12 || p.startsWith('/')) return 'skip';
  if (CODEBASE_RE.test(p)) return 'codebase';
  if (FRONTEND_RE.test(p)) return 'frontend';
  return 'other';
}

// A graph answer is only as current as the graph. When files have changed
// since it was built, the answer still helps, but it must not be quoted as
// settled fact.
export function staleNote(cwd, sid) {
  const built = mtime(graphPath(cwd));
  if (!built) return '';
  const newestEdit = events(sid).filter((e) => e.kind === 'edit').reduce((m, e) => Math.max(m, e.t || 0), 0);
  if (newestEdit <= built) return '';
  return '\n[atlias] Files have changed since this graph was built, so parts of this answer may be out of date. Confirm anything load-bearing against the files it names.';
}

export function prompt(payload) {
  const cfg = config();
  const sid = payload.session_id || 'no-session';
  const cwd = payload.cwd || process.cwd();
  const text = String(payload.prompt || '');
  // atlias_generated: text Atlias wrote (a /review prompt), never the person's request.
  if (cfg.flags.authorityLedger && !payload.atlias_generated) {
    authority.record(actorSession(payload, cfg), text, payload.prompt_id);
    authority.selected(payload);
  }
  const promptId = payload.prompt_id || sha(`${sid}:${Date.now()}:${text.slice(0, 80)}`);
  recordEvent(sid, { kind: 'prompt', prompt_id: promptId, text: clip(text, 200), ...subagentTag(payload, cfg) });
  const metaSid = actorSession(payload, cfg);
  const meta = sessionMeta(metaSid);
  saveSessionMeta(metaSid, { ...meta, cwd, lastPromptId: promptId });

  const kind = classify(text);
  if (kind === 'skip' || kind === 'other') return null;

  if (kind === 'codebase' && cfg.router.graph && exists(graphPath(cwd))) {
    const answer = graph.query(cwd, text.slice(0, 300), cfg.graph.queryBudget);
    // Recorded so the pointer-first nudge knows the graph has already answered
    // for this turn: a file the router itself named is exactly the file to open.
    if (answer) {
      recordEvent(sid, { kind: 'graph', via: 'router', ...subagentTag(payload, cfg) });
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `[atlias graph, ${cfg.graph.queryBudget}-token budget] Use this before opening files; open only what it names.\n${answer}${staleNote(cwd, sid)}` } };
    }
    return null;
  }
  if (kind === 'frontend' && cfg.router.companions && !meta.hintedFrontend) {
    const c = companions(cwd);
    saveSessionMeta(metaSid, { ...sessionMeta(metaSid), hintedFrontend: true });
    if (c.ufs) return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '[atlias] Frontend work: invoke the ultimate-frontend-skills skill before designing or styling; it carries the reference corpus and the anti-AI-tell audit.' } };
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '[atlias] Frontend work and ultimate-frontend-skills is not installed. Offer: `claude plugin marketplace add ridelink0/ultimate-frontend-skills` then `claude plugin install ultimate-frontend-skills@ultimate-frontend-skills`.' } };
  }
  return null;
}
