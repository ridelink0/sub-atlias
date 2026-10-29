# Atlias Max desktop app: completion report

Date: 2026-10-29 (America/Chicago). Project: D:/atlias-max-app (local git only; nothing pushed, deployed or charged). Harness: Atlias 4.0.0 vendored from D:/atlias-app commit d6c0930 (VENDOR.json). Brief: D:/atlias-app/docs/CLAUDE-APP-HANDOFF-1028.md. Model: Claude Opus 5.5 at xhigh effort.

## FULLY FINISHED IN EVERY ASPECT: NO

The app is built and verified end to end on Windows 11. On Linux, the logic and package are verified in WSL2, and the app runs under Xvfb. macOS has adapters written but nothing built or run. The sections below say exactly what is and is not verified. Under the brief's rule, an unverified platform means the app is not fully finished. Codex should not add the app to the local website yet.

## What was built

- **Electron app** (Electron 44.7.2, React 19.3.0), Max-only. It runs the real Atlias harness:
  - `src/host/runner.mjs` runs one process per job, driving `agent.turn` or one slash command.
  - `src/host/host.mjs` is the long-lived query host.
  - `src/main` holds the window, the named, schema-checked IPC with sender checks and membership gates, the account client, OS-protected secrets, job supervision and the OS adapters.
  - `src/renderer` holds the window UI, with no Node, no network and a strict CSP.
- **Workflows**:
  - projects, chats, full-text search across every saved chat (filters, paging, damaged-file reporting), resume, rename, pin and archive;
  - per-chat drafts, attachments from inside the project, slash-command hints;
  - a queue with edit and remove before start; Stop that stays "Stopping" until confirmed;
  - approvals that show the exact command or file, apply once, expire, and are bound to account, device, job and hash, with Enter never approving;
  - plan approval cards; outcomes taken from the harness's own edit and check events (verified, unverified, check failed, no changes, stopped, limit, interrupted, unknown);
  - a Changes pane with a real git diff per file; Checks and Usage tabs, where unknown or stale readings are labelled and never shown as zero;
  - Connections (provider sign-in in a real terminal window); Settings (the harness's own settings table); Atlias commands (every built-in, custom commands, tools, memory tools, permission modes);
  - explicit import of terminal chats; Open in terminal; keyboard shortcuts in both the menu and the window; narrow-window layout; reduced motion; forced colors.
- **Capability ledger**: `docs/CAPABILITY-LEDGER.md` traces every harness command, tool and engine to its app route and status.
- **Account service** (`account-service/`, local only, never deployed):
  - Account, Membership and Device records; PKCE sign-in with a loopback redirect and email code; an Ed25519 device key proof on every refresh and pass request;
  - refresh-token rotation, where reuse of an old token revokes the device; independent device revocation; logout;
  - v1 passes with `acct` and `dev`, valid offline for at most 7 days and at most 3 days past the paid-through date;
  - Stripe checkout ($4 for the first paid month after launch, then $12/month; prelaunch time uses none of it); linking a checkout to its account; migrating a terminal purchase by install id; signed, idempotent webhooks that re-read the subscription.
- **Membership policy**:
  - The gate runs in main, the host and the runner.
  - When membership ends, saved chats and results still open, Stop and sign-out still work, and new work is refused.
- **Packaging** (`forge.config.cjs`):
  - Windows Squirrel installer, macOS zip, Linux deb and rpm.
  - Release fuses: the inspector is off, and RunAsNode stays on because the harness's own children need it.
  - A test package differs from a release only in the inspector fuse and a `max-test.json` marker, and it shows a test bar.

## Evidence (receipts under D:/atlias-max-app/reports)

| Check | Result | Receipt |
|---|---|---|
| Unit and integration tests, Windows 11 (account service 6, real harness vertical slice 5, workflows 4, mailer 2) | 17 of 17 pass, `npm test` exit 0 (2026-10-29 03:48) | reports/unit-windows-last.log; source fingerprints reports/fingerprints-20261029T034833.txt |
| Unit and integration tests, Linux kernel 6.18 (WSL2 Ubuntu 26.04.1) | 11 of 11 pass (the earlier set; the 6 newer tests were not run on Linux) | reports/linux-*/unit.log |
| End to end, development build, Windows 11 | 21 of 21 steps pass | reports/e2e-dev-2026-10-29080800/receipt.txt |
| End to end, packaged test build, Windows 11, latest source | 21 of 21 pass | reports/e2e-packaged-2026-10-29081916/receipt.txt |
| Windows release installer: build, fuses, silent per-user install, files, Start menu shortcut, uninstall, removal | all pass; the installer is not signed, and it was built before the final POSIX-only Stop change (the Windows Stop path is unchanged) | reports/windows-install-2026-10-29081019/receipt.txt |
| Linux deb and rpm builds (x64) | both built: deb 92.8 MB, rpm 102.1 MB, each with the app binary and resources/harness | reports/linux-20261029T081714Z/receipt.txt, rpm-retry.txt |
| Linux end to end under Xvfb, development build, latest source | 21 of 21 pass, including Stop leaving no process of the command | reports/linux-20261029T081714Z/receipt.txt |

The 21 end-to-end steps:
- sign-in screen and test notice;
- security (no Node, no require, network blocked, inline script blocked);
- forged, oversized and signed-out requests refused;
- browser PKCE sign-in; membership screen with checkout;
- open a project; send a message with exact approvals and a verified outcome; real diff and Checks;
- reload restores the job; a denied edit changes nothing; Stop leaves no command process;
- search opens the right chat; terminal import; a slash command; commands and connections;
- narrow window; reduced motion; keyboard Tab order with visible focus; every control named;
- ended membership refuses work but keeps chats; sign-out removes secrets and keeps chats.

All billing in these checks used the local fake provider with test ids. No Stripe, model or paid API call was made.

## Findings fixed during the two passes

1. When the server said a membership ended, the pass was deleted, which locked people out of their own chats. Fixed: the pass stays as device proof, and main refuses new work.
2. A runner that could not start left its job "starting" forever. Fixed: the job ends as failed with the reason.
3. The runner exited 50 ms after posting its result, so a result could be lost under load. Fixed: main ends the runner after recording the result.
4. Linux folder comparison ignored case. Fixed.
5. The tool list read as if an edit had happened while it still awaited approval. Fixed: it is labelled "tool calls started".
6. Shortcuts did not work where menu accelerators do not reach. Fixed: the window also handles them, with dedupe.
7. Installing with Squirrel would have launched the full app mid-install. Fixed: the standard install, update and uninstall events are handled.
8. **Stop on Linux and macOS left the command running.** The harness's `abortRunning` SIGKILLs a watchdog that is not a group leader. Worked around in the runner: watchdogs get SIGTERM first. Filed for Codex: D:/atlias-app/reports/claude-app-handoff-1028/HARNESS-POSIX-ABORT-1029.md.
9. rpm 6 builds in a per-package folder, which breaks electron-installer-redhat's spec. packaging/rpm-spec.ejs copies from %{_topdir}/BUILD instead, and the rpm then built.
10. A false comment claimed email delivery through Resend. Corrected: email is not wired.

## Not verified, or not built (why it is not finished)

- **macOS**: nothing built or run. The Keychain, Gatekeeper, hardened runtime, Developer ID signing, notarization, VoiceOver, Terminal handoff and process-group stop are all unverified. They need a Mac and an Apple signing identity.
- **Linux desktop**: the only GUI run was under Xvfb in WSL2, where Playwright passes --no-sandbox. Still unverified:
  - a real GNOME or KDE session, the Chromium sandbox, a desktop keyring (with none present, secrets stay in memory only, by design);
  - Orca, Wayland, installing through apt or dnf on a supported distribution, and arm64.
- **Windows**:
  - Narrator was not exercised (the role and name checks ran in the page).
  - There is no code signing, so SmartScreen behaviour was not observed. Upgrade from one installed version to the next was not tested.
  - The release build itself was not launched (its inspector is off); the packaged test build was.
- **Engines**: only the OpenAI-compatible path ran, against the local fixture model. The Claude plan, ChatGPT plan, Ollama and the API engines were not run through the app, so no plan allowance was spent. Their sign-in opens a terminal; that path was written but not exercised.
- **Not implemented**:
  - an auto-update channel: Squirrel updates are not hosted, and Linux and macOS have no update route;
  - live email delivery for sign-in codes: account-service/mailer.mjs sends over HTTP in the Resend request shape and is tested only against a local fixture server; the server selects it when RESEND_API_KEY and MAIL_FROM are set (that selection is syntax-checked only), no live provider was called, and how the sign-in page reports a send failure was not tested;
  - a deployed account service and live Stripe configuration (not authorized);
  - starting the harness's MCP server from the app (it serves host harnesses).
- **Not exercised in the app's end-to-end runs**: worker sub-agents and /relay scheduling (/relay at and after-reset create a real Windows scheduled task). Plan approval (keep and approve), image attachments, /relay status, /deep-research and the provider terminal handoff script are covered by test/unit/workflows.test.mjs through the real runner and harness, but not through the window.
