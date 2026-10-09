#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectCatalog, runSoftwareContracts } from '../lib/ultimate-benchmark.mjs';
import { direction } from '../lib/benchmark-oracle.mjs';

const args = process.argv.slice(2);
const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const value = flag => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
try {
  let result;
  if (args[0] === 'inspect') result = inspectCatalog({ corpusRoot: value('--corpus-root') || sourceRoot });
  else if (args[0] === 'check') {
    result = runSoftwareContracts({ sourceRoot });
    process.exitCode = result.passed ? 0 : 1;
  } else if (args[0] === 'direction') {
    const reportPath = value('--report'), idsPath = value('--ids');
    if (!reportPath || !idsPath) throw new Error('Gev direction requires --report and the frozen --ids JSON file');
    result = direction(JSON.parse(fs.readFileSync(reportPath)), { expectedIds: JSON.parse(fs.readFileSync(idsPath)) });
  } else throw new Error('Usage: node tools/ultimate.mjs inspect [--corpus-root dir] | check | direction --report path --ids path');
  const text = JSON.stringify(result, null, 2) + '\n';
  const output = value('--out');
  if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, text); }
  process.stdout.write(text);
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 2; }
