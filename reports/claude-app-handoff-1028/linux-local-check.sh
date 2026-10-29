#!/bin/sh
set -eu
export PATH="/home/ridelink/atlias-max-ci/node/bin:$PATH"
SRC=/mnt/d/atlias-max-app
REPORT=/mnt/d/atlias-app/reports/ui-goal-1028
RUNNER="$REPORT/run-evidence.mjs"
WORK=$(mktemp -d /home/ridelink/atlias-max-codex-XXXXXX)
printf 'Private Linux check directory: %s\n' "$WORK"
(cd "$SRC" && tar --exclude=./node_modules --exclude=./out --exclude=./reports --exclude=./.git --exclude=./dist -cf - .) | (cd "$WORK" && tar -xf -)
ln -s /home/ridelink/atlias-max-ci/app/node_modules "$WORK/node_modules"
cd "$WORK"
node tools/build-renderer.mjs
node "$RUNNER" app-linux-node-final-unit "$WORK" --test --test-concurrency=1 test/unit/*.test.mjs
xvfb-run -a -s '-screen 0 1440x900x24' node "$RUNNER" app-linux-node-final-e2e "$WORK" test/e2e/run.mjs --out "$SRC/reports/codex-linux-node-final-e2e-1029"
