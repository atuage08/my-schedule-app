import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const MAX_SOURCE_BYTES=8*1024*1024;
let worker,sequence=0;
function sourcePath(root,name){
  if(typeof root!=='string'||root.length>4096||!isAbsolute(root)||typeof name!=='string'||name.length>1024||!name||name.startsWith('/')||/[\\:\x00-\x1f<>"|?*]/.test(name))throw Error('Source path escapes or is invalid');
  const parts=name.split('/');
  if(parts.length>64||resolve(root).split(sep).length>128||parts.some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)))throw Error('Source path escapes or is invalid');
  return {root:resolve(root),parts};
}
function windowsRequest(root,name,operation){
  if(!worker){
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./windows-source-worker.ps1',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const instance={child,pending:new Map(),buffer:''};worker=instance;
    const fail=()=>{
      if(worker===instance)worker=undefined;
      for(const {reject,timer} of instance.pending.values()){clearTimeout(timer);reject(Error('Windows protected source helper unavailable'));}
      instance.pending.clear();
    };
    child.on('error',fail);child.on('exit',fail);child.stdin.on('error',fail);
    child.stderr.on('data',()=>{}); // Never echo source contents or native diagnostics.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      instance.buffer+=chunk;
      if(instance.buffer.length>16*1024*1024){child.kill();fail();return;}
      let end;
      while((end=instance.buffer.indexOf('\n'))!==-1){
        const line=instance.buffer.slice(0,end);instance.buffer=instance.buffer.slice(end+1);
        let response;try{response=JSON.parse(line);}catch{child.kill();fail();return;}
        const pending=instance.pending.get(response.id);if(!pending)continue;
        instance.pending.delete(response.id);clearTimeout(pending.timer);
        if(response.ok)pending.resolve(response.data);else pending.reject(Error(response.error));
      }
      if(!instance.pending.size){child.unref();for(const stream of [child.stdin,child.stdout,child.stderr])stream.unref?.();}
    });
  }
  const instance=worker,{child}=instance;
  child.ref();for(const stream of [child.stdin,child.stdout,child.stderr])stream.ref?.();
  return new Promise((resolveResult,reject)=>{
    const id=++sequence;
    const timer=setTimeout(()=>{child.kill();reject(Error('Protected source read timed out'));},15000);
    instance.pending.set(id,{resolve:resolveResult,reject,timer});
    child.stdin.write(JSON.stringify({id,root,name,operation})+'\n');
  });
}
async function linuxOperation(root,parts,listing){
  const held=[];
  const dirFlags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
  try{
    if(!constants.O_DIRECTORY||!constants.O_NOFOLLOW)throw Error('Required no-follow support is unavailable');
    let directory=await open(sep,dirFlags);held.push(directory);
    for(const part of [...root.split(sep).filter(Boolean),...parts.slice(0,-1)]){
      directory=await open(`/proc/self/fd/${directory.fd}/${part}`,dirFlags);held.push(directory);
    }
    const path=`/proc/self/fd/${directory.fd}/${parts.at(-1)}`;
    const leaf=await open(path,listing?dirFlags:constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);held.push(leaf);
    const before=await leaf.stat({bigint:true});
    if(listing){
      if(!before.isDirectory())throw Error('Not a source directory');
      const entries=await readdir(`/proc/self/fd/${leaf.fd}`,{withFileTypes:true});
      if(entries.length>4096)throw Error('Too many source entries');
      return entries.map(entry=>({name:entry.name,kind:entry.isSymbolicLink()?'link':entry.isDirectory()?'directory':entry.isFile()?'file':'other'}));
    }
    if(!before.isFile()||before.nlink!==1n||before.size>BigInt(MAX_SOURCE_BYTES))throw Error('Linked, oversized or non-regular source refused');
    const chunks=[];let total=0;
    while(true){
      const buffer=Buffer.alloc(Math.min(65536,MAX_SOURCE_BYTES-total+1));
      const {bytesRead}=await leaf.read(buffer,0,buffer.length,null);
      if(!bytesRead)break;
      total+=bytesRead;if(total>MAX_SOURCE_BYTES)throw Error('Source grew beyond limit');
      chunks.push(buffer.subarray(0,bytesRead));
    }
    const after=await leaf.stat({bigint:true});
    if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw Error('Source changed during read');
    return Buffer.concat(chunks,total);
  }finally{for(const handle of held.reverse())await handle.close();}
}
export async function protectedSource(root,name,{listing=false}={}){
  const checked=sourcePath(root,name);
  if(process.platform==='win32'){
    const result=await windowsRequest(checked.root,checked.parts.join('/'),listing?'list':'read');
    return listing?(Array.isArray(result)?result:result?[result]:[]):Buffer.from(result,'base64');
  }
  if(process.platform==='linux')return linuxOperation(checked.root,checked.parts,listing);
  throw Error('Protected source reads require Windows or Linux; refusing an unsafe fallback');
}
