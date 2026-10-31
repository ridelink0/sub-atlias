import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'atlias-config-backup-'));
process.env.ATLIAS_HOME=path.join(dir,'home');
const core=await import('../lib/core.mjs');assert.equal(core.STATE_DIR,process.env.ATLIAS_HOME);
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
test('a changed config preserves its exact previous bytes and never overwrites that version',()=>{
 const file=path.join(core.STATE_DIR,'config.json');const original=Buffer.from('{"ui":{"accentColor":"blue"},"agent":{"engine":"auto"}}\r\n');
 core.ensureDir(core.STATE_DIR);fs.writeFileSync(file,original);core.writeText(file,'{"ui":{"accentColor":"cyan"}}\n');
 const name=crypto.createHash('sha256').update(original).digest('hex')+'.json';assert.deepEqual(fs.readFileSync(path.join(core.STATE_DIR,'config-backups',name)),original);
 const count=fs.readdirSync(path.join(core.STATE_DIR,'config-backups')).length;core.writeText(file,'{"ui":{"accentColor":"cyan"}}\n');assert.equal(fs.readdirSync(path.join(core.STATE_DIR,'config-backups')).length,count);
});
test('an unavailable backup blocks replacement and leaves the working preferences intact',()=>{
 const home=path.join(dir,'second');fs.mkdirSync(home,{recursive:true});
 const file=path.join(core.STATE_DIR,'config.json'),before=fs.readFileSync(file);
 const backups=path.join(core.STATE_DIR,'config-backups');fs.renameSync(backups,backups+'.kept');fs.writeFileSync(backups,'not a directory');
 assert.throws(()=>core.writeText(file,'{"agent":{"engine":"echo"}}'));assert.deepEqual(fs.readFileSync(file),before);
 fs.unlinkSync(backups);fs.renameSync(backups+'.kept',backups);
});
