import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateNativePlan,validateV3Input,V3_LIST} from '../src/notification-v3.js';
const now=new Date('2026-11-18T03:00:00.000Z');
const payload=()=>({formatVersion:2,itemId:'item-1',operationId:'op-2',operation:'deactivate',expectedGenerationId:'gen-1',generationId:'gen-2',title:'架空通知',notifyAt:null});
const native=()=>({nativeId:'native-1',listName:V3_LIST,title:'架空通知',completed:false,notifyAt:'2026-11-19T03:00:00.000Z',notes:JSON.stringify({app:'my-schedule',metadataVersion:2,itemId:'item-1',generationId:'gen-1',previousGenerationId:null,operationId:'op-1',state:'active',phase:'confirmed',pending:null})});
test('logical pause plans completed/no-date and keeps identity/generation metadata',()=>{
  const source=native(),before=JSON.stringify(source),plan=evaluateNativePlan(payload(),[source],now);assert.equal(plan.completed,true);assert.equal(plan.notifyAt,null);assert.equal(plan.metadata.state,'inactive');assert.equal(plan.metadata.generationId,'gen-2');assert.equal(JSON.stringify(source),before);
});
test('resume reuses exactly one inactive object and rejects old pause/update after generation changes',()=>{
  const source=native(),plan=evaluateNativePlan(payload(),[source],now),paused={...source,...plan,notes:JSON.stringify(plan.metadata)};
  const request={...payload(),operation:'upsert',operationId:'op-3',expectedGenerationId:'gen-2',generationId:'gen-3',notifyAt:'2026-11-19T04:00:00.000Z'};
  const resumed=evaluateNativePlan(request,[paused],now);assert.equal(resumed.nativeId,source.nativeId);assert.equal(resumed.completed,false);
  const current={...paused,...resumed,notes:JSON.stringify(resumed.metadata)};
  assert.throws(()=>evaluateNativePlan(payload(),[current],now),/古い/);assert.throws(()=>evaluateNativePlan({...request,expectedGenerationId:'gen-1'},[current],now));
});
test('same operation can be confirmed without reapplying only if actual state also agrees',()=>{
  const source=native(),plan=evaluateNativePlan(payload(),[source],now),done={...source,...plan,notes:JSON.stringify(plan.metadata)};
  assert.equal(evaluateNativePlan(payload(),[done],now).status,'already-applied');assert.throws(()=>evaluateNativePlan(payload(),[{...done,completed:false}],now));
});
test('only the dedicated list is considered, duplicates and missing targets never mutate',()=>{
  const other={...native(),listName:'個人用の別リスト'};assert.throws(()=>evaluateNativePlan(payload(),[other],now));assert.equal(evaluateNativePlan(payload(),[other,native()],now).nativeId,'native-1');assert.throws(()=>evaluateNativePlan(payload(),[native(),native()],now));assert.throws(()=>evaluateNativePlan(payload(),[],now));
});
test('legacy, malformed, processing and manual-state changes all stop',()=>{
  for(const source of [{...native(),notes:'item-1'},{...native(),notes:'broken'},{...native(),completed:true},{...native(),notes:JSON.stringify({...JSON.parse(native().notes),phase:'processing',pending:payload()})}])assert.throws(()=>evaluateNativePlan(payload(),[source],now));
});
test('arbitrary URL/list commands, physical delete, legacy version and empty IDs are rejected',()=>{
  for(const change of [{formatVersion:1},{operation:'delete'},{operation:'open-url'},{itemId:''},{itemId:'a&text=b'},{expectedGenerationId:null},{generationId:'gen-1'},{listName:'別リスト'},{url:'https://example.invalid'},{notifyAt:'2026-11-19T03:00:00Z'},{title:'bad\ntext'}])assert.throws(()=>validateV3Input({...payload(),...change}));
});
test('HTML-looking title is data only and past reactivation is refused',()=>{
  const p={...payload(),operation:'upsert',title:'<script> & 日本語',notifyAt:'2026-11-19T03:00:00.000Z'};assert.equal(evaluateNativePlan(p,[native()],now).title,p.title);assert.throws(()=>evaluateNativePlan({...p,notifyAt:'2026-11-17T03:00:00.000Z'},[native()],now));
});
