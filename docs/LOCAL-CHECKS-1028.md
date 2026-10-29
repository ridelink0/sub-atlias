# October 28 local checks

Gev requested connected-engine usage, explicit session selection, a beginner UI and bug sweep, local benchmark animation, Stripe readiness, and a delayed Claude app goal. Website work must remain local.

Implemented engine account rows with zero, unknown, stale and expired states; `/usage`; searchable arrow-key `/resume`; CLI `atlias resume` selection; explicit `last` remains available. Session token counts are separate from account percentages. Dedicated ChatGPT never borrows Codex's allowance. No credentials or model API calls are needed for account display.

## Initial checks (historical)

Initial targeted checks: 241/241 across 18 suites. Three new account/session Node tests passed, including 40 sessions, cancellation, unknown providers, zero percent, resize bounds and an invisible-selection guard. Existing actual ConPTY queue/attachment/plain-mode usability check passed with five loopback fixture calls and zero external model requests. Later results and their limits are recorded under Continued local verification below.

Local website changes add one-time benchmark bar motion, replay and reduced-motion cancellation without changing scores, scales or recorded values. Motion/billing targeted tests passed 18/18. The initial UFS debug timed out during page loading and was not a visual pass. The subsequent browser checks and screenshot review are recorded below.

Stripe audit reproduced a missing entitlement check before repair: an active subscription could receive a signed Max pass without its price or paid invoice being checked. The local repair requires the configured Max price, one item of quantity one, live mode and an expanded latest paid invoice; trialing and unpaid subscriptions are rejected. Requests are bounded and refuse redirects. Coupon product restrictions are checked for launch readiness. Production remains unconfigured and untested. No charge, subscription, deployment or publication was made.

Stripe lifecycle and search reference: https://docs.stripe.com/billing/subscriptions/overview and https://docs.stripe.com/api/subscriptions/search . Status alone does not prove every invoice is paid; this app requires the latest invoice to be paid before granting a new pass.

Claude message delivery was actually acknowledged; see CLAUDE-DELIVERY-1028.md. The app build handoff is scheduled at23:05:01 America/Chicago, not yet sent. Gev's final corrected app platforms are macOS, Windows and Linux; iOS is outside scope. Do not advertise the future app before Claude explicitly reports full completion and the evidence is reviewed. Native platform testing must never be guessed.

## Continued local verification

Completed receipts live under `reports/ui-goal-1028/`. Actual native account/resume runs exited zero, selected from40 saved sessions through both entry points, and kept an empty selected chat open. The25-command manual sweep covered help, connections, usage, settings, clear/resume, rewind cancellation and export without changing inspection preferences. A screenshot-capture race was found and fixed in the test: it now waits for a fresh `1 of1` filtered frame and matching query before capture. Seven actual ConPTY replay states were rendered and reviewed, including the corrected filtered picker. Session accounting includes workers and remains attributed by engine after switching/resuming; partial reporting stays labelled.

The full website test command (`node --test test/*.test.mjs`) exited zero:242 tests, zero failures or skips, and unchanged source hashes. The local site build also exited zero with unchanged source hashes and built nine pages. A separate accidental broad `node --test` invocation included the browser-flow helper and exited1; it is not counted as a suite pass. The four actual browser cases (360/1440, normal/reduced motion) exited zero with21 values unchanged, replay working, and animations cancelled when reduced motion is enabled mid-play. All four captures were inspected. The loopback native queue/attachment/plain workflow and local Stripe client/server contract integration also exited zero.

The adversarial runner exited zero:17 syntactically valid semantic regressions were caught by real assertion failures, with unmodified app/site positive-control copies passing first. Cases cover zero/foreign quotas, per-engine attribution, hidden/wrong picker choices, raw-mode fallback, working footer, price/invoice/live-mode checks, body limits, retry idempotency, expiry cap, signing-key mismatch, coupon eligibility and motion/reduced motion. See `adversarial/receipt.json` and its output log.

The broad UFS verifier exited1 and is not a clean audit:11 pre-existing style findings (brand blue and truthful unreleased-Max copy), plus three render findings (static preview has no waitlist backend, and two asset requests exceeded its wait). The animation-specific server/browser check supplies a local count fixture and passed. Existing brand and honest availability text were preserved. This does not establish live backend readiness. The final full app suite is recorded separately and must have its actual exit/result inspected before any completion claim.

Stripe preparation and remaining configuration/provider checks are documented in `STRIPE-READINESS-1028.md`. No live charge, paid API call, push or deployment was made.

## October29 integrity follow-up

The first full app run finished with exit1,3356/3361 checks. All five failures were in the real-repository integrity suite. The same source later passed13/13 in isolation and408/408 with all preceding50 suites. That original failure's cause is still unverified; an isolated pass does not erase it. Fixture setup now checks the actual Git stage/commit results so a failed baseline is reported directly.

Three additional checks reproduced separate discovery defects: failed or empty Git root discovery silently returned no diff, and a folder first observed without Git stayed negatively cached after `git init`. The minimal repair marks discovery errors incomplete and avoids caching missing roots. Before repair15/18 checks passed; after repair18/18 passed. Two syntactically valid planted regressions each failed the intended behavior assertion after an unmodified isolated control passed. Mutation-copy setup failures are preserved separately and are not counted as detected regressions. Evidence is under `gate-new-regression-red`, `gate-new-regression-green` and `discovery-mutations-final`.

The suspected native test failure-cleanup hang was a false alarm: a deliberately planted assertion after the real picker opened produced a natural parent exit1 in about two seconds, without invoking the probe's15-second emergency IPC exit. The probe itself exited0 and recorded this expected failure. This verifies that failure scenario, not every possible OS/process failure. See `native-failure-repro`.

The complete safe runner then exited0:3366/3366 checks across431 suites, followed by39/39 Node tests, with zero failures or skips. Its before/after source hashes match. Full trace output and the actual terminal receipt are under `app-suite-after-discovery-fix`. This establishes the current full-suite result; it does not prove the cause of the earlier transient failures. No source change was made to `lib/loop.mjs`. The website's current source hashes also still match its earlier passing242-test receipt.

## October29 POSIX Stop follow-up

Claude reported that `abortRunning` killed its POSIX watchdog before the watchdog could end the command group. Independent real Ubuntu WSL testing reproduced it:1/4 targeted checks passed, with commands and descendants still active. The repair sends SIGTERM to the watchdog first and allows1500ms for its existing handler; an unresponsive watchdog has its recorded command group ended before the watchdog. Cleanup clears the guard, and the timer is unreferenced. Windows keeps its taskkill tree path.

The four behavioral checks now pass on Windows and Linux with actual exit0 receipts. They cover simultaneous commands and descendants, the interruption error, an unresponsive watchdog and repeated/idle interrupts followed by a successful command. Isolated Linux positive control passed4/4; premature watchdog termination and omitted command-group cleanup each produced their intended assertion failure. The mutation wrapper exited0. The first mutation attempt failed its CRLF-sensitive fixture anchor before running cases; it is preserved and not counted as a pass. Normalizing only fixture line endings fixed that runner. RESEARCH-FIRST H3/H4/H5 applies: interrupted is not completed, and process liveness is checked independently of the returned result. No benchmark controller, request loop or Usage Limits source was changed.

The full safe runner finished at2026-10-29T09:08:11.212Z with actual exit0:3370/3370 checks across432 suites, then39/39 Node tests, zero skips and unchanged209-file source hashes. Evidence is under `app-suite-after-posix-abort`. The POSIX runtime measurements are Linux WSL measurements; native macOS behavior remains unverified. This shared-harness pass does not establish desktop-app completion. A documentation command was rejected because literal process-control words matched the guard; saving the same text with the file editor succeeded without any process-control action.
