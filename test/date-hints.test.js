import test from 'node:test';
import assert from 'node:assert/strict';
import {dateHint,enhanceDateFields} from '../src/time-controls.js';

for(const [date,expected] of [
  ['2026-11-23','2026/11/23（月）'],['2026-11-30','2026/11/30（月）'],
  ['2026-12-31','2026/12/31（木）'],['2027-01-01','2027/01/01（金）'],
  ['2028-02-29','2028/02/29（火）'],['2000-02-29','2000/02/29（火）'],
  ['2100-02-28','2100/02/28（日）'],
])test('calendar-day hint: '+date,()=>assert.equal(dateHint(date),expected));

for(const value of ['',null,undefined,'2026-02-29','2100-02-29','2026-04-31','2026-00-01','2026-13-01','2026-1-01','1999-12-31','2101-01-01','2026-11-23T12:00','<script>'])
  test('no invented weekday for '+String(value),()=>assert.equal(dateHint(value),''));

test('date decoration is display-only, updates both events and can refresh programmatic changes',()=>{
  const listeners=new Map(),attributes=new Map([['aria-describedby','existing-help']]);
  let created=0,hint;
  const input={name:'due',value:'2026-11-23',validity:{valid:true},
    parentElement:{classList:{contains:()=>true}},
    ownerDocument:{createElement(){created++;return {};}},
    getAttribute:key=>attributes.get(key),setAttribute:(key,value)=>attributes.set(key,value),
    after:node=>{hint=node;},addEventListener:(event,callback)=>listeners.set(event,callback)};
  const form={querySelectorAll:()=>[input]};
  const controls=enhanceDateFields(form);
  assert.equal(input.value,'2026-11-23');assert.equal(input.name,'due');
  assert.equal(hint.textContent,'2026/11/23（月）');assert.equal(hint.hidden,false);
  assert.equal(attributes.get('aria-describedby'),'existing-help date-hint-due');
  input.value='2028-02-29';listeners.get('input')();assert.equal(hint.textContent,'2028/02/29（火）');
  input.value='2027-01-01';listeners.get('change')();assert.equal(hint.textContent,'2027/01/01（金）');
  input.value='';controls.refresh();assert.equal(hint.textContent,'');assert.equal(hint.hidden,true);
  input.value='2026-11-23';input.validity.valid=false;controls.refresh();assert.equal(hint.textContent,'');
  enhanceDateFields(form);assert.equal(created,1);
});
