# Atlias Max desktop architecture: macOS, Windows and Linux

Updated 2026-10-28, America/Chicago, following Gev's explicit corrections. The authoritative targets are **macOS, Windows and Linux**. This replaces the former Windows/iOS recommendation. Mobile execution, mobile background behavior and iOS payment rules are not requirements.

Research only: no app code, account, credential, certificate, build, download, installation, automation, deployment or purchase was changed. Recommendations are proposed designs, not tested capabilities. RESEARCH-FIRST H3/H4/H5 and section 9 apply: preserve authority, distinguish stopped from complete, and verify mechanically. [Project rules](D:/harness-work/atlias-evolve/RESEARCH-FIRST.md)

## 1. Which shared desktop stack best reuses the real Atlias tools?

### Takeaway

Recommend **Electron, a shared React renderer, a narrow preload bridge, and the existing Node harness in a supervised utility process**. Each desktop runs its own local tools. No remote execution relay or three separate native UI implementations is necessary for this scope. This is an integration recommendation, not a measured size/performance claim.

### Cited Findings

- Electron supplies macOS, Windows and Linux binaries. Its current source lists Intel/Apple Silicon macOS and x64/ARM64 Windows/Linux; supported Linux versions must also be supported by Chromium and their distributor. One Linux build does not establish every distro. [Official platform support](https://github.com/electron/electron#platform-support)
- Electron main has Node APIs; its utilityProcess launches a Node-enabled child with message ports, offering a direct integration point for the existing JavaScript harness. Native Node dependencies can require recompilation for Electron's ABI and each target. [Process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [Utility process](https://www.electronjs.org/docs/latest/api/utility-process), [Native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)
- Tauri 2 documents packaging Node as a sidecar or bundling a Node runtime and JavaScript, with stdio/local-socket IPC possibilities. Its capabilities constrain frontend exposure but cannot repair insecure backend handlers or broad scopes. Linux also needs platform dependencies including WebKitGTK. [Node sidecar](https://v2.tauri.app/learn/sidecar-nodejs/), [Capabilities](https://v2.tauri.app/security/capabilities/), [Prerequisites](https://v2.tauri.app/start/prerequisites/)
- RN macOS and Windows have separate native setups. macOS requires matching React Native/macOS minor versions and has an Xcode build path; neither source establishes one matching macOS/Windows/Linux native target. [RN macOS](https://microsoft.github.io/react-native-macos/docs/getting-started), [RN Windows](https://microsoft.github.io/react-native-windows/docs/getting-started/)

### Inferences

| Route | Harness reuse | Integration cost | Decision |
|---|---|---|---|
| Electron on all three | Existing Node harness in supervised process; shared React app | Bundled Chromium/Node patching, bridge security, native ABI and per-OS packaging | Preferred smallest practical integration |
| Tauri 2 on all three | Node runtime/sidecar preserves harness | Rust IPC/supervision plus Node packaging; differing WebViews and Linux dependencies | Viable if measured footprint requirements justify it |
| RN macOS + RN Windows + separately validated Linux host | Shared domain concepts | Platform/version/native bridges plus another Linux implementation choice | Larger integration scope for this tools app |

No reuse percentage, memory/startup advantage, package size or delivery estimate was measured. The former mobile rationale for React Native no longer applies.

| Component | Owns | Must not expose |
|---|---|---|
| React renderer | Beginner projects, conversation, tool activity, diffs, approvals, usage, searchable sessions/resume | Node, filesystem, arbitrary shell, generic IPC or provider secrets |
| Preload | One filtered method per app operation | ipcRenderer, arbitrary channels, event objects or unrestricted paths |
| Electron main | Window lifecycle, sender checks, dialogs, account/device state, OS secret adapter and host supervision | Unfiltered renderer commands |
| Utility host | Actual Atlias harness/tools/providers, project scope, jobs/events, approvals, cancellation and receipts | Public execution endpoint or renderer-selected credential paths |
| OS adapters | Executables, shell/PTY handling, process trees, permissions and filesystem identity | Guessed cross-platform fallbacks labelled as successful tools |
| Account service | Authenticated account, verified Max membership, device issuance/revocation | Provider tokens/model billing or private signing keys in clients |

This proposed split uses Electron's documented processes and preserves one harness rather than inventing a new agent loop. [Process model](https://www.electronjs.org/docs/latest/tutorial/process-model)

Prove a Windows vertical slice first: actual tool inventory, selected project, session search, exact resume, bounded fixture job, tool streaming, one approval, cancellation and final usage/result. Then run the same slice on native Mac and Linux before styling or claiming parity.

“All real tools” requires a capability inventory recording dependencies, OS support, permissions, credential source, approval class, cancellation/resume and evidence for every tool. Shell availability does not make Windows commands, provider installations, browser automation or PTYs portable automatically. [Native dependency boundary](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)

### Gaps

- The initial local graph query returned no graph/no answer. No execution source audit, app dependency spike or utilityProcess compatibility test was performed.
- Actual provider adapters, native modules, terminal libraries and computer-use integrations need OS/architecture inventory.
- A dependency requiring standalone Node instead of Electron's runtime must be demonstrated and explicitly packaged/versioned; do not silently use arbitrary PATH Node.
- Native Mac/Linux hosts, signing access and dependency parity were not inspected.

## 2. How should security, Max, credentials, tools and resume work?

### Takeaway

Sandbox the renderer while the local host enforces project, account and operation authority. One authenticated Max account can authorize independent desktop installations, but current install-bound licensing does not itself supply that account system. Membership is distinct from provider billing and permission to execute an operation.

### Cited Findings

- Electron recommends context isolation, sandboxing, constrained navigation/window creation and IPC sender validation. ContextBridge should expose filtered methods rather than generic IPC; renderer sandboxing alone cannot make an unsafe bridge secure. [Security](https://www.electronjs.org/docs/latest/tutorial/security), [Context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation/), [Sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- safeStorage documents macOS Keychain, Windows DPAPI and varying Linux providers. Windows encryption does not protect against another same-user process. Linux legacy basic_text uses a hardcoded password when a real store is absent; newer async APIs also describe fallback/provider behavior. Current docs deprecate synchronous APIs from Electron 45; verify the pinned release and actual provider. [Secret storage](https://www.electronjs.org/docs/latest/api/safe-storage)
- Electron fuses disable unused capabilities at packaging time before signing. Node spawning/shell behavior is platform-dependent; Windows Job Objects can supervise process groups, with breakaway caveats. [Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses), [Node processes](https://nodejs.org/api/child_process.html), [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- Native OAuth uses external-browser authorization with PKCE; embedded client secrets cannot establish confidentiality. Current security guidance covers replay and refresh tokens. [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html), [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)
- Coordinator-reported baseline: CLI Ed25519 passes are install-bound, with seven-day offline and three-day paid-through grace; local billing is undeployed. The pinned 2026-09-30.endive contract uses saved CheckoutSession lookup and invoice status='paid'; nine local fake-provider checks and zero external charges were reported. This researcher did not independently audit that code. [Schema receipt](D:/atlias-app/reports/ui-goal-1028/stripe-schema-evidence.json), [Field contract](D:/atlias-app/reports/ui-goal-1028/stripe-field-contract.json)
- Stripe requires webhook fulfillment rather than relying only on a checkout return page, and fulfillment must handle repeated/concurrent processing. [Stripe fulfillment](https://docs.stripe.com/checkout/fulfillment)

### Inferences

#### Privilege boundary

Serve bundled UI from a tightly scoped app protocol. Explicitly keep nodeIntegration off, contextIsolation on, renderer sandbox on and webSecurity on. Treat model output, markdown, repository content, diffs and tool output as untrusted. Sanitize HTML, block scripts and restrict navigation/new windows/external URLs.

Every privileged handler validates sender frame/origin, schema, size and current account/project/job authority. Expose named operations such as listSessions, resumeSession, startJob, cancelJob and decideApproval. Never expose runAnyCommand, generic IPC, raw filesystem reads or unrestricted openExternal. These are proposed implementations of Electron's documented boundaries. [Security](https://www.electronjs.org/docs/latest/tutorial/security), [Bridge](https://www.electronjs.org/docs/latest/tutorial/context-isolation/)

The utility host intentionally has local user authority. Process separation improves crash/lifecycle separation; it is **not automatically an OS sandbox for arbitrary agent shell commands**. Project-root checks and approval gates cannot constrain every shell side effect through string inspection. Preserve and test the harness's real execution controls; Chromium sandboxing is not proof of shell containment. [Process privileges](https://www.electronjs.org/docs/latest/tutorial/process-model), [Node execution](https://nodejs.org/api/child_process.html)

Prefer MessagePorts/private stdio. No remote execution service is required. If existing loopback HTTP is retained, require authentication, loopback-only binding and origin/host checks. Use versioned request envelopes, bounded output and explicit errors. [Utility messaging](https://www.electronjs.org/docs/latest/api/utility-process)

#### One membership, separate devices and provider bills

Add server-owned Account, Membership and Device records. Link verified billing ownership to an authenticated account, then issue independent revocable credentials/passes for Windows, Mac and Linux. Do not copy one install-bound pass between machines or accept posted email/customer IDs/checkout URLs as ownership. Existing purchases need an authenticated linking/migration flow. No device-count restriction is invented here. [Native auth](https://www.rfc-editor.org/rfc/rfc8252.html), [Billing authority](https://docs.stripe.com/checkout/fulfillment)

Gate Max in the privileged host as well as the UI. Public verification keys can ship; private signing keys and Stripe secrets cannot. Preserve the verified offline policy unless Gev changes it; define in-flight job behavior at expiry, and retain cancellation/result/logout access. The distributed local client is inspectable: do not promise tamper-proof DRM.

Atlias Max pays for app/harness entitlement. Provider login, limits and charges remain attached to the selected supported provider account. Do not reuse provider tokens as Atlias tokens, share accounts, or quietly substitute API-billed execution. Usage labels must identify the actual account/source/freshness; unknown allowance remains unknown. Provider subscription/API interoperability is not certified by this report.

#### Secrets

| OS | Proposed policy | Negative checks |
|---|---|---|
| macOS | Main-process Keychain-backed protection with stable signed identity | Locked/denied Keychain, update/reinstall, account switch and changed signing identity |
| Windows | DPAPI/vault protection for current OS user | Wrong profile, corrupt ciphertext, account switch, logs; no claim of same-user isolation |
| Linux | Require a proven secure provider for the chosen Electron API/desktop | Missing D-Bus/keyring, GNOME/KDE differences, locked/temporary failure, basic_text/fallback, unknown-before-ready |

This policy derives from Electron's documented platform semantics. If secure persistence is unavailable, disable saving secrets and explain the requirement; never force plaintext mode or silently save unprotected credentials. Verify the selected provider against the pinned version, including legacy versus async API behavior. [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)

Keep provider credentials, Atlias device/refresh tokens and release-signing keys separate. Exclude secrets from renderer state, project files, event logs, URLs, crash data and bundles. Logout revokes app-device authority and removes that account's app secrets without deleting unrelated provider installations.

#### Operation invariants

| Operation | Proposed requirement |
|---|---|
| Projects | Host-owned ID maps to canonical selected root; check symlink/junction, permission and external-edit conflicts |
| Tools | Real harness adapter and declared executable/arguments; honest missing-dependency errors |
| Approval | One exact account/device/project/job/operation or diff hash, expiry/policy version, one-time consumption |
| Job creation | Stable request ID and payload hash persisted before mutation; duplicate recovers existing job, conflicting payload fails |
| Streaming | Ordered bounded events, tool receipts and final outcome/usage; token output is not completion |
| Search/resume | Actual saved sessions and engine/project/account identity; no silent new session |
| Close/reconnect | Separate UI attachment from cancellation; explicit close/quit policy and supervised host lifetime |
| Cancellation | Pending/stopping until evidence; owned descendants stopped and late results/usage reconciled |
| Usage | Preserve authoritative totals/final values; label estimates/stale sources |
| Recovery/update | Version records; never auto-replay mutation/approval; reject stale IPC/host versions |

These are proposed app contracts. MCP transport cannot substitute for a durable job journal: the official SDK documents version-dependent resumption and its removal for 2026-07-28. Pin the actual installed protocol rather than migrating it merely for a UI. [MCP lifecycle](https://go.sdk.modelcontextprotocol.io/protocol/)

### Gaps

- Account ownership linking, device revocation, protected persistence and IPC/job contracts remain to implement or audit.
- Existing tools may depend on Windows paths, shell quoting, executable discovery, provider stores or process behavior.
- No assertion is made that existing cancellation, approvals, usage or resume already satisfy the proposed contracts.

## 3. What packaging and verification prove all three desktop targets?

### Takeaway

Use signed/notarized direct macOS distribution, a signed Windows installer and tested Linux packages from one source base. Release/test jobs are platform-specific. This Windows workstation cannot establish native Mac/Linux execution, secrets, permissions, installer or accessibility passes.

### Cited Findings

- Apple direct notarization requires Developer ID signing, valid signatures for distributed executables, hardened runtime and secure timestamps. Notarization is an automated security check, not App Review; tickets and Gatekeeper behavior still need testing. Electron's Mac release workflow needs macOS/Xcode and signing access. [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [Electron signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- Mac App Store Electron needs App Sandbox/MAS builds and constrained resource/API behavior. This differs from ordinary Developer ID distribution; notarization does not grant arbitrary OS permissions. [MAS guide](https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide)
- Forge documents Squirrel.Windows installer/update artefacts and Windows-native build support; signing is separate. If MSIX is selected instead, Microsoft requires signed/trusted packages and recommends timestamps. Do not generalize MSIX rules into “every unsigned Win32 executable cannot run.” [Windows maker](https://www.electronforge.io/config/makers/squirrel.windows), [Signing](https://www.electronforge.io/guides/code-signing/code-signing-windows), [MSIX](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview)
- Forge deb requires Linux/macOS with dpkg/fakeroot; rpm requires Linux/rpm tooling. Electron's built-in autoUpdater has no Linux support and recommends distro package managers there. [deb](https://www.electronforge.io/config/makers/deb), [rpm](https://www.electronforge.io/config/makers/rpm), [Updater limits](https://www.electronjs.org/docs/latest/api/auto-updater)
- Debian APT authenticates repository Release signatures; generating a .deb does not configure an authenticated repository. Flatpak separately constrains filesystem/host resources and favors portals, so arbitrary host-tool compatibility is not automatic. [APT](https://manpages.debian.org/stable/apt/apt-secure.8.en.html), [Flatpak](https://docs.flatpak.org/en/latest/sandbox-permissions.html)
- Electron documents HTML accessibility and system assistive-technology integration, including Windows readers and macOS VoiceOver. Shared markup does not replace native checks. [Accessibility](https://www.electronjs.org/docs/latest/tutorial/accessibility)

### Inferences

| Target | Proposed initial release route | Required proof |
|---|---|---|
| macOS | Direct Developer ID signed/notarized app/deliverable | All helpers/harness executables signed; hardened-runtime entitlements; notarization log/ticket; clean Gatekeeper launch; Keychain/file privacy; Intel/Apple Silicon only where built/tested |
| Windows | Signed Forge Squirrel installer for claimed architecture | Signature/timestamp/trust, clean-user install/upgrade/uninstall, actual CLI/process launch, secrets and SmartScreen observations; signature is not a no-warning guarantee |
| Linux | Native .deb/.rpm builds for selected supported distro families | Runtime libraries, package dependencies, x64/ARM64 only where tested, X11/Wayland, keyring, Chromium sandbox, executable permissions and desktop integration |
| Linux updates | Authenticated package-manager/repository route or explicitly verified signed alternative | Update key trust, tampered/expired metadata, rollback, channel isolation and interrupted upgrade; no pretend built-in Linux updater |
| Sandboxed stores | Separately evaluated MAS/Flatpak distributions only if later requested | Recheck permissions/host tools; never disable sandbox or add blanket privileges just to pass a demo |

Routes are recommendations, not built artefacts. Direct desktop Max can use the existing web-billing design after production readiness and authenticated ownership are verified; the cross-device account layer remains to build.

Mac packaging/signing/runtime checks require native Mac access and signing identities. Linux package and desktop tests require actual supported Linux environments. WSL/headless tests cannot prove keyring, display server, sandbox, accessibility or installer behavior. Pin supported Electron, bundled Node and native dependencies; rebuild per target and test the packaged app outside the source tree. [Mac workflow](https://www.electronjs.org/docs/latest/tutorial/code-signing), [Linux maker](https://www.electronforge.io/config/makers/rpm), [ABI](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)

#### Two-pass validation matrix

All rows are proposed acceptance tests, not passed checks. Save revision, OS/distro/version, architecture, package, method and evidence. Initial fixtures must not spend model credits or create real billing changes.

| Area | Pass 1: functional | Pass 2: adversarial | Native evidence |
|---|---|---|---|
| Every real tool | Execute its smallest useful fixture | Missing CLI/native dependency, wrong PATH/version, denied permission, OS-specific command | Per tool per supported OS |
| Harness | Packaged run/read/edit/check and result | ABI mismatch, packaged path, helper crash, wrong cwd/config | All three apps |
| IPC | Valid named operations under sandbox/isolation | XSS/model HTML, iframe/window sender, forged channel, malformed/large input, hostile URL | Fixtures and each app |
| Max/device | One fixture account authorizes separate installations | Copied pass, wrong customer/device, expiry/offline boundary, key mismatch, concurrent claim, logout | Fake account/billing plus each OS |
| Provider isolation | Correct account and usage source, stub execution | Stale allowance, account switch, token-store collision, silent API billing substitute | Each host adapter |
| Approval | Approve/deny exact operation once | Changed args/diff, double click, expiry/replay, approval after cancellation/account switch | Both UI and host |
| Streaming/usage | Ordered tool events and final totals | Late usage, truncation, error, huge output, slow renderer, estimate labelled final | Fault fixtures/native UI |
| Search/resume | Exact saved session/engine/project restored | Duplicate names, moved root, wrong account, corrupt/legacy record, missing session | All three |
| Cancellation | Owned process tree stops and final state reconciles | Descendants, refused termination, late completion, close/crash/restart race | Windows jobs; Mac/Linux groups separately |
| Files | Selected root read/edit/check/artefact | Symlink/junction escape, case sensitivity, Unicode/spaces/long paths, read-only/network root, edit conflict | Each OS/filesystem |
| Secrets | Protected persist/retrieve and logout | Linux absent/locked/basic_text, denied Keychain, wrong Windows user, corruption, update/reinstall, secret scan | Actual OS stores |
| Accessibility | Keyboard task, reader roles, focus, native shortcuts/menus | Focus trap, typing shortcut collision, hidden cancel, zoom/high contrast/reduced motion, long approval | Narrator, VoiceOver, claimed Linux assistive stack |
| Packaging/update | Clean install/upgrade/uninstall and intended data preservation | Missing helper, tampered/unsigned update, rollback, stale IPC, migration failure, offline launch | Every claimed package |
| OS protections | Launch with default security settings; denied permissions handled | Gatekeeper/hardened runtime; Linux sandbox/display/keyring; Windows trust/policy | Native OS; no --no-sandbox workaround |

Recommended sequence: Windows vertical slice and both checks, then native Mac/Linux parity slices, then feature expansion and release packaging. Functionality precedes styling. Appropriate real checks and full manual sweeps are required; TypeScript compilation is not a substitute.

### Gaps

- Research checked official support/constraints and then challenged Node/Electron ABI, privilege leakage, Linux fallback secrets, packaging/update differences and cross-OS claims. Those are research passes only.
- Native macOS and Linux compilation, launch, tools, secrets, accessibility, packaging and updates remain **unverified**. No new Windows app/installer was built or tested in this research either.
- Mac/signing access, supported Linux distro/desktop/architecture matrix, repository/update hosting, release budget and dependency parity remain prerequisites.
- Tool parity needs actual operation receipts. Framework support, shared UI, signing or notarization cannot replace them.
