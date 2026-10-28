# October 28 local checks

Gev requested connected-engine usage, explicit session selection, a beginner UI and bug sweep, local benchmark animation, Stripe readiness, and a delayed Claude app goal. Website work must remain local.

Implemented engine account rows with zero, unknown, stale and expired states; `/usage`; searchable arrow-key `/resume`; CLI `atlias resume` selection; explicit `last` remains available. Session token counts are separate from account percentages. Dedicated ChatGPT never borrows Codex's allowance. No credentials or model API calls are needed for account display.

Initial targeted checks: 241/241 across 18 suites. Three new account/session Node tests passed, including 40 sessions, cancellation, unknown providers, zero percent, resize bounds and an invisible-selection guard. Existing actual ConPTY queue/attachment/plain-mode usability check passed with five loopback fixture calls and zero external model requests. New native account/session and full integration runs have separate logs; read their final results before claiming completion.

Local website changes add one-time benchmark bar motion, replay and reduced-motion cancellation without changing scores, scales or recorded values. Motion/billing targeted tests passed 18/18. UFS debug timed out during page loading, so that attempt is incomplete and is not a visual pass. Browser screenshot review remains required.

Stripe audit reproduced a missing entitlement check before repair: an active subscription could receive a signed Max pass without its price or paid invoice being checked. The local repair requires the configured Max price, one item of quantity one, live mode and an expanded latest paid invoice; trialing and unpaid subscriptions are rejected. Requests are bounded and refuse redirects. Coupon product restrictions are checked for launch readiness. Production remains unconfigured and untested. No charge, subscription, deployment or publication was made.

Stripe lifecycle and search reference: https://docs.stripe.com/billing/subscriptions/overview and https://docs.stripe.com/api/subscriptions/search . Status alone does not prove every invoice is paid; this app requires the latest invoice to be paid before granting a new pass.

Claude message delivery was actually acknowledged; see CLAUDE-DELIVERY-1028.md. The app build handoff is scheduled at23:05:01 America/Chicago, not yet sent. The separate20:37 continuation is after the measured Codex reset plus five minutes. Keep both until their actual receipts exist. Do not advertise the future app before Claude explicitly reports full completion and the evidence is reviewed. iOS testing must never be guessed.
