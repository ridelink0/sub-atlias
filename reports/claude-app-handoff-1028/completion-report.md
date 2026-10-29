# Atlias Max desktop app: completion report

Date: 2026-10-29 (America/Chicago)
Project: D:/atlias-max-app (local git only; nothing pushed, deployed or charged)
Harness: Atlias 4.0.0 vendored from D:/atlias-app commit 1cb3b18e42fbefb144f5fecab3fc234426d2993b (VENDOR.json)
Brief: D:/atlias-app/docs/CLAUDE-APP-HANDOFF-1028.md
Model: Claude Opus 5.5 at xhigh effort

## FULLY FINISHED IN EVERY ASPECT: NO

Claude, 2026-10-29 10:10 Central (after the measured reset): the UI comparison's wins 1 to 4 are built (docs/UI-COMPARISON-1029.md), and "Open in terminal" prefers Windows Terminal. All on the final source (fingerprints in `reports/fingerprints-20261029T150904.txt`, 77 files, list sha256 6858adb6...):
- Windows unit 35 of 35 (`reports/unit-windows-last.log`).
- Dev window 32 of 32 (`reports/e2e-dev-2026-10-29150002`); fresh test package, packaged window 32 of 32 (`reports/e2e-packaged-2026-10-29150149`).
- Linux unit 35 of 35, Xvfb window 31 of 31, deb and rpm built (`reports/linux-20261029T150311Z`).
- Windows Terminal, real: 10 of 10 (`reports/wt-check-2026-10-29145754`).

macOS is still not built or run, so the answer stays NO.

Independent Codex checks at 08:49 Central repaired terminal ANSI contrast and the detached Windows updater helper. Current actual results: Windows unit 29/29, dev window 29/29, fresh test package and packaged window 29/29; Linux unit 29/29 and Xvfb window 28/28. Final receipts freeze 51 source/renderer files. Both planted regressions failed their intended assertions. See `docs/CODEX-LOCAL-QA-1029.md` and `D:/atlias-app/reports/ui-goal-1028/app-local-qualification-1029.json` for scope and raw receipts. These fixture checks do not establish native macOS, a real Linux desktop, live billing/providers or a real release upgrade of the changed helper. The historical checks below retain their original source scope.

The app is built and verified end to end on Windows 11. On Linux:
- The logic, packages and window are verified in WSL2 under Xvfb.
- No real desktop session has run it.

macOS has adapters written, but nothing built or run.

The sections below say exactly what is and is not verified. Under the brief's rule, an unverified platform means the app is not fully finished. Codex should not add the app to the local website yet.

## What was built

- **Electron app** (Electron 44.7.2, React 19.3.0), Max-only, running the real Atlias harness:
  - `src/host/runner.mjs`: one process per job, driving `agent.turn` or one slash command.
  - `src/host/host.mjs`: the long-lived query host.
  - `src/main`: the window; named, schema-checked IPC with sender checks and membership gates; the account client; OS-protected secrets; job supervision; OS adapters; updates.
  - `src/renderer`: the window UI, with no Node, no network and a strict CSP.
- **Workflows**:
  - Projects and chats: full-text search across every saved chat, resume, rename, pin and archive.
  - Composer: per-chat drafts; attachments from inside the project, including images sent to the model; slash-command hints.
  - Running work:
    - a queue, with edit and remove before start;
    - Stop that waits for confirmation;
    - approvals that show the exact command or file, apply once, expire, and are bound to account, device, job and hash;
    - plan cards that show the plan and offer approve, keep planning or ask for a change;
    - worker sub-agents;
    - outcomes taken from the harness's own edit and check events.
  - Review: a Changes pane with the real git diff; Checks and Usage tabs.
  - Connections, Settings and Atlias commands (every built-in plus custom ones).
  - Settings, About: check for updates.
  - Window behaviour: keyboard shortcuts in both menu and window, narrow layout, reduced motion, forced colors.
- **Account service** (`account-service/`, local only, never deployed):
  - Sign-in: PKCE with a loopback redirect and an email code; an Ed25519 device proof; refresh rotation, where reuse revokes the device; device revocation.
  - Passes: v1, valid offline for at most 7 days and at most 3 days past paid-through.
  - Billing: Stripe checkout ($4 for the first paid month after launch, then $12/month; prelaunch time uses none of it) and signed, idempotent webhooks.
  - Sign-in email:
    - The account service sends through an HTTP mailer (Resend request shape) when `RESEND_API_KEY` and `MAIL_FROM` are set.
    - Otherwise codes go to a local outbox file.
    - A failed send shows a retry page and keeps no code.
- **Updates** (`src/main/updates.mjs`):
  - An Ed25519-signed manifest per platform and architecture, carrying version, https address, installer type, size and SHA-256.
  - The download is kept only when size and checksum match.
  - On Windows, a small cmd helper waits for the app to exit, then starts Squirrel's Setup.exe. Setup replaces the whole install folder; Squirrel's log calls it "burning it to the ground".
  - On macOS and Linux, the checked file is shown in its folder, with install words.
  - Release builds have no feed, because none is published.
- **Terminal drawer** (Ctrl+J, or View, Terminal), the first recommendation of `docs/TERMINAL-WRAPPER-RESEARCH-1029.md`:
  - Real terminals inside the window: xterm.js 6 draws them; main owns the ptys (`@lydell/node-pty` 1.2.0-beta.18, prebuilt for all three systems).
  - A pane runs a shell in the project, the full Atlias terminal UI, or an engine sign-in (Connections opens it here), always with this account's Atlias home.
  - Links open through the app's confirm dialog. Ctrl+Shift+C copies, Ctrl+V pastes, Ctrl+J hides it.
  - On Windows the Atlias CLI runs with a bundled console `node.exe`: official v22.21.0, kept only when its SHA-256 matches nodejs.org's list (`tools/fetch-node.mjs`).
- **Appearance** (Settings, Appearance), RideLink's way:
  - Light or dark follows the computer by default; Dark and Light override it.
  - Accents: Atlo blue plus RideLink's nine. Each has a text-safe tone, a fill, and text on the fill chosen for contrast.
- **Packaging** (`forge.config.cjs`):
  - Windows Squirrel installer, macOS zip, Linux deb and rpm.
  - Release fuses: the inspector is off; RunAsNode stays on for the harness's own children.
  - Test packages differ only in the inspector fuse and a `max-test.json` marker.
- **From the UI comparison** (docs/UI-COMPARISON-1029.md, wins 1 to 4):
  - Shift+Tab in the message box moves through the harness's own permission cycle (workspace, auto-accept, plan, auto); Tab still moves on.
  - The sidebar filters chats by state: All, Running, Waiting (for you), Done, with counts. A new chat still on its first turn is listed from its jobs and opens from there.
  - Changes shows line numbers. A comment goes under any line (mouse, or arrow keys and Enter). Comments are kept per project until sent to the open chat as one message naming each file and line.
  - Stage, Unstage and Revert per file; Stage or Delete for an untracked file. Each asks first, with focus on the question.
    - The host acts only while the file is still the change that was shown.
    - It refuses files outside the project folder and treats names literally.
- **Open in terminal** opens Windows Terminal when it is installed (`wt -w 0 nt -d <folder>`: a new tab in the most recent window, or a new window), with the bundled console node.exe. Otherwise, or for a path with a semicolon, it opens a cmd window as before.
- **Ledger**: `docs/CAPABILITY-LEDGER.md` traces every harness command, tool and engine to its app route and status.

## Evidence (receipts under D:/atlias-max-app/reports)

Source fingerprints after the final edits: `reports/fingerprints-20261029T070842.txt` (source files plus the bundled node.exe; sha256 of the list da74c560632d8cdda4bb5ac29a7e6e435ea9bfa241a93b87fa86414dddbdcb84).

| Check | Result | Receipt |
|---|---|---|
| Unit and integration tests, Windows 11, final source (adds review.test.mjs: parser, stage, unstage, revert, refusals, permission cycle, Windows Terminal choice, cmd in a non-ASCII folder) | 35 of 35 pass, 0 skipped, exit 0 | reports/unit-windows-last.log |
| End to end, development build and fresh packaged test build, Windows 11, final source | 32 of 32 each, exit 0. New: Waiting and Running filters (an unsaved running chat reopened from the sidebar), Shift+Tab cycle with two quick presses, two diff comments (mouse and keyboard) arriving as one model message, stage, a refused stale revert, revert, untracked delete, axe-core on the review pane and sidebar in light and dark | reports/e2e-dev-2026-10-29150002, reports/e2e-packaged-2026-10-29150149 |
| Linux (WSL2 Ubuntu 26.04.1), final source | unit 35 of 35; Xvfb e2e 31 of 31 (UI Automation is Windows only); deb 94,126,292 bytes sha256 8716c5e9...; rpm 103,355,982 bytes sha256 4c3158c7... | reports/linux-20261029T150311Z/receipt.txt |
| Windows Terminal, real | 10 of 10: through platform.openTerminal into its own named window; the CLI ran in a folder with spaces and accents, with this account's home, the chat to resume, a console for input, and the bundled node.exe; that window then closed through UI Automation | reports/wt-check-2026-10-29145754/receipt.txt |
| Unit and integration tests, Windows 11: account service 6, harness slice 5, workflows 5, mailer 3, updates 4, terminal 4 | 27 of 27 pass, 0 skipped, `npm test` exit 0 | reports/unit-windows-last.log |
| End to end, packaged test build, Windows 11, final source | 28 of 28 steps pass, exit 0: terminal drawer, appearance and axe-core audit included | reports/e2e-packaged-2026-10-29120414/receipt.txt |
| Same tests, Linux 6.18 (WSL2 Ubuntu 26.04.1), final source | 27 of 27 pass. The install-helper test checks only the script text there; it runs the helper on Windows | reports/linux-20261029T120341Z/unit.log |
| End to end, packaged test build, Windows 11 | 25 of 25 steps pass, exit 0 | reports/e2e-packaged-2026-10-29110435/receipt.txt |
| End to end under Xvfb, Linux development build, final source | 27 of 27 pass (the UI Automation step is Windows only), including the terminal drawer with the app binary as Node, appearance and axe-core. Stop leaves no command process | reports/linux-20261029T120341Z/receipt.txt |
| Linux Stop with only the harness repair (app workaround removed in a copy) | unit 22 of 22; e2e 24 of 24; no command process left. The workaround was then removed from the project | reports/linux-stop-variant-20261029T095946Z/receipt.txt |
| Linux packages (x64), final source | deb 94,124,680 bytes, sha256 86fc4183...; rpm 103,348,518 bytes, sha256 36b27647... | reports/linux-20261029T120341Z/receipt.txt |
| Windows release installer: build, fuses, silent install, files, shortcut, uninstall | all pass, exit 0: files, shortcut and the empty Start menu folder removed; user data kept. The installer is not signed | reports/windows-install-2026-10-29111155/receipt.txt |
| Windows in-app upgrade (test packages): the installed 0.1.0 app checks a local signed feed, downloads and checks 0.1.1, quits, and its helper starts Setup.exe | all 24 pass, exit 0: 0.1.1 installed (binary 0.1.1); Start menu and Desktop shortcuts present, then removed on uninstall; app files removed | reports/windows-inapp-upgrade-2026-10-29105808/receipt.txt |
| Windows upgrade by running the 0.1.1 release Setup.exe over 0.1.0 | upgrade passes (binary 0.1.1, shortcut and user data kept). One FAIL: right after uninstall, the 0.1.1 files were still there under Squirrel's `.dead` marker (deferred deletion). Later checks remove files within two minutes | reports/windows-upgrade-2026-10-29094319/receipt.txt |

The two Windows receipts above that ran before `src/main/index.cjs` changed (empty Start menu folder removal at uninstall) are the packaged e2e and the in-app upgrade. That file only acts on Squirrel's install and uninstall events. The release install check (111155) ran after the change and covers it.

The 25 end-to-end steps:
- Startup and security:
  - sign-in screen with the test notice;
  - no Node, no require, network blocked, inline script blocked;
  - forged, oversized and signed-out requests refused.
- Sign-in and membership:
  - browser PKCE sign-in, where the first email send fails, the retry page shows and the window keeps waiting; the retry delivers the code through the HTTP mailer;
  - membership screen with checkout.
- Working in a project:
  - open a project; exact approvals and a verified outcome; real diff;
  - reload restores the job; a denied edit changes nothing; Stop leaves no command process;
  - search opens the right chat; terminal import; a slash command;
  - plan card with the plan and its three choices, where Keep planning changes nothing;
  - an image from the file picker reaches the model request.
- Accessibility and layout:
  - commands and connections;
  - narrow window; reduced motion; keyboard Tab order with visible focus; every control named in the page;
  - Windows UI Automation, the tree Narrator reads: 30 named interactive controls, none unnamed.
- Updates: a foreign signature is refused; a signed update is offered, downloaded, checked and handed to the installer.
- Membership end and sign-out:
  - ended membership refuses work but keeps chats;
  - sign-out removes secrets and keeps chats.

All billing used the local fake provider with test ids. All email went to local stand-in servers. No Stripe, email, model or paid API call was made.

## Findings fixed during the two passes

1. When the server said a membership ended, the pass was deleted, locking people out of their chats. The pass now stays, and main refuses new work.
2. A runner that could not start left its job "starting" forever. It now ends as failed.
3. The runner exited 50 ms after posting its result. Main now ends it after recording the result.
4. Linux folder comparison ignored case.
5. The tool list read as if an edit happened while it still awaited approval.
6. Shortcuts did not work where menu accelerators do not reach.
7. A Squirrel install would have launched the full app mid-install.
8. Stop on Linux and macOS left the command running. The harness repaired it in 1cb3b18. The app's own workaround was removed after the harness's stop alone passed the Linux check.
9. rpm 6 broke electron-installer-redhat's spec. Fixed with a project template.
10. A comment falsely claimed email delivery.
11. The plan card asked for approval without showing the plan, which appeared only after the job. The card now carries the plan.
12. The plan card repeated the terminal prompt "[a]pprove ... [e]dit:" under its own heading.
13. A failed sign-in email kept a code the person never received, counted it toward the hourly limit, and surfaced as an unhandled server error. It now shows a retry page and withdraws the code.
14. The Windows update started Setup.exe 800 ms before the app quit, while Setup deletes the install folder. A helper now waits for the app to exit.
15. The first wait helper, a detached PowerShell, never ran: without a console it exits at once (measured). A cmd helper replaced it; it starts Setup 6 to 14 s after the app exits, mostly time spent in `tasklist`.
16. The install check measured "user data left as it was" after the first run had already created it. It now measures before the install and removes what it created.
17. The UI Automation step looked up Playwright's launcher process, not Electron's main process.
18. Journal events over 64 KB are cut, which would empty a long plan card. The plan is capped by bytes and marked when shortened.
19. The upgrade checks read the version and uninstalled while Squirrel was still finishing. That made the version read come back empty and the uninstall exit -1. The failed uninstall left my test shortcuts in the Start menu and on Gev's Desktop; I removed both. The checks now wait for Squirrel and check the Desktop too.
20. Uninstall left an empty "Atlias" Start menu folder. The uninstall event now removes it when empty.
21. The e2e Stop step required a visible "Stopping" frame, which a fast stop never renders. It now accepts an immediate stop and still requires zero leftover processes.
22. On Windows the app binary is a GUI-subsystem program. Run as Node in a console it gets output but no console input (measured), so the separate-window "Open in terminal" and engine sign-in could never take input with the real app. The earlier handoff test used node.exe in its place. Interactive CLI use now runs with a bundled console node.exe. It is verified in the drawer; a visible separate window was not run.
23. node-pty on Windows reports pid 0 until ConPTY has started the program. The pid is now read live.
24. After a pty's program exited, its port and socket kept the process alive. The pty is now killed on exit.
25. The strict CSP refused xterm's theme `<style>` and its selection style attributes. Inline styles are now allowed; scripts, frames, forms and the network stay closed.
26. Playwright emulates a light colour scheme by default, so every earlier capture was light. The appearance step turns emulation off and checks the app against Windows' own setting, which here is dark.
27. axe-core found:
    - the terminal tab list broke the tablist rule;
    - the test notice bar, tags, the key hint in the primary button and the selected chat's meta line were under 4.5:1;
    - white on Atlo blue read 3.96:1 in dark mode, so the dark fill is now #2b6be1 (4.56:1).
    It now finds none, in light or dark.
28. `relay.js` and `usage.js` of Usage Limits, run from Claude Code's shell, picked Codex's window. The first relay was booked 20 minutes out; I cancelled it and re-armed with `--host claude`. Reported for its owner; I did not change its files.
29. The diff parser dropped every file with a space in its name, so Changes never showed it. It also added an empty line after the last hunk. Both are fixed.
30. Open in terminal from a folder with a non-ASCII name never started the CLI: cmd reads a script in the console code page and the script is UTF-8. A test that runs cmd itself failed, then passed once the script's first line switched cmd to UTF-8.
31. In light mode the Changes pane's green "+N" read 4.32:1. The light green is now #0f6e42. The audit had never run with that pane open; it does now.
32. The new comment list's links read under 4.5:1 in dark mode; they now take the ink colour with an underline. The running and waiting word was cut off at the end of a narrow sidebar row; it now comes first.
33. With the review pane open, the message box's hint wrapped into a scrollbar. It now ends in an ellipsis on one line.

## Not verified, or not built (why it is not finished)

- **macOS**: nothing built or run. Keychain, Gatekeeper, hardened runtime, Developer ID signing, notarization, VoiceOver, Terminal handoff, Stop, and the update's show-in-folder path are all unverified. They need a Mac and an Apple signing identity.
- **Linux desktop**: the only GUI run was under Xvfb in WSL2, where Playwright passes --no-sandbox. Still unverified:
  - a real GNOME or KDE session, the Chromium sandbox, a desktop keyring;
  - Orca, Wayland, installing through apt or dnf, and arm64.
- **Windows**:
  - Narrator itself was not run; its UI Automation tree was checked.
  - There is no code signing, so SmartScreen behaviour was not observed.
  - The release build was not launched (its inspector is off). The in-app upgrade used test packages.
- **Engines**: only the OpenAI-compatible path ran, against local stand-in models. The Claude plan, ChatGPT plan, Ollama and the API engines were not run through the app. Their sign-in opens a separate terminal window, which was not exercised.
- **Updates**:
  - No feed is published, so a release build says so.
  - Squirrel updates by full reinstall (no delta).
  - macOS and Linux installs are manual after the checked download.
- **Email**: only local stand-in servers; no live provider was called.
- **Not implemented**:
  - a deployed account service and live Stripe (not authorized);
  - starting the harness's MCP server from the app.
- **Not in the window e2e**:
  - worker sub-agents and /deep-research (covered through the runner in unit tests);
  - /relay at and after-reset, which would create a real Windows scheduled task.
- **Terminal**:
  - The drawer is verified on Windows (dev and packaged) and Linux under Xvfb; not on macOS.
  - The pty library is a beta.
  - A link click opens the native confirm dialog and was not exercised in the e2e.
  - "Open in terminal" through Windows Terminal ran for real in a named window. The app's own `-w 0` (the most recent window) was not run, so as not to add a tab to a window of Gev's. The cmd fallback is unit-tested with a stand-in; that window was not opened.
  - The provider's own sign-in was not completed.
- **UI comparison**: written (docs/UI-COMPARISON-1029.md); wins 1 to 4 are built.
  - Still to build: side chat and worktree mode.
  - The status filter covers the open project, not every project.
- **Leftovers on this PC from my checks** (deletion was declined):
  - `%LOCALAPPDATA%\atlias_max`: Squirrel's `.dead` residue, which Squirrel removes on the next install;
  - `%APPDATA%\Atlias Max`: Chromium caches created by install-check first runs.
