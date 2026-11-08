import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDom} from '../src/dom.js';

class Text {
  nodeType=3;
  constructor(text){this.textContent=text;}
}
class Element {
  nodeType=1;children=[];attributes=new Map();
  constructor(tag){this.tag=tag;}
  setAttribute(name,value){this.attributes.set(name,value);}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];}
  get textContent(){return this.children.map(child=>child.textContent).join('');}
  set innerHTML(value){throw Error('HTML parsing is forbidden');}
}
const document={createElement:tag=>new Element(tag),createTextNode:text=>new Text(text)};
const payloads=['<img src=x onerror="alert(1)">','</input><svg onload="alert(1)">','&lt;script&gt;alert(1)&lt;/script&gt;','" autofocus onfocus="alert(1)" x="',"<script>alert('x')</script>",'日本語 & < > " \' 改行\n文字','javascript:alert(1)'];

for(const payload of payloads)test('DOM creation treats attack/special text literally: '+payload.slice(0,25),()=>{
  const {h,replace}=createDom(document);
  const field=h('input',{type:'text',value:payload,'aria-label':payload,'data-edit':payload});
  const display=h('div',{},h('strong',{},payload));
  assert.equal(field.value,payload);assert.equal(field.attributes.get('aria-label'),payload);assert.equal(field.attributes.get('data-edit'),payload);
  assert.equal(display.textContent,payload);assert.equal(display.children[0].children[0].nodeType,3);
  replace(display,h('p',{},payload));assert.equal(display.textContent,payload);
  assert.equal(display.children.length,1);assert.equal(display.children[0].tag,'p');
});
test('DOM helper rejects executable tags, URL attributes and string event handlers',()=>{
  const {h}=createDom(document);
  for(const tag of ['script','img','svg','iframe','object','style'])assert.throws(()=>h(tag));
  for(const key of ['onclick','onerror','src','href','srcdoc','innerHTML','style'])assert.throws(()=>h('div',{[key]:'javascript:alert(1)'}));
  assert.throws(()=>h('form',{method:'post'}));
});
test('all app rendering modules are free of HTML parser sinks',async()=>{
  for(const name of ['app.js','dom.js','time-controls.js']){
    const source=await readFile(new URL('../src/'+name,import.meta.url),'utf8');
    assert.ok(!/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\s*\(|createContextualFragment|DOMParser/.test(source),name);
  }
});
