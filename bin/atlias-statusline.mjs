#!/usr/bin/env node
import { renderClaudeLabel } from '../lib/claude-label.mjs';
let input='';for await(const chunk of process.stdin)input+=chunk;
const at=process.argv.indexOf('--state');
process.stdout.write(await renderClaudeLabel(input,{stateFile:at<0?undefined:process.argv[at+1]})+'\n');
