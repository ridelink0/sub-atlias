# Atlias download and terminal follow-up

Gev, October 24, 2026. Local source changes; publication is separate.

## Terminal changes

Approval questions wrap at word boundaries so the engine/model, other subscription billing and default answer remain visible. Oversized questions explain that the terminal needs resizing. Help uses bounded spacing instead of padding every command to the longest syntax. The slash menu explains Tab versus Enter, and running turns explicitly say Working. Atlo, the original atlias wordmark, the prompt and brand remain intact. Sub-atlias keeps the host-owned prompt and receives the shared Atlias setup/help changes.

## Functional pass

- App full suite: 3118/3118 across 398 suites, exit 0. Nine process-termination checks were explicitly skipped under Gev's no-PID-termination rule, not counted as passes. Worker routing suite: 9/9, exit 0. Receipt: reports/ux-followup-full.log.
- Focused terminal and slash suites: 208/208. Real Windows ConPTY source composer and approval question both exited 0 without a model task. Actual ANSI was rendered and inspected with xterm.js; screenshot: reports/ui-preview-1024/terminal-approval.png.
- Website picker: curl, npm, bun, brew, paru and yay; only published install routes have copyable commands. The Homebrew formula and Arch PKGBUILD are inspectable downloads, marked coming soon. The site still excludes internal screens, detailed text tables and raw benchmark history.
- Real isolated installer consumed only the public Free package and returned atlias 4.0.1. The pinned public archive checksum was verified; the Arch package function ran in an isolated directory and its CLI returned 4.0.1. Shell syntax passed for both installer and PKGBUILD. Homebrew on macOS, AUR publication and actual Bun installation remain unverified.
- Browser: both install pages at desktop/phone widths, normal/reduced motion, all six choices, copy text, unpublished states, keyboard navigation, no horizontal overflow and downloadable assets passed in eight scenarios. Both pages also passed with JavaScript disabled; a direct Homebrew fragment selected its panel.

## Adversarial pass

Re-read each changed runtime, generator, browser module, installer, recipe, template, CSS and test. Challenged long approval text, cursor placement, tiny/oversized viewports, shell prefixes containing spaces and metacharacters, failed npm exit status, invalid arguments, unpublished package claims, no-JavaScript access, keyboard focus and retained private data. The first website full run caught stale caption measurements; the actual measurements were refreshed and the affected checks passed. No invented package-manager install command or private full-app source is exported.

The native package recipes use public Free sub-atlias revision 6e73aa99b9975f22ca78b7216c9c2bb22e86005d, SHA-256 12f8d450c984d8d213a5833e27ea816bf18f093a2157a5ea4ccde48f828cd50d. Homebrew, paru and yay need publication before they can be advertised as ready installs. Production deployment, screen-reader use and live subscription inference remain unverified.
