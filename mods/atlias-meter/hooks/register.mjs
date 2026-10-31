// atlias-meter: a read-only mod for Claude Code 2.1.287 or newer. Every hook
// here passes its event on exactly as it arrived. The one thing it adds to a
// session is the /atlias-meter command, which prints what has been counted.
// Codex's two reports for Gev (2026-10-12) both put a read-only meter first:
// what each piece costs has to be known before anything is cut.
import { newTally, add, addChars, addUsage, addStep, resultChars, resultErrors, toolGroup, table } from './meter.mjs';

const tally = newTally();
export const COMMAND = 'atlias-meter';
export const STORE_KEY = 'atlias-meter.last';

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show what skills, tools, context, reminders and tool results have cost since the mod loaded', immediate: true });
    return next(e);
  });
  on('command.run', { command: COMMAND }, async () => ({ text: table(tally) }))
    .catch(async () => ({ text: 'atlias-meter could not print its table; nothing else is affected.' }));
  // What Claude Code injects for the model on its own: the skill listing, reminders, instruction files, hook context.
  on('prompt.attachment', async ($, e, next) => { add(tally, 'attachment:' + e.type, e.text); return next(e); });
  // A skill's text when it is expanded.
  on('skill.prompt', async ($, e, next) => { add(tally, 'skill:' + e.skill, e.text); return next(e); });
  // Each tool's description, once, and whether it waits behind tool search.
  on('tool.describe', async ($, e, next) => { add(tally, (e.isDeferred ? 'tool-deferred:' : 'tool:') + toolGroup(e.tool), e.description); return next(e); });
  // The blocks sent with a conversation's first message.
  on('prompt.context', async ($, e, next) => { for (const block of e.blocks || []) add(tally, 'context:' + block.name, block.text); return next(e); });
  // Every tool result as it is stored, by the tool that produced it.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const group = toolGroup(e.origin && e.origin.tool);
    addChars(tally, 'result:' + group, resultChars(e.message));
    resultErrors(tally, group, e.message);
    return next(e);
  })
    // If the count ever fails, the row is stored exactly as it would have been without the mod.
    .catch(async ($, e, next) => next(e));
  // Every request: what the API says it cost, summed, and one exact ledger row with the tool
  // names and argument key names it called. A failed count leaves the result untouched.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e);
    try {
      addUsage(tally, result && result.usage, e.agentId);
      addStep(tally, result, e.agentId);
    } catch { /* the result goes on as the engine streamed it */ }
    return result;
  });
  // Kept where another session can read it; a failed save must never fail the turn.
  on('turn.complete', async ($, e, next) => {
    try { await $.store.set(STORE_KEY, tally); } catch { /* the command still shows it */ }
    return next(e);
  });
}
