import {requireNotifications} from './features.js';
import {newId,STORAGE_KEY} from './model.js';

export const REMOVAL_KEY='my-schedule.notification-removals.v1';
export const REMOVAL_READY=false; // Enable only after the separate shortcut is verified.
export const REMOVAL_SHORTCUT='マイスケジュール通知解除テスト';
export const REMOVAL_LIMITS=Object.freeze({entries:100,chars:100000});
const ordinary=item=>item?.type==='event'&&item.repeat==='none'&&item.eventSeriesId===undefined&&item.exceptionDate===undefined;
export function readRemovals(storage){
  const raw=storage.getItem(REMOVAL_KEY);
  if(raw===null)return {raw,value:{version:1,entries:[]}};
  if(typeof raw!=='string'||raw.length>REMOVAL_LIMITS.chars)throw Error('解除待ち領域を確認できません');
  const value=JSON.parse(raw);
  if(!value||Object.keys(value).sort().join(',')!=='entries,version'||value.version!==1||!Array.isArray(value.entries)||value.entries.length>REMOVAL_LIMITS.entries)throw Error('解除待ち形式が不正です');
  const ids=new Set();
  for(const entry of value.entries){
    if(!entry||Object.keys(entry).sort().join(',')!=='createdAt,itemId,operationId,phase,reason,title'||typeof entry.itemId!=='string'||!entry.itemId||entry.itemId.length>128||typeof entry.operationId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(entry.operationId)||ids.has(entry.operationId)||typeof entry.title!=='string'||!entry.title.trim()||entry.title.length>160||!['off','deleted'].includes(entry.reason)||!['prepared','pending'].includes(entry.phase)||typeof entry.createdAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.createdAt)||!Number.isFinite(Date.parse(entry.createdAt))||new Date(entry.createdAt).toISOString()!==entry.createdAt)throw Error('解除待ち項目が不正です');
    ids.add(entry.operationId);
  }
  return {raw,value};
}
export function stageRemovals(storage,before,after,now=new Date()){
  requireNotifications();
  const next=new Map(after.items.map(item=>[item.id,item]));
  const targets=before.items.filter(item=>ordinary(item)&&(!next.has(item.id)||(item.notification?.enabled&&!next.get(item.id).notification?.enabled)));
  if(!targets.length)return null;
  const {raw,value}=readRemovals(storage),ids=[];
  for(const item of targets){
    const operationId=newId();ids.push(operationId);
    value.entries.push({operationId,itemId:item.id,title:item.title,reason:next.has(item.id)?'off':'deleted',phase:'prepared',createdAt:now.toISOString()});
  }
  const encoded=JSON.stringify(value);
  if(value.entries.length>REMOVAL_LIMITS.entries||encoded.length>REMOVAL_LIMITS.chars)throw Error('解除待ちの上限です');
  // Do not replace a changed queue, even for a non-cooperating writer.
  if(storage.getItem(REMOVAL_KEY)!==raw)throw Error('解除待ちが変更されました');
  storage.setItem(REMOVAL_KEY,encoded);
  if(storage.getItem(REMOVAL_KEY)!==encoded)throw Error('解除待ちを保存確認できません');
  return {raw:encoded,ids};
}
export function commitRemovals(storage,plan){
  requireNotifications();
  if(!plan)return;
  const {raw,value}=readRemovals(storage);if(raw!==plan.raw)throw Error('解除待ちが変更されました');
  for(const entry of value.entries)if(plan.ids.includes(entry.operationId))entry.phase='pending';
  const encoded=JSON.stringify(value);storage.setItem(REMOVAL_KEY,encoded);
  if(storage.getItem(REMOVAL_KEY)!==encoded)throw Error('解除待ちの確定を確認できません');
}
export function removalEligible(entry,state){
  const current=state?.items.find(item=>item.id===entry.itemId);
  return entry.phase==='pending'&&(entry.reason==='deleted'?!current:ordinary(current)&&current.notification?.enabled===false);
}
export function removalPayload(entry){
  requireNotifications();
  if(!entry||typeof entry.itemId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(entry.itemId)||typeof entry.operationId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(entry.operationId)||typeof entry.title!=='string'||!entry.title.trim()||entry.title.length>160||/[\u0000-\u001f\u007f]/.test(entry.title))throw Error('解除対象が不正です');
  return Object.freeze({formatVersion:1,itemId:entry.itemId,operationId:entry.operationId,operation:'delete',title:entry.title,notifyAt:null});
}
export function removalURL({origin,store,operationId}){
  requireNotifications();
  if(!REMOVAL_READY)throw Error('解除用ショートカットの検証が終わるまで送信できません');
  if(origin!=='https://my-schedule-test.pages.dev'||!store.writable||store.protection)throw Error('解除連携を停止しています');
  const base=store.token();if(store.storage.getItem(STORAGE_KEY)!==base.raw)throw Error('現在データを確認できません');
  const entry=readRemovals(store.storage).value.entries.find(entry=>entry.operationId===operationId);
  if(!entry||!removalEligible(entry,store.state))throw Error('解除対象を確定できません');
  if(!store.matches(base)||store.storage.getItem(STORAGE_KEY)!==base.raw)throw Error('現在データが変わりました');
  return 'shortcuts://run-shortcut?name='+encodeURIComponent(REMOVAL_SHORTCUT)+'&input=text&text='+encodeURIComponent(JSON.stringify(removalPayload(entry)));
}
