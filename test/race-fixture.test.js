import test from 'node:test';
import assert from 'node:assert/strict';
import {retryLocked,raceRound} from './fixtures/race-operations.js';
const failure=code=>Object.assign(Error(code),{code});
const paths={normal:'normal',parked:'parked',outside:'outside'};
const immediate=async()=>{};

test('cleanup retries transient locks with a bounded increasing wait',async()=>{
  let calls=0,retries=0;const waits=[];
  const result=await retryLocked(async()=>{if(++calls<4)throw failure('EBUSY');return 'restored';},{maxAttempts:4,delayMs:5,wait:async ms=>{waits.push(ms);},onRetry(){retries++;}});
  assert.equal(result,'restored');assert.equal(calls,4);assert.equal(retries,3);assert.deepEqual(waits,[5,10,15]);
});
test('a permanent lock fails after the retry budget rather than passing silently',async()=>{
  let calls=0;await assert.rejects(retryLocked(async()=>{calls++;throw failure('EBUSY');},{maxAttempts:3,wait:immediate}),error=>error.code==='EBUSY');assert.equal(calls,3);
});
test('non-lock errors fail immediately without retry',async()=>{
  let calls=0;await assert.rejects(retryLocked(async()=>{calls++;throw failure('EIO');},{wait:immediate}),error=>error.code==='EIO');assert.equal(calls,1);
});
test('race cleanup waits for unlink and rename locks before reporting restoration',async()=>{
  const log=[];let unlinkCalls=0,restoreCalls=0,retries=0;
  await raceRound({paths,hold:async()=>{log.push('hold');},retry:{wait:immediate,maxAttempts:5},onLinked(){log.push('linked');},onCleanupRetry(){retries++;},ops:{
    async rename(from,to){if(from==='parked'&&++restoreCalls<3)throw failure('EPERM');log.push(`${from}->${to}`);},
    async symlink(){log.push('symlink');},
    async unlink(){if(++unlinkCalls<3)throw failure('EBUSY');log.push('unlink');}
  }});
  assert.deepEqual(log,['normal->parked','symlink','linked','hold','unlink','parked->normal']);assert.equal(retries,4);
});
test('a failed link creation restores the parked directory and is not counted as an attack',async()=>{
  const log=[];let linked=0,blocked=0;
  await raceRound({paths,hold:immediate,retry:{wait:immediate},onLinked(){linked++;},onAttackBlocked(){blocked++;},ops:{
    async rename(from,to){log.push(`${from}->${to}`);},async symlink(){throw failure('EPERM');},async unlink(){throw Error('no link was created');}
  }});
  assert.equal(linked,0);assert.equal(blocked,1);assert.deepEqual(log,['normal->parked','parked->normal']);
});
test('an unexpected attack error is propagated after restoring the workspace',async()=>{
  const log=[];
  await assert.rejects(raceRound({paths,hold:immediate,retry:{wait:immediate},ops:{
    async rename(from,to){log.push(`${from}->${to}`);},async symlink(){throw failure('EIO');},async unlink(){throw Error('not linked');}
  }}),error=>error.code==='EIO');
  assert.deepEqual(log,['normal->parked','parked->normal']);
});
test('permanently blocked link cleanup fails and does not attempt unsafe directory restoration',async()=>{
  let renames=0;
  await assert.rejects(raceRound({paths,hold:immediate,retry:{wait:immediate,maxAttempts:2},ops:{
    async rename(){renames++;},async symlink(){},async unlink(){throw failure('EBUSY');}
  }}),error=>error.code==='EBUSY');assert.equal(renames,1);
});
