---
name: double-check
description: "Use before calling a code change done, when the atlias gate holds a reply for a second pass, or when asked to verify, bug-check or review your own change, or to turn a failing test into a fix."
---

# double-check

Done means two passes happened and the reply names both.

## Pass 1: functional proof

1. List every file you changed this turn (`harness_progress get` shows them).
2. Run the cheapest real check that would fail if the change were wrong: `node --check`, `JSON.parse`, `py_compile`, the project's own test or sweep script, a request against the running app. `harness_verify {paths}` does the syntax floor.
3. Read the output. A check you did not read did not happen.

## Pass 2: adversarial hunt

Re-read each changed file as the person trying to break it. Ask, in order:

- Empty, missing or malformed input: what happens on `null`, `""`, `[]`, a corrupt line, a missing file?
- Boundaries: first item, last item, exactly the threshold, zero, negative.
- Windows: backslashes, drive letters, a BOM at the start of a file, CRLF, a path with spaces, a locked file.
- Callers: who assumed the old behaviour, the old name, the old return shape? Grep for them.
- Failure paths: which `catch` swallows the error the user would need to see?
- Concurrency: two hooks or two sessions writing the same file at once.
- Regressions: what worked before that this change could have broken? Run that check too.

Fix what you find, re-run pass 1 for the fixed files, and end the reply with one line: `Pass 1: <check> passed. Pass 2: <what was found and fixed, or nothing found after checking X, Y, Z>.`

## Reading a test failure

atlias tests and gate messages come in three lines: what happened, why it matters, how to fix it. Fix the cause the message names, not the assertion. If the test is wrong, say so with the evidence before changing it.