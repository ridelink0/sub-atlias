# Atlias Max app: observed visual and workflow references

Research date: October 28, 2026. Research only for Gev and Claude's Windows/iOS app work. No app screen was designed or implemented. All references below are private analysis, not image assets licensed for shipping. Product screenshots, logos, texts and proprietary illustrations must not be copied into Atlias. Public access does not grant an image reuse licence. The manifest records the exact verified URL, HTTP result, creator/publisher, source page, local file, retrieval date and reuse restriction for every downloaded public image.

Read first: the assigned Deep Research researcher instructions, `D:/harness-work/atlias-evolve/RESEARCH-FIRST.md`, Image Deep Research and Ultimate Frontend Skills in the installed 6.9.0 plugin, the project memory index, and the October 28 four-part app goal. Acting on RESEARCH-FIRST H4/H5: stopping and verified completion need different visible outcomes. This is a product-state research inference, not a benchmark or a claim that these app features already exist.

## 1. What can actually be seen, and how strong is the evidence?

### Takeaway

The strongest observed interaction references are Anthropic's official VS Code edit-permission screenshots, OpenAI's project images, and the publishers' iOS App Store screenshots. Reason Machines is an uncertain match for Gev's word “Reason”; only its public staged marketing UI was observed. A screenshot verifies what is drawn in that image, not whether its pictured feature works.

### Cited Findings

| Reference | Actually observed | Evidence boundary and useful move |
|---|---|---|
| Claude Code VS Code extension | Conversation beside code; an `@utils.py#2-3` context reference; an expanded file edit with numbered choices and a separate alternative-instruction field. | Official documentation screenshots of an editor extension, not the standalone native desktop app. Put an approval decision beside the exact affected file/change. [Anthropic source](https://code.claude.com/docs/en/vs-code) |
| ChatGPT projects | A short project list with an explicit New project action; a named project above its composer; Project settings reached through an overflow control. | Official help article images. The help article itself was blocked by a browser challenge; its public image links were separately verified as images. Keep the current project visible while composing. [OpenAI source](https://help.openai.com/en/articles/10169521-projects-in-chatgpt) |
| ChatGPT iPhone | A vertically scrolling conversation, compact top controls and bottom composer; generated content remains in the conversation. Four selected App Store frames were opened in a contact sheet. | Official promotional captures with marketing framing, not a hands-on app test. The selected frames do not show search, project switching, errors or offline behavior. [App Store source](https://apps.apple.com/us/app/chatgpt/id6448311069) |
| Claude iPhone | Five selected frames include file-output cards, a notification photo and a task review list. The review frame visibly separates All / Blocked / In progress / Done and presents a blocked task's question and Approve action. | Official promotional composites. No notification delivery, task resume or remote execution was tested. Use the blocked-task question as a readable unit, without copying its pictured promise of shipping from anywhere. [App Store source](https://apps.apple.com/us/app/claude-by-anthropic/id6473753684) |
| Windows NavigationView | Official examples show a left navigation pane with Settings at its foot, and an alternative horizontal navigation arrangement with a search field. | Documentation sample UI, not an Atlias implementation. The source describes adaptive left/top modes. [Microsoft source](https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/navigationview) |
| Apple sidebars | The rendered HIG page shows a sidebar illustration and correct/incorrect examples of visually rich content extending beneath an iPad sidebar. | Platform guidance, not an iPhone conversation screen. This does not justify applying translucent layers over dense code. [Apple source](https://developer.apple.com/design/human-interface-guidelines/sidebars) |
| Reason Machines | A staged desktop composition shows a narrow conversation/task column and a larger work area with Review / Desktop / Terminal labels. The pictured composer includes attachment/context affordances and a model name; an embedded chart preview has a Take control control. | Rendered marketing page, not native app UI or verified execution. The homepage makes harness claims that this study did not validate. The identity match remains unconfirmed. [Reason source](https://reasonmachines.com) |

**Local evidence inventory.** All paths below are relative to this notes file's `visual-assets/` folder. Absolute root: `D:/atlias-app/research_notes/Atlias Max app research/visual-assets/`.

- `asset-manifest.json`: 16 downloaded public images, each with URL/source/creator/reuse limits. Nine iOS promotional frames, three Claude Code editor screenshots, two ChatGPT project images and two Microsoft navigation examples. `chatgpt-appstore-lookup.json` and `claude-appstore-lookup.json` preserve the official Apple lookup responses used to find the image URLs.
- `public-ui-contact1.jpg`: opened; tiles 1–8. ChatGPT iOS 1/3/4/8, Claude iOS 1/3/5/6.
- `public-ui-contact2.jpg`: opened; tiles 9–16. Claude iOS 7, all three editor screenshots, both project images, both NavigationView examples.
- `public-ui-contact3.jpg`: opened after repair; tiles 17–19 are Gev's supplied terminal references, copied locally for same-drive sheet rendering. The initial sheet showed broken images because the sheet generator cannot use its relative file paths across C: and D:. The originals were opened directly before repair; the regenerated sheet reports all tiles loaded.
- `round1-desktop/sheet1.jpg`: opened. Five URLs studied at 1440px width, scroll requests 0/900; four pages rendered and one challenge wall excluded. Every actual scroll reached is recorded in `round1-desktop/report.json`. Top/down shots can repeat when a page cannot scroll that far.
- `round2-mobile/sheet1.jpg`: opened. Refined 390px study of Reason, Claude Code editor documentation and Apple sidebars, with a longer 6500ms wait and scroll requests 0/900. These are responsive website/documentation captures, not native phone screenshots. Measurements and actual reached scrolls are in `round2-mobile/report.json`.
- `collect-public-refs.mjs`: reproducible local acquisition and UFS sheet script; it checks successful HTTP and image content types before saving. Node 22.21.0 and installed headless Chromium/Edge were used. There was no login, paid API, image generation or capture of Gev's live private chats.

**Selected full images actually opened**, beyond all five contact sheets:

- `public-images/claude-vscode-edit-permission.png`: readable file diff, file-specific question, one-time/persistent/refuse choices, alternative text field.
- `public-images/claude-ios-7.png`: task list and an expanded approval request. This remains an App Store composite.
- `round1-desktop/s05/top.png`: Reason's staged desktop UI inside its marketing page.
- Original Gev attachments `C:/Users/OWNER/.codex/attachments/bd915a57-de76-4377-acb0-db724c8ec677/image-1.png`, `image-2.png`, `image-3.png`: all opened directly. They are terminal references, not app screenshots. Local copies are `user-supplied/terminal-reference-1.png` through `terminal-reference-3.png`.

**Measured versus pictured.** UFS's computed type/color numbers describe the rendered documentation or marketing pages, not fonts or colors inside their embedded screenshots. For example, the desktop study measured Claude documentation body text at 16px/26.4px and Microsoft's documentation body at 16px/20.8px; neither establishes native app tokens. The two JSON study reports are the measurements. No screenshot pixels were used to assert exact product spacing, tap sizes, contrast, typefaces or accessibility compliance.

### Inferences

- First-round evidence was dominated by documentation, not actual app views. The refinement therefore added official embedded screenshots and official iOS promotional frames before drawing interaction conclusions. The narrow-site round checked what remains visible in 390px captures; it does not establish native touch behavior.
- Borrow relationships: project to conversation, request to affected file, task to blocker, output to review. Preserve Atlias's own wordmark/Atlo identity and actual capabilities. Do not import another product's colors, icons, screenshots or terminology merely because it appears in a reference.

### Gaps

- `help.openai.com` returned “Just a moment...” to the headless browser; no hidden app state was inferred. Node fetch also returned 403 for the article. Its two linked image endpoints returned valid image responses and were opened.
- The first attempt to resolve Apple's relative HIG image URL returned 404. `apple-direct-assets-limitation.json` records it. The rendered HIG captures provide the observed evidence instead. The web text tool saw a JavaScript shell; official tutorial JSON supplied readable platform guidance.
- No authenticated Claude/ChatGPT app session was opened; no native Windows app, iPhone simulator/device, keyboard flow, accessibility tree or network-failure behavior was tested. No standalone Claude Code desktop screenshot was obtained here; editor-extension images are labeled accordingly.
- No Reason app login, download, runtime, settings, mobile conversation or feature was verified. Do not resolve Gev's intended “Reason” from this research alone.

## 2. Which interaction relationships transfer to Atlias's beginner workflow?

### Takeaway

Keep each task's location, execution state and evidence legible before adding visual polish. A beginner should be able to tell what project is open, which engine/model is active, what action awaits a decision and what check actually ran.

### Cited Findings

- Claude Code's desktop reference documents file attachment or `@` context, permission modes, a diff view, workspace panels, usage, session organization and keyboard shortcuts. This is documented capability, separate from this study's pictured extension UI. [Official desktop reference](https://code.claude.com/docs/en/desktop)
- The observed editor permission image names the affected file and keeps the proposed edit visible beside the choice. Its numbered list makes each available response discoverable in that capture. [Official editor reference](https://code.claude.com/docs/en/vs-code)
- The project captures make the named project explicit before composing, while leaving project settings behind an additional control. They establish a hierarchy, not a complete settings workflow. [Official project reference](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)
- Gev's supplied first terminal image shows engine/model/effort, workspace and plan information below the composer. The second shows a searchable resume list, session metadata, selection and keyboard help. The third shows multiple engine allowance rows whose values must not be treated as a current usage reading. These are directly observed private references. [Terminal reference 1](visual-assets/user-supplied/terminal-reference-1.png), [reference 2](visual-assets/user-supplied/terminal-reference-2.png), [reference 3](visual-assets/user-supplied/terminal-reference-3.png)

### Inferences

The following is an implementable interaction-state checklist for Claude, not a statement that Atlias already supports these states. Implement only against actual engine, entitlement, tool and sync contracts; show an explicit unavailable state when a contract is missing.

| Area | Required state set and acceptance behavior |
|---|---|
| First use | No projects: one clear action to open/create the supported kind of workspace. If Max entitlement is required, resolve it before inviting a task that cannot run. Preserve an interrupted draft across entitlement checks. |
| Project navigation | Show current project and selected chat. Switching projects must not silently move the draft or execution target. Long and duplicate names need distinguishing metadata and a readable full-name affordance. |
| Resume/search | Loading, matches, no sessions, no results, corrupt/unavailable item and load error are separate. Search through actual stored sessions; preview/rename shortcuts must advertise only implemented actions. Show branch/project association. |
| Composer | Empty, populated, multiline, sending, streaming and stopped states. Keep Send, Stop and New chat semantically distinct. Enter/newline behavior must be visible/discoverable and tested with IME composition. |
| Attachment/context | Selected, preparing, ready, unsupported, failed and removed. Show file name/type and which context will be sent. A stale/failed attachment cannot look successfully attached. |
| Engine/model/effort | Show the active engine and model; distinguish selected configuration from the model that actually executed. Different-subscription worker use follows Gev's existing approval rules, including the existing max-effort exception; this research adds no new approval flow. |
| Allowances | Each connected engine: known fresh value, stale cached value, unavailable, signed out, capped and reset pending. Name used versus remaining and the window/timezone. Unknown is not 0%; cached success is not a live reading. |
| Running tool | One readable action summary with affected path/resource, running/done/failed/canceled state and expandable raw evidence. Tool progress must not imply a file was edited merely because the action started. |
| Permission | State the exact requested operation, target and scope. Keep allow once / persistent scope / refuse distinguishable only where supported. Return focus predictably; Enter must not accidentally approve a newly appearing request. |
| Blocked task | Keep the question, relevant evidence and allowed response together. A blocked state must remain discoverable after navigation away. Don't equate it with a crash or a finished task. |
| Diff/review | No changes, changed files, selected file, unsupported/binary/large diff, loading and error. File changes and a model's prose summary are different evidence. Review can be reached without losing the conversation. |
| Checks | Not run, running, passed, failed, canceled and unavailable; display command and relevant output. Passing a subset cannot produce an unqualified all-checked completion badge. |
| Completion | Done with verified checks, finished without verification, stopped at user request and stopped by limit/error are separate outcomes. A task can be idle while required work remains. |
| Loading/error | Preserve drafts and current context. Say whether retry repeats a request or resumes a task; avoid duplicating execution after a timeout where completion is unknown. |
| Offline/device handoff | Explain whether work is on this device or another machine. Local files/commands must not appear executable on iOS without a verified execution bridge. Reconnection cannot silently reissue a destructive action. |
| Settings/shortcuts | Stable discoverable settings entry; searchable/discoverable supported commands. Keep beginner labels alongside shortcut hints. Shortcuts supplement visible controls and must not conflict with text editing or the OS. |

### Gaps

Current Atlias mobile execution/sync, entitlement/offline rules and actual app code were outside this visual assignment. The checklist is acceptance criteria for later implementation/testing, not a proposed backend architecture. There is no basis here to promise mobile parity, background execution, voice input, automatic merging, remote control or notification delivery.

## 3. How should Windows keyboard, iOS touch and accessibility be checked?

### Takeaway

Use platform behavior as the starting point and test each state with its real input model. A narrow webpage render is useful evidence about a webpage; a working iOS app still requires device/simulator and accessibility checks.

### Cited Findings

- Microsoft's keyboard guidance calls for logical tab stops, sensible initial focus, arrow navigation inside controls and discoverable shortcuts; focus should not land initially on an action with a harmful outcome. [Windows keyboard guidance](https://learn.microsoft.com/en-us/windows/apps/develop/input/keyboard-interactions)
- Microsoft's inclusive-design guidance favors standard controls and coherent programmatic hierarchy, and asks for high-contrast/DPI/system-font support without color-only distinctions. [Windows accessibility guidance](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/designing-inclusive-software)
- Apple's accessibility guidance asks for larger text support, sufficient contrast and information conveyed through more than one method. Its official JSON used here explicitly discusses Dynamic Type and enlargement to at least 200 percent. [Apple accessibility guidance](https://developer.apple.com/design/human-interface-guidelines/accessibility), [official document JSON](https://developer.apple.com/tutorials/data/design/human-interface-guidelines/accessibility.json)
- Apple's motion guidance calls for purposeful, optional motion, alternatives to motion-only communication, restrained repeated feedback and cancelable transitions. [Apple motion guidance](https://developer.apple.com/design/human-interface-guidelines/motion), [official document JSON](https://developer.apple.com/tutorials/data/design/human-interface-guidelines/motion.json)

### Inferences

| Pass | Concrete checks for Claude's eventual implementation |
|---|---|
| Windows keyboard | Navigate project list, chat list, composer, attachments, engine selector, tool details, diff, permission and settings without a mouse. Verify focus visibility/order, Escape dismissal and focus restoration. Test selection navigation independently from editing text. |
| iOS touch | At 390px and the actual smallest supported device size, open a project, resume a chat, attach a supported file, send/stop, answer a blocker and inspect changes. Verify safe areas, keyboard overlap, screen rotation and reachable actions. Don't shrink a multi-pane desktop editor into a phone. |
| Text/accessibility | Check largest supported Dynamic Type, Windows text/DPI scaling, long paths, translated/long labels, high contrast, light/dark modes and screen-reader names/state announcements. Status cannot rely on color alone. |
| Streaming | New content must not repeatedly steal focus or force the scroll position while Gev reads earlier output. Provide a clear way back to the newest activity. Ensure an approval request is announced once and stays reachable. |
| Reduced motion | System reduction preference wins. Replace decorative movement with static state feedback; loading, progress, errors and completed checks remain understandable. Avoid requiring animation to finish before an action becomes usable. |
| Adversarial state hunt | Exercise duplicate titles, 40+ sessions, empty query/results, huge lines/diffs, missing files, corrupt history, stale allowance data, expired auth/entitlement, network loss during send, cancellation during a tool, denied permission and resume after restart. Preserve draft/context and distinguish unknown outcome from failure. |

**Research verification, two passes.** Functional pass: all 16 public image downloads had successful image HTTP responses; the corrected sheet manifest reports all 19 tiles loaded, and all five contact sheets plus the selected full images listed above were opened. Adversarial pass: challenged the native/web distinction, rejected blocked pages as UI evidence, repaired the cross-drive sheet error, recorded Apple's failed direct asset path, separated measured webpage typography from embedded UI, retained Reason identity uncertainty and marked untested state behavior as future acceptance checks. This verifies the research package only. It is not a functional or accessibility pass of the future app.

### Gaps

No future-app feature, accessibility implementation or iOS runtime was tested. Public reference screenshots do not expose focus order, screen-reader semantics, touch targets, reduced-motion behavior, error recovery or data freshness. Those claims require the eventual app's real checks and two-pass review.
