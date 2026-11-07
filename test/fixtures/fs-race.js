import {parentPort,workerData} from 'node:worker_threads';
import {rename,symlink,unlink} from 'node:fs/promises';
import {join,dirname,basename,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const base=resolve(workerData.base);
if(dirname(base)!==resolve(tmpdir())||!basename(base).startsWith('my-schedule-security-'))throw Error('Invalid race-test workspace');
const normal=join(base,'project','sub'),parked=join(base,'project','parked'),outside=join(base,'outside');
let stop=false,swaps=0;parentPort.on('message',()=>{stop=true;});
parentPort.postMessage('ready');
while(!stop){
  let moved=false,linked=false;
  try{
    await rename(normal,parked);moved=true;
    await symlink(outside,normal,process.platform==='win32'?'junction':'dir');linked=true;swaps++;
    await new Promise(resolve=>setTimeout(resolve,2));
  }catch{}
  finally{
    if(linked)await unlink(normal);
    if(moved)await rename(parked,normal);
  }
  await new Promise(resolve=>setImmediate(resolve));
}
parentPort.postMessage({swaps});parentPort.close();
