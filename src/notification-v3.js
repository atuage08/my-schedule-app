import {requireNotifications} from './features.js';
// Pure data/protocol helpers. No storage, network, clipboard or native access.
export const V3_READY=false;
export const V3_ORIGIN='https://my-schedule-test.pages.dev';
export const V3_SHORTCUT='マイスケジュール通知連携v3テスト';
export const V3_LIST='マイスケジュール通知テスト';
const id=value=>typeof value==='string'&&value.length>0&&value.length<=128;
const wireId=value=>id(value)&&/^[A-Za-z0-9_-]+$/.test(value);
const uuid=()=>globalThis.crypto.randomUUID();
const keys=(value,list)=>{if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...list].sort().join(','))throw Error('通知連携の構造が不正です');};
const title=value=>typeof value==='string'&&value.trim()&&value.length<=160;
const utc=value=>typeof value==='string'&&/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const ordinary=item=>item?.type==='event'&&item.repeat==='none'&&item.eventSeriesId===undefined&&item.exceptionDate===undefined;
function desired(value){keys(value,['enabled','notifyAt','title']);if(typeof value.enabled!=='boolean'||!title(value.title)||(value.enabled?!utc(value.notifyAt):value.notifyAt!==null))throw Error('通知の希望状態が不正です');}
export function validateLink(link){
  keys(link,['version','mode','records','legacyRemovals']);
  if(link.version!==1||!['review','ready'].includes(link.mode)||!Array.isArray(link.records)||link.records.length>1000||!Array.isArray(link.legacyRemovals)||link.legacyRemovals.length>100)throw Error('通知連携の上限・形式が不正です');
  const seen=new Set(),ops=new Set();
  for(const r of link.records){
    keys(r,['itemId','generationId','operationId','status','desired','pending']);
    if(!id(r.itemId)||seen.has(r.itemId)||!['unverified','active','inactive','unknown'].includes(r.status)||(r.generationId!==null&&!wireId(r.generationId))||(r.operationId!==null&&!wireId(r.operationId)))throw Error('通知対象が不正です');
    if(['active','inactive'].includes(r.status)&&(!r.generationId||!r.operationId)||r.status==='unverified'&&(r.generationId!==null||r.operationId!==null))throw Error('確認済み世代が不正です');
    seen.add(r.itemId);desired(r.desired);
    if(r.pending!==null){
      const p=r.pending;keys(p,['operationId','expectedGenerationId','generationId','operation','title','notifyAt','status']);
      if(!wireId(p.operationId)||ops.has(p.operationId)||!wireId(p.generationId)||(p.expectedGenerationId!==null&&!wireId(p.expectedGenerationId))||p.expectedGenerationId===p.generationId||!['upsert','deactivate'].includes(p.operation)||!title(p.title)||!['pending','unknown','suspended'].includes(p.status)||(p.operation==='upsert'?!utc(p.notifyAt):p.notifyAt!==null))throw Error('通知依頼が不正です');
      if(p.expectedGenerationId!==r.generationId)throw Error('依頼と確認済み世代が一致しません');
      ops.add(p.operationId);
    }
  }
  for(const entry of link.legacyRemovals){
    keys(entry,['createdAt','itemId','operationId','phase','reason','title']);
    if(!id(entry.itemId)||!wireId(entry.operationId)||!title(entry.title)||!['prepared','pending'].includes(entry.phase)||!['off','deleted'].includes(entry.reason)||typeof entry.createdAt!=='string'||entry.createdAt.length>32||!Number.isFinite(Date.parse(entry.createdAt)))throw Error('旧解除待ちが不正です');
  }
  return link;
}
function request(record){return {operationId:uuid(),expectedGenerationId:record.generationId,generationId:uuid(),operation:record.desired.enabled?'upsert':'deactivate',title:record.desired.title,notifyAt:record.desired.notifyAt,status:'pending'};}
export const newV3Request=record=>{requireNotifications();return request(record);};
export function needsV3(before,after){
  if(before.version===3)return true;
  const next=new Map(after.items.map(item=>[item.id,item])),previous=new Map(before.items.map(item=>[item.id,item]));
  return before.items.some(old=>ordinary(old)&&(!next.has(old.id)||JSON.stringify(old.notification)!==JSON.stringify(next.get(old.id).notification)||old.notification&&old.title!==next.get(old.id).title))||after.items.some(item=>ordinary(item)&&item.notification!==undefined&&(!previous.has(item.id)||JSON.stringify(previous.get(item.id).notification)!==JSON.stringify(item.notification)));
}
export function stageV3(before,after,legacyRemovals=[]){
  requireNotifications();
  if(before.version===3&&after.version!==3)throw Error('v3を自動降格できません');
  const previous=new Map(before.items.map(item=>[item.id,item])),next=new Map(after.items.map(item=>[item.id,item]));
  const touched=new Set();
  for(const old of before.items)if(ordinary(old)&&(!next.has(old.id)||JSON.stringify(old.notification)!==JSON.stringify(next.get(old.id).notification)||old.notification&&old.title!==next.get(old.id).title))touched.add(old.id);
  for(const item of after.items)if(ordinary(item)&&item.notification!==undefined&&(!previous.has(item.id)||JSON.stringify(previous.get(item.id).notification)!==JSON.stringify(item.notification)))touched.add(item.id);
  if(before.version!==3&&!touched.size)return;
  if(after.version!==3){
    after.version=3;after.notificationLink={version:1,mode:'review',records:[],legacyRemovals:structuredClone(legacyRemovals)};
    for(const item of before.items)if(ordinary(item)&&item.notification!==undefined)touched.add(item.id);
  }
  const link=after.notificationLink;
  // Existing in-flight or restored requests are never silently replaced.
  for(const itemId of touched){
    const item=next.get(itemId),old=previous.get(itemId);
    const target=ordinary(item)&&item.notification?.enabled?{enabled:true,notifyAt:item.notification.notifyAt,title:item.title}:{enabled:false,notifyAt:null,title:item?.title||old.title};
    let record=link.records.find(record=>record.itemId===itemId);
    if(!record){record={itemId,generationId:null,operationId:null,status:'unverified',desired:target,pending:null};link.records.push(record);}
    const changed=JSON.stringify(record.desired)!==JSON.stringify(target);record.desired=target;
    if(!record.pending||record.pending.status==='pending'&&changed)record.pending=request(record);
  }
  validateLink(link);
}
export function suspendLink(state){
  if(state.version!==3)return;
  state.notificationLink.mode='review';
  for(const record of state.notificationLink.records)if(record.pending)record.pending.status='suspended';
}
export function v3Payload(record){
  requireNotifications();
  if(!record||!wireId(record.itemId)||!record.pending||record.pending.status!=='pending'||!record.generationId||!['active','inactive'].includes(record.status))throw Error('初回照合・結果確認が必要です');
  validateLink({version:1,mode:'ready',records:[record],legacyRemovals:[]});
  const p=record.pending;
  if(/[\u0000-\u001f\u007f]/.test(p.title))throw Error('タイトルに制御文字があります');
  return Object.freeze({formatVersion:2,itemId:record.itemId,operationId:p.operationId,operation:p.operation,expectedGenerationId:p.expectedGenerationId,generationId:p.generationId,title:p.title,notifyAt:p.notifyAt});
}
export function v3URL({origin,store,itemId}){
  requireNotifications();
  if(!V3_READY)throw Error('世代対応ショートカットの実機検証が完了するまで連携できません');
  if(origin!==V3_ORIGIN||!store.writable||store.protection||store.state?.version!==3||store.state.notificationLink.mode!=='ready')throw Error('通知連携を停止しています');
  const base=store.token();
  if(store.storage.getItem('my-schedule.prototype.v1')!==base.raw)throw Error('保存先が変わりました');
  const record=store.state.notificationLink.records.find(record=>record.itemId===itemId),payload=v3Payload(record);
  if(!store.matches(base)||store.storage.getItem('my-schedule.prototype.v1')!==base.raw)throw Error('保存先が変わりました');
  return 'shortcuts://run-shortcut?name='+encodeURIComponent(V3_SHORTCUT)+'&input=text&text='+encodeURIComponent(JSON.stringify(payload));
}
export function validateV3Input(p){
  keys(p,['formatVersion','itemId','operationId','operation','expectedGenerationId','generationId','title','notifyAt']);
  if(p.formatVersion!==2||!wireId(p.itemId)||!wireId(p.operationId)||!wireId(p.expectedGenerationId)||!wireId(p.generationId)||p.expectedGenerationId===p.generationId||!title(p.title)||/[\u0000-\u001f\u007f]/.test(p.title)||!['upsert','deactivate'].includes(p.operation)||(p.operation==='upsert'?!utc(p.notifyAt):p.notifyAt!==null))throw Error('非対応・不正な通知入力です');
  return p;
}
// Reference decision logic for the manually built iPhone shortcut, NOT an
// EventKit adapter. Returns a plan only, and never accesses or changes reminders.
export function evaluateNativePlan(payload,candidates,now=new Date()){
  const p=validateV3Input(payload);
  if(!Array.isArray(candidates)||candidates.length>1000||!Number.isFinite(now.getTime()))throw Error('検索を確認できません');
  const matches=[];
  for(const item of candidates){
    if(item.listName!==V3_LIST)continue;
    if(item.notes===p.itemId)throw Error('旧形式のため先に手動照合が必要です');
    if(typeof item.notes!=='string'||item.notes.length>4096)throw Error('専用リストの識別情報を確認できません');
    let metadata;try{metadata=JSON.parse(item.notes);}catch{throw Error('専用リストに未確認のメモがあります');}
    keys(metadata,['app','metadataVersion','itemId','generationId','previousGenerationId','operationId','state','phase','pending']);
    if(metadata.app!=='my-schedule'||metadata.metadataVersion!==2||!wireId(metadata.itemId)||!wireId(metadata.generationId)||(metadata.previousGenerationId!==null&&!wireId(metadata.previousGenerationId))||!wireId(metadata.operationId)||!['active','inactive'].includes(metadata.state)||!['confirmed','processing'].includes(metadata.phase))throw Error('識別情報が不正です');
    if(metadata.phase==='processing'||metadata.pending!==null)throw Error('中断・処理中の対象があります');
    if(metadata.itemId===p.itemId)matches.push({item,metadata});
  }
  if(matches.length!==1)throw Error('対象なし・複数一致のため変更しません');
  const {item,metadata}=matches[0],active=p.operation==='upsert';
  if(!id(item.nativeId)||typeof item.completed!=='boolean')throw Error('対象オブジェクトを確認できません');
  if(metadata.generationId===p.generationId&&metadata.operationId===p.operationId){
    if(metadata.previousGenerationId===p.expectedGenerationId&&item.completed===!active&&item.notifyAt===p.notifyAt&&item.title===p.title&&metadata.state===(active?'active':'inactive'))return {status:'already-applied',nativeId:item.nativeId};
    throw Error('同じ依頼の反映内容が一致しません');
  }
  if(metadata.operationId===p.operationId||metadata.generationId!==p.expectedGenerationId)throw Error('古い依頼・不一致です');
  if(metadata.state==='inactive'?(item.completed!==true||item.notifyAt!==null):(item.completed!==false||!utc(item.notifyAt)))throw Error('実状態と識別情報が一致しません');
  if(active&&new Date(p.notifyAt)<=now)throw Error('通知日時は未来を指定してください');
  return {status:'plan',nativeId:item.nativeId,title:p.title,notifyAt:p.notifyAt,completed:!active,metadata:{...metadata,generationId:p.generationId,previousGenerationId:p.expectedGenerationId,operationId:p.operationId,state:active?'active':'inactive'}};
}
