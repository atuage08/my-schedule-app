import test from 'node:test';
import assert from 'node:assert/strict';
import {ScheduleStore} from '../src/storage.js';
import {seed,serializeState,STORAGE_KEY} from '../src/model.js';
import {NotificationConnection,CONNECTION_ITEM_ID,CONNECTION_TITLE,RESULT_PREFIX,bootNotificationStore} from '../src/notification-connection.js';
import {createConnectionUI} from '../src/notification-connection-ui.js';
import {V3_ORIGIN,V3_LIST} from '../src/notification-v3.js';
class Element{
  nodeType=1;children=[];open=false;
  constructor(tag){this.tag=tag;}
  setAttribute(key,value){this[key]=value;}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  get textContent(){return this.children.map(n=>n.textContent).join('');}
  showModal(){this.open=true;}close(){this.open=false;}
}
const walk=node=>[node,...(node.children||[]).flatMap(walk)];
const button=(root,text)=>walk(root).find(n=>n.tag==='button'&&n.textContent===text);
const now=new Date('2026-11-22T03:00:00.000Z');
const rec=f=>f.store.state.notificationLink.records.find(r=>r.itemId===CONNECTION_ITEM_ID);
function receipt(f,inspection=false){const r=rec(f),p=r.pending,generation=inspection?'bootstrap-generation':p.generationId;return {format:'my-schedule-notification-result',formatVersion:1,kind:inspection?'inspection':'operation',itemId:r.itemId,operationId:p.operationId,operation:inspection?'inspect':p.operation,expectedGenerationId:r.generationId,generationId:generation,outcome:inspection?'observed':'applied',observed:{listName:V3_LIST,title:CONNECTION_TITLE,notifyAt:inspection?null:p.notifyAt,completed:inspection||p.operation==='deactivate',state:inspection||p.operation==='deactivate'?'inactive':'active',phase:'confirmed',pending:null,generationId:generation,previousGenerationId:inspection?null:p.expectedGenerationId,operationId:inspection?'bootstrap-operation':p.operationId}};}
async function data({paired=true,empty=false}={}){
  const map=new Map(empty?[]:[[STORAGE_KEY,serializeState(seed('2026-11-22'))]]),hooks={};let writes=0;
  const storage={getItem:key=>map.get(key)??null,setItem(key,value){writes++;if(hooks.write)hooks.write(key,value);map.set(key,value);}};
  const store=new ScheduleStore({storage,locks:{request:async(name,options,fn)=>fn()},now:()=>now});await store.refresh();const connection=new NotificationConnection({store,origin:()=>V3_ORIGIN,now:()=>now});const f={map,hooks,store,connection,get writes(){return writes;}};
  if(empty)return f;await connection.createFixture(true);await connection.prepareInspection(true);
  if(paired){await connection.accept(JSON.stringify(receipt(f,true)),{consent:true,inspectionConfirmed:true});await store.mutate(d=>{d.items.find(item=>item.id===CONNECTION_ITEM_ID).notification={enabled:true,notifyAt:'2026-11-23T03:00:00.000Z'};},store.token(),{notificationV3:true});await connection.prepare(true);}
  return f;
}
function ui(f,result){
  const saved={document:globalThis.document,window:globalThis.window,history:globalThis.history},root=new Element('body'),cleared=[];
  const location={origin:V3_ORIGIN,pathname:'/',search:'',hash:typeof result==='string'?result:RESULT_PREFIX+encodeURIComponent(JSON.stringify(result))};
  globalThis.document={body:root,createElement:tag=>new Element(tag),createTextNode:text=>({nodeType:3,textContent:String(text)})};globalThis.window={location};globalThis.history={state:null,replaceState(state,title,url){cleared.push(url);location.hash='';}};
  const app=createConnectionUI({store:f.store,onChange(){},notify(){}});
  return {root,location,cleared,app,restore(){for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}};
}
test('valid callback saves first and then clears its fragment without navigation',async()=>{
  const f=await data(),u=ui(f,receipt(f));try{await u.app.receiveLocation();assert.equal(rec(f).pending,null);assert.equal(u.cleared.length,1);assert.equal(u.location.hash,'');assert.match(u.root.textContent,/反映確認の報告/);}finally{u.restore();}
});
test('failed receipt save retains URL and text; repeated page events do not retry automatically',async()=>{
  const f=await data(),r=receipt(f),u=ui(f,r);let failures=0;
  try{f.hooks.write=()=>{failures++;throw Error('denied');};await u.app.receiveLocation();assert.equal(u.cleared.length,0);assert.ok(u.location.hash.startsWith(RESULT_PREFIX));assert.equal(walk(u.root).find(n=>n.tag==='textarea'&&n['aria-label']==='読み戻し結果JSON').value,JSON.stringify(r));
    await u.app.receiveLocation();assert.equal(failures,1);delete f.hooks.write;
    const consent=walk(u.root).find(n=>n.tag==='input'&&n.type==='checkbox');consent.checked=true;consent.onchange();await button(u.root,'結果JSONを検証して保存').onclick();assert.equal(u.cleared.length,1);assert.equal(rec(f).pending,null);
  }finally{u.restore();}
});
test('inspection URL waits for explicit fresh-state confirmation and does not auto-pair',async()=>{
  const f=await data({paired:false}),u=ui(f,receipt(f,true));try{await u.app.receiveLocation();assert.equal(rec(f).status,'unverified');assert.equal(u.cleared.length,0);
    let checks=walk(u.root).filter(n=>n.tag==='input'&&n.type==='checkbox');checks[0].checked=true;checks[0].onchange();await button(u.root,'結果JSONを検証して保存').onclick();assert.equal(rec(f).status,'unverified');
    checks=walk(u.root).filter(n=>n.tag==='input'&&n.type==='checkbox');checks[1].checked=true;checks[1].onchange();await button(u.root,'結果JSONを検証して保存').onclick();assert.equal(rec(f).status,'inactive');assert.equal(u.cleared.length,1);
  }finally{u.restore();}
});
test('a return into an empty partition stops without seeding or retaining a false success',async()=>{
  const source=await data(),r=receipt(source),f=await data({empty:true}),u=ui(f,r);try{await bootNotificationStore(f.store,u.location.hash);await u.app.receiveLocation();assert.equal(f.map.size,0);assert.equal(f.writes,0);assert.equal(u.cleared.length,0);assert.match(u.root.textContent,/初期化・統合せず停止/);}finally{u.restore();}
});
test('bad result encoding is rejected and a newer fragment is never cleared by an older save',async()=>{
  const f=await data(),bad=ui(f,RESULT_PREFIX+'%ZZ');try{const raw=f.map.get(STORAGE_KEY);await bad.app.receiveLocation();assert.equal(bad.cleared.length,0);assert.equal(f.map.get(STORAGE_KEY),raw);}finally{bad.restore();}
  const u=ui(f,receipt(f));try{f.hooks.write=()=>{u.location.hash=RESULT_PREFIX+encodeURIComponent('{"new":"result"}');};await u.app.receiveLocation();assert.equal(u.cleared.length,0);assert.ok(u.location.hash.includes('new'));}finally{u.restore();}
});

test('explicit inspection button launches once; redraw and reopen never navigate automatically',async()=>{
  const f=await data({paired:false}),u=ui(f,'');try{
    u.app.open();const consent=walk(u.root).find(n=>n.tag==='input'&&n.type==='checkbox');consent.checked=true;consent.onchange();
    const prepare=button(u.root,'初回・再接続の照合依頼を準備');await Promise.all([prepare.onclick(),prepare.onclick()]);
    assert.equal(u.location.href,undefined);const launch=button(u.root,'保存した照合依頼でショートカットを開く');assert.ok(launch);assert.equal(launch.disabled,false);
    launch.onclick();const first=u.location.href;assert.equal(new URL(first).searchParams.get('name'),'マイスケジュール通知連携v3読み取り確認テスト');
    launch.onclick();assert.equal(u.location.href,first);assert.equal(button(u.root,'保存した照合依頼でショートカットを開く'),undefined);
    u.app.changed();u.app.open();assert.equal(u.location.href,first);assert.equal(button(u.root,'保存した照合依頼でショートカットを開く'),undefined);
  }finally{u.restore();}
});

test('inspection save failure never exposes a launch button or navigates',async()=>{
  const f=await data({paired:false}),u=ui(f,'');try{
    await f.store.mutate(d=>{d.notificationLink.records.find(r=>r.itemId===CONNECTION_ITEM_ID).pending.status='pending';},f.store.token(),{user:false});
    u.app.open();const consent=walk(u.root).find(n=>n.tag==='input'&&n.type==='checkbox');consent.checked=true;consent.onchange();
    f.hooks.write=()=>{throw Error('denied');};await button(u.root,'初回・再接続の照合依頼を準備').onclick();
    assert.equal(button(u.root,'保存した照合依頼でショートカットを開く'),undefined);assert.equal(u.location.href,undefined);
  }finally{u.restore();}
});

function readback(f){const r=receipt(f),o=r.observed;return {format:'my-schedule-notification-readback',formatVersion:1,purpose:'verification',itemId:r.itemId,operationId:r.operationId,reminder:{listName:V3_LIST,title:o.title,notifyAtText:o.notifyAt??'',completed:o.completed,notesText:JSON.stringify({app:'my-schedule',metadataVersion:2,itemId:r.itemId,generationId:o.generationId,previousGenerationId:o.previousGenerationId,operationId:o.operationId,state:o.state,phase:o.phase,pending:o.pending})}};}

test('readback URL is only a report; explicit fresh-read approval is required before verification',async()=>{
  const f=await data(),r=readback(f),u=ui(f,r),raw=f.map.get(STORAGE_KEY);try{
    await bootNotificationStore(f.store,()=>u.location.hash);await u.app.receiveLocation();assert.equal(f.map.get(STORAGE_KEY),raw);assert.equal(u.cleared.length,0);assert.equal(rec(f).pending.status,'unknown');
    let checks=walk(u.root).filter(n=>n.tag==='input'&&n.type==='checkbox');checks[0].checked=true;checks[0].onchange();
    await button(u.root,'結果JSONを検証して保存').onclick();assert.equal(f.map.get(STORAGE_KEY),raw);
    checks=walk(u.root).filter(n=>n.tag==='input'&&n.type==='checkbox');checks[1].checked=true;checks[1].onchange();await button(u.root,'結果JSONを検証して保存').onclick();
    assert.equal(rec(f).pending,null);assert.equal(u.cleared.length,1);assert.match(u.root.textContent,/変更後の読み戻し報告/);
  }finally{u.restore();}
});

test('verification launch button is separate from mutation and initial pairing, double click launches once',async()=>{
  const f=await data(),u=ui(f,''),raw=f.map.get(STORAGE_KEY);try{
    u.app.open();let check=walk(u.root).find(n=>n.tag==='input'&&n.type==='checkbox');check.checked=true;check.onchange();
    assert.equal(button(u.root,'初回・再接続の照合依頼を準備').disabled,true);
    const prepare=button(u.root,'変更後の反映確認を準備');await Promise.all([prepare.onclick(),prepare.onclick()]);assert.equal(f.map.get(STORAGE_KEY),raw);assert.equal(u.location.href,undefined);
    const launch=button(u.root,'読み取り専用で反映を確認する');assert.ok(launch);launch.onclick();const first=u.location.href;launch.onclick();assert.equal(u.location.href,first);
    const url=new URL(first);assert.equal(url.searchParams.get('name'),'マイスケジュール通知連携v3読み取り確認テスト');assert.equal(JSON.parse(url.searchParams.get('text')).purpose,'verification');
    u.app.open();u.app.changed();assert.equal(button(u.root,'読み取り専用で反映を確認する'),undefined);assert.equal(f.map.get(STORAGE_KEY),raw);
  }finally{u.restore();}
});

test('verification save failure retains report and never automatically retries on page events',async()=>{
  const f=await data(),r=readback(f),u=ui(f,r);try{
    await u.app.receiveLocation();let checks=walk(u.root).filter(n=>n.tag==='input'&&n.type==='checkbox');checks[0].checked=true;checks[0].onchange();checks=walk(u.root).filter(n=>n.tag==='input'&&n.type==='checkbox');checks[1].checked=true;checks[1].onchange();
    let attempts=0;f.hooks.write=()=>{attempts++;throw Error('denied');};await button(u.root,'結果JSONを検証して保存').onclick();assert.equal(u.cleared.length,0);assert.equal(rec(f).pending.status,'unknown');
    await u.app.receiveLocation();u.app.changed();assert.equal(attempts,1);assert.ok(u.location.hash.startsWith(RESULT_PREFIX));
  }finally{u.restore();}
});
