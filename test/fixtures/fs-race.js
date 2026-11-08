import {parentPort,workerData} from 'node:worker_threads';
import {rename,symlink,unlink} from 'node:fs/promises';
import {join,dirname,basename,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {raceRound} from './race-operations.js';
const base=resolve(workerData.base);
if(dirname(base)!==resolve(tmpdir())||!basename(base).startsWith('my-schedule-security-'))throw Error('Invalid race-test workspace');
const normal=join(base,'project','sub'),parked=join(base,'project','parked'),outside=join(base,'outside');
let stop=false,swaps=0,blocked=0,cleanupRetries=0;
parentPort.on('message',message=>{if(message?.type==='stop')stop=true;});
try{
  for(let round=0;!stop;round++){
    if(!swaps&&round>=40)throw Error('Could not create a real race-test link');
    await raceRound({paths:{normal,parked,outside},ops:{rename,symlink,unlink},
      onLinked(){swaps++;if(swaps===1)parentPort.postMessage({type:'ready'});},
      onAttackBlocked(){blocked++;},onCleanupRetry(){cleanupRetries++;}
    });
    await new Promise(resolve=>setImmediate(resolve));
  }
  parentPort.postMessage({type:'result',swaps,blocked,cleanupRetries,restored:true});
}finally{parentPort.close();}
