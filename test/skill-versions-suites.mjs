import * as authority from '../lib/authority.mjs';
import * as settings from '../lib/settings.mjs';

export default function skillVersionSuites({ suite, check, fs, core }) {
  suite('skill version expert', 'skill versions: full exact bodies once with every ordered occurrence', () => {
    const sid = 'skill-version-render';
    const file = 'fixture/SKILL.md';
    const first = 'FIRST_BODY\r\n' + 'Keep every rule and original byte. '.repeat(260) + '\r\nFIRST_END';
    const second = 'AMENDED_BODY\r\nThe later policy changes rule 2.\r\nAMENDED_END';
    authority.clear(sid);
    authority.record(sid, 'REQUEST_A', 'a');
    authority.skill(sid, file, first);
    authority.record(sid, 'REQUEST_B', 'b');
    authority.skill(sid, file, first);
    authority.skill(sid, file, second);
    authority.skill(sid, file, first);
    authority.record(sid, 'REQUEST_A', 'a-again');
    const saved = fs.readFileSync(authority.ledgerPath(sid));
    const off = authority.render(sid, { flags: { authorityLedger: true } });
    const on = authority.render(sid, { flags: { authorityLedger: true, authorityBodiesOnce: true } });
    const why = { happened: 'skill body or occurrence changed', why: 'Saving tokens must preserve exact versions and when each instruction became active.', fix: 'Render each full version once and keep every repeated occurrence with an in-context reference.' };
    check('off retains all three complete first-version bodies and the amendment', off.split(first).length === 4 && off.includes(second), why);
    check('on retains every byte of both distinct full versions exactly once', on.split(first).length === 2 && on.split(second).length === 2 && on.includes('FIRST_END') && on.includes('AMENDED_END'), why);
    check('each unchanged re-selection applies at its own ordered occurrence', on.includes('Selected skill fixture/SKILL.md 4:\nApply again') && on.includes('Selected skill fixture/SKILL.md 6:\nApply again') && on.split('instructions from occurrence 2.').length === 3, why);
    check('repeated user requests remain full ordered occurrences', on.includes('User request 1:\nREQUEST_A') && on.includes('User request 3:\nREQUEST_B') && on.includes('User request 7:\nREQUEST_A'), why);
    check('rendering cannot alter the persisted exact ledger', saved.equals(fs.readFileSync(authority.ledgerPath(sid))) && authority.read(sid).length === 7, why);
    check('a second render or switching off restores the same complete representation', authority.render(sid, { flags: { authorityLedger: true, authorityBodiesOnce: true } }) === on && authority.render(sid, { flags: { authorityLedger: true } }) === off, why);
    const other = sid + '-different-file';
    authority.clear(other);
    authority.skill(other, file, first);
    authority.skill(other, 'other/SKILL.md', first);
    const separate = authority.render(other, { flags: { authorityLedger: true, authorityBodiesOnce: true } });
    check('identical bytes from different selected files are distinct versions', separate.split(first).length === 3, why);
    check('authority disabled remains silent even with the body switch on', authority.render(sid, { flags: { authorityLedger: false, authorityBodiesOnce: true } }) === '', why);
    const old = { ledger: core.config().flags.authorityLedger, bodies: core.config().flags.authorityBodiesOnce };
    try {
      settings.set('flags.authorityLedger', true);
      settings.set('flags.authorityBodiesOnce', true);
      check('the public setting enables the exact version renderer and is off by default', core.DEFAULTS.flags.authorityBodiesOnce === false && authority.render(sid) === on && settings.rows().some((s) => s.id === 'flags.authorityBodiesOnce' && s.about), why);
    } finally {
      settings.set('flags.authorityLedger', old.ledger);
      settings.set('flags.authorityBodiesOnce', old.bodies);
    }
  });
}
