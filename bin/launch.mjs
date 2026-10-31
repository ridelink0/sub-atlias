#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import readline from 'node:readline/promises';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function chooseProject({ask,out,root=ROOT,exists=fs.statSync}={}){
 out('Atlias opens your coding project in its own terminal.');
 out('Paste the folder you want to work on. Nothing in it changes during setup.');
 for(;;){const raw=await ask('Project folder (0 to cancel): ');if(raw===null||raw===undefined)return null;let answer=String(raw).trim();if(answer==='0')return null;if(!answer){out('Choose a project folder, or type 0 to cancel.');continue;}if((answer.startsWith('"')&&answer.endsWith('"'))||(answer.startsWith("'")&&answer.endsWith("'")))answer=answer.slice(1,-1);const folder=path.resolve(answer);try{if(!exists(folder).isDirectory())throw Error();if(folder===root){out('That is the Atlias app folder. Choose your project instead.');continue;}return folder;}catch{out('That folder could not be opened. Check the path and try again.');}}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<13)){console.error('Atlias needs Node.js 22.13 or newer. Install it from https://nodejs.org, then open Atlias again.');process.exitCode=1;}else{
 const rl=readline.createInterface({input:process.stdin,output:process.stdout});let folder;try{folder=await chooseProject({ask:q=>rl.question(q),out:s=>console.log(s)});}finally{rl.close();}
 if(folder){process.chdir(folder);process.argv=[process.execPath,path.join(ROOT,'bin','atlias.mjs')];await import(pathToFileURL(path.join(ROOT,'bin','atlias.mjs')));}
 }
}
