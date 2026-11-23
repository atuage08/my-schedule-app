import * as features from '../src/features.js';
import * as v3 from '../src/notification-v3.js';
// Execute the actual editor with a small DOM adapter and the real persistence
// implementation. No browser profile, user storage or custom-scheme navigation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createDom} from '../src/dom.js';
import * as model from '../src/model.js';
import * as shortcut from '../src/shortcut-test.js';
import {ScheduleStore} from '../src/storage.js';
const now=new Date('2026-11-17T03:00:00.000Z');
const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
const editorSource=source.slice(source.indexOf('function openEditor('),source.indexOf("$('#editor').addEventListener"));
class Element{
  nodeType=1;children=[];attributes=new Map();disabled=false;checked=false;
  constructor(tag){this.tag=tag;}
  setAttribute(name,value){this.attributes.set(name,value);}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  get type(){return this.attributes.get('type');}
  get name(){return this.attributes.get('name');}
  get textContent(){return this.children.map(child=>child.textContent).join('');}
  set textContent(text){this.children=[{nodeType:3,textContent:text}];}
  get value(){return this._value??(this.tag==='select'?this.children.find(node=>node.selected)?.value??this.children[0]?.value:'');}
  set value(value){this._value=value;}
  get elements(){return Object.fromEntries(walk(this).filter(node=>node.name).map(node=>[node.name,node]));}
  showModal(){this.open=true;}
  close(){this.open=false;}
}
const walk=node=>[node,...(node.children||[]).flatMap(walk)];
async function setup({origin=shortcut.TEST_ORIGIN,existing=false,fail=false,enabled=false,task=null,day=null}={}){
  const clock=day===null?now:model.localDate(day);
  const initialState=model.seed('2026-11-18');if(enabled){initialState.version=2;initialState.items[0].notification={enabled:true,notifyAt:'2026-11-18T03:00:00.000Z'};}
  if(task)initialState.items=[task];
  const map=new Map([[model.STORAGE_KEY,model.serializeState(initialState)]]);
  const storage={getItem:key=>map.get(key)??null,setItem(key,value){if(fail&&key===model.STORAGE_KEY)throw Error('denied');map.set(key,value);}};
  const locks={request:async(name,options,action)=>action()};
  const store=new ScheduleStore({storage,locks,now:()=>clock});await store.refresh();
  const editor=new Element('dialog');editor.setAttribute('id','editor');const messages=[],navigations=[];
  const query=selector=>selector.startsWith('#')?walk(editor).filter(node=>node.attributes?.get('id')===selector.slice(1)):walk(editor).filter(node=>node.attributes?.has(selector.slice(1,-1)));
  const document={createElement:tag=>new Element(tag),createTextNode:text=>({nodeType:3,textContent:String(text)}),querySelectorAll:query};
  const {h,replace}=createDom(document),$=selector=>query(selector)[0];
  class FormData{
    constructor(form){this.form=form;}
    get(name){const node=this.form.elements[name];return node?.disabled?null:node?.value??null;}
  }
  const context={...features,...model,...shortcut,...v3,document,h,replace,$,FormData,Date,structuredClone,store,state:store.state,selected:'2026-11-18',processing:false,storageBlocked:false,lastMutationFailed:false,
    window:{location:{origin,set href(value){navigations.push(value);}}},
    hint:text=>h('p',{},text),textButton:(text,attributes={})=>h('button',attributes,text),enhanceTimeFields:()=>({precise:false,refresh(){},setPrecise(){}}),enhanceDateFields:()=>({refresh(){}}),
    defaults:selected=>model.defaults(selected,now),notify:text=>messages.push(text),render(){},confirmDeletion:async()=>false,
    rollTasks:draft=>model.rollTasks(draft,model.dateKey(clock)),
    taskRecurrences:data=>model.taskRecurrences(data,model.dateKey(clock)),
    notificationFromLocal:(enabled,value,previous)=>{const result=model.notificationFromLocal(enabled,value,previous,now);assert.equal(result.notifyAt,enabled?new Date(value).toISOString():null);return result;},savedEventURL:args=>shortcut.savedEventURL({...args,now}),
    mutate:async(action,base)=>{const result=await store.mutate(action,base,{queueRemovals:origin===shortcut.TEST_ORIGIN,notificationV3:origin===shortcut.TEST_ORIGIN});context.lastMutationFailed=!result.ok;context.state=store.state;return result.ok;},
  };
  runInNewContext(editorSource+'\nopenEditor(initial);',Object.assign(context,{initial:existing?store.state.items[0]:null}));
  return {store,map,editor,$,messages,navigations,
    async submit(){await $('#entry-form').onsubmit({preventDefault(){}});},
    async reload(day){
      const reopened=new ScheduleStore({storage,locks,now:()=>model.localDate(day)});
      await reopened.initialize();
      assert.equal((await reopened.rollover()).ok,true);
      return reopened;
    },
  };
}

const repeatingTask=changes=>({
  id:'recurring-task',seriesId:'recurring-series',type:'task',title:'架空の繰り返しタスク',
  due:'2026-11-23',repeat:'monthly',anchorDay:23,anchorMonth:9,excluded:[],pinned:false,...changes,
});

test('editing all monthly occurrences to yearly uses the displayed due month',async()=>{
  const task=repeatingTask();
  const f=await setup({task,day:task.due,existing:true,origin:'https://example.invalid'});
  const form=f.$('#entry-form');
  form.elements.scope.value='all';
  form.elements.repeat.value='yearly';
  await f.submit();
  assert.equal(f.editor.open,false);
  const saved=f.store.state.items[0];
  assert.equal(saved.anchorMonth,11);
  assert.equal(saved.due,task.due);
  assert.equal(saved.id,task.id);
  assert.equal(saved.seriesId,task.seriesId);
  const reopened=await f.reload(task.due);
  assert.deepEqual(reopened.state.items,[saved]);
  assert.equal((await reopened.mutate(draft=>model.complete(draft,task.id,model.localDate(task.due)))).ok,true);
  assert.equal(reopened.state.items[0].due,'2027-11-23');
  const completion=reopened.state.history[0];
  assert.equal(completion.due,task.due);
  assert.equal(completion.seriesId,task.seriesId);
  assert.equal((await reopened.mutate(draft=>model.restore(draft,completion.id,model.localDate(task.due)))).ok,true);
  assert.equal(reopened.state.items[0].due,'2027-11-23');
  assert.ok(reopened.state.history[0].restoredAt);
});

for(const [from,to,next] of [
  ['daily','weekly','2026-11-30'],
  ['weekly','biweekly','2026-12-07'],
  ['biweekly','daily','2026-11-24'],
  ['weekly','monthly','2026-12-23'],
  ['daily','yearly','2027-11-23'],
])test('editing all from '+from+' to '+to+' resets both anchors',async()=>{
  const original=repeatingTask({repeat:from,anchorDay:31,anchorMonth:9});
  const f=await setup({task:original,day:original.due,existing:true,origin:'https://example.invalid'});
  const form=f.$('#entry-form');
  form.elements.scope.value='all';form.elements.repeat.value=to;
  await f.submit();
  const [task]=(await f.reload(original.due)).state.items;
  assert.equal(task.due,original.due);
  assert.equal(task.repeat,to);
  assert.deepEqual([task.anchorDay,task.anchorMonth],[23,11]);
  assert.equal(model.nextDate(task.due,task.repeat,task.anchorDay,task.anchorMonth),next);
});

for(const entry of [
  {label:'yearly to monthly after leap-day clipping',repeat:'yearly',day:29,month:2,edit:{repeat:'monthly'},expected:[28,2,'2027-02-28','2027-03-28']},
  {label:'a new due date within a monthly series',repeat:'monthly',day:31,month:1,edit:{due:'2027-03-05'},expected:[5,3,'2027-03-05','2027-04-05']},
  {label:'a title edit on a clipped monthly series',repeat:'monthly',day:31,month:1,edit:{title:'架空の名称変更'},expected:[31,1,'2027-02-28','2027-03-31']},
  {label:'a title edit on a clipped yearly series',repeat:'yearly',day:29,month:2,edit:{title:'架空の名称変更'},expected:[29,2,'2027-02-28','2028-02-29']},
])test(entry.label,async()=>{
  const original=repeatingTask({due:'2027-02-28',repeat:entry.repeat,anchorDay:entry.day,anchorMonth:entry.month});
  const f=await setup({task:original,day:original.due,existing:true,origin:'https://example.invalid'});
  const form=f.$('#entry-form');
  form.elements.scope.value='all';
  for(const [name,value] of Object.entries(entry.edit))form.elements[name].value=value;
  await f.submit();
  assert.equal(f.editor.open,false);
  const [task]=(await f.reload(original.due)).state.items;
  const next=model.nextDate(task.due,task.repeat,task.anchorDay,task.anchorMonth);
  assert.deepEqual([task.anchorDay,task.anchorMonth,task.due,next],entry.expected);
  assert.equal(task.title,entry.edit.title??original.title);
  assert.equal(task.seriesId,original.seriesId);
});

test('editing only this occurrence does not reanchor the original series',async()=>{
  const original=repeatingTask({due:'2027-02-28',anchorDay:31,anchorMonth:1});
  const f=await setup({task:original,day:original.due,existing:true,origin:'https://example.invalid'});
  const form=f.$('#entry-form');
  form.elements.scope.value='one';form.elements.repeat.value='yearly';form.elements.title.value='架空の今回だけ';
  await f.submit();
  assert.equal(f.editor.open,false);
  const {items,history}=(await f.reload(original.due)).state;
  const series=items.find(item=>item.id===original.id);
  const detached=items.find(item=>item.id!==original.id);
  assert.deepEqual(series,{...original,due:'2027-03-31'});
  assert.equal(detached.repeat,'none');
  assert.equal(detached.seriesId,undefined);
  assert.equal(detached.due,original.due);
  assert.equal(detached.title,'架空の今回だけ');
  assert.deepEqual(history,[]);
});
test('new-event editor saves v3, reopens settings and keeps unverified transport disabled',async()=>{
  const f=await setup();const form=f.$('#entry-form');form.elements.title.value='架空：保存通知';
  assert.equal(f.$('#event-notify-enabled').checked,false);assert.equal(f.$('#event-notify-at').disabled,true);
  f.$('#event-notify-enabled').checked=true;f.$('#event-notify-enabled').onchange();assert.equal(f.$('#event-notify-at').disabled,false);
  await f.submit();assert.equal(f.store.state.version,3);assert.equal(f.navigations.length,0);
  assert.equal(f.$('#event-notify-enabled').checked,true);assert.equal(f.$('#event-notify-at').value,'2026-11-18T12:00');
  const id=f.store.state.items.at(-1).id;assert.equal(f.$('#event-shortcut').disabled,true);
  f.$('#event-shortcut').onclick();assert.equal(f.navigations.length,0);
  f.$('#event-notify-confirm').checked=true;f.$('#event-shortcut').onclick();assert.equal(f.navigations.length,0);
  assert.equal(f.store.state.notificationLink.records.find(record=>record.itemId===id).desired.enabled,true);
});
test('existing event can enable and change a notification without changing its ID',async()=>{
  const f=await setup({existing:true}),id=f.store.state.items[0].id;
  f.$('#event-notify-enabled').checked=true;f.$('#event-notify-enabled').onchange();await f.submit();
  f.$('#event-notify-at').value='2026-11-18T15:00';await f.submit();
  assert.equal(f.store.state.items.filter(item=>item.id===id).length,1);assert.equal(model.stamp(new Date(f.store.state.items.find(item=>item.id===id).notification.notifyAt)),'2026-11-18T15:00');assert.equal(f.navigations.length,0);
});
test('turning off saves off/null and does not launch a removal or a shortcut',async()=>{
  const f=await setup({existing:true});f.$('#event-notify-enabled').checked=true;await f.submit();
  f.$('#event-notify-enabled').checked=false;f.$('#event-notify-enabled').onchange();await f.submit();
  assert.deepEqual(f.store.state.items.find(item=>item.id==='sample-event-1').notification,{enabled:false,notifyAt:null});assert.equal(f.navigations.length,0);
});
test('save failure and invalid notification time do not migrate storage or launch',async()=>{
  for(const fail of [false,true]){
    const f=await setup({existing:true,fail}),raw=f.map.get(model.STORAGE_KEY);f.$('#event-notify-enabled').checked=true;
    if(!fail)f.$('#event-notify-at').value='';await f.submit();assert.equal(f.map.get(model.STORAGE_KEY),raw);assert.equal(f.navigations.length,0);
    f.$('#event-notify-confirm').checked=true;f.$('#event-shortcut').onclick();assert.equal(f.navigations.length,0);
  }
});
test('old data stays v1 on an ordinary no-notification edit, and other origins hide settings',async()=>{
  const f=await setup({existing:true});f.$('#entry-form').elements.title.value='架空変更';await f.submit();assert.equal(f.store.state.version,1);assert.equal(f.store.state.items.find(item=>item.id==='sample-event-1').title,'架空変更');
  const production=await setup({origin:'https://example.invalid',existing:true});assert.equal(production.$('#event-notify-enabled'),undefined);assert.equal(production.$('#event-shortcut'),undefined);
});

test('failed edit of an enabled notification cannot launch even after reverting the unsaved title',async()=>{
  const f=await setup({existing:true,fail:true,enabled:true}),raw=f.map.get(model.STORAGE_KEY);
  f.$('#entry-form').elements.title.value='失敗する変更';await f.submit();assert.equal(f.map.get(model.STORAGE_KEY),raw);
  f.$('#entry-form').elements.title.value='週末のプランを考える';f.$('#event-notify-confirm').checked=true;f.$('#event-shortcut').onclick();assert.equal(f.navigations.length,0);
});
test('editing v2 data outside test origin preserves notification settings without exposing launch UI',async()=>{
  const f=await setup({existing:true,enabled:true,origin:'https://example.invalid'});assert.equal(f.$('#event-notify-enabled'),undefined);
  f.$('#entry-form').elements.title.value='架空変更';await f.submit();
  assert.equal(f.store.state.version,2);assert.deepEqual(f.store.state.items.find(item=>item.id==='sample-event-1').notification,{enabled:true,notifyAt:'2026-11-18T03:00:00.000Z'});assert.equal(f.navigations.length,0);
});
