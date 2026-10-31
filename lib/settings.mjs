// Everything a user can change, in one place: the mode atlias runs in, and
// every key in config.json with what it does, its value and its default.
// `atlias settings` is the menu; `atlias mode` and `atlias config set` are the
// one-line forms of the same writes.
import path from 'node:path';
import {editionDefaults, claudeOffered, offeredEngines} from './edition.mjs';
import { STATE_DIR, DEFAULTS, CHOICES, config, readJson, writeJson, parseSetting, flagEnvName } from './core.mjs';

// What atlias is on this machine. Both is the default and what most people want.
export const MODES = {
  both: 'sub-harness inside Claude Code, Codex and the rest, plus the atlias agent in a terminal',
  sub: 'sub-harness only; typing atlias shows the status instead of asking',
  standalone: 'agent only; the hooks in other harnesses stay silent and typing atlias starts the agent',
};
// Older versions saved the chooser's answer ("ask", "agent", "sub-harness")
// without ever reading it, so those values carry no intent: they read as both.
export function normalizeMode(value) {
  const v = String(value || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(MODES, v) ? v : 'both';
}
export function mode(cfg = config()) { return normalizeMode(cfg.agent && cfg.agent.mode); }
// The hooks run inside other harnesses. Standalone is the one mode that asks
// them to stay out of those sessions.
export function hooksActive(cfg = config()) { return mode(cfg) !== 'standalone'; }
// What typing atlias with nothing after it does: the help when there is no
// terminal to answer in, otherwise whatever the mode says.
export function bareCommand(m = mode(), isTTY = Boolean(process.stdin.isTTY), edition = editionDefaults()) {
  if (!isTTY) return 'help';
  if (edition?.agentFirst) return 'agent';
  return { both: 'chooser', sub: 'status', standalone: 'agent' }[normalizeMode(m)];
}

// A round-five flag (the flags section) is described here like any other key,
// and says what it changes, off being the behaviour the baseline was run on.
export const DESCRIPTIONS = {
  'agent.relay': 'opt-in automatic saved-session continuations through Windows Task Scheduler; the model gets a relay tool, and /relay manages status and cancellation; off leaves benchmark prompts unchanged',
  'agent.relayMaxRuns': 'maximum automatic continuations in one relay chain (1 to 20, default 3); a new user-authorized task starts a new chain',
  'attachments.enabled': 'allow explicitly mentioned project PNG, JPEG and WebP images to reach a supported model; off keeps text-only attachments',
  'attachments.allowExternal': 'allow explicitly typed absolute image paths outside the project; off keeps project-only attachments. Selected image bytes go to your chosen model when you send. Does not allow outside text files or .git contents',
  'attachments.maxImages': 'maximum image files attached to one message, from 1 to 8; the default is 4 and provider/model limits still apply',
  'attachments.maxFileBytes': 'maximum bytes per image, up to 7 MiB; lower this to reduce upload size, without resizing or altering your image',
  'attachments.maxTotalBytes': 'maximum image bytes in one attached batch, up to 20 MiB; a conversation also keeps a hard 20 MiB image limit',
  'attachments.detail': 'requested image detail for OpenAI routes: auto, low, high or original; other providers keep their own image processing and model support still applies',

  'ui.accentColor': 'terminal composer accent: atlias keeps the original blue, none uses plain text, or choose a color name or #rrggbb; affects presentation only and takes effect after restarting Atlias',
  'ui.compactWelcome': 'show a short terminal welcome instead of the full Atlo and wordmark header; off keeps the original reference layout; restart Atlias after changing it',
  'ui.showHints': 'show keyboard hints in the terminal footer and a command tip in the welcome; off keeps a quieter prompt, and /help remains available',
  'ui.terminalEnabled': 'use the terminal composer with live slash commands, Tab completion and multiline paste in an interactive terminal. On by default; set false to opt out. Non-TTY or unsupported raw input keeps line mode. Restart Atlias after changing this setting',
  'ui.followUp': 'Enter during a turn: queue (the default) waits for the next turn; steer changes direction at the next model request, as Enter does in Codex CLI. Ctrl+Q sends the other kind; Tab stays command completion. Restart Atlias after changing this setting',
  'flags.hooksOnly': 'atlias works through its hooks alone: installing for Codex registers no MCP server (Codex sends every tool definition in full on every call), and the session brief and the instruction block name no tool; the handoff note, the exact requests after a compaction and the rules that need no tool stay; run atlias install again after changing it',
  'flags.leanBrief': 'a shorter session brief: no list of the MCP tool names (the host lists the tools itself), the Companions section only when two copies of a companion load at once, and the pass-line rule without the sentence that explains the gate',
  'flags.gateRunsCheck': 'when the gate would hold a reply because no check ran after the last edit, it runs the project\'s own visible check itself (check.py, canitedit_check.py, run_tests.sh, the npm test script and the like), stopped at 10 seconds, records it, and holds the reply only if it fails; the brief then says so and no longer asks for an edit and its check in one message',
  'flags.sameTextSwitch': 'in the atlias agent loop, an edit whose new text is its old text, or a byte-for-byte repeat of the last edit that failed, is answered with a steer and does not count against agent.maxBadReplies; a repeat also makes that file\'s next edit a whole Python def or class, found by its header, or the whole file',
  'flags.finishOnGreen': 'in the atlias agent loop, after a round in which an edit landed, atlias runs the project\'s own visible check (the one the gate can name: check.py, canitedit_check.py, the npm test script) and, when it passes, stops there as answered instead of spending more rounds; a failing check adds nothing to the context',
  'flags.impliedChanges': 'in the atlias agent loop, the system prompt gains one paragraph for a request that is shorter than what it needs: before editing, read every function and field the new behaviour touches and bring each one in line (state that moves on, counters, and any text that reports them). Off, the prompt is the one the baseline ran on',
  'flags.strayToolCalls': 'in the atlias agent loop, a reply that is itself one tool call atlias could not read (a bare or json-fenced object under a name such as run_shell, or with JSON that does not parse) is run when the name is a known stray one, and is otherwise answered with what was wrong and the real tool names. Off, such a reply is taken as the final answer and the task ends there, which lost 9 tasks in the 2026-10-11 runs',
  'flags.preloadFiles': 'in the atlias agent loop, the first request of a session in a small project (at most 6 files, no subfolder, at most 8,000 characters shown) carries every file in full, numbered as read_file shows them, so the model does not spend its first rounds listing, outlining and reading them; each of those rounds re-sends the whole context. Off, the first message is the request alone, as every run before 2026-10-13 had. A larger project is never shown this way',
  'flags.visibleCheck': 'in the atlias agent loop, with agent.testCommand auto, a project with no package.json test, Cargo.toml, go.mod or pytest setup has its own check script at its top (check.py and the like, as the stop gate names them) run after an edit, so the model need not spend a call to run it. Off: such a project gets no automatic check.',
  'flags.quietNoCheck': 'in the atlias agent loop, a project with no check atlias can name (no detected test command and no top-level check script) gets a prompt that does not ask the model to run a check, and its answer is not sent back for want of one; the model is still told to say plainly that it could not check. Off: the prompt asks for a check and an unchecked answer is sent back once.',
  'flags.stallStop': 'with flags.finishOnGreen, when the project check atlias runs after each edit fails with exactly the same output after 3 edits in a row, the run stops as check-stalled instead of spending its remaining rounds; off: it goes on until the check passes or the rounds run out',
  'flags.greenFailShown': 'with flags.finishOnGreen, a failure of the project check atlias runs after an edit is shown to the model in its next request, so it needs no call of its own to run the check; off: the failure is kept from the model and it runs the check itself',
  'flags.verifyStrict': 'a shell command counts as a check only when a check word stands as a whole token (npx tsc, node test/run.mjs), so cat tsconfig.json, cat .eslintrc.json and node dist/latest.js no longer count; off: the older match, which counts them',
  'flags.looseKeepsLines': 'an edit matched by its first and last line is refused when the span holds more lines old_string never named than named lines the file lacks, so code the model never asserted is not deleted unseen; off: the span is replaced whole',
  'flags.stallLastLine': 'with flags.stallStop, two check failures count as the same when their last non-empty line matches with digits masked, so a traceback that quotes a changed line or line number still counts; off: the whole output must match',
  'flags.strayNameArgs': 'with flags.strayToolCalls, a reply that is one {"name": ..., "arguments": ...} object is read as that tool call (run_shell and the like map onto shell); a reply with no arguments or parameters key is still an answer; off: only the {"tool": ...} shape is read',
  'flags.redCheckNudge': 'in the atlias agent loop, an answer given while the newest check run after the last edit failed is sent back once, with what the check said, instead of being taken as the final answer. Off, an answer is accepted once any check ran after the last edit, whatever it said, which is how every run before 2026-10-12 behaved; on the 60-task screen 11 of the 16 failed runs ended in an answer',
  'flags.authorityLedger': 'preserve complete instruction-file text and every earlier request in order during manual compaction; never trim authority to an evidence budget. Off preserves stored baseline behavior. Complete authority can exhaust a small model window, which must be reported rather than silently cut',
  'flags.authorityBodiesOnce': 'With authorityLedger on, retain the full exact body of each selected skill version once in the authority context, and preserve every later occurrence as an in-context reference. Original skill files and persisted exact occurrence rows stay unchanged. Off retains repeated full bodies.',
  'flags.exactTokenTotals': 'Eval reports give the prompt and output totals of a task and its largest prompt only when every round reported a whole count; one silent round makes them unknown and promptUnknownRounds says how many were silent. Off keeps the stored report shape, where those sums cover only the rounds that reported.',
  'agent.toolSet': 'which tools the atlias agent offers a model: all is every tool, as every run before 2026-10-12 had; core leaves out apply_patch, todo, recall and remember, whose schemas are 42 percent of the tool list text, and drops the two sentences that name them. The opening block is re-sent on every call (48.8 percent of all prompt tokens on the 60-task screen), so what it carries is paid about eight times a task. A tool that is not offered still runs if a model calls it. Any other value reads as all',
  'flags.checkFailDominates': 'a failed check stays failed until the same command runs again and does not fail, so a later, different command that exits 0 (a print-only python -c, say) no longer counts as the check after the last edit. Off, any later check that exits 0 counts, which let a run whose check.py failed end as verified in trial-02',
  'flags.passLineNeedsCheck': 'the stop gate takes the two-pass line only when a check ran after the last edit, the gate ran one itself, or the reply says plainly that it could not check; otherwise it asks for the check. Off, the line is taken on its words, as it was in trials 02 to 08',
  'flags.subagentsApart': 'Claude Code sends agent_id with the hook events a subagent fires, so its edits, commands and guard events are kept out of the main session\'s stop gate turn and out of the git check of changed files. The gate then stops asking the main session for checks of files it never wrote (council reports, board posts, scratch copies), and a subagent\'s check no longer counts as the main session\'s check. Off: every event counts for the session, as before.',
  'flags.guardCommandPositions': 'the destructive-command guard reads each simple command a line runs and skips one whose program only reads or prints (rg, grep, cat, echo), so searching for a word such as a process-kill command is not refused; substitutions, redirects and nested shells are still checked whole. Off: the old whole-line match.',
  'flags.briefNoCheckRule': 'when the project names no check, the brief says so and tells the model not to write one, instead of asking for the smallest real check (a 9B wrote its own: 14 extra shell calls in 16 screen runs). Off: the old words.',
  'flags.briefAllTools': 'the full brief names all ten tools of the atlias server; off, it names the eight it always named.',
  'flags.quietDoneClaim': 'the stop gate never holds a done reply for the want of a check: after a code edit with no check after it, it runs the project check it can name itself (with gateRunsCheck) and holds only if that fails. Pass claims are still checked. Off: a done reply with no check after the last edit is held.',
  'flags.noWorkingRules': 'the brief carries no working rules at all, so the model works as it does natively and Atlias adds no rule bytes. Pair it with gateRunsCheck, quietDoneClaim and verify.doublePass off so the gate still runs a check it can name and never holds a reply for a missing pass line; with doublePass on (the default) the gate still asks for the second-pass line the brief no longer mentions. Off: the rules as before.',
  'flags.guardResetOnEdit':'in the atlias agent loop, the repeat guard\'s record of identical tool calls is cleared whenever an edit lands (edit_file, write_file or apply_patch changed a file), so a call made again after an edit counts from zero instead of being refused as the fourth repeat. Without an edit in between the fourth identical call is still refused. Off, the record is kept for the whole run, which refused the re-run of python check.py after the last fix in humanevalfix-python-64',
  'verify.syntax': 'hold a reply whose edited files do not parse',
  'verify.doublePass': 'hold a done reply until a second adversarial read of the changes happened',
  'verify.integrity': 'check claims against evidence: passes that never ran, done with no check after the last edit',
  'verify.stubs': 'flag placeholders, TODOs and elided code added in this change',
  'verify.weakenedTests': 'flag skipped, focused or deleted tests and asserts that cannot fail',
  'verify.unwired': 'flag new functions and classes that nothing calls',
  'guard.loopThreshold': 'identical tool calls in a row before the guard steps in',
  'guard.loopWindow': 'how many recent tool calls the loop guard looks at',
  'guard.destructive': 'ask before rm -rf, force pushes, dropped tables and the like',
  'graph.autoBuild': 'build the knowledge graph at session start when a project has none',
  'graph.autoUpdate': 'refresh the graph in the background after edits',
  'graph.maxFilesForAutoBuild': 'skip the automatic build above this many files',
  'graph.queryBudget': 'characters a graph answer may use',
  'graph.godNodes': 'hub nodes named in the session brief',
  'graph.updateDebounceMs': 'milliseconds between background graph refreshes',
  'brief.memoryChars': 'characters of memory in the session brief',
  'brief.progressChars': 'characters of the handoff note in the session brief',
  'recall.budgetChars': 'characters a recall answer may use',
  'recall.bodyChars': 'characters of each memory body in a recall answer',
  'dream.enabled': 'distil each finished session into the digest for later consolidation',
  'dream.keepHistory': 'digest rows kept',
  'router.graph': 'answer codebase questions from the graph before files are read',
  'router.companions': 'point frontend work at the installed companion skills',
  'pointer.nudge': 'when a whole file is read that the knowledge graph could have answered, say so once and name the query that would have done it; the read is never blocked',
  'pointer.minBytes': 'a whole-file read smaller than this is cheaper than asking, so it passes without a word',
  'pointer.perSession': 'pointer-first nudges one session may spend, at most one per turn',
  'ui.usageEnabled': 'show Atlias own-provider token counts in its terminal, including prompt, output and cache counts when the provider reports them; native Claude and Codex host sessions keep their own counts and are not inspected. Takes effect when the agent starts or after /settings. Off, nothing new is printed',
  'ui.usagePosition': 'where the usage display sits: top or bottom (one pinned line, the text scrolls in the rest of the terminal), or sidebar (a column at the right edge; a terminal under 100 columns gets the top line instead). Without a terminal it is a plain line printed before each prompt (once at the start for top)',
  'ui.usageColor': 'the colour of the usage display: rainbow, a name (red, orange, amber, gold, yellow, lime, green, teal, cyan, blue, indigo, purple, magenta, pink, white, gray), or a hex colour such as #ffb000; NO_COLOR and output that is not a terminal print it plain',
  'agent.notifyAfterSeconds': 'in the atlias agent, a turn that took at least this many seconds rings the terminal bell and shows a desktop notification when it ends, so you can work elsewhere while it runs; 0 turns it off. Only the repl: atlias exec and eval never notify',
  'update.source': 'where atlias update fast-forwards this git checkout from: a remote name (its branch of the same name as the checked-out one), remote/branch, a local ref, or the path or URL of a repository; empty means the upstream of the current branch. atlias update never resets, merges or pushes',
  'update.autoPrompt': 'when the atlias agent starts in a terminal, check the update source for new commits (a few seconds at most, silent on any failure) and offer to update; "Never ask me again" sets this to false, after which only atlias update updates. Set it back to true to be asked again',
  'ui.usageAnimation': 'how the usage display moves: none, pulse (brightness rises and falls), wave (brightness travels along the line, and a rainbow scrolls), or shimmer (a bright patch sweeps across); drawn about six times a second, only on a terminal with colour, and stopped when the agent exits',
  'agent.mode': 'both, sub or standalone (see atlias mode)',
  'agent.engine': 'direct engines: claude-plan (your Claude plan through the Claude Agent SDK, Atlias runs every tool), chatgpt (personal ChatGPT plan), responses (OpenAI API), anthropic (Claude API), gemini (Google API), openai (compatible API), ollama (local). Auto uses exactly one configured direct engine; ambiguity asks for a choice. claude and codex run host harnesses only when agent.hostEngines is on; they are never auto fallbacks',
  'license.required': 'true: the Atlias app needs an active Max subscription (Stripe) and stops cleanly, after the current turn, when it lapses; false: no check (the default until Max is on sale)',
  'license.url': 'where the signed subscription pass and the checkout link come from (the Atlias site functions)',
  'license.publicKey': 'the Ed25519 public key (base64 SPKI) every subscription pass must be signed with',
  'license.recheckHours': 'how often a running session asks the server again whether the subscription is still paid',
  'agent.hostEngines': 'off: Atlias always runs the model itself and refuses the claude and codex host harnesses; on: they may be chosen explicitly',
  'agent.subagentEngine': 'default worker connection; inherit uses the main engine. A different engine asks before launch unless main effort or permissions is max',
  'agent.subagentConcurrency': 'at most this many sub-agents of one reply run at once; the rest wait as queued. 0 (the default) means no cap, as before',
  'agent.subagentRounds': 'tool rounds each sub-agent may use, 1 to 100; 20 is the old fixed cap. agent.maxToolRounds still caps it',
  'agent.subagentTokenBudget': 'tokens (in plus out) one sub-agent may spend; it stops at the first model call at or past it, with stop token-budget. 0 (the default) means none',
  'agent.subagentHandback': 'text (the default): the parent reads the sub-agent answer as before; typed: the harness writes the hand-back from its own record (status, turns, tool calls, tokens, files changed, check after its edits), then the answer',
  'agent.subagentVerify': 'off (the default); check: a sub-agent that changed files with no passing check after its last edit is marked unverified and the parent is told not to rely on it',
  'agent.subagentModel': 'optional worker model from that engine; blank uses its configured model. /agents validates a selection',
  'agent.subagents': 'on: in interactive and exec turns the model may hand a self-contained part of the work to a sub-agent with its own context (at most agent.subagentRounds rounds each, 20 by default, one level); off: never. Benchmarks never offer it',
  'agent.claudePlanModel': 'Claude model for the claude-plan engine (claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, claude-fable-5-1)',
  'agent.claudePlanEffort': 'reasoning effort for the claude-plan engine: low, medium, high, xhigh or max (model sends none; Opus 5.5 then uses medium)',
  'agent.anthropicEffort': 'reasoning effort sent as output_config.effort on Anthropic API requests (model sends none)',
  'agent.chatgptModel': 'model discovered for the authorized ChatGPT account; no API-key fallback',
  'agent.chatgptReasoningEffort': 'requested reasoning effort, verified against model capabilities before a ChatGPT plan request',
  'agent.responsesUrl': 'native Responses API base URL; remote endpoints require HTTPS',
  'agent.responsesModel': 'explicit model for OpenAI Responses API billing, separate from a ChatGPT subscription',
  'agent.responsesReasoningEffort': 'native Responses reasoning effort; model leaves provider default; no sampling parameters are added',
  'agent.anthropicUrl': 'Anthropic Messages API base URL; consumer Claude subscription tokens are unsupported',
  'agent.anthropicModel': 'explicit Claude API model; uses ANTHROPIC_API_KEY with separate API billing',
  'agent.anthropicMaxTokens': 'maximum output tokens for Anthropic Messages requests',
  'agent.geminiUrl': 'Gemini generateContent API base URL; no Antigravity consumer token or proxy',
  'agent.geminiModel': 'explicit Gemini API model; uses GEMINI_API_KEY or GOOGLE_API_KEY with separate API billing',
  'agent.ollamaUrl': 'where the local Ollama server listens',
  'agent.ollamaModel': 'the Ollama model the agent drives',
  'agent.ollamaNumCtx': 'the context window atlias asks Ollama for, in tokens, on every request; capped at the model\'s trained length and grown in powers of two when a conversation needs it; without it Ollama uses its own default (4096 on a GPU under 24 GiB) and cuts an over-long conversation from the front, task first',
  'agent.ollamaNumPredict': 'the most tokens one Ollama reply may generate; the window is kept at least this much larger than the prompt',
  'agent.ollamaKeepAlive': 'how long Ollama keeps the model loaded after a request (for example 30m); empty leaves it to the server',
  'agent.ollamaTemperature': 'the sampling temperature atlias asks Ollama for on every request, from 0 to 2; 0 always takes the likeliest token',
  'agent.ollamaPresencePenalty': 'the presence penalty atlias asks Ollama for, from 0 to 2; -1 sends none, so the model keeps its own (qwen3.5 ships with 1.5, which works against repeating the code it was shown)',
  'agent.openaiReasoningEffort': 'for an OpenAI-compatible endpoint, how much a model that can reason does so before it answers: model sends nothing and leaves the default of the endpoint, none, low, medium or high go out as reasoning_effort; checked sends none only where atlias can name a check for the directory it works in, and nothing elsewhere',
  'agent.ollamaThink': 'whether a model that can reason before it answers does so: model leaves it to the model\'s own default, on asks for it, off asks for the answer alone',
  'agent.openaiUrl': 'any OpenAI-compatible endpoint: OpenAI, OpenRouter, LM Studio, vLLM, llama.cpp',
  'agent.openaiModel': 'the model name that endpoint expects; the openai engine needs it',
  'agent.nativeTools': 'use the endpoint\'s own tool calling, falling back to text blocks when it refuses',
  'agent.maxToolRounds': 'tool calls the agent may make for one message',
  'agent.evalDir': 'where atlias eval makes its scratch workspaces; empty means an atlias-evals folder in the system temp folder (ATLIAS_EVAL_DIR or eval --work override it)',
  'agent.maxBadReplies': 'model replies in a row that may produce nothing usable - a tool block that did not parse, an edit that did not apply, or a reply the provider cut off at its output limit - before atlias stops and says which of those it was; counted apart from the round budget, and cleared by any round that did something',
  'agent.keepObservations': 'recent tool results kept in full; older ones shrink to a one-line note',
  'agent.evictBlock': 'how many old tool results are shrunk at once; shrinking one per turn would rewrite the prompt every turn and lose the provider cache',
  'agent.outputBudget': 'characters of tool output allowed into the context, decided once as it enters; each tool gets a share of this, since a shell run, a file read, a grep and a directory listing do not deserve the same room',
  'agent.testCommand': 'the check atlias runs itself when the agent answers after editing: auto finds npm test, pytest, go test or cargo test; off turns it off; or give a command',
  'agent.skillIndex': 'whether the agent\'s system message carries an index of installed skills: off (the default since 2026-10-12, by Gev\'s decision) has none; relevant names at most five installed skills whose name or description shares words with the request, one short line each with the path to read, capped at about 600 characters, and says how to list the rest (no model is used to choose them, and the instructions inside a skill are never shortened); all lists every skill folder on this PC, which is what every run before that date used. On the benchmark that index was about 1,440 characters on every call and no run was seen using a skill. Any other value reads as off',
  'agent.permissions': 'workspace (default): edits in the project run, a flagged command or a write outside the project asks; ask: every edit and command asks first; read-only: no edits, a command asks; auto-accept: edits and writes run without asking, commands still ask; plan: exploration only, writes and commands are refused until you leave plan mode (/permissions <mode>); auto: commands run without asking, a risky one (guard-flagged, credentials, payments, publishing, sending) still asks; max: never asks anything, so it refuses deletes outside the project, system folders, credentials, spending, publishing, sending, killing by PID and the guard\'s destructive patterns, and logs every call under the Atlias home (max-log)',
  'agent.sandbox': 'work in a throwaway git worktree of the last commit, show the diff when the run stops and change the project only if you take it; a dirty tree is refused and a folder that is not a git repository says so and runs as usual',
};

const CONFIG_PATH = () => path.join(STATE_DIR, 'config.json');
// The release's own text for the two engine rows, which names no Claude route (Gev, 2026-10-30).
const RELEASE_DESCRIPTIONS = {
  'agent.engine': 'direct engines: chatgpt (personal ChatGPT plan), responses (OpenAI API), gemini (Google API), openai (compatible API), ollama (local). Auto uses exactly one configured direct engine; ambiguity asks for a choice. codex runs a host harness only when agent.hostEngines is on; it is never an auto fallback',
  'agent.hostEngines': 'off: Atlias always runs the model itself and refuses the codex host harness; on: it may be chosen explicitly',
};

export function rows(cfg = config()) {
  const out = [];
  // Gev (2026-10-29, 2026-10-30): the release has no Claude at all, so its list names no Claude engine
  // and has no claudePlan or anthropic rows.
  const claude = claudeOffered();
  for (const [section, keys] of Object.entries(DEFAULTS)) {
    for (const [key, def] of Object.entries(keys)) {
      const id = `${section}.${key}`;
      if (!claude && /^agent\.(claudePlan|anthropic)/.test(id)) continue;
      const value = (cfg[section] || {})[key];
      let choices = (CHOICES[section] || {})[key] || (typeof def === 'boolean' ? [true, false] : null);
      if (!claude && ['agent.engine', 'agent.subagentEngine'].includes(id) && choices) choices = offeredEngines(choices, false);
      // A flag can also be set from the environment for one run, and then the
      // environment wins over what is written here; the listing names the variable.
      out.push({ number: out.length + 1, id, section, key, value, def, changed: JSON.stringify(value) !== JSON.stringify(def), choices, about: (!claude && RELEASE_DESCRIPTIONS[id]) || DESCRIPTIONS[id] || '', env: section === 'flags' ? flagEnvName(key) : '' });
    }
  }
  return out;
}

export function format(list = rows()) {
  const width = Math.max(...list.map((r) => r.id.length));
  return list.map((r, i) => {
    const n = String(r.number ?? i + 1).padStart(2);
    const val = JSON.stringify(r.value);
    const def = r.changed ? `  (default ${JSON.stringify(r.def)})` : '';
    return `${n}  ${r.id.padEnd(width)}  ${val}${def}\n      ${r.about}${r.env ? ` (for one run: ${r.env}=${typeof r.def === 'boolean' ? '1' : '<value>'})` : ''}`;
  }).join('\n');
}

// Write one setting through parseSetting, and read it back through config()
// so what is reported is what took effect.
export function set(id, raw) {
  const parts = String(id || '').split('.');
  if (parts.length !== 2) return { ok: false, text: 'A setting uses section.key, for example attachments.detail.' };
  const [section, key] = parts;
  const parsed = parseSetting(section, key, raw);
  if (parsed.error) return { ok: false, text: parsed.error };
  const user = readJson(CONFIG_PATH(), {}) || {};
  user[section] = { ...(user[section] || {}), [key]: parsed.value };
  writeJson(CONFIG_PATH(), user);
  return { ok: true, text: `${id} = ${JSON.stringify(config()[section][key])}${['ui.accentColor', 'ui.compactWelcome'].includes(id) ? '; restart Atlias to apply' : ''}` };
}

export function reset(id) {
  const parts = String(id || '').split('.');
  if (parts.length !== 2) return { ok: false, text: 'A setting uses section.key, for example attachments.detail.' };
  const [section, key] = parts;
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, section) || !Object.prototype.hasOwnProperty.call(DEFAULTS[section], key)) return { ok: false, text: `unknown key ${id}` };
  const user = readJson(CONFIG_PATH(), {}) || {};
  if (user[section]) {
    delete user[section][key];
    if (!Object.keys(user[section]).length) delete user[section];
  }
  writeJson(CONFIG_PATH(), user);
  return { ok: true, text: `${id} = ${JSON.stringify(config()[section][key])} (default)${['ui.accentColor', 'ui.compactWelcome'].includes(id) ? '; restart Atlias to apply' : ''}` };
}

export function setMode(value) {
  const v = String(value || '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(MODES, v)) return { ok: false, text: `mode is one of ${Object.keys(MODES).join(', ')}; got ${JSON.stringify(value)}` };
  const r = set('agent.mode', v);
  return r.ok ? { ok: true, text: `mode ${v}: ${MODES[v]}` } : r;
}

export function describeMode(cfg = config()) {
  const m = mode(cfg);
  return [`mode ${m}: ${MODES[m]}`, '', ...Object.entries(MODES).map(([k, v]) => `  ${k === m ? '*' : ' '} ${k.padEnd(10)} ${v}`), '', 'change it with: atlias mode both|sub|standalone'].join('\n');
}

// Keep the opening view short; stable numbers still address every setting.
const COMMON = new Set(['agent.mode', 'agent.engine', 'agent.permissions', 'agent.subagentEngine', 'agent.subagentModel', 'ui.terminalEnabled', 'ui.accentColor', 'ui.compactWelcome', 'ui.showHints', 'ui.usageEnabled', 'attachments.enabled', 'attachments.detail']);
export function selectRows(list, query = 'common') {
  const q = String(query).trim().toLowerCase();
  if (!q || q === 'common') return list.filter(r => COMMON.has(r.id));
  if (q === 'all') return list;
  if (q === 'changed') return list.filter(r => r.changed);
  if (q.startsWith('section ')) return list.filter(r => r.section.toLowerCase() === q.slice(8).trim());
  return list.filter(r => `${r.id} ${MENU_LABELS[r.id] || ''} ${r.about}`.toLowerCase().includes(q));
}

const MENU_LABELS = {
  'agent.mode': 'Run mode', 'agent.engine': 'Main connection', 'agent.permissions': 'Permissions',
  'agent.subagentEngine': 'Worker connection', 'agent.subagentModel': 'Worker model',
  'ui.terminalEnabled': 'Terminal composer', 'ui.accentColor': 'Accent color', 'ui.compactWelcome': 'Compact welcome',
  'ui.showHints': 'Keyboard hints', 'ui.usageEnabled': 'Show token usage',
  'attachments.enabled': 'Image attachments', 'attachments.allowExternal': 'Explicit external images', 'attachments.detail': 'Image detail',
  'attachments.maxImages': 'Images per message', 'attachments.maxFileBytes': 'Bytes per image', 'attachments.maxTotalBytes': 'Bytes per batch',
};
export function formatMenu(list) {
  const label = r => MENU_LABELS[r.id] || r.id;
  const width = Math.max(0, ...list.map(r => label(r).length));
  return list.map(r => {
    const value = ['attachments.maxFileBytes', 'attachments.maxTotalBytes'].includes(r.id) && Number.isFinite(r.value) ? `${r.value / 1048576} MiB (${r.value} bytes)` : r.id === 'agent.subagentEngine' && r.value === 'inherit' ? 'Follow main connection' : r.id === 'agent.subagentModel' && !r.value ? 'Use connection default' : JSON.stringify(r.value) ?? 'unknown';
    return `${String(r.number).padStart(3)}  ${label(r).padEnd(width)}  ${Array.from(value).length > 32 ? Array.from(value).slice(0, 29).join('') + '...' : value}${r.changed ? '  *' : ''}`;
  }).join('\n');
}

// ask and out are injected so the same interactions can be exercised without IO.
export async function menu(ask, out) {
  let query = 'common', page = 0;
  for (;;) {
    const list = rows(), visible = selectRows(list, query);
    const pages = Math.max(1, Math.ceil(visible.length / 12)); page = Math.min(page, pages - 1);
    out(`Settings: ${query} (${visible.length} of ${list.length}; page ${page + 1}/${pages})`);
    out(visible.length ? formatMenu(visible.slice(page * 12, (page + 1) * 12)) : 'No settings match. Try all, common, changed, or a different search.');
    if (visible.some(r => r.changed)) out('* changed from its default; selecting an option shows its explanation.');
    const answer = String(await ask('\nselect number/key; /search; common/all/changed; section <name>; next/prev; reset <key>; q: ')).trim();
    const lower = answer.toLowerCase();
    if (!answer || ['q', 'quit', 'exit'].includes(lower)) return 0;
    if (['all', 'common', 'changed'].includes(lower) || lower.startsWith('section ')) { query = lower; page = 0; continue; }
    if (answer.startsWith('/')) { query = answer.slice(1).trim() || 'common'; page = 0; continue; }
    if (['next', 'n', 'prev', 'p'].includes(lower)) { page = Math.max(0, Math.min(pages - 1, page + (['next', 'n'].includes(lower) ? 1 : -1))); continue; }
    const resetNumber = /^r([1-9]\d*)$/i.exec(answer), resetKey = /^reset\s+(\S+)$/i.exec(answer);
    const resetting = Boolean(resetNumber || resetKey);
    const target = resetNumber?.[1] || resetKey?.[1] || answer;
    const row = /^[1-9]\d*$/.test(target) ? list[Number(target) - 1] : list.find(r => r.id.toLowerCase() === target.toLowerCase());
    if (!row) { out(`no setting ${answer}; use a full number, section.key, or /search`); continue; }
    out(format([row]));
    if (resetting) { out(reset(row.id).text); continue; }
    let raw;
    if (row.choices) {
      out(row.choices.map((c, i) => `  ${i + 1}  ${c}${c === row.value ? '  (current)' : ''}`).join('\n'));
      const pick = String(await ask(`${row.id}: `)).trim();
      const idx = /^[1-9]\d*$/.test(pick) ? Number(pick) : NaN;
      raw = Number.isSafeInteger(idx) && row.choices[idx - 1] !== undefined ? String(row.choices[idx - 1]) : pick;
    } else raw = String(await ask(`${row.id} (now ${JSON.stringify(row.value)}): `));
    if (!raw.trim()) { out('unchanged'); continue; }
    out(set(row.id, raw).text);
  }
}
