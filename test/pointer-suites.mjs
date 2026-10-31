// Pointer-first enforcement: the check that makes "ask the graph before you
// open files" cost something instead of being advice. Most of this file is the
// other half of that feature - every condition that keeps the nudge quiet has a
// check of its own, because a nudge that fired on every read would be worse
// than none. Loaded by test/run.mjs, which owns suite() and check().
import * as pointer from '../lib/pointer.mjs';

export default async function pointerSuites({ suite, check, core, track, router, TMP, ROOT, fs, path }) {
  const PROJ = path.join(TMP, 'pointer-project');
  const NOGRAPH = path.join(TMP, 'pointer-nograph');
  fs.mkdirSync(path.join(PROJ, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(PROJ, 'graphify-out', 'graph.json'), '{}');
  fs.mkdirSync(NOGRAPH, { recursive: true });
  const BIG = path.join(PROJ, 'big-module.mjs');
  const SMALL = path.join(PROJ, 'tiny.mjs');
  const OTHER = path.join(PROJ, 'second-module.mjs');
  const body = 'export function widen(n) { return n + 1; }\n'.repeat(400); // about 17 KB
  fs.writeFileSync(BIG, body);
  fs.writeFileSync(OTHER, body);
  fs.writeFileSync(SMALL, 'export const one = 1;\n');
  fs.writeFileSync(path.join(NOGRAPH, 'big-module.mjs'), body);
  const READ_ALL = 'cat'; // a whole-file read through the shell, the way Codex reads

  const sid = (n) => 'pointer-' + n;
  const turnFor = (s, text) => router.prompt({ session_id: s, cwd: PROJ, prompt: text });
  const readWhole = (s, cwd, file, extra = {}) => track.postTool({ session_id: s, cwd, tool_name: 'Read', tool_input: { file_path: file, ...extra } });
  const contextOf = (out) => (out && out.hookSpecificOutput ? out.hookSpecificOutput.additionalContext : '');

  suite('pointer-first expert', 'pointer-first: a whole file instead of a graph query', () => {
    check('a whole-file read is recognised, and a window is not', pointer.wholeFileRead('Read', { file_path: BIG }) === BIG && pointer.wholeFileRead('Read', { file_path: BIG, offset: 20, limit: 60 }) === null, { happened: `${pointer.wholeFileRead('Read', { file_path: BIG })} then ${pointer.wholeFileRead('Read', { file_path: BIG, offset: 20, limit: 60 })}`, why: 'Reading a window is already the pointer-first habit; nudging someone who is doing the right thing is how a harness trains a model to ignore it.', fix: 'Check READ_TOOLS and WINDOW_KEYS in wholeFileRead.' });
    check('a read through the shell counts, and a piped one does not', pointer.wholeFileRead('Bash', { command: `${READ_ALL} lib/app.mjs` }) === 'lib/app.mjs' && pointer.wholeFileRead('Bash', { command: `${READ_ALL} lib/app.mjs | sort` }) === null, { happened: `${pointer.wholeFileRead('Bash', { command: `${READ_ALL} lib/app.mjs` })} then ${pointer.wholeFileRead('Bash', { command: `${READ_ALL} lib/app.mjs | sort` })}`, why: 'Codex reads files through the shell, so a harness that only watches read tools sees nothing there. A pipe is a different operation and must not be mistaken for a read.', fix: 'Check SHELL_READ.' });
    check('a tool that is not a read is ignored', pointer.wholeFileRead('Grep', { pattern: 'x', path: BIG }) === null, { happened: String(pointer.wholeFileRead('Grep', { pattern: 'x', path: BIG })), why: 'grep and outline are the cheap moves; counting them as whole-file reads would nudge exactly the behaviour the rule wants.', fix: 'Keep READ_TOOLS to read tools.' });

    const s1 = sid('first');
    turnFor(s1, 'please make the export path faster than it is today');
    const nudge = readWhole(s1, PROJ, BIG);
    const text = contextOf(nudge);
    check('the first whole-file read of a turn is nudged', /pointer-first/.test(text) && text.includes('big-module.mjs'), { happened: text.slice(0, 200) || JSON.stringify(nudge), why: 'This is the whole feature: the rule existed in the brief and nothing enforced it, so a model could read the project file by file and pay nothing for skipping the graph.', fix: 'Check the conditions in pointer.consider.' });
    check('and the nudge names the query that should have run', /graph_query \{ question: "please make the export path faster/.test(text), { happened: text.split('\n').find((l) => /graph_query/.test(l)) || '(no query line)', why: 'A nudge that says "you should have asked the graph" without the question is a scolding; with the question it is one call away from being followed.', fix: 'Check pointer.question and pointer.reason.' });
    check('the read is not blocked', Boolean(nudge) && nudge.hookSpecificOutput.hookEventName === 'PostToolUse' && !nudge.decision && !nudge.hookSpecificOutput.permissionDecision, { happened: JSON.stringify(nudge).slice(0, 200), why: 'The read has already happened by the time this fires, and blocking after the fact would cost the tokens twice and lose the content. It is a note, not a decision.', fix: 'Return contextOutput, never a decision.' });
    const again = readWhole(s1, PROJ, OTHER);
    check('the same turn is not nudged twice', again === null, { happened: JSON.stringify(again), why: 'A turn that opens six files would otherwise pay six notes for one lesson, and the sixth is pure cost.', fix: 'Key the spent flag on the prompt id in consider.' });

    const s2 = sid('nograph');
    router.prompt({ session_id: s2, cwd: NOGRAPH, prompt: 'please make the export path faster than it is today' });
    check('a project with no graph is never nudged', track.postTool({ session_id: s2, cwd: NOGRAPH, tool_name: 'Read', tool_input: { file_path: path.join(NOGRAPH, 'big-module.mjs') } }) === null, { happened: 'a nudge fired with no graph to ask', why: 'There was nothing to ask. Telling someone to query a graph that does not exist is the worst kind of false alarm: it cannot even be obeyed.', fix: 'Return early unless graphPath exists.' });

    const s3 = sid('small');
    turnFor(s3, 'please make the export path faster than it is today');
    check('a file too small to matter is not nudged', readWhole(s3, PROJ, SMALL) === null, { happened: JSON.stringify(readWhole(s3, PROJ, SMALL)), why: 'Asking the graph about a twenty-line file costs more than reading it. The rule is about saving tokens, not obeying itself.', fix: 'Check pointer.minBytes in consider.' });

    const s4 = sid('named');
    turnFor(s4, 'have a look at big-module.mjs and tell me what widen does');
    check('a file the user named is not nudged', readWhole(s4, PROJ, BIG) === null, { happened: JSON.stringify(readWhole(s4, PROJ, BIG)), why: 'When the prompt names the file, opening it IS the request, and a note telling the model to ask where the file is reads as a harness that did not listen.', fix: 'Check namedInPrompt.' });

    const s5 = sid('asked');
    turnFor(s5, 'please make the export path faster than it is today');
    core.recordEvent(s5, { kind: 'tool', tool: 'mcp__plugin_atlias_atlias__graph_query' });
    check('a turn that already asked the graph is not nudged', readWhole(s5, PROJ, BIG) === null, { happened: JSON.stringify(readWhole(s5, PROJ, BIG)), why: 'The file being read is probably the file the graph just named. Nudging there punishes the exact behaviour the rule asks for.', fix: 'Check graphAsked, including the host prefix on MCP tool names.' });

    const s6 = sid('mine');
    turnFor(s6, 'please make the export path faster than it is today');
    core.recordEvent(s6, { kind: 'edit', tool: 'Write', files: [BIG] });
    check('a file this session wrote is not nudged', readWhole(s6, PROJ, BIG) === null, { happened: JSON.stringify(readWhole(s6, PROJ, BIG)), why: 'After an edit the graph is the stale one, not the file. Re-reading what you just changed is correct and must not cost a note.', fix: 'Check pointer.touched.' });

    const s7 = sid('budget');
    let spoke = 0;
    for (let i = 0; i < 5; i++) {
      turnFor(s7, `turn ${i}: please make the export path faster than it is today`);
      if (contextOf(readWhole(s7, PROJ, BIG))) spoke++;
    }
    check('the session budget caps the nudges', spoke === core.DEFAULTS.pointer.perSession, { happened: `${spoke} nudges over 5 turns against a budget of ${core.DEFAULTS.pointer.perSession}`, why: 'One lesson repeated twenty times in a long session is twenty times the cost for the same teaching, and it trains the model to skim past the note.', fix: 'Check the spent counter in consider.' });

    const off = pointer.consider({ session_id: sid('off'), cwd: PROJ, tool_name: 'Read', tool_input: { file_path: BIG } }, { pointer: { nudge: false, minBytes: 0, perSession: 9 } });
    check('the setting switches it off', off === null, { happened: JSON.stringify(off), why: 'Every atlias behaviour that speaks has to be one a user can silence, or the harness argues with the user.', fix: 'Check pointer.nudge at the top of consider.' });
  });

  suite('pointer-first helper expert', 'pointer-first: the parts the nudge is made of', () => {
    check('a graph event from the router counts as asking', pointer.graphAsked([{ kind: 'graph', via: 'router' }]) && pointer.graphAsked([{ kind: 'shell', command: 'python -m graphify query "where is x"' }]) && !pointer.graphAsked([{ kind: 'tool', tool: 'Read' }]), { happened: 'graphAsked disagreed with one of the three', why: 'The router answers codebase questions from the graph before the model does anything; a nudge that cannot see that would fire on the very read the router asked for.', fix: 'Check GRAPH_ASK and graphAsked.' });
    check('a prompt naming the file, or its stem, is recognised', pointer.namedInPrompt('open lib/gate.mjs please', '/p/lib/gate.mjs') && pointer.namedInPrompt('what does the gate module do', '/p/gate.mjs') && !pointer.namedInPrompt('make the exports faster', '/p/gate.mjs'), { happened: 'namedInPrompt disagreed with one of the three', why: 'The commonest false alarm is nudging a read the user asked for by name.', fix: 'Check namedInPrompt; the stem needs four characters before it is worth matching.' });
    check('an edit event for the file is found', pointer.touched([{ kind: 'edit', files: [BIG] }], BIG) && !pointer.touched([{ kind: 'edit', files: [OTHER] }], BIG) && !pointer.touched([{ kind: 'tool', tool: 'Read' }], BIG), { happened: 'touched disagreed with one of the three', why: 'A file the session wrote is a file the session knows.', fix: 'Check pointer.touched.' });
    const slice = pointer.turnSlice([{ kind: 'prompt', prompt_id: 'p1', text: 'the first turn' }, { kind: 'tool', tool: 'Read' }, { kind: 'prompt', prompt_id: 'p2', text: 'the second turn' }, { kind: 'tool', tool: 'Grep' }]);
    check('the turn starts at the last prompt', slice && slice.promptId === 'p2' && slice.turn.length === 1 && slice.turn[0].tool === 'Grep', { happened: JSON.stringify(slice), why: 'Reading from the start of the window would drag a previous turn\'s graph query in and silence the nudge for ever.', fix: 'Check turnSlice.' });
    check('no prompt marker in the window means no turn, and no nudge', pointer.turnSlice([{ kind: 'tool', tool: 'Read' }]) === null && pointer.turnSlice([]) === null, { happened: JSON.stringify(pointer.turnSlice([{ kind: 'tool', tool: 'Read' }])), why: 'A convenience must never pay for a full read of a whole session log; the gate does that because it has to, and this does not.', fix: 'Return null rather than falling back to the whole log.' });
    check('the query is the user\'s own question when there is one', pointer.question(BIG, '  How does the  export flow reach the worker? ') === 'How does the export flow reach the worker?', { happened: pointer.question(BIG, '  How does the  export flow reach the worker? '), why: 'That question is exactly what the graph exists to answer, so it is the best possible suggestion.', fix: 'Check pointer.question.' });
    check('and falls back to the file when the prompt says too little', pointer.question(BIG, 'ok') === 'where is big-module used and what depends on it', { happened: pointer.question(BIG, 'ok'), why: 'A suggested query of "ok" would be worse than no suggestion.', fix: 'Check the length floor in pointer.question.' });
    const r = pointer.reason(PROJ, BIG, 13000, 'where is widen used');
    check('the note names the file, its size and the query', r.includes('big-module.mjs') && r.includes('13 KB') && r.includes('where is widen used') && /What went wrong:/.test(r) && /Fix:/.test(r), { happened: r.slice(0, 220), why: 'Every other thing atlias says follows the same shape - what happened, why it matters, what to do - and a model can only change course if the note says what to change.', fix: 'Keep the four lines in pointer.reason.' });
    const sP = sid('envelope');
    turnFor(sP, 'please make the export path faster than it is today');
    const env = pointer.postTool({ session_id: sP, cwd: PROJ, tool_name: 'Read', tool_input: { file_path: BIG } }, core.config());
    check('postTool wraps the note as a PostToolUse context output and nothing more', env && env.hookSpecificOutput && env.hookSpecificOutput.hookEventName === 'PostToolUse' && /pointer-first/.test(env.hookSpecificOutput.additionalContext) && Object.keys(env).length === 1, { happened: JSON.stringify(env).slice(0, 220), why: 'This is the hook entry point the host actually calls. A note in the wrong envelope, or one carrying a decision field beside it, would either never reach the model or would block a read that has already happened.', fix: 'Return contextOutput(PostToolUse, text) from pointer.postTool and nothing else.' });
    check('and it says nothing when the note would not fire', pointer.postTool({ session_id: sid('envelope-quiet'), cwd: NOGRAPH, tool_name: 'Read', tool_input: { file_path: path.join(NOGRAPH, 'big-module.mjs') } }, core.config()) === null, { happened: JSON.stringify(pointer.postTool({ session_id: sid('envelope-quiet'), cwd: NOGRAPH, tool_name: 'Read', tool_input: { file_path: path.join(NOGRAPH, 'big-module.mjs') } }, core.config())), why: 'PostToolUse fires on every tool call in a session; anything but null on the common path is a note on every read.', fix: 'postTool returns null when consider does.' });
    const routerSrc = fs.readFileSync(path.join(ROOT, 'lib', 'router.mjs'), 'utf8');
    check('the router records a graph event beside the answer it injects', /recordEvent\(sid, \{ kind: 'graph'/.test(routerSrc), { happened: routerSrc.split('\n').filter((l) => /kind: 'graph'/.test(l)).join(' | ') || '(no graph event recorded)', why: 'Without that event the nudge cannot tell a model that skipped the graph from one the router already answered for, and it would fire on the first file of every codebase question.', fix: 'Record { kind: graph } in router.prompt when it returns an answer.' });
  });
}
