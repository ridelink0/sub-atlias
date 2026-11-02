# Changelog

## 4.0.2

macOS, tested on macOS 26 on Apple silicon. Most of this helps Linux and Windows as well.

- Memory now lands where Claude Code reads it. The folder name follows Claude Code's own rule (every character that is not a letter or digit becomes a dash, and long names are cut and hashed) and comes from the git repository, so a subfolder shares its repository's memory. Paths with a space, dot or underscore, such as `~/Library/Application Support`, were affected. Memory saved under the old name moves over once.
- A very deep project no longer fails with `ENAMETOOLONG`.
- The guard now flags macOS commands that erase a disk, turn off a protection or delete a keychain, and recursive deletes of system folders, the home folder and what it keeps work in.
- `lib/watchdog.mjs` now ships. `lib/proc.mjs` starts it, so any check run that way failed without it.
- Home in another case (`/USERS/ME`) is still home, so no graph build starts across the whole home folder.
- `graph_explain` and `graph_affected` pass on graphify's "ambiguous, retry with this id" answer instead of saying no graph exists.
- `atlias status`, `recall`, `progress`, `dream`, `graph` and `shortcut`, and `install --extras`, `--companions` and `--shortcut`, now exist. The package already told people and models to run them.
- Hooks are recognised from a checkout in any folder, so a reinstall from one not named atlias no longer stacks a second set.
- On macOS, Antigravity and the other IDE hosts get Node's full path, because an app started from the Dock cannot find a Node from nvm, fnm or Homebrew. Run `atlias install` again after changing Node version.
- Finder's `._name.js` files are no longer reported as broken code.

## 4.0.0

- Replaces the public package payload with the atlias host integration: install, native launch metering, hooks, MCP, shared memory, graph, and verification.
- Removes the standalone agent, private harness loop, evaluation corpora, internal reports, and benchmark runner from the package payload.
- Preserves the repository's existing Git history and MIT license.
