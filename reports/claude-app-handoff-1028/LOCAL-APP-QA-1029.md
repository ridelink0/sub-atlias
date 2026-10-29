# Local app checks, October 29, 2026

Codex independently checked the current source after Claude's 07:10 budget pause. Claude's existing Extra high session and Usage Limits relay were preserved; no new goal was sent. Everything stayed local.

## Repairs

The terminal inherited xterm's default minimum contrast of 1. Actual Light ANSI output measured DarkGreen at 3.011:1. Setting `minimumContrastRatio: 4.5` fixes that output in both appearances. The window test now measures all 16 ANSI foreground colors against the first opaque background behind the actual rendered text in Light and Dark. Windows development, the fresh Windows package and Linux Xvfb each passed all 32 samples; the minimum was 4.511906749:1. Their terminal captures were inspected.

The original Windows update helper failed twice, including an isolated run: its detached CMD process did not reach the stand-in installer after app exit. A no-pipe diagnostic also showed that an empty process query could lead to an installer launch while the stand-in app was alive. The replacement uses the bundled standalone console Node, copied beside the checked download so replacing the install folder cannot replace the running helper. It probes the app PID with signal 0, waits for exit, and refuses installation on an unknown process-query error or a four-minute timeout. The app passes the same trusted console runtime that its terminal uses. Paths and arguments go directly to `spawn`, without a shell.

Actual Windows tests use the bundled Node, a folder containing spaces and a non-ASCII character, a stand-in app process and a marker installer. They verify waiting, launch after exit, a live-app deadline, a query error, missing runtime and launch failure. The new deadline/error tests shorten the generated helper's deadline in their own fixture only. Only owned fixture child processes are stopped during cleanup.

## Actual results

Raw logs, source snapshots and actual exit codes are under `D:/atlias-app/reports/ui-goal-1028/`:

| Receipt directory | Result |
| --- | --- |
| app-unit-node-final | Windows 29/29 unit tests; exit 0 |
| app-windows-node-final-dev | Windows 29/29 window steps; exit 0 |
| app-windows-package-node-final | Fresh Windows test package; exit 0 |
| app-windows-node-final-packaged | Packaged Windows 29/29 window steps; exit 0 |
| app-linux-node-final-unit | Linux 29/29 unit tests; exit 0 |
| app-linux-node-final-e2e | Linux Xvfb 28/28 window steps; exit 0 |

All six receipts have identical before/after hashes for 51 source and bundled-renderer files. Unit logs report zero skipped/cancelled tests. Windows-only behavioral bodies are conditional on Windows; Linux's count does not establish Windows behavior. Linux ran in a new private directory with existing Linux dependencies, preserving Claude's CI copy. No dependencies or packages were downloaded by that Linux check.

The window checks cover HTTP mailer selection and failed-send retry through browser sign-in, signed fixture membership, approvals and real file edits/checks, Stop, workers, chat search/resume, plans, images, terminal lifecycle, usage/connections, axe, settings persistence and membership expiry. Windows also checks the actual UI Automation tree. Models, email and billing remain local fixtures. The update window step downloads a signed fixture and uses an install hook; it does not install a real release. The separate unit check actually runs the detached update helper with a harmless marker installer.

`app-local-qualification-1029.json` validates those logs, exits, hashes, ANSI samples and the fresh ASAR's exact main/updater/renderer bytes plus its bundled Node. The vendor remains harness commit `1cb3b18e42fbefb144f5fecab3fc234426d2993b`; Stop passed again through the window on both operating systems.

## Adversarial pass

Reread main's updater caller, the generated helper, terminal setup, both changed test files and the evidence scripts for missing inputs, argument types, path quoting, encoding, timing, background selection and failure cleanup. Added validation for missing/non-array arguments and unsafe PIDs. The helper fails closed when its runtime cannot be staged or launched.

Two valid semantic regressions were rejected by real behavior checks:

- Replacing the built terminal's 4.5 option with 1 produced the intended Light DarkGreen 3.011:1 failure (28/29 window steps, exit 1). The exact original bundle bytes were restored, then the final fresh packaged check passed 29/29.
- Removing the unknown-query-error refusal in an isolated copy passed syntax but failed the actual query-error assertion (exit 1), after the same isolated positive control passed. The live app source was unchanged.

Earlier contrast failures caused by shortcut debouncing and measuring a sibling viewport were fixture errors, not product evidence. They were corrected before the measured red/green pair. The first inline packaging invocation failed with a rebuilder exit; the file-based runner then built successfully. Its original child diagnostic is incomplete, so no packaging source defect is claimed. The qualification script initially used slash-separated ASAR keys on Windows; native path normalization fixed that checker error.

## Remaining qualification

FULLY FINISHED IN EVERY ASPECT: NO.

No native macOS build/run, real Linux desktop/keyring/sandbox/Orca/install, real provider app workflow, real external email or live billing was established here. The changed helper was not rerun through a real Squirrel release upgrade. Existing historical installer receipts retain their original source scope. Release signing, real Narrator use and the remaining comparison/Windows Terminal work still need their recorded checks. These results do not open the local website app gate.
