#!/usr/bin/env node
// atlias hook dispatcher. One entry point for every host event:
//   node lib/hooks.mjs <event> [--host claude|codex|gemini]
// Reads the host's JSON payload on stdin, prints JSON only when there is
// something to say (silence costs the model nothing), and always exits 0 so a
// harness fault can never break the host.
import { readStdin, emit, detectHost, log, flagStamp, flagLine, config, actorSession } from './core.mjs';
import { planTurn, reportTurn, HOOK_TIMEOUT_MS } from './local-helpers.mjs';
import * as brief from './brief.mjs';
import * as router from './router.mjs';
import * as guard from './guard.mjs';
import * as track from './track.mjs';
import * as gate from './gate.mjs';
import * as progress from './progress.mjs';
import * as dream from './dream.mjs';
import * as graph from './graph.mjs';
import { hooksActive } from './settings.mjs';

const event = process.argv[2] || '';
const host = detectHost();

// Gemini CLI hooks take a flat shape ({decision, additionalContext, reason}).
// Claude Code and Codex share the hookSpecificOutput shape. UNVERIFIED for Gemini
// beyond what graphify ships for its own BeforeTool hook.
export function shape(out, h = host) {
  if (!out || h !== 'gemini') return out;
  // A plain-text result (PreCompact) keeps the flat shape Gemini's PreCompress hook had before.
  if (typeof out === 'string') return { decision: 'allow', additionalContext: out };
  const hs = out.hookSpecificOutput || {};
  if (out.decision === 'block') return { decision: 'deny', reason: out.reason };
  if (hs.permissionDecision === 'deny') return { decision: 'deny', reason: hs.permissionDecisionReason };
  if (hs.additionalContext) return { decision: 'allow', additionalContext: hs.additionalContext };
  return { decision: 'allow' };
}

export function dispatch(ev, payload, h) {
  switch (ev) {
    case 'session-start': return brief.sessionStart(payload, h);
    case 'prompt': return router.prompt(payload, h);
    case 'pre-tool': return guard.preTool(payload, h);
    case 'post-tool': return track.postTool(payload, h);
    case 'post-tool-failure': return track.postToolFailure(payload, h);
    case 'pre-compact': return progress.preCompact(payload, h);
    case 'post-compact': return progress.postCompact(payload, h);
    case 'stop': return gate.stop(payload, h);
    case 'subagent-stop': return track.subagentStop(payload, h);
    case 'session-end': return dream.sessionEnd(payload, h);
    default: log(`unknown event ${ev}`); return null;
  }
}

async function main() {
  if (event === 'dream-worker') return dream.worker(process.argv.slice(3));
  if (event === 'graph-worker') return graph.worker(process.argv.slice(3));
  const payload = await readStdin();
  // Standalone mode keeps atlias out of other harnesses' sessions entirely.
  if (!hooksActive()) return;
  // A study switches round-five flags per arm through the environment the host
  // starts its hooks in. Once a session, the log says what this one ran with,
  // so an arm can be checked after the fact; quiet when no flag is in play.
  if (event === 'session-start') {
    const f = flagStamp();
    if (f.changed.length || Object.keys(f.env).length || f.unknown.length || f.bad.length) log(`session-start ${payload && payload.session_id ? payload.session_id : ''} flags: ${flagLine(f)}`);
  }
  const out = shape(await withHelpers(event, payload, dispatch(event, payload, host), host));
  // Claude Code reads a PreCompact hook's plain stdout as extra summary instructions and
  // rejects hookSpecificOutput for it, so a string result is written as text, not JSON.
  if (typeof out === 'string') process.stdout.write(out + '\n');
  else if (out) emit(out);
}

// The local planner and reporter (lib/local-helpers.mjs), off unless localPipeline turns them on.
// prompt: the planner's labelled advice is added after any other context. stop: when the turn really
// ends (nothing blocked it), the reporter's unverified line is shown to the person as a system
// message, which the model does not read. Claude Code only; any other host is left as it was.
export async function withHelpers(ev, payload, out, h = host, deps = {}) {
  if (h !== 'claude' || (ev !== 'prompt' && ev !== 'stop') || !payload) return out;
  const cfg = config();
  const sid = actorSession(payload, cfg);
  if (ev === 'prompt') {
    const planned = await planTurn({ cfg, sid, fetchImpl: deps.fetchImpl, timeoutCap: HOOK_TIMEOUT_MS.prompt });
    if (!planned.ran || !planned.block) return out;
    const prior = out?.hookSpecificOutput?.additionalContext;
    return { ...(out || {}), hookSpecificOutput: { ...(out?.hookSpecificOutput || {}), hookEventName: 'UserPromptSubmit', additionalContext: prior ? `${prior}\n\n${planned.block}` : planned.block } };
  }
  if (out && out.decision === 'block') return out;
  const reported = await reportTurn({ cfg, sid, answer: payload.last_assistant_message, fetchImpl: deps.fetchImpl, timeoutCap: HOOK_TIMEOUT_MS.stop });
  if (!reported.ran || !reported.line) return out;
  return { ...(out || {}), systemMessage: reported.line };
}

if (process.argv[1] && /hooks\.mjs$/.test(process.argv[1])) {
  main()
    .catch((e) => log(`${event} failed: ${e && e.stack ? e.stack : e}`))
    .finally(() => {
      // Never process.exit here: stdout to a pipe is asynchronous, and exiting
      // would truncate whatever has not been flushed. Setting the code lets
      // the write finish and the process end on its own.
      process.exitCode = 0;
      // Backstop: if some handle keeps the loop alive, leave rather than hold
      // up the host. Unreferenced, so it never delays a clean exit.
      if (!/worker$/.test(event)) setTimeout(() => process.exit(0), 10000).unref();
    });
}
