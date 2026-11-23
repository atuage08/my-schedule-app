import {V3_READY,v3URL} from '../src/notification-v3.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {TEST_ORIGIN,savedEventURL,eligibleEvent} from '../src/shortcut-test.js';
import {STORAGE_KEY,stamp} from '../src/model.js';

const now=new Date('2026-11-17T03:00:00.000Z');
function fixture(){
  const item={id:'saved-event-001',type:'event',title:'架空の予定 <>& 日本語',start:'2026-11-18T12:00',end:'2026-11-18T13:00',allDay:false,repeat:'none',excluded:[],notification:{enabled:true,notifyAt:'2026-11-17T04:00:00.000Z'}};
  const state={version:2,items:[item],history:[]},raw=JSON.stringify(state),base={raw,revision:1};let writes=0;
  const store={writable:true,protection:null,state,matches:b=>b===base,storage:{getItem:key=>{assert.equal(key,STORAGE_KEY);return raw;},setItem(){writes++;throw Error('No writes allowed');}}};
  return {origin:TEST_ORIGIN,store,base,item,notifyLocal:stamp(new Date(now.getTime()+3600000)),confirmed:true,now,get writes(){return writes;}};
}
test('saved event supplies existing ID and saved title; repeated launches retain item ID only',()=>{
  const f=fixture(),first=JSON.parse(new URL(savedEventURL(f)).searchParams.get('text')),second=JSON.parse(new URL(savedEventURL(f)).searchParams.get('text'));
  assert.equal(first.itemId,f.item.id);assert.equal(first.title,f.item.title);assert.equal(first.notifyAt,'2026-11-17T04:00:00.000Z');
  assert.equal(first.itemId,second.itemId);assert.notEqual(first.operationId,second.operationId);assert.equal(f.writes,0);
});
test('tasks, recurrence parents and detached exceptions are excluded',()=>{
  for(const item of [null,{...fixture().item,type:'task'},{...fixture().item,repeat:'daily'},{...fixture().item,eventSeriesId:'parent'},{...fixture().item,exceptionDate:'2026-11-17'}]){
    assert.equal(eligibleEvent(item),false);const f=fixture();f.item=item;assert.throws(()=>savedEventURL(f));
  }
});
test('origin, explicit consent, save failure flag and protection stop prevent transport',()=>{
  for(const change of [{origin:'https://example.invalid'},{confirmed:false},{blocked:true}])assert.throws(()=>savedEventURL(Object.assign(fixture(),change)));
  for(const change of [{writable:false},{protection:{kind:'save-unverified'}},{matches:()=>false}]){
    const f=fixture();Object.assign(f.store,change);assert.throws(()=>savedEventURL(f));assert.equal(f.writes,0);
  }
});
test('external changes, missing storage, unreadable storage and deleted or changed items refuse transport',()=>{
  for(const getItem of [()=>null,()=>'{changed}',()=>{throw Error('denied');}]){const f=fixture();f.store.storage.getItem=getItem;assert.throws(()=>savedEventURL(f));}
  for(const items of [[],[{...fixture().item,title:'changed'}]]){const f=fixture();f.store.state.items=items;assert.throws(()=>savedEventURL(f));}
});
test('empty or invalid IDs and titles are rejected',()=>{
  for(const changes of [{id:''},{id:'bad&query'},{title:''},{title:'bad\ntext'}]){
    const f=fixture();Object.assign(f.item,changes);assert.throws(()=>savedEventURL(f));
  }
});
test('saved notification must be enabled, valid and future; local input cannot override it',()=>{
  for(const notification of [undefined,{enabled:false,notifyAt:null},{enabled:true,notifyAt:'bad'},{enabled:true,notifyAt:now.toISOString()}]){const f=fixture();if(notification===undefined)delete f.item.notification;else f.item.notification=notification;assert.throws(()=>savedEventURL(f));}
  const f=fixture();const data=JSON.parse(new URL(savedEventURL({...f,notifyLocal:'2099-01-01T12:00'})).searchParams.get('text'));assert.equal(data.notifyAt,f.item.notification.notifyAt);
});
const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
const handler=source.slice(source.indexOf("    if($('#event-shortcut'))"),source.indexOf('    const scope=()=>'));
function click({dirty=false,blocked=false,origin=TEST_ORIGIN}={}){
  const f=fixture(),button={},status={textContent:''},nodes={'#event-shortcut':button,'#event-shortcut-status':status,'#event-notify-at':{value:f.notifyLocal},'#event-notify-confirm':{checked:true}},navigations=[];
  runInNewContext(handler,{ V3_READY,v3URL,$:key=>nodes[key],capture(){},data:dirty?{...f.item,title:'unsaved'}:f.item,original:f.item,savedEventURL:args=>savedEventURL({...args,now}),window:{location:{origin,set href(value){navigations.push(value);}}},store:f.store,entryBase:f.base,processing:false,storageBlocked:false,lastMutationFailed:blocked});
  assert.equal(navigations.length,0);button.onclick();return {navigations,status};
}
test('actual edit-panel click refuses unverified v3 transport',()=>{
  const result=click();assert.equal(result.navigations.length,0);assert.match(result.status.textContent,/開始できません/);
});
test('actual click refuses unsaved edits, failed saves and other origins',()=>{
  for(const options of [{dirty:true},{blocked:true},{origin:'https://example.invalid'}]){const result=click(options);assert.equal(result.navigations.length,0);assert.match(result.status.textContent,/開始できません/);}
});
