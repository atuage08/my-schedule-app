import {parentPort,workerData} from 'node:worker_threads';
import {on} from 'node:events';
import {rename,symlink,unlink} from 'node:fs/promises';
import {join,dirname,basename,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {raceRound} from './race-operations.js';
const base=resolve(workerData.base);
if(dirname(base)!==resolve(tmpdir())||!basename(base).startsWith('my-schedule-security-'))throw Error('Invalid race-test workspace');
const paths={normal:join(base,'project','sub'),parked:join(base,'project','parked'),outside:join(base,'outside'),staged:join(base,'attack-link')};
const commands=on(parentPort,'message');
let swaps=0,blocked=0,cleanupRetries=0,rounds=0;
async function command(type,round){
  const next=await commands.next(),message=next.value?.[0];
  if(next.done||message?.type!==type||message.round!==round)throw Error('Unexpected race worker command');
}
try{
  for(let round=0;round<10;round++){
    await command('arm',round);
    let linked=false,attackBlocked=false;
    await raceRound({paths,ops:{rename,symlink,unlink},hold:async()=>{},
      async onArmed(){parentPort.postMessage({type:'armed',round});await command('attack',round);},
      onLinked(){linked=true;swaps++;},
      onAttackBlocked(){attackBlocked=true;blocked++;},onCleanupRetry(){cleanupRetries++;},
      async beforeCleanup(){
        parentPort.postMessage({type:'prepared',round,linked,blocked:attackBlocked});
        // Hold the real attack until the parent acknowledges all reads settled.
        await command('release',round);
      }
    });
    rounds++;parentPort.postMessage({type:'restored',round});
  }
  await command('stop',10);
  parentPort.postMessage({type:'result',swaps,blocked,cleanupRetries,rounds,restored:true});
}finally{await commands.return();parentPort.close();}
