// Sub-agents in Atlias's own loop (Gev, 2026-10-21): the model may hand a
// self-contained part of the work to a fresh sub-agent; several start at once;
// one level only; never offered on the benchmark path.
import * as loop from '../lib/loop.mjs';

export default async function subagentSuites({ asyncSuite, check, core, agentMod, TMP, fs, path }) {
  let n = 0;
  const work = () => { const d = path.join(TMP, 'subagents', `w${++n}`); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'a.txt'), 'alpha\n'); return d; };
  const block = (o) => '```atlias\n' + JSON.stringify(o) + '\n```';
  const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 };
  // A scripted engine: sub-agent conversations are recognised by their brief.
  function engine(parentReplies, log) {
    const live = { now: 0, max: 0 };
    const chat = async (messages) => {
      const first = messages.find((m) => m.role === 'user');
      const isChild = /a sub-agent of atlias/.test(String(first && first.content));
      log.push({ child: isChild, system: messages[0].content });
      if (isChild) {
        live.now++; live.max = Math.max(live.max, live.now);
        await new Promise((r) => setTimeout(r, 40));
        live.now--;
        const task = /Task: (.*)$/m.exec(first.content)[1];
        return { content: `found ${task}`, calls: [], usage, requestUsages: [usage] };
      }
      return { content: parentReplies.shift() || 'all done', calls: [], usage, requestUsages: [usage] };
    };
    return { chat, live };
  }

  await asyncSuite('sub-agent expert', 'sub-agents: offered only when asked, run together, one level, answer only', async () => {
    check('the agent tool is not in the tool table, so requests without sub-agents keep every byte', !loop.TOOL_NAMES.includes('agent') && !loop.offeredTools('all', true).some((t) => t.name === 'agent') && loop.offeredTools('all', true, ['agent']).some((t) => t.name === 'agent'),
      { happened: loop.offeredTools('all', true, ['agent']).map((t) => t.name).join(','), why: 'Stored benchmark runs must stay comparable; the tool list is re-sent on every call.', fix: 'Keep AGENT_TOOL outside TOOLS and add it through extra.' });
    check('the native schema lists it only when asked', loop.toolSchemas(true, 'all', ['agent']).some((t) => t.function.name === 'agent') && !loop.toolSchemas(true, 'all').some((t) => t.function.name === 'agent'),
      { happened: 'toolSchemas', why: 'Native engines read the schema list.', fix: 'Pass extra into toolSchemas.' });

    const log = [];
    const { chat, live } = engine([`Two parts.\n${block({ tool: 'agent', task: 'list the callers of parse', name: 'finder' })}\n${block({ tool: 'agent', task: 'read the tests for parse' })}`], log);
    const said = [];
    const st = agentMod.newState(work(), 'echo');
    const answer = await loop.runLoop(st, 'look into parse', { chat, say: (t) => said.push(t), native: false, subagents: true });
    const results = st.messages.filter((m) => m.role === 'user' && /finished/.test(String(m.content))).map((m) => m.content).join('\n');
    check('two agent blocks run two sub-agents and the parent gets both answers', /finder finished/.test(results) && /found list the callers of parse/.test(results) && /found read the tests for parse/.test(results) && answer === 'all done',
      { happened: JSON.stringify({ answer, results }), why: 'The parent must see each sub-agent\'s final answer.', fix: 'Check runSubagent and the agent case in runToolCore.' });
    check('the two sub-agents ran at the same time', live.max === 2, { happened: `at most ${live.max} at once`, why: 'Gev asked for sub-agents; Claude Code runs them in parallel.', fix: 'Start every agent block of a reply before running the calls in order.' });
    const parentSys = log.find((l) => !l.child).system, childSys = log.find((l) => l.child).system;
    check('the parent is offered the agent tool and a sub-agent is not (one level)', /agent\{task,name,engine,model\}/.test(parentSys) && !/agent\{task,name,engine,model\}/.test(childSys),
      { happened: `parent ${/agent\{/.test(parentSys)} child ${/agent\{/.test(childSys)}`, why: 'Nested sub-agents multiply cost without bound.', fix: 'Offer extra only when depth is 0.' });
    check('the sub-agents\' token counts join the parent\'s', st.cache && st.cache.calls === 4 && st.cache.reported === 4,
      { happened: JSON.stringify(st.cache), why: '/cost must count every call the turn made.', fix: 'Merge child.cache into state.cache.' });
    check('the screen shows each sub-agent start and finish', said.some((t) => /finder started/.test(t)) && said.some((t) => /finder finished/.test(t)),
      { happened: said.join(' | '), why: 'The person must see what is running.', fix: 'Say start and finish in runSubagent.' });

    const log2 = [];
    const off = engine([block({ tool: 'agent', task: 'anything' })], log2);
    const st2 = agentMod.newState(work(), 'echo');
    await loop.runLoop(st2, 'try it', { chat: off.chat, native: false });
    const offResult = st2.messages.map((m) => String(m.content)).join('\n');
    check('without subagents (the benchmark path) the tool is neither offered nor run', !/agent\{task/.test(log2[0].system) && /sub-agents are not available/.test(offResult) && !log2.some((l) => l.child),
      { happened: offResult.slice(-300), why: 'Eval and benchmark runs call runLoop without subagents and must not change.', fix: 'Default subagents to false in runLoop.' });

    const empty = await loop.runSubagent({ subagent: { chat: off.chat }, sid: 's', cwd: TMP }, { tool: 'agent', task: '  ' });
    check('an agent call with no task says how to write one', /give the sub-agent a task/.test(empty), { happened: empty, why: 'A clear error is an observation the model can act on (RESEARCH-FIRST H3).', fix: 'Check the empty-task branch.' });
    check('interactive turns offer sub-agents by default and the setting can turn them off', core.DEFAULTS.agent.subagents === 'on' && agentMod.subagentsOn({}) === true && agentMod.subagentsOn({ subagents: 'off' }) === false,
      { happened: core.DEFAULTS.agent.subagents, why: 'Gev wants Atlias to spawn sub-agents for every user.', fix: 'Default agent.subagents to on.' });
  });
}
