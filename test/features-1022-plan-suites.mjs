// H.A.C council round two (2026-10-22, h2), feature 4: plan mode, approve to exit. Pure choice and an
// injected approval step, so no terminal is needed. The repl wiring only runs on a TTY (checked by reading it).
export default async function planSuites({ asyncSuite, check, agentMod }) {
  await asyncSuite('plan approval expert', 'plan approval: the three choices, and an unclear answer keeps planning', async () => {
    const pc = agentMod.planChoice;
    check('a and approve switch', pc('a') === 'approve' && pc(' Approve ') === 'approve' && pc('y') === 'approve', { happened: [pc('a'), pc(' Approve '), pc('y')].join(','), why: 'The person chose to approve the plan; the answer must be read as approval.', fix: 'Check planChoice.' });
    check('e asks for an edit', pc('e') === 'edit' && pc('edit') === 'edit', { happened: [pc('e'), pc('edit')].join(','), why: 'Editing is the third choice.', fix: 'Check planChoice.' });
    check('k, an empty answer and anything unclear keep planning', pc('k') === 'keep' && pc('') === 'keep' && pc('x') === 'keep' && pc('approve me') === 'keep', { happened: [pc('k'), pc(''), pc('x'), pc('approve me')].join(','), why: 'A plan must never be approved by an unclear answer.', fix: 'The default of planChoice is keep.' });
    check('the prompt names the three choices as the person sees them', agentMod.PLAN_PROMPT.includes('[a]pprove and switch to workspace, [k]eep planning, [e]dit'), { happened: agentMod.PLAN_PROMPT, why: 'The choices must be visible.', fix: 'Keep PLAN_PROMPT as written.' });
  });
  await asyncSuite('plan approval expert', 'plan approval: approve switches to workspace and carries the plan out; keep changes nothing', async () => {
    const calls = [];
    const out = [];
    const deps = {
      setPermission: (m) => { calls.push(m); return { ok: true, text: 'mode ' + m }; },
      turn: async (t) => { calls.push('turn:' + t); return 'done'; },
    };
    const approved = await agentMod.planApproval(async () => 'a', (t) => out.push(t), deps);
    check('approve sets workspace, then sends the approval, and returns its reply', calls[0] === 'workspace' && String(calls[1]).startsWith('turn:The plan is approved') && approved === 'done', { happened: calls.join(' | ') + ' => ' + approved, why: 'Approval must change the mode and start the work in the same step.', fix: 'Check planApproval.' });
    calls.length = 0;
    const kept = await agentMod.planApproval(async () => 'k', (t) => out.push(t), deps);
    check('keep sets nothing and sends nothing', calls.length === 0 && kept === null, { happened: calls.join(' | ') + ' => ' + kept, why: 'Keep planning must leave the mode and the conversation alone.', fix: 'Return null on keep without calling anything.' });
    calls.length = 0;
    const answers = ['e', 'use a map instead', 'k'];
    const edited = await agentMod.planApproval(async () => answers.shift(), (t) => out.push(t), deps);
    check('edit sends the change, then asks again, and changes no mode', calls.length === 1 && calls[0] === 'turn:Change the plan: use a map instead' && answers.length === 0 && edited === null, { happened: calls.join(' | ') + ' => ' + edited + ' left ' + answers.length, why: 'An edit is a request for a revised plan, which must come back for approval.', fix: 'Re-ask after the edit turn.' });
  });
}
