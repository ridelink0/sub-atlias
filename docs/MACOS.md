# sub-atlias on macOS

Tested on 2026-11-01 on macOS 26.6.2 on Apple silicon, Node 24.20.0, Python 3.14, Claude Code 2.1.261.

## Results

| Test | Before | After |
| --- | --- | --- |
| End-to-end: commands, 10 hooks, 9 MCP tools, native launcher, Mac scenarios | 79 of 118 | 126 of 126 |
| Dangerous Mac commands the guard missed | 20 | 0 |
| The package's own tests | pass | pass, with `test/macos.mjs` added |

## Fixed

| Bug | What happened | Fix |
| --- | --- | --- |
| **Memory in the wrong folder** | Any path with a space, dot or underscore wrote memory Claude Code never reads. `~/Library/Application Support` is one. Subfolders of a repository also got their own memory | Claude Code's folder-name rule, read from its binary, and the git repository root its docs specify. Old memory moves over once |
| Guard | `diskutil erase*`, `dd of=/dev/rdisk`, `csrutil disable`, `security delete-keychain`, `rm -rf ~/Library`, `rm -rf /Applications` and others ran with no question | New rules. `rm -rf /tmp/x`, `/var/folders` and `~/Library/Caches/x` stay free |
| Case-insensitive disk | `/USERS/ME` was not recognised as home, so a graph build could start across the whole home folder | Compare real paths |
| IDEs started from the Dock | An app started from the Dock cannot find a Node from nvm, so Antigravity and other IDE hosts could not start the MCP server | They get Node's full path on macOS, or Homebrew's stable link. With nvm, run `atlias install` again after changing Node version |
| Finder's `._a.js` | Reported as broken code | Ignored |
| Very deep project | `ENAMETOOLONG` from `harness_remember` | Long names are cut and hashed, as Claude Code does |
| `lib/watchdog.mjs` missing | Anything run through `proc.runSync` failed | It ships now |
| Commands that did not exist | The package told people and models to run `status`, `recall`, `dream`, `shortcut`, `install --extras` and `--companions`, and all failed | They exist now |
| Ambiguous graph node | Graphify's "retry with this id" became "no graph here" | The answer is passed on |
| Reinstall from a folder not named atlias | Added a second set of hooks each time | Recognised by the mark install leaves |

## Not tested

- **Codex, Gemini CLI, Antigravity, Cursor and the other hosts.** None was installed, so their config files were checked but no host read them.
- **A Mac with no developer tools.** `/usr/bin/python3` is a stub there that opens an install dialog, and `findPython` still probes `python3` at session start.
- **The git-root memory rule in a real Claude session.** It comes from Claude Code's docs. The folder-name rule was read from its binary and matches a real session's folder.

## Open

- **Antigravity's config path is unsettled.** Atlias writes `~/.gemini/config/mcp_config.json`, and GitHub's install guide says `~/.gemini/antigravity/mcp_config.json`. Check with "View raw config" in the app.
- **Plugin hooks use a bare `node`.** Claude's desktop app passes a working PATH, but a host that does not would fail silently. The plugin format has no way to name the path at install.
- **Homebrew's Python refuses `pip install`**, so `atlias install --companions` can fail there. Use `uv tool install graphifyy`.
