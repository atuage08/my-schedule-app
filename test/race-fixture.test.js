import test from 'node:test';
import assert from 'node:assert/strict';
import {retryLocked,raceRound} from './fixtures/race-operations.js';
import {raceSession} from './fixtures/race-session.js';
import {EventEmitter} from 'node:events';
const failure=code=>Object.assign(Error(code),{code});
const paths={normal:'normal',parked:'parked',outside:'outside',staged:'staged'};
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
  assert.deepEqual(log,['symlink','normal->parked','staged->normal','linked','hold','normal->staged','parked->normal','unlink']);assert.equal(retries,4);
});
test('a failed link installation restores the parked directory and is not counted as an attack',async()=>{
  const log=[];let linked=0,blocked=0;
  await raceRound({paths,hold:immediate,retry:{wait:immediate},onLinked(){linked++;},onAttackBlocked(){blocked++;},ops:{
    async rename(from,to){if(from==='staged')throw failure('EPERM');log.push(`${from}->${to}`);},async symlink(){},async unlink(name){log.push(`unlink ${name}`);}
  }});
  assert.equal(linked,0);assert.equal(blocked,1);assert.deepEqual(log,['normal->parked','parked->normal','unlink staged']);
});
test('an unexpected attack error is propagated after restoring the workspace',async()=>{
  const log=[];
  await assert.rejects(raceRound({paths,hold:immediate,retry:{wait:immediate},ops:{
    async rename(from,to){if(from==='staged')throw failure('EIO');log.push(`${from}->${to}`);},async symlink(){},async unlink(name){log.push(`unlink ${name}`);}
  }}),error=>error.code==='EIO');
  assert.deepEqual(log,['normal->parked','parked->normal','unlink staged']);
});
test('permanently blocked link withdrawal fails and does not attempt unsafe directory restoration',async()=>{
  let renames=0;
  await assert.rejects(raceRound({paths,hold:immediate,retry:{wait:immediate,maxAttempts:2},ops:{
    async rename(from){renames++;if(from==='normal'&&renames>1)throw failure('EBUSY');},async symlink(){},async unlink(){throw Error('not withdrawn');}
  }}),error=>error.code==='EBUSY');assert.equal(renames,4);
});

test('restoration cannot start until the reader releases the cleanup barrier',async()=>{
  const log=[];let release,prepared;
  const barrier=new Promise(resolve=>{release=resolve;});
  const ready=new Promise(resolve=>{prepared=resolve;});
  const operation=raceRound({paths,hold:immediate,async beforeCleanup(){prepared();await barrier;},ops:{
    async rename(from,to){log.push(`${from}->${to}`);},async symlink(){log.push('link');},async unlink(){log.push('unlink');}
  }});
  await ready;
  assert.deepEqual(log,['link','normal->parked','staged->normal']);
  // Simulate a slow protected read without relying on OS scheduling or sleeps.
  await Promise.resolve();assert.equal(log.includes('unlink'),false);
  release();await operation;
  assert.deepEqual(log,['link','normal->parked','staged->normal','normal->staged','parked->normal','unlink']);
});

test('restoration also waits for the reader after blocked link installation',async()=>{
  const log=[];let release,prepared;
  const barrier=new Promise(resolve=>{release=resolve;});
  const ready=new Promise(resolve=>{prepared=resolve;});
  const operation=raceRound({paths,hold:immediate,async beforeCleanup(){prepared();await barrier;},ops:{
    async rename(from,to){if(from==='staged')throw failure('EPERM');log.push(`${from}->${to}`);},async symlink(){},async unlink(name){log.push(`unlink ${name}`);}
  }});
  await ready;assert.deepEqual(log,['normal->parked']);release();await operation;
  assert.deepEqual(log,['normal->parked','parked->normal','unlink staged']);
});

test('a complete staged link is armed before reads and moved without creating a link at the read path',async()=>{
  const log=[];let reading=false;
  await raceRound({paths,hold:immediate,async onArmed(){log.push('armed');reading=true;},async beforeCleanup(){log.push('drained');reading=false;},ops:{
    async symlink(target,name){assert.equal(reading,false);assert.equal(target,'outside');assert.equal(name,'staged');log.push('create staged');},
    async rename(from,to){log.push(`${from}->${to}`);},
    async unlink(name){assert.equal(reading,false);assert.equal(name,'staged');log.push('unlink staged');}
  }});
  assert.deepEqual(log,['create staged','armed','normal->parked','staged->normal','drained','normal->staged','parked->normal','unlink staged']);
});

test('failed staged junction creation is a failure and never modifies the source directory',async()=>{
  let renames=0,armed=false;
  await assert.rejects(raceRound({paths,onArmed(){armed=true;},ops:{
    async symlink(target,name){assert.equal(name,'staged');throw failure('EPERM');},async rename(){renames++;},async unlink(){throw Error('not created');}
  }}),error=>error.code==='EPERM');
  assert.equal(renames,0);assert.equal(armed,false);
});

test('permanent staged link deletion failure remains a test failure after source restoration',async()=>{
  const log=[];
  await assert.rejects(raceRound({paths,hold:immediate,retry:{wait:immediate,maxAttempts:2},ops:{
    async symlink(){},async rename(from,to){log.push(`${from}->${to}`);},async unlink(){throw failure('EPERM');}
  }}),error=>error.code==='EPERM');
  assert.deepEqual(log,['normal->parked','staged->normal','normal->staged','parked->normal']);
});

class FakeWorker extends EventEmitter{
  sent=[];
  postMessage(message){this.sent.push(message);}
  async terminate(){this.emit('exit',1);}
}

test('worker session registers before send and requires both result and clean exit',async()=>{
  const worker=new FakeWorker(),session=raceSession(worker);let exited=false;
  worker.postMessage=message=>{worker.sent.push(message);if(message.type==='attack')worker.emit('message',{type:'prepared',round:0,linked:true});};
  assert.equal((await session.exchange('attack','prepared',0)).linked,true);
  const done=session.finish().then(result=>{exited=true;return result;});
  worker.emit('message',{type:'result',restored:true});
  await Promise.resolve();assert.equal(exited,false);
  worker.emit('exit',0);assert.equal((await done).restored,true);
  await session.dispose();
});

test('early worker exit rejects the waiting phase and future commands',async()=>{
  const worker=new FakeWorker(),session=raceSession(worker);
  const prepared=session.exchange('attack','prepared',0);worker.emit('exit',0);
  await assert.rejects(prepared,/before completed restoration/);
  await assert.rejects(session.exchange('release','restored',0),/before completed restoration/);
  await session.dispose();
});

test('worker errors and unexpected round messages are propagated',async()=>{
  for(const invalid of ['error','round']){
    const worker=new FakeWorker(),session=raceSession(worker),pending=session.exchange('attack','prepared',0);
    if(invalid==='error')worker.emit('error',Error('worker fixture failure'));
    else worker.emit('message',{type:'prepared',round:1});
    await assert.rejects(pending,invalid==='error'?/worker fixture failure/:/Unexpected/);await session.dispose();
  }
});

test('missing worker acknowledgments fail within the protocol timeout',async()=>{
  const worker=new FakeWorker(),session=raceSession(worker,{timeoutMs:10});
  await assert.rejects(session.exchange('attack','prepared',0),/protocol timed out/);await session.dispose();
});

test('missing worker exit fails even after a restoration result',async()=>{
  const worker=new FakeWorker(),session=raceSession(worker,{timeoutMs:10});const done=session.finish();
  worker.emit('message',{type:'result',restored:true});
  await assert.rejects(done,/exit timed out/);await session.dispose();
});

test('disposing a failed test rejects any pending phase and terminates the worker',async()=>{
  const worker=new FakeWorker(),session=raceSession(worker);let terminated=false;
  worker.terminate=async()=>{terminated=true;worker.emit('exit',1);};
  const pending=session.exchange('attack','prepared',0);const failed=assert.rejects(pending,/disposed before restoration/);
  await session.dispose();await failed;assert.equal(terminated,true);
});
