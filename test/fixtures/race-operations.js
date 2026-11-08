const LOCK_ERRORS=new Set(['EBUSY','EPERM','EACCES']);
export const isLockError=error=>LOCK_ERRORS.has(error?.code);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// This is test-fixture cleanup only. Persistent locks and all other errors fail.
export async function retryLocked(operation,{maxAttempts=40,delayMs=5,wait=sleep,onRetry=()=>{}}={}){
  if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>100||!Number.isFinite(delayMs)||delayMs<0)throw Error('Invalid retry limit');
  for(let attempt=0;attempt<maxAttempts;attempt++){
    try{return await operation();}
    catch(error){
      if(!isLockError(error)||attempt+1===maxAttempts)throw error;
      onRetry(error);await wait(Math.min(delayMs*(attempt+1),50));
    }
  }
}

export async function raceRound({paths,ops,hold=sleep,onLinked=()=>{},onAttackBlocked=()=>{},onCleanupRetry=()=>{},retry={}}){
  let moved=false,linked=false;
  try{
    await ops.rename(paths.normal,paths.parked);moved=true;
    await ops.symlink(paths.outside,paths.normal,process.platform==='win32'?'junction':'dir');linked=true;
    onLinked();await hold(2);
  }catch(error){if(!isLockError(error))throw error;onAttackBlocked(error);}
  finally{
    const options={...retry,onRetry:onCleanupRetry};
    // Never follow or recursively remove the attack link. Restore in order.
    if(linked)await retryLocked(()=>ops.unlink(paths.normal),options);
    if(moved)await retryLocked(()=>ops.rename(paths.parked,paths.normal),options);
  }
}
