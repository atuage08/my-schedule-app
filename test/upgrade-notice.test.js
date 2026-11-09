import test from 'node:test';
import assert from 'node:assert/strict';
import {UpgradeNotice,UPGRADE_KEY} from '../src/upgrade-notice.js';
import {LOCK_NAME} from '../src/storage.js';
function fixture(){
  const data=new Map(),storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
  const names=[],locks={request:async(name,options,action)=>{names.push(name);return action();}};
  return {data,storage,locks,names,notice:new UpgradeNotice({storage,locks})};
}
test('upgrade notice appears initially and refresh without explicit acknowledgment cannot dismiss it',()=>{
  const {notice,data}=fixture();assert.equal(notice.required,true);notice.refresh();notice.refresh();assert.equal(notice.required,true);assert.equal(data.size,0);
});
test('unchecked notice cannot record acknowledgment',async()=>{
  const {notice,data}=fixture();assert.equal((await notice.acknowledge(false)).ok,false);assert.equal(notice.required,true);assert.equal(data.size,0);
});
test('explicit verified acknowledgment uses the same lock and survives a new page without repeated prompts',async()=>{
  const f=fixture();assert.equal((await f.notice.acknowledge(true)).ok,true);assert.equal(f.notice.required,false);assert.deepEqual(f.names,[LOCK_NAME]);
  assert.equal(new UpgradeNotice(f).required,false);assert.equal(f.data.size,1);assert.ok(f.data.has(UPGRADE_KEY));
});
test('failed notice persistence leaves notice visible',async()=>{
  const f=fixture();f.storage.setItem=()=>{throw Error('permission denied');};assert.equal((await f.notice.acknowledge(true)).ok,false);assert.equal(f.notice.required,true);assert.equal(f.data.size,0);
});
test('notice readback failure never reports success or dismisses the notice',async()=>{
  const f=fixture();f.storage.setItem=()=>{};assert.equal((await f.notice.acknowledge(true)).ok,false);assert.equal(f.notice.required,true);
});
test('missing, malformed or unreadable notice receipt is not treated as acknowledged',()=>{
  const f=fixture();f.data.set(UPGRADE_KEY,'unsupported');f.notice.refresh();assert.equal(f.notice.required,true);
  f.storage.getItem=()=>{throw Error('unavailable');};f.notice.refresh();assert.equal(f.notice.required,true);
});
test('notice acknowledgment from another tab is reread and receipt deletion restores the notice',async()=>{
  const f=fixture(),other=new UpgradeNotice(f);await other.acknowledge(true);f.notice.refresh();assert.equal(f.notice.required,false);
  f.data.delete(UPGRADE_KEY);f.notice.refresh();assert.equal(f.notice.required,true);
});
test('notice does not fall back to unlocked writes',async()=>{
  const f=fixture(),notice=new UpgradeNotice({...f,locks:null});assert.equal((await notice.acknowledge(true)).ok,false);assert.equal(f.data.size,0);assert.equal(notice.required,true);
});
