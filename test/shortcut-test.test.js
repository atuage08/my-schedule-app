import * as features from '../src/features.js';
import {TEST_ORIGIN,SHORTCUT_NAME,TEST_ITEM_ID,createTestPayload,shortcutURL} from '../src/shortcut-test.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createDom} from '../src/dom.js';
import {taskRecurrences} from '../src/model.js';

// Exercise the actual rendering and bound click handler without booting the
// app, reading browser storage, or navigating to a real custom protocol.
const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
const rendering=source.slice(source.indexOf('function render(){'),source.indexOf('function openEditor('));
class Element{
  nodeType=1;children=[];attributes=new Map();
  setAttribute(name,value){this.attributes.set(name,value);}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  get textContent(){return this.children.map(node=>node.textContent).join('');}
}
function setup(origin){
  const app=new Element();app.setAttribute('id','app');const navigations=[];
  const walk=node=>[node,...(node.children||[]).flatMap(walk)];
  const matches=(node,selector)=>selector.startsWith('#')?node.attributes?.get('id')===selector.slice(1):/^\[([\w-]+)\]$/.test(selector)&&node.attributes?.has(selector.slice(1,-1));
  const document={
    createElement:()=>new Element(),createTextNode:text=>({nodeType:3,textContent:text}),
    querySelectorAll:selectors=>walk(app).filter(node=>selectors.split(',').some(selector=>matches(node,selector))),
  };
  const $=selector=>document.querySelectorAll(selector)[0],{h,replace}=createDom(document);
  const location={origin,set href(value){navigations.push(value);}};
  const forbidden=new Proxy({},{get(){throw Error('Sensitive API must not be accessed');}});
  runInNewContext(rendering+'\nrender();',{
    ...features,hasResultFragment:()=>false,removalPanel:()=>null,TEST_ORIGIN,createTestPayload,shortcutURL,notify(){throw Error('Unexpected transport error');},document,window:{location},h,replace,$,state:{items:[],history:[]},view:'home',selected:'2026-11-14',home:()=>[],
    textButton:(text,attributes={})=>h('button',attributes,text),dateKey:()=> '2026-11-14',taskRecurrences,
    upgrade:{required:false},lastSaveWarning:'',reminderKind:'none',reminderDismissed:false,storageBlocked:false,processing:false,
    backupUI:{open(){}},localStorage:forbidden,navigator:forbidden,
    setTimeout(){throw Error('No automatic timer allowed');},setInterval(){throw Error('No automatic interval allowed');},
  });
  return {button:$('#shortcut-test'),text:app.textContent,navigations,location};
}
test('exact test origin displays the button and explanation without auto-launch or sensitive reads',()=>{
  const page=setup('https://my-schedule-test.pages.dev');
  assert.equal(page.button.textContent,'ショートカット連携テスト');
  assert.ok(page.text.includes('架空の予定をJSONで渡します。通知日時は操作時から約10分後です。通知連携の成功は未確認です。'));
  assert.deepEqual(page.navigations,[]);
});
test('production, local, preview, insecure, suffix and non-default-port origins do not show the test UI',()=>{
  for(const origin of ['https://my-schedule.pages.dev','http://127.0.0.1:4173','https://preview.my-schedule-test.pages.dev','http://my-schedule-test.pages.dev','https://my-schedule-test.pages.dev.example.invalid','https://my-schedule-test.pages.dev:8443','null']){
    const page=setup(origin);assert.equal(page.button,undefined);assert.equal(page.text.includes('固定文字列 TEST-123'),false);assert.deepEqual(page.navigations,[]);
  }
});
test('one manual click sends only validated fictional JSON to the encoded shortcut name',()=>{
  const page=setup('https://my-schedule-test.pages.dev');page.button.onclick();
  assert.equal(page.navigations.length,1);
  const url=new URL(page.navigations[0]);assert.equal(url.protocol,'shortcuts:');assert.equal(url.hostname,'run-shortcut');
  assert.deepEqual([...url.searchParams.keys()],['name','input','text']);
  assert.equal(url.searchParams.get('name'),SHORTCUT_NAME);assert.equal(url.searchParams.get('input'),'text');
  const payload=JSON.parse(url.searchParams.get('text'));assert.equal(payload.itemId,TEST_ITEM_ID);assert.equal(payload.title,'架空の予定：通知連携テスト');assert.equal(payload.operation,'upsert');
  assert.equal(page.navigations[0],shortcutURL(payload));
});
test('click handler rechecks the origin even after the button was rendered',()=>{
  const page=setup('https://my-schedule-test.pages.dev');page.location.origin='https://my-schedule.pages.dev';page.button.onclick();assert.deepEqual(page.navigations,[]);
});
