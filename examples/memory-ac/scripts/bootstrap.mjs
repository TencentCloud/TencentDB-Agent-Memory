import {mkdir, readFile, copyFile, access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
const repo = resolve('vendor/TencentDB-Agent-Memory');
async function run(command,args) {
  await new Promise((yes,no)=>{const p=spawn(command,args,{stdio:'inherit',windowsHide:true}); p.on('error',no); p.on('exit',c=>c===0?yes():no(Error(command+': '+c)));});
}
await mkdir('vendor',{recursive:true});
try {await access(repo);} catch(e) {
  if(e.code!=='ENOENT') throw e;
  await run('git',['clone','--single-branch','--branch','v2.0.0-beta.1','--depth','1','https://github.com/TencentCloud/TencentDB-Agent-Memory.git',repo]);
}
const {execFileSync} = await import('node:child_process');
const sha=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(sha!=='41444344ce11467a5b5ad6aa032f5e261da1f4d2') throw Error('MemoryCore revision mismatch; refusing checkout/reset');
const changes=execFileSync('git',['-C',repo,'status','--porcelain'],{encoding:'utf8'});
if(changes.trim()) throw Error('Existing vendor changes; refusing to overwrite');
const lockPath='repro/MemoryCore.clean.package-lock.json';
const lock=await readFile(lockPath);
let upstream;
try {upstream=await readFile(repo+'/MemoryCore/package-lock.json');} catch(e) {if(e.code!=='ENOENT')throw e;}
if(upstream&&lock.toString().replace(/\r\n/g,'\n')!==upstream.toString().replace(/\r\n/g,'\n')) throw Error('Pinned lock differs; explicit review needed');
if(!upstream)await copyFile(lockPath,repo+'/MemoryCore/package-lock.json');
const npm=process.platform==='win32'?'npm.cmd':'npm';
// npm.cmd is a fixed executable; no caller-supplied shell text is interpolated.
if(process.platform==='win32') await run('cmd.exe',['/d','/c',npm,'--prefix',repo+'/MemoryCore','ci','--ignore-scripts','--include=optional','--no-audit','--no-fund']);
else await run(npm,['--prefix',repo+'/MemoryCore','ci','--ignore-scripts','--include=optional','--no-audit','--no-fund']);
console.log(JSON.stringify({status:'pass',memorycore_commit:sha,postinstall_scripts:false}));
