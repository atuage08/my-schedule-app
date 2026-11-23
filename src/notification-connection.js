import {requireNotifications} from './features.js';
import {STORAGE_KEY,defaults,dateKey} from './model.js';
import {V3_ORIGIN,V3_LIST,validateV3Input,v3Payload,newV3Request} from './notification-v3.js';

export const CONNECTION_ITEM_ID='connection-test-event-001';
export const CONNECTION_TITLE='【接続試験】架空の予定';
export const CONNECTION_SHORTCUT='マイスケジュール通知連携v3接続テスト';
export const READBACK_SHORTCUT='マイスケジュール通知連携v3読み取り確認テスト';
// Bootstrap boundary for ONE newly provisioned fictional item, not a fabricated
// history of prior notification updates. Never use this to reset an existing ID.
export const CONNECTION_INITIAL_MEMO=Object.freeze({app:'my-schedule',metadataVersion:2,itemId:CONNECTION_ITEM_ID,generationId:'connection-generation-001',previousGenerationId:'connection-generation-000',operationId:'connection-operation-001',state:'inactive',phase:'confirmed',pending:null});
export const MAX_RESULT_BYTES=4096;
export const RESULT_PREFIX='#notification-result=';
const fail=message=>{throw Error(message);};
const wireId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const utc=value=>typeof value==='string'&&/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const keys=(value,allowed)=>{if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...allowed].sort().join(','))fail('結果JSONのキー・構造が不正です');};
const pendingWire=r=>{const p=r.pending;return {formatVersion:2,itemId:r.itemId,operationId:p.operationId,operation:p.operation,expectedGenerationId:p.expectedGenerationId,generationId:p.generationId,title:p.title,notifyAt:p.notifyAt};};
const matchesDesired=(d,o)=>d.enabled===(o.state==='active')&&d.title===o.title&&d.notifyAt===o.notifyAt;
export function parseResult(text){
  requireNotifications();
  if(typeof text!=='string'||!text.length||new TextEncoder().encode(text).length>MAX_RESULT_BYTES)fail('結果JSONは空でない4096バイト以下にしてください');
  let r;try{r=JSON.parse(text);}catch{fail('結果JSONを読み込めません');}
  if(r?.format==='my-schedule-notification-readback'){
    keys(r,['format','formatVersion','purpose','itemId','operationId','reminder']);
    if(r.formatVersion!==1||!['initial','verification'].includes(r.purpose)||!wireId(r.itemId)||!wireId(r.operationId))fail('読み取り報告の識別情報が不正です');
    keys(r.reminder,['listName','title','notifyAtText','completed','notesText']);
    const actual=r.reminder;
    if(typeof actual.notesText!=='string'||actual.notesText.length>4096||typeof actual.notifyAtText!=='string')fail('読み取り報告の型が不正です');
    let memo;try{memo=JSON.parse(actual.notesText);}catch{fail('読み戻したメモが不正です');}
    keys(memo,['app','metadataVersion','itemId','generationId','previousGenerationId','operationId','state','phase','pending']);
    if(memo.app!=='my-schedule'||memo.metadataVersion!==2||memo.itemId!==r.itemId)fail('メモと対象IDが一致しません');
    // Reuse the strict receipt validator. These values come from actual notes,
    // never from the requested new generation or the current desired settings.
    const verification=r.purpose==='verification';
    const normalized={format:'my-schedule-notification-result',formatVersion:1,kind:verification?'verification':'inspection',itemId:r.itemId,operationId:r.operationId,operation:verification?(memo.state==='active'?'upsert':'deactivate'):'inspect',expectedGenerationId:verification?memo.previousGenerationId:null,generationId:memo.generationId,outcome:'observed',observed:{listName:actual.listName,title:actual.title,notifyAt:actual.notifyAtText===''?null:actual.notifyAtText,completed:actual.completed,state:memo.state,phase:memo.phase,pending:memo.pending,generationId:memo.generationId,previousGenerationId:memo.previousGenerationId,operationId:memo.operationId}};
    return {...parseResult(JSON.stringify(normalized)),readback:true};
  }
  keys(r,['format','formatVersion','kind','itemId','operationId','operation','expectedGenerationId','generationId','outcome','observed']);
  if(r.format!=='my-schedule-notification-result'||r.formatVersion!==1||!['operation','inspection','verification'].includes(r.kind)||!wireId(r.itemId)||!wireId(r.operationId)||!wireId(r.generationId)||(r.expectedGenerationId!==null&&!wireId(r.expectedGenerationId)))fail('結果JSONの型・識別情報が不正です');
  if(r.kind==='operation'||r.kind==='verification'){
    const outcomes=r.kind==='verification'?['observed']:['applied','already-applied','cancelled','rejected','unknown'];
    if(!['upsert','deactivate'].includes(r.operation)||!wireId(r.expectedGenerationId)||r.generationId===r.expectedGenerationId||!outcomes.includes(r.outcome))fail('結果の操作・状態が不正です');
  }else if(r.operation!=='inspect'||r.outcome!=='observed')fail('照合結果が不正です');
  const success=r.kind!=='operation'||['applied','already-applied'].includes(r.outcome);
  if(!success){if(r.observed!==null)fail('未確認結果に確定状態を付けないでください');return r;}
  const o=r.observed;
  keys(o,['listName','title','notifyAt','completed','state','phase','pending','generationId','previousGenerationId','operationId']);
  if(o.listName!==V3_LIST||typeof o.title!=='string'||!o.title.trim()||o.title.length>160||/[\u0000-\u001f\u007f]/.test(o.title)||typeof o.completed!=='boolean'||!['active','inactive'].includes(o.state)||o.phase!=='confirmed'||o.pending!==null||!wireId(o.generationId)||!wireId(o.operationId)||(o.previousGenerationId!==null&&!wireId(o.previousGenerationId))||o.previousGenerationId===o.generationId||o.generationId!==r.generationId)fail('読み戻し状態が不正です');
  if(o.state==='inactive'?(o.completed!==true||o.notifyAt!==null):(o.completed!==false||!utc(o.notifyAt)))fail('日時・完了状態が一致しません');
  if(r.kind!=='inspection'&&(o.operationId!==r.operationId||o.previousGenerationId!==r.expectedGenerationId))fail('確定メモと操作が一致しません');
  return r;
}
export function resultFromFragment(hash){
  requireNotifications();
  if(!hasResultFragment(hash))return null;
  if(!hash.startsWith(RESULT_PREFIX))fail('結果URLの形式が不正です');
  if(hash.length>RESULT_PREFIX.length+MAX_RESULT_BYTES*3)fail('結果URLが大きすぎます');
  let text;try{text=decodeURIComponent(hash.slice(RESULT_PREFIX.length));}catch{fail('結果URLのエンコードが不正です');}
  return {text,result:parseResult(text)};
}
export const hasResultFragment=hash=>typeof hash==='string'&&hash.startsWith('#notification-result');
const currentHash=hash=>typeof hash==='function'?hash():hash;
export async function refreshNotificationStore(store,hash,{initialize=false}={}){
  const resultAtEntry=hasResultFragment(currentHash(hash));
  // A callback landing in an empty Safari/PWA partition must never seed data.
  if(initialize&&!resultAtEntry)await store.initialize();else await store.refresh();
  // Latch callbacks seen at entry, and recheck after the asynchronous read.
  // Neither malformed results nor unrelated partitions may trigger rollover.
  if(resultAtEntry||hasResultFragment(currentHash(hash)))return {ok:true,deferred:true};
  if(store.status==='ready'&&store.locks?.request)return store.rollover();
  return {ok:true,deferred:false};
}
export const bootNotificationStore=(store,hash)=>refreshNotificationStore(store,hash,{initialize:true});
export class NotificationConnection{
  constructor({store,origin,now=()=>new Date()}){this.store=store;this.origin=origin;this.now=now;this.tickets=new WeakSet();}
  scope(consent){
    requireNotifications();
    if(this.origin()!==V3_ORIGIN||!consent)fail('テスト環境と架空データの確認が必要です');
    if(!this.store.writable||this.store.protection||this.store.state?.version!==3)fail('保存先を確認できません。初期化・統合せず停止します');
    const r=this.store.state.notificationLink.records.find(r=>r.itemId===CONNECTION_ITEM_ID);
    if(!r||r.desired.title!==CONNECTION_TITLE||r.pending&&r.pending.title!==CONNECTION_TITLE)fail('固定の架空接続試験データだけを対象にできます');
    return r;
  }
  async createFixture(consent){
    requireNotifications();
    if(this.origin()!==V3_ORIGIN||!consent||!this.store.writable)fail('テスト環境と保存状態を確認してください');
    if(this.store.state.items.some(item=>item.id===CONNECTION_ITEM_ID)||this.store.state.notificationLink?.records.some(r=>r.itemId===CONNECTION_ITEM_ID))fail('接続試験データは既にあります。初期化・上書きしません');
    const now=this.now(),base=this.store.token();
    return this.store.mutate(d=>{d.items.push({id:CONNECTION_ITEM_ID,type:'event',title:CONNECTION_TITLE,...defaults(dateKey(now),now),allDay:false,repeat:'none',excluded:[],notification:{enabled:false,notifyAt:null}});d.version=Math.max(d.version,2);},base,{notificationV3:true});
  }
  async prepareInspection(consent){
    this.tickets=new WeakSet();
    const r=this.scope(consent),base=this.store.token();
    if(r.pending?.status==='unknown')fail('変更依頼が結果不明です。初回照合ではなく変更後の反映確認を使ってください');
    const result=await this.store.mutate(d=>{const record=d.notificationLink.records.find(record=>record.itemId===r.itemId);if(!record.pending)record.pending=newV3Request(record);if(record.pending.status==='pending')record.pending.status='suspended';},base,{user:false});
    if(!result.ok||!result.verified)return result;
    const current=this.store.state.notificationLink.records.find(record=>record.itemId===r.itemId);
    const request=Object.freeze({format:'my-schedule-notification-readback-request',formatVersion:1,purpose:'initial',itemId:current.itemId,operationId:current.pending.operationId});
    const ticket=Object.freeze({kind:'inspection',request,base:this.store.token(),url:'shortcuts://run-shortcut?name='+encodeURIComponent(READBACK_SHORTCUT)+'&input=text&text='+encodeURIComponent(JSON.stringify(request))});
    this.tickets.add(ticket);return {...result,request,ticket};
  }
  async prepareVerification(consent){
    this.tickets=new WeakSet();
    const r=this.scope(consent),base=this.store.token();
    if(this.store.state.notificationLink.mode!=='ready'||r.pending?.status!=='unknown')fail('保存済みの結果不明な変更依頼が必要です。復元後は再接続してください');
    const payload=Object.freeze(pendingWire(r));
    const result=await this.store.mutate(()=>{},base,{user:false});
    if(!result.ok||!result.verified)return result;
    const request=Object.freeze({format:'my-schedule-notification-readback-request',formatVersion:1,purpose:'verification',itemId:r.itemId,operationId:payload.operationId});
    const ticket=Object.freeze({kind:'verification',request,payload,base:this.store.token(),url:'shortcuts://run-shortcut?name='+encodeURIComponent(READBACK_SHORTCUT)+'&input=text&text='+encodeURIComponent(JSON.stringify(request))});
    this.tickets.add(ticket);return {...result,request,ticket};
  }
  async prepare(consent){
    this.tickets=new WeakSet();
    const r=this.scope(consent),base=this.store.token();
    if(this.store.state.notificationLink.mode!=='ready'||this.store.state.notificationLink.records.some(r=>r.pending?.status==='unknown'))fail('初回照合・結果不明の確認が必要です');
    const payload=Object.freeze(validateV3Input(v3Payload(r)));
    if(!matchesDesired(r.desired,{state:payload.operation==='upsert'?'active':'inactive',title:payload.title,notifyAt:payload.notifyAt})||payload.operation==='upsert'&&new Date(payload.notifyAt)<=this.now())fail('依頼と現在の希望・未来日時が一致しません');
    const result=await this.store.mutate(d=>{const record=d.notificationLink.records.find(record=>record.itemId===r.itemId);record.pending.status='unknown';record.status='unknown';},base,{user:false});
    if(!result.ok||!result.verified)return result;
    const saved=this.store.state.notificationLink.records.find(record=>record.itemId===r.itemId);
    if(JSON.stringify(pendingWire(saved))!==JSON.stringify(payload)||!matchesDesired(saved.desired,{state:payload.operation==='upsert'?'active':'inactive',title:payload.title,notifyAt:payload.notifyAt}))fail('準備中に設定が変わりました。再照合してください');
    const ticket=Object.freeze({kind:'operation',payload,base:this.store.token(),url:'shortcuts://run-shortcut?name='+encodeURIComponent(CONNECTION_SHORTCUT)+'&input=text&text='+encodeURIComponent(JSON.stringify(payload))});
    this.tickets.add(ticket);return {...result,ticket};
  }
  launch(ticket,consent,navigate){
    const r=this.scope(consent);
    if(!ticket||!this.tickets.has(ticket)||!this.store.matches(ticket.base)||this.store.storage.getItem(STORAGE_KEY)!==ticket.base.raw||!r.pending)fail('起動予約が無効です。自動再送せず確認してください');
    if(ticket.kind==='inspection'){
      if(r.pending.operationId!==ticket.request.operationId)fail('照合依頼が変わりました');
    }else if(!['operation','verification'].includes(ticket.kind)||r.pending.status!=='unknown'||JSON.stringify(pendingWire(r))!==JSON.stringify(ticket.payload))fail('送信依頼が変わりました');
    this.tickets.delete(ticket);navigate(ticket.url); // Even an exception leaves the outcome unknown.
  }
  async accept(text,{consent=false,inspectionConfirmed=false,verificationConfirmed=false}={}){
    this.tickets=new WeakSet();
    requireNotifications();
    const receipt=parseResult(text),r=this.scope(consent),base=this.store.token();
    const initialReadback=receipt.readback&&receipt.kind==='inspection';
    if(receipt.itemId!==r.itemId||!r.pending||receipt.operationId!==r.pending.operationId||(!initialReadback&&receipt.expectedGenerationId!==r.generationId))fail('保存中の依頼・保存領域と一致しません。データを初期化しません');
    const p=r.pending;
    if(receipt.kind!=='inspection'){
      if(p.status!=='unknown'||this.store.state.notificationLink.mode!=='ready'||receipt.expectedGenerationId!==p.expectedGenerationId||receipt.generationId!==p.generationId||receipt.operation!==p.operation)fail('古い結果・未実行依頼・操作不一致です');
      if(receipt.kind==='verification'&&!verificationConfirmed)fail('変更処理の終了と直前の読み戻しを明示確認してください');
      if(receipt.observed&&(receipt.observed.title!==p.title||receipt.observed.notifyAt!==p.notifyAt||receipt.observed.state!==(p.operation==='upsert'?'active':'inactive')))fail('報告内容と送信依頼が一致しません');
    }else if(p.status==='unknown'||!inspectionConfirmed||receipt.observed.title!==CONNECTION_TITLE)fail('初回・再接続と変更後確認を区別し、直前の読み戻しを明示確認してください');
    const result=await this.store.mutate(d=>{
      const record=d.notificationLink.records.find(record=>record.itemId===r.itemId);
      if(!receipt.observed){record.status='unknown';record.pending.status='suspended';return;}
      const o=receipt.observed;record.generationId=o.generationId;record.operationId=o.operationId;record.status=o.state;
      record.pending=matchesDesired(record.desired,o)?null:newV3Request(record);
      d.notificationLink.mode='ready';
    },base,{user:false});
    return {...result,reported:result.ok&&!!receipt.observed,uncertain:!receipt.observed};
  }
}
