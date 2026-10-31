import { terminalTheme } from '../lib/terminal-appearance.mjs';
import * as settings from '../lib/settings.mjs';
import * as commands from '../lib/commands.mjs';
import * as qol from '../lib/qol.mjs';

export default async function({ suite, asyncSuite, check, core, agentMod, TMP, fs, path }) {
  const detail = happened => ({ happened: String(happened || ''), why: 'Customization must remain discoverable and refuse ambiguous input.', fix: 'Check settings filtering, exact selection and command dispatch.' });
  suite('customization expert', 'customization: searchable settings keep stable identities', () => {
    const all = settings.rows(), common = settings.selectRows(all);
    check('the opening view is short and all options remain reachable', common.length > 5 && common.length < 20 && all.length > 100 && settings.selectRows(all, 'all').length === all.length, detail());
    check('custom colors are normalized, and rainbow or terminal escapes cannot enter the accent', core.parseSetting('ui','accentColor','#abc').value === '#aabbcc' && core.parseSetting('ui','accentColor','amber').value === 'amber' && Boolean(core.parseSetting('ui','accentColor','rainbow').error) && Boolean(core.parseSetting('ui','accentColor','\x1b[31m').error), detail());
    check('the theme has a safe basic-color fallback and does not interpret arbitrary text', terminalTheme('#abc').basic >= 30 && terminalTheme('#abc').basic <= 97 && terminalTheme('invalid').mark.join(',') === '47,116,245' && terminalTheme('none').plain, detail());
    check('menu rows are brief while full descriptions remain available on selection', settings.formatMenu(common).split('\n').length === common.length && !settings.formatMenu(common).includes(common[0].about) && settings.format([common[0]]).includes(common[0].about), detail());
    const attachments = settings.selectRows(all, 'section attachments');
    check('section and description searches preserve global numbers', attachments.length === 6 && attachments.every(r => all[r.number - 1].id === r.id) && settings.selectRows(all, 'image detail').some(r => r.id === 'attachments.detail'), detail());
    check('friendly labels are searchable and the default view avoids internal key names', settings.selectRows(all,'Main connection').some(r=>r.id==='agent.engine') && settings.formatMenu(common).includes('Accent color') && !settings.formatMenu(common).includes('ui.accentColor'), detail());
    check('no match stays empty instead of displaying unrelated settings', settings.selectRows(all, 'no-such-setting-query').length === 0, detail());
    check('filtered lists show their original selection numbers', settings.format(attachments).includes(String(attachments[0].number).padStart(2) + '  attachments.enabled'), detail());
  });
  await asyncSuite('customization adversary', 'customization: real menu filtering, reset and malformed choices', async () => {
    const cfgFile = path.join(core.STATE_DIR, 'config.json'), before = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile) : null;
    const menu = async answers => { const said = []; await settings.menu(async () => answers.shift() ?? 'q', s => said.push(s)); return said.join('\n'); };
    try {
      settings.reset('attachments.enabled');
      const n = settings.rows().find(r => r.id === 'attachments.enabled').number;
      const text = await menu(['/attachments', `${n}junk`, 'attachments.enabled', '2', 'changed', 'reset attachments.enabled', 'q']);
      check('search, exact key toggle, changed filter and reset work through the menu', /Settings: attachments/.test(text) && /no setting .*junk/.test(text) && /attachments.enabled = false/.test(text) && /Settings: changed/.test(text) && core.config().attachments.enabled === true, detail(text.slice(-200)));
      settings.reset('agent.mode');
      const choice = await menu(['agent.mode', '3junk', 'q']);
      check('a malformed numbered choice cannot select a mode', core.config().agent.mode === 'both' && /is one of/.test(choice), detail());
      const pages = await menu(['all','next','prev','q']);
      check('large groups page in both directions and retain their global numbers', /page 2\//.test(pages) && pages.lastIndexOf('page 1/') > pages.indexOf('page 2/'), detail());
      const empty = await menu(['/no-such-setting-query', 'q']);
      check('an empty search gives an actionable next step', /No settings match. Try all/.test(empty), detail());
    } finally { if (before) fs.writeFileSync(cfgFile, before); else fs.rmSync(cfgFile, { force: true }); }
  });
  await asyncSuite('help expert', 'customization: contextual help and attachment controls', async () => {
    const home = path.join(TMP, 'contextual-help'); fs.mkdirSync(path.join(home, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(home, 'commands', 'fixture.md'), '---\ndescription: fixture custom help\n---\nRead this project.');
    const focused = commands.helpText(TMP, home, '/agents');
    check('exact help shows usage and an example without dumping unrelated commands', focused.includes('/agents [inherit') && focused.includes('Example: /agents inherit') && !focused.includes('/undo'), detail());
    check('custom help uses the provided home and search has an explicit no-match result', commands.helpText(TMP, home, 'fixture').includes('/fixture') && commands.helpText(TMP, home, 'unfindable-command').includes('No command matches'), detail());
    const state = agentMod.newState(TMP, 'openai'); state.messages = [{ role: 'user', content: 'Typed request', _fileContext: 'x'.repeat(400), _images: [{ mimeType: 'image/png', data: 'AQ==', name: 'fixture.png', detail: 'auto' }] }];
    const said = []; let saved = 0; const ctx = { cwd: TMP, home, state, out: s => said.push(s), api: { saveChat: () => saved++ } };
    await commands.dispatch('/help fixture', ctx);
    await commands.dispatch('/attachments', ctx);
    check('dispatch reaches contextual custom help and image inspection without a model call', said.some(s => s.includes('/fixture')) && said.some(s => s.includes('fixture.png') && s.includes('PNG, JPEG')), detail());
    check('context estimates include references and explicitly exclude image tokens', /Image tokens are excluded/.test(qol.contextText(state)) && /Image tokens are excluded/.test(agentMod.statusText(state)) && /about 10\d tokens sent/.test(agentMod.statusText(state)), detail(agentMod.statusText(state)));
    await commands.dispatch('/attachments nope', ctx);
    check('invalid attachment actions do not mutate the conversation', state.messages[0]._images.length === 1, detail());
    await commands.dispatch('/attachments clear', ctx);
    check('clearing images preserves the typed request and text references and saves the change', !state.messages[0]._images && state.messages[0].content === 'Typed request' && state.messages[0]._fileContext.length === 400 && saved === 1, detail());
  });
}
