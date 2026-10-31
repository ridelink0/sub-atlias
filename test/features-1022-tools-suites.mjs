// H.A.C round two: web_fetch and background are offered to interactive turns only (wiring of features 5 and 6).
// The commands here are harmless if they ever run: a destructive one is refused by the guard, and the plan-mode
// test runs "echo" only. No network: the local address is refused before any connection.
import * as loop from '../lib/loop.mjs';
import * as bg from '../lib/background.mjs';
import * as core from '../lib/core.mjs';
import * as permissions from '../lib/permissions.mjs';

export default async function toolSuites({ asyncSuite, check, TMP }) {
  const blk = (obj) => '```atlias\n' + JSON.stringify(obj) + '\n```';
  const scripted = (replies) => { const left = [...replies]; return async () => ({ content: left.length ? left.shift() : 'Done.' }); };
  const fresh = (sid) => ({ sid, cwd: TMP, engine: 'echo', messages: [], history: [], todo: [], asks: [], edited: new Set(), reads: new Map(), undo: [], clock: 0, obs: 0, editedAt: 0, verifiedAt: 0 });
  const names = (extra) => loop.offeredTools('all', false, extra).map((t) => t.name);
  const text = (st) => st.messages.map((m) => String(m.content)).join(' | ');
  await asyncSuite('interactive tools expert', 'interactive tools: with no extra the tool list is the base list; each new tool is offered only when named', async () => {
    const base = loop.TOOL_NAMES.filter((n) => n !== 'graph_query');
    check('with no extra, the offered tools are exactly the base tools', JSON.stringify(names([])) === JSON.stringify(base), { happened: names([]).join(','), why: 'The eval path must send the same tool list as before (golden.mjs checks the bytes).', fix: 'offeredTools must add nothing when extra is empty.' });
    check('web_fetch and background are offered only when named in extra, in that order', names(['web_fetch']).slice(-1)[0] === 'web_fetch' && !names(['web_fetch']).includes('background') && JSON.stringify(names(['web_fetch', 'background']).slice(-2)) === '["web_fetch","background"]' && !names([]).includes('background'), { happened: names(['web_fetch', 'background']).join(','), why: 'Each tool is its own switch.', fix: 'Check offeredTools.' });
  });
  await asyncSuite('interactive tools expert', 'interactive tools: an eval run refuses web_fetch; an interactive run runs it and refuses a local address before any connection', async () => {
    const evalState = fresh('tools-eval');
    await loop.runLoop(evalState, 'fetch it', { chat: scripted([blk({ tool: 'web_fetch', url: 'http://127.0.0.1/' }), 'Done.']), say: () => {}, ask: null });
    check('a run without interactive does not run web_fetch', /unknown tool web_fetch/.test(text(evalState)), { happened: text(evalState).slice(0, 200), why: 'The benchmark path must not reach the network through a new tool.', fix: 'Gate the case on state.interactive.' });
    const live = fresh('tools-live');
    await loop.runLoop(live, 'fetch it', { chat: scripted([blk({ tool: 'web_fetch', url: 'http://127.0.0.1/' }), 'Done.']), say: () => {}, ask: null, interactive: true });
    check('an interactive run runs web_fetch, and the address check refuses the local address', /web_fetch refused: 127\.0\.0\.1 is a private address/.test(text(live)), { happened: text(live).slice(0, 200), why: 'The tool must run in interactive turns, through the address check.', fix: 'Check the web_fetch case.' });
  });
  await asyncSuite('interactive tools expert', 'interactive tools, B1: a background command takes the shell guard and the permission check; nothing refused starts', async () => {
    const before = bg.running();
    const guarded = fresh('tools-guard');
    await loop.runLoop(guarded, 'run it', { chat: scripted([blk({ tool: 'background', command: 'echo rm -rf /' }), 'Done.']), say: () => {}, ask: null, interactive: true });
    check('a destructive background command is refused by the guard and nothing starts', /refused/.test(text(guarded)) && bg.running() === before, { happened: `${text(guarded).slice(0, 160)} | running ${bg.running()} (was ${before})`, why: 'A background job has no one to confirm it; the same guard as the shell tool decides.', fix: 'Pass the guard in the background case.' });
    const planned = fresh('tools-plan');
    core.setRunOverride({ agent: { permissions: 'plan' } });
    try { await loop.runLoop(planned, 'run it', { chat: scripted([blk({ tool: 'background', command: 'echo planned' }), 'Done.']), say: () => {}, ask: null, interactive: true }); }
    finally { core.setRunOverride(null); }
    const refusal = permissions.planRefusal('background').slice(0, 30);
    check('in plan mode a background command gets the same refusal as a shell command, and nothing starts', text(planned).includes(refusal) && bg.running() === before, { happened: `${text(planned).slice(0, 160)} | running ${bg.running()} (was ${before})`, why: 'Plan mode is read-only; a background job would run a command in it.', fix: 'commandTool must include background starts in the permission block.' });
  });

  await asyncSuite('interactive tools expert', 'eval path: a run without interactive sends the base tool list and no interactive text; interactive adds only the two tools', async () => {
    const capture = () => {
      const seen = [];
      const chat = async (messages, tools) => { seen.push({ system: String(messages[0].content), tools: tools ? tools.map((t) => (t.function ? t.function.name : t.name)) : null }); return { content: 'Done.', calls: [] }; };
      return { seen, chat };
    };
    const plain = capture();
    await loop.runLoop(fresh('bytes-plain'), 'hello', { chat: plain.chat, say: () => {}, ask: null, native: true });
    const live = capture();
    await loop.runLoop(fresh('bytes-live'), 'hello', { chat: live.chat, say: () => {}, ask: null, native: true, interactive: true });
    const baseTools = loop.TOOL_NAMES.filter((n) => n !== 'graph_query');
    check('the eval path sends the base tool list, in order', JSON.stringify(plain.seen[0].tools) === JSON.stringify(baseTools), { happened: String(plain.seen[0].tools), why: 'The benchmark request must not gain a tool (golden.mjs checks the bytes too).', fix: 'Gate the new tools on interactive in runLoop.' });
    check('the eval path system text names neither interactive tool', !/web_fetch|background{/.test(plain.seen[0].system), { happened: 'web_fetch or background found in the eval system text', why: 'A tool line in the prompt is the same cost as a tool in the list.', fix: 'Keep extra empty when interactive is false.' });
    check('interactive adds exactly the two tools after the base list', JSON.stringify(live.seen[0].tools) === JSON.stringify([...baseTools, 'web_fetch', 'background']), { happened: String(live.seen[0].tools), why: 'Interactive turns are the only place the two tools are offered.', fix: 'Check the extra list in runLoop.' });
    const textPlain = capture();
    await loop.runLoop(fresh('text-plain'), 'hello', { chat: textPlain.chat, say: () => {}, ask: null });
    const textLive = capture();
    await loop.runLoop(fresh('text-live'), 'hello', { chat: textLive.chat, say: () => {}, ask: null, interactive: true });
    check('in text mode the eval system text names no interactive tool, and interactive names both', !/web_fetch/.test(textPlain.seen[0].system) && /web_fetch{url/.test(textLive.seen[0].system) && /background{command/.test(textLive.seen[0].system), { happened: 'text-mode system texts differ as expected? see the two runs', why: 'In text mode the tool line is part of the system prompt, so it is where a leak would show.', fix: 'Keep extra empty when interactive is false.' });
  });
}
