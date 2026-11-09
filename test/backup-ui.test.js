import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackupUI} from '../src/backup-ui.js';
import {ScheduleStore,META_KEY} from '../src/storage.js';
import {createBackup} from '../src/backup.js';
import {STORAGE_KEY,seed,serializeState} from '../src/model.js';
class TextNode{nodeType=3;constructor(value){this.textContent=value;}}
class Element{
  nodeType=1;children=[];listeners=new Map();disabled=false;checked=false;open=false;
  constructor(tag){this.tag=tag;}
  setAttribute(key,value){this[key]=value;}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  addEventListener(type,callback){this.listeners.set(type,callback);}
  showModal(){this.open=true;}
  close(){this.open=false;this.listeners.get('close')?.();}
  remove(){}
  click(){if(!this.disabled)return this.onclick?.();}
  get textContent(){return this.children.map(child=>child.textContent).join('');}
  set innerHTML(value){throw Error('HTML parsing forbidden');}
}
function walk(node){return [node,...(node.children||[]).flatMap(walk)];}
function button(root,label){const matches=walk(root).filter(n=>n.tag==='button'&&n.textContent===label);assert.equal(matches.length,1,'unique action '+label);return matches[0];}
function input(root,id){return walk(root).find(n=>n.id===id);}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function environment(raw=serializeState(seed('2026-11-09'))){
  const oldDocument=globalThis.document,shareDescriptor=Object.getOwnPropertyDescriptor(navigator,'share'),canDescriptor=Object.getOwnPropertyDescriptor(navigator,'canShare');
  const root=new Element('body');globalThis.document={body:root,createElement:tag=>new Element(tag),createTextNode:value=>new TextNode(value)};
  const data=new Map([[STORAGE_KEY,raw]]),storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
  const locks={request:async(name,options,action)=>action()};
  const store=new ScheduleStore({storage,locks,now:()=>new Date('2026-11-09T03:00:00Z')});await store.refresh();
  const ui=createBackupUI({store,onChange(){},notify(){}});ui.open();
  return {root,store,data,ui,restore(){globalThis.document=oldDocument;for(const [key,descriptor]of [['share',shareDescriptor],['canShare',canDescriptor]]){if(descriptor)Object.defineProperty(navigator,key,descriptor);else delete navigator[key];}},setShare(can,share){Object.defineProperty(navigator,'canShare',{value:can,configurable:true});Object.defineProperty(navigator,'share',{value:share,configurable:true});},async choose(file){const chooser=input(root,'backup-file');chooser.files=[file];chooser.onchange();for(let i=0;i<10;i++)await settle();}};
}
test('backup UI remains accessible with corrupt or unreadable data and refuses implicit restore',async()=>{
  for(const raw of ['{broken',serializeState(seed('2026-11-09'))]){
    const env=await environment(raw);
    try{
      const file=await createBackup(seed('2026-11-09'));await env.choose(file.file);
      const action=button(env.root,raw==='{broken'?'このバックアップで復旧する':'現在データを置き換える');assert.equal(action.disabled,true);assert.equal(env.data.get(STORAGE_KEY),raw);
      assert.ok(env.root.textContent.includes('全完了履歴'));assert.ok(env.root.textContent.includes('マージはしません'));
    }finally{env.restore();}
  }
});
test('emergency UI requires both destructive approval and saved-or-skipped quarantine acknowledgment',async()=>{
  const env=await environment('{broken');
  try{
    await env.choose((await createBackup(seed('2026-11-09'))).file);
    const action=button(env.root,'このバックアップで復旧する'),ack=input(env.root,'replace-ack'),loss=input(env.root,'loss-ack'),skip=input(env.root,'skip-ack');
    ack.checked=true;ack.onchange();assert.equal(action.disabled,true);
    loss.checked=true;loss.onchange();assert.equal(action.disabled,true);
    skip.checked=true;skip.onchange();assert.equal(action.disabled,false);
    await action.click();assert.equal(env.store.status,'ready');assert.equal(env.store.state.items.length,6);
  }finally{env.restore();}
});
test('cancel and invalid replacement files do not change the original or retain an actionable old preview',async()=>{
  const env=await environment('{broken');
  try{
    await env.choose((await createBackup(seed('2026-11-09'))).file);await button(env.root,'復元をキャンセル').click();assert.equal(env.data.get(STORAGE_KEY),'{broken');
    await env.choose(new File(['broken'],'invalid.json'));assert.equal(walk(env.root).filter(n=>n.tag==='button'&&n.textContent==='このバックアップで復旧する').length,0);assert.equal(env.data.get(STORAGE_KEY),'{broken');
  }finally{env.restore();}
});
test('validated file can be inspected while storage is unreadable but cannot be written',async()=>{
  const env=await environment('{broken');
  try{
    env.store.storage.getItem=()=>{throw Error('read denied');};await env.store.refresh();env.ui.changed();
    await env.choose((await createBackup(seed('2026-11-09'))).file);
    assert.ok(env.root.textContent.includes('JSONの検証に成功'));assert.ok(env.root.textContent.includes('検証済みファイル'));assert.equal(env.data.get(STORAGE_KEY),'{broken');
  }finally{env.restore();}
});
test('sharing uses the exact prepared file, supports post-canShare errors, and never confirms automatically',async()=>{
  const env=await environment();let received;
  try{
    env.setShare(()=>true,async({files})=>{received=files[0];throw Object.assign(Error('cancel'),{name:'AbortError'});});env.ui.changed();
    await button(env.root,'保存済みデータのJSONを準備').click();
    await button(env.root,'共有して「ファイル」に保存').click();await settle();
    assert.ok(received instanceof File);assert.equal(env.data.get(META_KEY),undefined);assert.ok(env.root.textContent.includes('共有を中断'));
    assert.equal(button(env.root,'ダウンロードで保存').disabled,false);
    env.setShare(()=>true,async()=>{throw Error('share failed');});env.ui.changed();await button(env.root,'共有して「ファイル」に保存').click();await settle();
    assert.ok(env.root.textContent.includes('共有できませんでした'));assert.equal(env.data.get(META_KEY),undefined);
  }finally{env.restore();}
});
test('download remains available when file sharing is unsupported and only explicit receipt records backup',async()=>{
  const env=await environment();
  try{
    env.setShare(()=>false,undefined);await button(env.root,'保存済みデータのJSONを準備').click();
    assert.equal(button(env.root,'共有して「ファイル」に保存').disabled,true);assert.equal(button(env.root,'ダウンロードで保存').disabled,false);assert.equal(env.data.get(META_KEY),undefined);
    await button(env.root,'このJSONファイルを保存できました').click();assert.ok(JSON.parse(env.data.get(META_KEY)).confirmed);
  }finally{env.restore();}
});
test('hostile filenames and task titles render as text without HTML parsing',async()=>{
  const env=await environment('{broken');
  try{
    const data=seed('2026-11-09');data.items[2].title='<svg onload=alert(1)>';data.items[2].repeat='daily';data.items[2].due='2100-12-30';data.items[2].excluded=['2100-12-30','2100-12-31'];
    env.store.now=()=>new Date('2100-12-31T03:00:00Z');await env.choose((await createBackup(data)).file);
    assert.ok(env.root.textContent.includes(data.items[2].title));assert.equal(walk(env.root).some(n=>n.tag==='svg'),false);
  }finally{env.restore();}
});

test('download initiation uses the prepared blob and never records a save confirmation',async()=>{
  const env=await environment(),oldTimeout=globalThis.setTimeout;let downloaded=false,received;
  const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
  try{
    await button(env.root,'保存済みデータのJSONを準備').click();
    URL.createObjectURL=file=>{received=file;return 'blob:test-owned';};URL.revokeObjectURL=()=>{};
    const originalCreate=document.createElement;document.createElement=tag=>{const element=originalCreate(tag);if(tag==='a')element.click=()=>{downloaded=true;};return element;};
    globalThis.setTimeout=()=>({unref(){}});
    button(env.root,'ダウンロードで保存').click();assert.equal(downloaded,true);assert.ok(received instanceof File);assert.equal(env.data.get(META_KEY),undefined);
    assert.ok(env.root.textContent.includes('ダウンロードを開始しました'));
  }finally{URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;globalThis.setTimeout=oldTimeout;env.restore();}
});

test('backup-confirmation failure is shown without a success message',async()=>{
  const env=await environment();
  try{
    await button(env.root,'保存済みデータのJSONを準備').click();const set=env.store.storage.setItem;
    env.store.storage.setItem=(key,value)=>{if(key===META_KEY)throw Error('storage denied');return set(key,value);};
    await button(env.root,'このJSONファイルを保存できました').click();assert.ok(env.root.textContent.includes('記録できませんでした'));assert.equal(env.data.get(META_KEY),undefined);
  }finally{env.restore();}
});

test('unverified recovery survives UI refresh, JSON preparation and reopening while retaining original quarantine',async()=>{
  const original='broken\ud800',env=await environment(original);
  try{
    await env.choose((await createBackup(seed('2026-11-09'))).file);
    const get=env.store.storage.getItem,set=env.store.storage.setItem;let readFails=false,writes=0;
    env.store.storage.setItem=(key,value)=>{set(key,value);if(key===STORAGE_KEY){writes++;readFails=true;}};
    env.store.storage.getItem=key=>{if(key===STORAGE_KEY&&readFails)throw Error('readback failed');return get(key);};
    for(const id of ['replace-ack','loss-ack','skip-ack']){input(env.root,id).checked=true;input(env.root,id).onchange();}
    await button(env.root,'このバックアップで復旧する').click();assert.equal(env.store.status,'unverified');assert.equal(writes,1);
    assert.ok(env.root.textContent.includes('成否は不確定'));assert.ok(!env.root.textContent.includes('書き込みは完了しました'));
    readFails=false;await env.store.refresh();env.ui.changed();
    await button(env.root,'保存済みデータのJSONを準備').click();assert.equal(env.store.status,'unverified');assert.equal(writes,1);
    assert.equal(env.store.retainedQuarantine().raw,original);assert.ok(env.root.textContent.includes('メモリーだけ'));assert.ok(env.root.textContent.includes('再読み込み'));
    await button(env.root,'過去の保持対象を退避（'+env.store.retainedQuarantineInfo()[0].id+'）').click();assert.equal(env.store.retainedQuarantine().raw,original);
    button(env.root,'閉じる').click();env.ui.open();assert.equal(env.store.status,'unverified');assert.ok(env.root.textContent.includes('保護停止中'));
    assert.equal((await env.store.mutate(d=>{d.items=[];})).ok,false);assert.equal(writes,1);
  }finally{env.restore();}
});

test('verified A recovery followed by B prepares the actual B file in the current-data UI',async()=>{
  const env=await environment('corrupt-A'),oldURL=URL.createObjectURL;let captured;
  try{
    const source={data:seed('2026-11-09'),exportedAt:'2026-11-09T03:00:00.000Z'};
    assert.equal((await env.store.restore(env.store.preview(source),{replace:true,emergency:true,quarantine:'skip'})).ok,true);
    env.data.set(STORAGE_KEY,'corrupt-B');await env.store.refresh();env.ui.changed();
    await button(env.root,'現在の破損データの退避ファイルを準備').click();
    URL.createObjectURL=file=>{captured=file;return 'blob:unit-current';};button(env.root,'ダウンロードで保存').click();
    const bytes=new Uint8Array(await captured.arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=2)text+=String.fromCharCode(bytes[i]|bytes[i+1]<<8);
    assert.equal(text,'corrupt-B');assert.ok(captured.name.includes('current'));assert.equal(env.store.retainedQuarantineInfo().length,0);
  }finally{URL.createObjectURL=oldURL;env.restore();}
});

test('storage changes after preparation block the old file download and relabel it as past',async()=>{
  const env=await environment('corrupt-A'),oldURL=URL.createObjectURL;let downloaded=false;
  try{
    await button(env.root,'現在の破損データの退避ファイルを準備').click();env.data.set(STORAGE_KEY,'corrupt-B');
    URL.createObjectURL=()=>{downloaded=true;return 'blob:unit-stale';};button(env.root,'ダウンロードで保存').click();
    assert.equal(downloaded,false);assert.ok(env.root.textContent.includes('現在ではありません'));assert.ok(env.root.textContent.includes('準備後に保存先が変わりました'));
  }finally{URL.createObjectURL=oldURL;env.restore();}
});

test('failed A recovery followed by B exposes distinct current and historical actions',async()=>{
  const env=await environment('corrupt-A');
  try{
    const set=env.store.storage.setItem;env.store.storage.setItem=(key,value)=>{if(key===STORAGE_KEY)throw Error('write failed');return set(key,value);};
    const source={data:seed('2026-11-09'),exportedAt:'2026-11-09T03:00:00.000Z'};
    await env.store.restore(env.store.preview(source),{replace:true,emergency:true,quarantine:'skip'});
    env.data.set(STORAGE_KEY,'corrupt-B');await env.store.refresh();env.ui.changed();
    assert.ok(env.root.textContent.includes('過去の保持対象（現在データとは別）'));
    await button(env.root,'現在の破損データの退避ファイルを準備').click();assert.equal(env.store.quarantine().raw,'corrupt-B');
    const id=env.store.retainedQuarantineInfo()[0].id;await button(env.root,`過去の保持対象を退避（${id}）`).click();
    assert.ok(env.root.textContent.includes('現在の破損データではありません'));assert.ok(env.root.textContent.includes('保存先とは異なります'));
  }finally{env.restore();}
});
