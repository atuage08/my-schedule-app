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

export async function raceRound({paths,ops,hold=sleep,onArmed=async()=>{},onLinked=()=>{},onAttackBlocked=()=>{},beforeCleanup=async()=>{},onCleanupRetry=()=>{},retry={}}){
  // Windows junction creation is multi-step (mkdir, open, set reparse point).
  // Prepare it away from the reader before any concurrent reads start. Only
  // rename complete entries into the attacked pathname, never partial stubs.
  await ops.symlink(paths.outside,paths.staged,process.platform==='win32'?'junction':'dir');
  let moved=false,linked=false,staged=true;
  try{
    await onArmed();
    await ops.rename(paths.normal,paths.parked);moved=true;
    await ops.rename(paths.staged,paths.normal);linked=true;staged=false;
    onLinked();await hold(2);
  }catch(error){if(!isLockError(error))throw error;onAttackBlocked(error);}
  finally{
    // Drain in-flight reads before restoration; repeated reads can otherwise
    // keep Windows rename locked for the entire retry budget.
    await beforeCleanup();
    const options={...retry,onRetry:onCleanupRetry};
    // Move the complete link out before restoring the original directory.
    // Never follow or recursively remove a link or an unexpected directory.
    if(linked){await retryLocked(()=>ops.rename(paths.normal,paths.staged),options);staged=true;}
    if(moved)await retryLocked(()=>ops.rename(paths.parked,paths.normal),options);
    if(staged)await retryLocked(()=>ops.unlink(paths.staged),options);
  }
}
