import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const outDir = path.resolve(process.argv[2] || '');
if (!outDir.startsWith('D:\\atlias-test-runs\\') || fs.existsSync(outDir)) throw new Error('a new directory inside D:/atlias-test-runs is required');
process.env.ATLIAS_MAX_TEST_PACKAGE = '1';
const { default: packageApp } = await import(pathToFileURL(path.join(process.cwd(), 'node_modules/@electron-forge/core/dist/api/package.js')));
console.log(JSON.stringify(await packageApp({ dir: process.cwd(), outDir, interactive: false })));
