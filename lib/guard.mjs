// PreToolUse: two guards, both silent unless they fire.
// 1. Loop guard: the same tool with the same input N times this session is a
//    loop (NanoBot issue 4522); deny once with a teaching reason.
// 2. Destructive guard: commands that cannot be undone are turned into an ask,
//    never a silent allow. Killing a Windows process by PID is in the list because
//    Windows shares one process across many windows.
import { config, recordEvent, eventsTail, sha, clip, filesFromTool, commandFromTool, isShellTool, subagentTag } from './core.mjs';

const EXEMPT = /^(TodoWrite|TodoRead|ListAgents|ReadNotifications|Monitor|AskUserQuestion)$/i;

export const DESTRUCTIVE = [
  // Council 1013b (b06, b07): the target may be quoted, globbed (/*, ~/*), followed by ) or a
  // backtick or an escaped quote (inside $( ), ( ), `...` or bash -lc \"...\"), and the r flag may
  // come after other flags or as --recursive.
  { re: /\brm["']?(?:\s|\\\r?\n)+(?:(?:-[a-zA-Z]+|--[a-z-]+)\s+)*(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?:\s|\\\r?\n)+(?:(?:-[a-zA-Z]+|--[a-z-]+)\s+)*["']?(?:~|\/|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE|\*|\.\.|[A-Za-z]:)[\\/]?\*?["']?(?=$|[\s;&|)`'"\\])/, why: 'recursive delete aimed at a root, home, parent or drive' },
  { re: /\bgit(?:\s+(?:--no-pager|--literal-pathspecs|--no-optional-locks|--no-replace-objects|--no-lazy-fetch|--no-advice|--bare|-P|-p|--paginate)|\s+(?:-[Cc]\s+|--(?:git-dir|work-tree|namespace|config-env)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s;&|]+)|\s+--exec-path(?:=(?:"[^"]*"|'[^']*'|[^\s;&|]+))?)*\s+(reset\s+--hard|push\b[^\n]*\s(--force|-f)\b|clean\s+-[a-zA-Z]*f|checkout\s+--\s+\.|branch\s+-D\b)/i, why: 'git command that discards history or work' },
  { re: /\b(taskkill|Stop-Process|spps|kill\s+-9|pkill|killall)\b|\bkill\s+(?:-(?:Id|s\s+\w+|\w+)\s+)*-?\d+\b/i, why: 'process kill; on Windows one process can own many windows, close the specific window instead' },
  // The target may come before the flag, be quoted, be $HOME or the user's folder, or end in \*.*.
  { re: /\b(Remove-Item|ri|rd|rmdir|del|erase)\b(?=[^\n]*(?:-Recurse\b|\s-r\b|\/s\b))(?=[^\n]*\s["']?(?:[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+[\\/]?|[A-Za-z]:[\\/]?|~[\\/]?|\$HOME[\\/]?|\$env:USERPROFILE[\\/]?|%USERPROFILE%[\\/]?)\*?(?:\.\*)?["']?(?=$|[\s;&|)]))/i, why: 'recursive delete aimed at a drive root or home' },
  // No \b before the redirect: a space before > is not a word boundary, so "echo x > /dev/sda" slipped by.
  { re: /\b(format\s+[a-zA-Z]:|mkfs\b|dd\s+if=|(?:Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition|diskpart)\b)|>\s*\/dev\/(sd|hd|vd|xvd|nvme|mmcblk|disk)/i, why: 'disk-level destruction' },
  { re: /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, why: 'irreversible database statement' },
  { re: /\b(npm\s+publish|gh\s+repo\s+delete|netlify\s+sites:delete)\b/, why: 'outward-facing publish or delete' },
];

// flags.guardCommandPositions (off by default; Codex's audit of 2026-10-13, F5):
// the patterns are matched against each simple command a line runs, and a
// simple command whose program only reads or prints is skipped, so a search for
// a word is not taken for the command it names. A program that substitutes a
// command ($( ), backticks, <( )) or redirects (>) is matched as before, and so
// is everything else, a nested shell's quoted script included.
const READ_ONLY = new Set(['rg', 'grep', 'egrep', 'fgrep', 'findstr', 'select-string', 'sls', 'ag', 'ack', 'cat', 'type', 'get-content', 'gc', 'head', 'tail', 'less', 'more', 'echo', 'printf', 'write-output', 'write-host', 'wc', 'sort', 'uniq']);
const GIT_READ = new Set(['grep', 'log', 'show', 'diff', 'blame']);
export function simpleCommands(cmd) {
  const parts = [];
  let text = '', bare = '', quote = '', escaped = false;
  const flush = () => { if (text.trim()) parts.push({ text, bare }); text = ''; bare = ''; };
  for (const ch of String(cmd || '')) {
    if (quote) {
      text += ch;
      if (escaped) escaped = false;
      else if (quote === '"' && ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; text += ch; continue; }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') { flush(); continue; }
    text += ch;
    bare += ch;
  }
  flush();
  // A quote still open at the end means this reading of the line is not the shell's (a Windows
  // path ending in a backslash inside double quotes, say), so the caller must not trust the split.
  parts.open = Boolean(quote);
  return parts;
}
function commandWords(text) {
  const words = [];
  let word = '', quote = '', active = false;
  for (const ch of text) {
    if (quote) { if (ch === quote) quote = ''; else word += ch; active = true; continue; }
    if (ch === '"' || ch === "'") { quote = ch; active = true; continue; }
    if (/\s/.test(ch)) { if (active) words.push(word); word = ''; active = false; continue; }
    word += ch; active = true;
  }
  if (quote) return null;
  if (active) words.push(word);
  return words;
}
function readOnly(part) {
  if (/\$\(|`|<\(/.test(part.text) || part.bare.includes('>')) return false;
  const words = commandWords(part.text.trim());
  if (!words) return false;
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || /^(sudo|env|command|time|nohup|exec)$/i.test(words[i]))) i++;
  const program = (words[i] || '').replace(/^["']|["']$/g, '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  if (program === 'git') {
    i++;
    // Only reviewed global options are skipped. Config/pager overrides and
    // unknown options remain on the conservative whole-command path.
    while (i < words.length && words[i].startsWith('-')) {
      if (['--no-pager', '--literal-pathspecs', '--no-optional-locks'].includes(words[i])) i++;
      else if (words[i] === '-C' && i + 1 < words.length && !words[i + 1].startsWith('-')) i += 2;
      else if (['--git-dir', '--work-tree', '--namespace'].includes(words[i]) && i + 1 < words.length && !words[i + 1].startsWith('-')) i += 2;
      else if (/^--(?:git-dir|work-tree|namespace)=.+/.test(words[i])) i++;
      else return false;
    }
    return GIT_READ.has(String(words[i] || '').toLowerCase());
  }
  return READ_ONLY.has(program);
}
// flags.guardCommandPositions, council 1013b (b06, b07): redirects that only drop or merge output
// (2>/dev/null, 2>&1) are not writes, and shapes this reader cannot follow fall back to the whole
// line: a pipe into a shell or interpreter, a backslash-newline, an escaped quote, ANSI-C $'...',
// and an assignment with a quoted value (FOO='x grep' rm ... would make grep the program).
const HARMLESS_REDIRECT = /\d*>&\d+|&>>?\s*\/dev\/null\b|\d*>>?\s*\/dev\/null\b/g;
const UNREADABLE = /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|fish|eval|source|xargs|python[0-9.]*|node|deno|bun|perl|ruby|php|lua|pwsh|powershell|cmd)\b|\\\r?\n|\\["']|\$'|(?:^|\s)[A-Za-z_]\w*=["']/i;
export function destructiveReason(cmd, positions = false) {
  if (!cmd) return null;
  const line = positions ? String(cmd).replace(HARMLESS_REDIRECT, ' ') : cmd;
  const parts = positions && !UNREADABLE.test(line) ? simpleCommands(line) : null;
  const texts = parts && !parts.open ? parts.filter((p) => !readOnly(p)).map((p) => p.text) : [cmd];
  for (const text of texts) for (const d of DESTRUCTIVE) if (d.re.test(text)) return d.why;
  return null;
}

// flags.guardResetOnEdit, council 1013b (b05, b06): an edit that returns a file to content an earlier
// edit in the tail left it with (the same content hash, written by track.mjs under the flag) is a
// revert, not a change, so it resets nothing; otherwise A to B and B to A clears the guard forever.
// The content from before the first edit of the tail has no hash, so its first return still resets.
const revertsEarlier = (evs, i) => evs[i].after !== undefined && evs.slice(0, i).some((e) => e.kind === 'edit' && e.after === evs[i].after);

// Hosts whose PreToolUse can pause a tool for the user. Codex fails open on
// permissionDecision "ask" (codex-rs/hooks/src/events/pre_tool_use.rs,
// unsupported_permission_decision_fails_open) and Gemini CLI has no ask, so an
// ask there would let the command run unchallenged.
export const CAN_ASK = new Set(['claude']);
export function preTool(payload, host = 'claude') {
  const cfg = config();
  const tag = subagentTag(payload, cfg);
  const sid = payload.session_id || 'no-session';
  const tool = String(payload.tool_name || '');
  const input = payload.tool_input || {};
  const key = sha(`${tool}\n${JSON.stringify(input)}`);
  const files = filesFromTool(tool, input);
  const command = commandFromTool(tool, input);
  recordEvent(sid, { kind: 'tool', tool, key, files, command: command ? clip(command, 300) : undefined, ...tag });

  if (!EXEMPT.test(tool)) {
    const evs = eventsTail(sid).filter((e) => !cfg.flags.subagentsApart || (e.subagent || '') === (tag.subagent || ''));
    let lastDeny = -1;
    for (let i = evs.length - 1; i >= 0; i--) if (evs[i].kind === 'deny' && evs[i].key === key) { lastDeny = i; break; }
    let from = Math.max(lastDeny + 1, evs.length - cfg.guard.loopWindow);
    // flags.guardResetOnEdit, the hook side of the loop's switch (lib/loop.mjs):
    // an edit that landed changes what a read or a check returns, so identical
    // calls after it count from zero (c16 F4: one false denial took a run's last
    // call). Files changed through the shell leave no edit event and reset nothing.
    if (cfg.flags && cfg.flags.guardResetOnEdit === true) for (let i = evs.length - 1; i >= from; i--) if (evs[i].kind === 'edit' && !evs[i].failed && !revertsEarlier(evs, i)) { from = i + 1; break; }
    const recent = evs.slice(from).filter((e) => e.kind === 'tool');
    const same = recent.filter((e) => e.key === key).length;
    if (same >= cfg.guard.loopThreshold) {
      recordEvent(sid, { kind: 'deny', key, tool, ...tag });
      const reason = `atlias guard: ${tool} has now been called ${same} times this session with exactly the same input${command ? ` (${clip(command, 120)})` : files.length ? ` (${files.join(', ')})` : ''}.\nWhat went wrong: an identical call returns an identical result, so this is a loop, and every pass spends tokens on nothing new.\nFix: read the last result of this call, then either change the input, take a different route to the same fact, or tell the user plainly what cannot be done and why. This one denial resets the counter.`;
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
    }
    // The other loop OpenHands' stuck detector names: two calls taking turns,
    // A B A B A B, each answering what it answered before.
    let lastAlt = -1;
    for (let i = evs.length - 1; i >= 0; i--) if (evs[i].kind === 'deny' && evs[i].why === 'alternating') { lastAlt = i; break; }
    // The same edit boundary as identical calls (Codex's audit F4): A B A, an edit
    // that landed, then B A B is not a loop. A failed edit changes nothing.
    if (cfg.flags && cfg.flags.guardResetOnEdit === true) for (let i = evs.length - 1; i > lastAlt; i--) if (evs[i].kind === 'edit' && !evs[i].failed && !revertsEarlier(evs, i)) { lastAlt = i; break; }
    const keys = evs.slice(lastAlt + 1).filter((e) => e.kind === 'tool').slice(-6).map((e) => e.key);
    if (keys.length === 6 && keys[0] !== keys[1] && keys[0] === keys[2] && keys[2] === keys[4] && keys[1] === keys[3] && keys[3] === keys[5]) {
      recordEvent(sid, { kind: 'deny', key, tool, why: 'alternating', ...tag });
      const reason = `atlias guard: the last six tool calls went back and forth between the same two calls with the same inputs, and each answered what it answered before.\nWhat went wrong: that is a loop in two steps, and it spends tokens on nothing new.\nFix: use what those two results already say; change one input, take a different route, or tell the user plainly what is blocking you. This denial resets the pattern.`;
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
    }
  }

  if (cfg.guard.destructive && isShellTool(tool)) {
    const why = destructiveReason(command, Boolean(cfg.flags && cfg.flags.guardCommandPositions === true));
    if (why && !CAN_ASK.has(host)) {
      // No way to pause for the user here, so deny, and let the identical
      // command through once the user has answered. One answer, one run.
      const evs = eventsTail(sid).filter((e) => !cfg.flags.subagentsApart || (e.subagent || '') === (tag.subagent || '') || (e.kind === 'prompt' && !e.subagent));
      let last = -1;
      for (let i = evs.length - 1; i >= 0; i--) if ((evs[i].kind === 'destructive' || evs[i].kind === 'destructive-confirmed') && evs[i].key === key) { last = i; break; }
      if (last !== -1 && evs[last].kind === 'destructive' && evs.slice(last + 1).some((e) => e.kind === 'prompt')) {
        recordEvent(sid, { kind: 'destructive-confirmed', key, tool, ...tag });
        return null;
      }
      recordEvent(sid, { kind: 'destructive', key, tool, ...tag });
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `atlias guard: ${why}. This harness cannot pause a command for approval, so it was stopped. Ask the user in your reply whether to run: ${clip(command, 200)}. If they say yes, run exactly the same command again and it will go through once.` } };
    }
    if (why) {
      recordEvent(sid, { kind: 'destructive', key, tool, ...tag });
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `atlias guard: ${why}. Confirm with the user before running: ${clip(command, 200)}` } };
    }
  }
  return null;
}
