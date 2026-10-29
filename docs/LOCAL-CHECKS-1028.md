# October 28 local checks

Gev requested connected-engine usage, explicit session selection, a beginner UI and bug sweep, local benchmark animation, Stripe readiness, and a delayed Claude app goal. Website work must remain local.

Implemented engine account rows with zero, unknown, stale and expired states; `/usage`; searchable arrow-key `/resume`; CLI `atlias resume` selection; explicit `last` remains available. Session token counts are separate from account percentages. Dedicated ChatGPT never borrows Codex's allowance. No credentials or model API calls are needed for account display.

Initial targeted checks: 241/241 across 18 suites. Three new account/session Node tests passed, including 40 sessions, cancellation, unknown providers, zero percent, resize bounds and an invisible-selection guard. Existing actual ConPTY queue/attachment/plain-mode usability check passed with five loopback fixture calls and zero external model requests. New native account/session and full integration runs have separate logs; read their final results before claiming completion.

Local website changes add one-time benchmark bar motion, replay and reduced-motion cancellation without changing scores, scales or recorded values. Motion/billing targeted tests passed 18/18. UFS debug timed out during page loading, so that attempt is incomplete and is not a visual pass. Browser screenshot review remains required.

Stripe audit reproduced a missing entitlement check before repair: an active subscription could receive a signed Max pass without its price or paid invoice being checked. The local repair requires the configured Max price, one item of quantity one, live mode and an expanded latest paid invoice; trialing and unpaid subscriptions are rejected. Requests are bounded and refuse redirects. Coupon product restrictions are checked for launch readiness. Production remains unconfigured and untested. No charge, subscription, deployment or publication was made.

Stripe lifecycle and search reference: https://docs.stripe.com/billing/subscriptions/overview and https://docs.stripe.com/api/subscriptions/search . Status alone does not prove every invoice is paid; this app requires the latest invoice to be paid before granting a new pass.

Claude message delivery was actually acknowledged; see CLAUDE-DELIVERY-1028.md. The app build handoff is scheduled at23:05:01 America/Chicago, not yet sent. Gev's final corrected app platforms are macOS, Windows and Linux; iOS is outside scope. Do not advertise the future app before Claude explicitly reports full completion and the evidence is reviewed. Native platform testing must never be guessed.

## Continued local verification

Completed receipts live under `reports/ui-goal-1028/`. Actual native account/resume runs exited zero, selected from40 saved sessions through both entry points, and kept an empty selected chat open. The25-command manual sweep covered help, connections, usage, settings, clear/resume, rewind cancellation and export without changing inspection preferences. A screenshot-capture race was found and fixed in the test: it now waits for a fresh `1 of1` filtered frame and matching query before capture. Seven actual ConPTY replay states were rendered and reviewed, including the corrected filtered picker. Session accounting includes workers and remains attributed by engine after switching/resuming; partial reporting stays labelled.

The full website test command (`node --test test/*.test.mjs`) exited zero:242 tests, zero failures or skips, and unchanged source hashes. The local site build also exited zero with unchanged source hashes and built nine pages. A separate accidental broad `node --test` invocation included the browser-flow helper and exited1; it is not counted as a suite pass. The four actual browser cases (360/1440, normal/reduced motion) exited zero with21 values unchanged, replay working, and animations cancelled when reduced motion is enabled mid-play. All four captures were inspected. The loopback native queue/attachment/plain workflow and local Stripe client/server contract integration also exited zero.

The adversarial runner exited zero:17 syntactically valid semantic regressions were caught by real assertion failures, with unmodified app/site positive-control copies passing first. Cases cover zero/foreign quotas, per-engine attribution, hidden/wrong picker choices, raw-mode fallback, working footer, price/invoice/live-mode checks, body limits, retry idempotency, expiry cap, signing-key mismatch, coupon eligibility and motion/reduced motion. See `adversarial/receipt.json` and its output log.

The broad UFS verifier exited1 and is not a clean audit:11 pre-existing style findings (brand blue and truthful unreleased-Max copy), plus three render findings (static preview has no waitlist backend, and two asset requests exceeded its wait). The animation-specific server/browser check supplies a local count fixture and passed. Existing brand and honest availability text were preserved. This does not establish live backend readiness. The final full app suite is recorded separately and must have its actual exit/result inspected before any completion claim.

Stripe preparation and remaining configuration/provider checks are documented in `STRIPE-READINESS-1028.md`. No live charge, paid API call, push or deployment was made.
