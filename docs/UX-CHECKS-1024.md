# Atlias beginner experience verification

Gev, October 24, 2026. Implementation is local; no publication or real subscription inference was performed.

## Functional pass

- Final app release suite: 3115/3115 across 398 suites, exit 0, with 9 process-termination checks explicitly skipped under Gev's no-PID-termination rule. The separately executed worker suite passed 9/9. Receipt: `reports/ux-release-full-1024.log`. An earlier broader checkpoint passed 3155/3155 across 405 suites.
- Worker routing: 9/9 tests, including a real local HTTP transport, unchanged main model, rejection before launch, serialized approvals, max effort, invalid defaults, usage aggregation, cancellation closing the provider request, and an isolated planted unknown-measurement regression caught by the check.
- Cache/accounting regression selection: 49/49. Cache-engineering R2/Q2/Q3/M3 support preserving provider-reported categories; no cache policy or performance claim changed.
- UI/command checks: 225/225 plus exported-function coverage 5/5. Syntax checks passed for changed modules.
- Actual Windows ConPTY: source and installed bare `atlias` boot, slash discovery, Tab, help dispatch, narrow/wide resize and exit 0. No model task was submitted. ANSI output was rendered with xterm.js and inspected in `reports/ui-preview-1024/`.
- Website full suite: 198/198. Follow-up checks after anchor spacing: 14/14. The rebuilt website omits internal terminal examples, screen plots, result/plan tables and the raw history download. The actual public server returns 404 for the removed history and private paths.
- Browser feature flow: desktop/mobile, normal/reduced motion, loaded assets, no horizontal overflow, worker guide click-through, mobile menu and consent copy all passed. Final screenshots are in `D:/atlias-site/research/ux-feature-1024/`.
- UFS rendered review: zero errors. URL verification: zero errors; existing APCA preference warnings remain while measured body text passes WCAG. The source audit flags Atlias's existing blues; Gev explicitly required preserving the brand.
- Real end-card caption ground remeasured after source changes: desktop 11.13:1 and 6.47:1; mobile 13.25:1 and 13.83:1.

## Adversarial pass

Reviewed the changed routes, adapters, stream renderer, settings, help/setup, native launcher, README, public exporter, chart escaping, pages and generated output. Challenged empty/unknown routes, rejected/missing approvals, concurrent questions, max settings, model isolation, cancellation, missing usage, mixed sources, Unicode, paste, terminal width, no-color output, retained private data and direct download URLs. This pass fixed model-default reset, worker output aggregation, missing-value zeros, source labels, mobile code wrapping and fixed-header anchor clipping. Relevant checks were rerun after each correction.

## Limits

Live subscription access and account eligibility, production deployment and screen-reader use remain unverified. Mock and loopback transport results do not establish usage savings or transfer a subscription. Sub-atlias shares Atlias-owned setup/help/launch improvements; the native host owns its own prompt and subagent tools.

Completed locally October 24, 2026, within the requested five-hour window. No required implementation or verification work remains for this request. Production publication and real account consumption were outside this local build.
