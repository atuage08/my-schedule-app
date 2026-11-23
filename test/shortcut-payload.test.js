import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestPayload,validatePayload,shortcutURL,TEST_ITEM_ID,SHORTCUT_NAME} from '../src/shortcut-test.js';

const now=new Date('2026-11-17T03:04:30.000Z');
const payload=()=>({...createTestPayload(now)});
test('fictional payload has exactly six fields, stable item ID and rounded UTC notification time',()=>{
  const data=createTestPayload(now);
  assert.deepEqual(Object.keys(data),['formatVersion','itemId','operationId','operation','title','notifyAt']);
  assert.equal(data.formatVersion,1);assert.equal(data.itemId,TEST_ITEM_ID);assert.equal(data.operation,'upsert');
  assert.equal(data.notifyAt,'2026-11-17T03:15:00.000Z');assert.ok(Object.isFrozen(data));
  assert.equal(createTestPayload(new Date('2026-11-17T03:04:00.000Z')).notifyAt,'2026-11-17T03:14:00.000Z');
});
test('new manual requests use different operation IDs but target the same fictional item',()=>{
  const first=payload(),second=payload();assert.notEqual(first.operationId,second.operationId);assert.equal(first.itemId,second.itemId);
});
test('Japanese and HTML-like titles and URL metacharacters round-trip as JSON text without query injection',()=>{
  const data={...payload(),title:'架空 <script> &text=別値 # + % " 日本語'};
  const url=new URL(shortcutURL(data));assert.equal(url.searchParams.get('name'),SHORTCUT_NAME);
  assert.equal(url.searchParams.size,3);assert.equal(url.hash,'');assert.deepEqual(JSON.parse(url.searchParams.get('text')),data);
});
test('reject unsupported version, operations, fields, missing fields and non-records',()=>{
  for(const data of [null,[],Object.create(null),{...payload(),formatVersion:2},{...payload(),operation:'delete'},{...payload(),extra:'bad'}])assert.throws(()=>validatePayload(data));
  for(const key of Object.keys(payload())){const data=payload();delete data[key];assert.throws(()=>shortcutURL(data));}
});
test('reject invalid IDs and oversized or control-character titles',()=>{
  for(const key of ['itemId','operationId'])for(const value of ['',null,'x'.repeat(129),'../outside','a&b','日本語'])assert.throws(()=>shortcutURL({...payload(),[key]:value}));
  for(const title of ['', ' ', 'x'.repeat(161),'bad\ntext','bad\u0000text',null])assert.throws(()=>shortcutURL({...payload(),title}));
});
test('reject impossible dates, ambiguous local times, offsets and oversized input',()=>{
  for(const notifyAt of ['2026-02-30T03:00:00.000Z','2026-11-17T25:00:00.000Z','2026-11-17T03:00','2026-11-17T12:00:00+09:00','2026-11-17T03:00:00.001Z','2100-01-01T00:00:00.000Z','x'.repeat(10000),null])assert.throws(()=>shortcutURL({...payload(),notifyAt}));
  assert.throws(()=>createTestPayload(new Date(NaN)));
});
test('date calculation crosses month and year boundaries without timezone dependence',()=>{
  assert.equal(createTestPayload(new Date('2026-12-31T23:55:00.000Z')).notifyAt,'2027-01-01T00:05:00.000Z');
  assert.equal(createTestPayload(new Date('2028-02-28T23:55:00.000Z')).notifyAt,'2028-02-29T00:05:00.000Z');
});
