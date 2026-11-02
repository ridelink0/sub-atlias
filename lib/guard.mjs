// PreToolUse: two guards, both silent unless they fire.
// 1. Loop guard: the same tool with the same input N times this session is a
//    loop (NanoBot issue 4522); deny once with a teaching reason.
// 2. Destructive guard: commands that cannot be undone are turned into an ask,
//    never a silent allow. Killing a Windows process by PID is in the list because
//    Windows shares one process across many windows.
import { config, recordEvent, eventsTail, sha, clip, filesFromTool, commandFromTool, isShellTool } from './core.mjs';

const EXEMPT = /^(TodoWrite|TodoRead|ListAgents|ReadNotifications|Monitor|AskUserQuestion)$/i;

export const DESTRUCTIVE = [
  { re: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+("?~\/?|\/|\$HOME|%USERPROFILE%|\*|\.\.|[A-Za-z]:[\\/]?)("|\s|$)/, why: 'recursive delete aimed at a root, home, parent or drive' },
  { re: /\bgit\s+(reset\s+--hard|push\b[^\n]*\s(--force|-f)\b|clean\s+-[a-zA-Z]*f|checkout\s+--\s+\.|branch\s+-D\b)/, why: 'git command that discards history or work' },
  { re: /\b(taskkill|Stop-Process|kill\s+-9|pkill|killall)\b/i, why: 'process kill; on Windows one process can own many windows, close the specific window instead' },
  { re: /\b(Remove-Item|rd|rmdir|del)\b[^\n]*(-Recurse|\/s)[^\n]*(\s[A-Za-z]:\\?(\s|$)|\\\*|~)/i, why: 'recursive delete aimed at a drive root or home' },
  { re: /\b(format\s+[a-zA-Z]:|mkfs\b|dd\s+if=|>\s*\/dev\/sd)/i, why: 'disk-level destruction' },
  // macOS. A recursive delete of what a Mac keeps its work and its system in. The cache,
  // temp and project folders under them stay free: ~/Library/Caches/x, /tmp, /var/folders.
  { re: /\brm["']?\s+(?:-\S+\s+)*?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\s+(?:[^\n;&|]*?\s)?["']?(?:\/\*?|(?:~|\$HOME|\$\{HOME\})["']?(?:\/(?:Library|Documents|Desktop|Downloads|Pictures|Movies|Music|Applications))?\/?\*?|\/Users(?:\/[^/\s"']+(?:\/(?:Library|Documents|Desktop|Downloads|Pictures|Movies|Music))?)?\/?\*?|\/private\/?|\/(?:Applications|Library|System|Volumes|usr|bin|sbin|etc|private\/etc)(?:\/[^\s"']*)?|(?:\/private)?\/var(?:\/(?!folders(?:\/|\s|"|'|$))[^\s"']*)?)["']?(?=[\s;&|)]|$)/i, why: 'recursive delete aimed at a Mac system folder, the home folder, or what it keeps your work in' },
  { re: /\bdiskutil\s+(?:erase\w*|reformat|partitionDisk|splitPartition|mergePartitions|resizeVolume|secureErase|zeroDisk|randomDisk|(?:apfs|cs|ap)\s+(?:delete\w*|erase\w*|resizeContainer))\b|\bnewfs(?:_\w+)?\b|\basr\s+restore\b|\bdd\b[^\n|;&]*\bof=\/dev\/(?!null\b|zero\b|stdout\b|stderr\b)|>\s*\/dev\/r?disk\d/i, why: 'disk-level destruction on macOS' },
  { re: /\b(?:csrutil\s+(?:disable|clear|authenticated-root\s+disable)|spctl\s+(?:--master-disable|--global-disable)|fdesetup\s+disable|tmutil\s+delete\w*|security\s+delete-\w+|nvram\s+-[cd]|launchctl\s+(?:bootout|unload|remove|disable)|dscl\s+\S+\s+-delete|sudo\s+(?:shutdown|reboot|halt))\b/, why: 'turns off a macOS protection, deletes a keychain or backup, or changes what the system runs' },
  { re: /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, why: 'irreversible database statement' },
  { re: /\b(npm\s+publish|gh\s+repo\s+delete|netlify\s+sites:delete)\b/, why: 'outward-facing publish or delete' },
];

export function destructiveReason(cmd) {
  if (!cmd) return null;
  for (const d of DESTRUCTIVE) if (d.re.test(cmd)) return d.why;
  return null;
}

// Hosts whose PreToolUse can pause a tool for the user. Codex fails open on
// permissionDecision "ask" (codex-rs/hooks/src/events/pre_tool_use.rs,
// unsupported_permission_decision_fails_open) and Gemini CLI has no ask, so an
// ask there would let the command run unchallenged.
export const CAN_ASK = new Set(['claude']);
export function preTool(payload, host = 'claude') {
  const cfg = config();
  const sid = payload.session_id || 'no-session';
  const tool = String(payload.tool_name || '');
  const input = payload.tool_input || {};
  const key = sha(`${tool}\n${JSON.stringify(input)}`);
  const files = filesFromTool(tool, input);
  const command = commandFromTool(tool, input);
  recordEvent(sid, { kind: 'tool', tool, key, files, command: command ? clip(command, 300) : undefined });

  if (!EXEMPT.test(tool)) {
    const evs = eventsTail(sid);
    let lastDeny = -1;
    for (let i = evs.length - 1; i >= 0; i--) if (evs[i].kind === 'deny' && evs[i].key === key) { lastDeny = i; break; }
    const recent = evs.slice(Math.max(lastDeny + 1, evs.length - cfg.guard.loopWindow)).filter((e) => e.kind === 'tool');
    const same = recent.filter((e) => e.key === key).length;
    if (same >= cfg.guard.loopThreshold) {
      recordEvent(sid, { kind: 'deny', key, tool });
      const reason = `atlias guard: ${tool} has now been called ${same} times this session with exactly the same input${command ? ` (${clip(command, 120)})` : files.length ? ` (${files.join(', ')})` : ''}.\nWhat went wrong: an identical call returns an identical result, so this is a loop, and every pass spends tokens on nothing new.\nFix: read the last result of this call, then either change the input, take a different route to the same fact, or tell the user plainly what cannot be done and why. This one denial resets the counter.`;
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
    }
    // The other loop OpenHands' stuck detector names: two calls taking turns,
    // A B A B A B, each answering what it answered before.
    let lastAlt = -1;
    for (let i = evs.length - 1; i >= 0; i--) if (evs[i].kind === 'deny' && evs[i].why === 'alternating') { lastAlt = i; break; }
    const keys = evs.slice(lastAlt + 1).filter((e) => e.kind === 'tool').slice(-6).map((e) => e.key);
    if (keys.length === 6 && keys[0] !== keys[1] && keys[0] === keys[2] && keys[2] === keys[4] && keys[1] === keys[3] && keys[3] === keys[5]) {
      recordEvent(sid, { kind: 'deny', key, tool, why: 'alternating' });
      const reason = `atlias guard: the last six tool calls went back and forth between the same two calls with the same inputs, and each answered what it answered before.\nWhat went wrong: that is a loop in two steps, and it spends tokens on nothing new.\nFix: use what those two results already say; change one input, take a different route, or tell the user plainly what is blocking you. This denial resets the pattern.`;
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
    }
  }

  if (cfg.guard.destructive && isShellTool(tool)) {
    const why = destructiveReason(command);
    if (why && !CAN_ASK.has(host)) {
      // No way to pause for the user here, so deny, and let the identical
      // command through once the user has answered. One answer, one run.
      const evs = eventsTail(sid);
      let last = -1;
      for (let i = evs.length - 1; i >= 0; i--) if ((evs[i].kind === 'destructive' || evs[i].kind === 'destructive-confirmed') && evs[i].key === key) { last = i; break; }
      if (last !== -1 && evs[last].kind === 'destructive' && evs.slice(last + 1).some((e) => e.kind === 'prompt')) {
        recordEvent(sid, { kind: 'destructive-confirmed', key, tool });
        return null;
      }
      recordEvent(sid, { kind: 'destructive', key, tool });
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `atlias guard: ${why}. This harness cannot pause a command for approval, so it was stopped. Ask the user in your reply whether to run: ${clip(command, 200)}. If they say yes, run exactly the same command again and it will go through once.` } };
    }
    if (why) {
      recordEvent(sid, { kind: 'destructive', key, tool });
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `atlias guard: ${why}. Confirm with the user before running: ${clip(command, 200)}` } };
    }
  }
  return null;
}
