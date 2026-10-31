// Task Scheduler starts this small entry point without the interactive shell's environment.
import path from 'node:path';
const args=process.argv.slice(2);
const home=args[args.indexOf('--home')+1], id=args[args.indexOf('--id')+1];
if(!path.isAbsolute(home||'')||!/^[a-f0-9]{24}$/.test(id||''))throw Error('An absolute Atlias home and exact relay id are required.');
process.env.ATLIAS_HOME=home;
const {runScheduledRelay}=await import('../lib/relay.mjs');
const result=await runScheduledRelay(id);
process.stdout.write(JSON.stringify(result)+'\n');
process.exitCode=['failed','held'].includes(result.status)?2:0;
