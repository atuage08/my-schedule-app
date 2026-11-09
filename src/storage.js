import {STORAGE_KEY,parseState,serializeState,seed,rollTasks,dateKey} from './model.js';
import {checkedData,createBackup,createQuarantine,prepareRestore,dataDigest,freeze} from './backup.js';

export const LOCK_NAME='my-schedule.data-write.v1';
export const META_KEY='my-schedule.backup-meta.v1';
export const BACKUP_INTERVAL=336*60*60*1000;
const messages={conflict:'データが変更されました。読み直してから確認をやり直してください',blocked:'保存を停止しています。バックアップ・緊急復旧を確認してください',locks:'Web Locksを利用できないため書き込みを停止しています',save:'保存できませんでした。元データは変更していません',unverified:'書き込みを試みましたが、保存先の状態を確認できず成否は不確定です。この画面では追加の保存・復元を停止します。再読み込み前に保持中の元データを退避してください',busy:'保存処理中です。完了を待ってください',date:'日付と復元候補を再確認してください'};
const error=reason=>Object.assign(Error(messages[reason]||'処理を完了できませんでした'),{reason});
messages['retention-limit']='過去の保持対象が上限（8件・合計32MiB）に達するため、新しい上書きを停止しました。保持対象を退避してからページの扱いを判断してください。自動破棄はしません';
const emptyMeta=()=>({version:1,engaged:null,confirmed:null});
export function parseMeta(raw){
  if(raw===null)return emptyMeta();
  if(typeof raw!=='string'||raw.length>2048)throw Error('Invalid metadata');
  const meta=JSON.parse(raw);
  if(!meta||Object.keys(meta).sort().join(',')!=='confirmed,engaged,version'||meta.version!==1||![true,false,null].includes(meta.engaged))throw Error('Invalid metadata');
  const c=meta.confirmed;
  if(c!==null&&(!c||Object.keys(c).sort().join(',')!=='at,digest,id'||!Number.isSafeInteger(c.at)||c.at<0||typeof c.digest!=='string'||!/^[0-9a-f]{64}$/.test(c.digest)||typeof c.id!=='string'||!c.id||c.id.length>128))throw Error('Invalid metadata');
  return meta;
}
export class ScheduleStore{
  constructor({storage,locks,now=()=>new Date()}={}){
    this.storage=storage;this.locks=locks;this.now=now;this.raw=undefined;this.state=null;this.status='unavailable';this.revision=0;this.busy=false;this.lastWall=now().getTime();this.clockBack=false;
    // A write-outcome latch is independent of later successful reads. Its only
    // lifetime is this store/page; there is deliberately no implicit reset.
    this.protection=null;this.currentCorruption=null;this.observation='unreadable';this.retainedRecoveries=[];this.snapshotSequence=0;
  }
  get writable(){return !!this.locks?.request&&this.status==='ready'&&!this.busy;}
  token(){return Object.freeze({raw:this.raw,revision:this.revision});}
  matches(base){return base?.raw===this.raw&&base.revision===this.revision;}
  _observe(raw){
    if(raw===null){this.currentCorruption=null;this.observation='missing';return null;}
    try{const data=parseState(raw);this.currentCorruption=null;this.observation='valid';return data;}
    catch{
      if(this.currentCorruption?.raw!==raw)this.currentCorruption=Object.freeze({id:'current-'+(++this.snapshotSequence),raw,capturedAt:this.now().toISOString()});
      this.observation='corrupt';return null;
    }
  }
  _adopt(raw){
    const data=this._observe(raw);
    if(this.protection)return; // Observation never clears the write-outcome latch.
    if(raw!==this.raw){this.revision++;this.raw=raw;}
    if(raw===null){this.state=null;this.status='missing';return;}
    if(data){this.state=freeze(data);this.status='ready';}else{this.state=null;this.status='corrupt';}
  }
  async _lock(action){if(!this.locks?.request)throw error('locks');return this.locks.request(LOCK_NAME,{mode:'exclusive'},action);}
  async refresh(){
    const read=()=>{try{this._adopt(this.storage.getItem(STORAGE_KEY));}catch{this.observation='unreadable';this.currentCorruption=null;if(!this.protection){this.status='unavailable';this.state=null;this.revision++;}}};
    if(this.locks?.request)await this._lock(read);else read();
    return this.status;
  }
  async initialize(){
    if(this.protection)return;
    try{
      if(!this.locks?.request){await this.refresh();return;}
      await this._lock(()=>{
        const raw=this.storage.getItem(STORAGE_KEY);this._adopt(raw);
        if(raw===null&&this.storage.getItem(META_KEY)===null){const result=this._write(serializeState(seed(dateKey(this.now()))));if(result.ok)this._metadata(meta=>({...meta,engaged:false}));}
      });
    }catch{this.status='unavailable';this.state=null;}
  }
  _check(base){
    if(this.protection)throw error('unverified');
    if(!this.matches(base))throw error('conflict');
    let current;try{current=this.storage.getItem(STORAGE_KEY);}catch{this.status='unavailable';throw error('blocked');}
    if(current!==base.raw){this._adopt(current);throw error('conflict');}
  }
  _write(raw,{recovery=false}={}){
    if(this.protection)return {ok:false,committed:false,reason:'unverified',message:messages.unverified};
    try{this.storage.setItem(STORAGE_KEY,raw);}catch{return {ok:false,committed:false,reason:'save',message:messages.save};}
    try{
      const saved=this.storage.getItem(STORAGE_KEY);
      if(saved!==raw||serializeState(parseState(saved))!==raw)throw Error('Readback differs');
      this._adopt(saved);return {ok:true,committed:true,verified:true};
    }catch{
      this.protection=Object.freeze({kind:recovery?'recovery-unverified':'save-unverified'});
      this.currentCorruption=null;this.observation='uncertain-after-write';
      this.revision++;this.state=null;this.status='unverified';
      return {ok:false,committed:null,verified:false,reason:'unverified',message:messages.unverified};
    }
  }
  _metadata(action){
    try{
      let meta;try{meta=parseMeta(this.storage.getItem(META_KEY));}catch{meta=emptyMeta();}
      const raw=JSON.stringify(action(meta));parseMeta(raw);this.storage.setItem(META_KEY,raw);return null;
    }catch{return 'データの保存とは別に、バックアップ案内用の記録を保存できませんでした';}
  }
  async _operation(action){
    if(this.protection)return {ok:false,committed:false,reason:'unverified',message:messages.unverified};
    if(this.busy)return {ok:false,committed:false,reason:'busy',message:messages.busy};
    this.busy=true;
    try{return await this._lock(action);}catch(cause){return {ok:false,committed:false,reason:cause.reason||'blocked',message:messages[cause.reason]||messages.blocked};}
    finally{this.busy=false;}
  }
  async mutate(action,base=this.token(),{user=true}={}){
    if(this.status!=='ready')return {ok:false,reason:'blocked',message:messages.blocked};
    let raw;
    try{const draft=structuredClone(this.state);action(draft);raw=serializeState(draft);}catch{return {ok:false,reason:'validation',message:'変更を検証できません。入力と保存上限を確認してください'};}
    return this._operation(()=>{
      this._check(base);
      if(raw===serializeState(this.state))return {ok:true,committed:false,verified:true};
      const result=this._write(raw);
      if(result.ok&&user){this.engagedInSession=true;result.warning=this._metadata(meta=>({...meta,engaged:true}));}
      return result;
    });
  }
  async rollover(){return this.mutate(draft=>rollTasks(draft,dateKey(this.now())),this.token(),{user:false});}
  async backup(){
    // A single read fixes the snapshot, even when write locks are unavailable.
    const read=()=>{
      const raw=this.storage.getItem(STORAGE_KEY);
      if(raw===null)throw error('blocked');
      const data=parseState(raw);this._adopt(raw);return data;
    };
    const data=this.locks?.request?await this._lock(read):read();
    return createBackup(data,this.now());
  }
  preview(source,base=this.token()){
    if(!this.matches(base)||!['ready','corrupt','missing'].includes(this.status))throw error('conflict');
    const data=checkedData(source.data);
    return freeze({sourceData:data,exportedAt:source.exportedAt,base,emergency:this.status!=='ready',plan:prepareRestore(data,dateKey(this.now()))});
  }
  async restore(preview,approval){
    if(!approval?.replace||(preview.emergency&&(!approval.emergency||!['saved','skip'].includes(approval.quarantine))))return {ok:false,reason:'approval',message:'置き換え範囲と元データ消失の確認が必要です'};
    return this._operation(()=>{
      this._check(preview.base);
      if(!['ready','corrupt','missing'].includes(this.status))throw error('blocked');
      const plan=prepareRestore(preview.sourceData,dateKey(this.now()));
      if(plan.raw!==preview.plan.raw)return {ok:false,reason:'date',message:messages.date,preview:this.preview({data:preview.sourceData,exportedAt:preview.exportedAt},preview.base)};
      const recoveryTarget=preview.emergency&&typeof preview.base.raw==='string'?{raw:preview.base.raw,capturedAt:this.now().toISOString()}:null;
      // Bound failed-attempt retention without ever evicting an older target.
      // Refuse a new write if keeping its preimage would exceed the budget.
      if(recoveryTarget&&!this.retainedRecoveries.some(target=>target.raw===recoveryTarget.raw)&&this.retainedRecoveries.length&&
        (this.retainedRecoveries.length>=8||this.retainedRecoveries.reduce((sum,target)=>sum+target.raw.length*2,0)+recoveryTarget.raw.length*2>32*1024*1024))throw error('retention-limit');
      const changed=this.status!=='ready'||plan.raw!==serializeState(this.state);
      const result=this._write(plan.raw,{recovery:preview.emergency});
      if(result.ok&&preview.emergency)this.retainedRecoveries=[]; // Includes recovery of a deleted key.
      else if(recoveryTarget){
          let target=this.retainedRecoveries.find(target=>target.raw===recoveryTarget.raw);
          if(!target){target=Object.freeze({...recoveryTarget,id:'retained-'+(++this.snapshotSequence),reason:result.reason});this.retainedRecoveries.push(target);}
          if(this.protection)this.protection=Object.freeze({...this.protection,targetId:target.id});
      }
      if(result.ok&&changed){this.engagedInSession=true;result.warning=this._metadata(meta=>({...meta,engaged:true}));}
      return result;
    });
  }
  _readForQuarantine(){
    try{const raw=this.storage.getItem(STORAGE_KEY);this._adopt(raw);return raw;}
    catch{this.observation='unreadable';this.currentCorruption=null;throw Object.assign(Error('保存先を読めず現在性を確認できないため、現在データの退避を停止しました。過去の保持対象は別の操作で退避してください'),{reason:'quarantine-unreadable'});}
  }
  _quarantineArtifact(target,source,currentMatch,checkedAt){
    const artifact=createQuarantine(target.raw,this.now());
    const file=new File([artifact.file],artifact.file.name.replace('corrupt-','corrupt-'+source+'-'+target.id+'-'),{type:artifact.file.type});
    return Object.freeze({...artifact,file,source,targetId:target.id,capturedAt:target.capturedAt,currentMatch,checkedAt});
  }
  quarantine(){
    // This API means CURRENT corruption only; no fallback to retained history.
    const expected=this.currentCorruption;
    if(!expected)throw Object.assign(Error('現在の破損スナップショットがありません。保存先の状態を再確認してください'),{reason:'quarantine-missing'});
    const raw=this._readForQuarantine();
    if(raw!==expected.raw||this.currentCorruption?.id!==expected.id)throw Object.assign(Error('退避対象と現在の保存先が変わりました。古いデータを現在のものとして出力せず停止しました。内容の状態を再確認してください'),{reason:'quarantine-conflict'});
    return this._quarantineArtifact(expected,'current',true,this.now().toISOString());
  }
  retainedQuarantine(id=this.protection?.targetId){
    const target=this.retainedRecoveries.find(target=>target.id===id);
    if(!target)throw Object.assign(Error('指定された過去の保持対象はありません'),{reason:'quarantine-missing'});
    let currentMatch=null;try{currentMatch=this._readForQuarantine()===target.raw;}catch{/* Historical bytes remain available, but currentness is unknown. */}
    return this._quarantineArtifact(target,'retained',currentMatch,this.now().toISOString());
  }
  verifyQuarantine(artifact){
    if(artifact.source==='retained'){
      if(!this.retainedRecoveries.some(target=>target.id===artifact.targetId&&target.raw===artifact.raw))throw Object.assign(Error('この保持対象は復旧完了により終了しています'),{reason:'quarantine-expired'});
      let currentMatch=null;try{currentMatch=this._readForQuarantine()===artifact.raw;}catch{/* Historical export makes no currentness claim. */}
      return {currentMatch,checkedAt:this.now().toISOString()};
    }
    if(artifact.source!=='current'||this._readForQuarantine()!==artifact.raw||this.currentCorruption?.id!==artifact.targetId)throw Object.assign(Error('準備後に保存先が変わりました。古い退避ファイルの保存を停止しました。現在のデータから準備し直してください'),{reason:'quarantine-conflict'});
    return {currentMatch:true,checkedAt:this.now().toISOString()};
  }
  quarantineInfo(){return this.currentCorruption?{available:true,id:this.currentCorruption.id,bytes:this.currentCorruption.raw.length*2,capturedAt:this.currentCorruption.capturedAt,observation:this.observation}:{available:false,bytes:null,capturedAt:null,observation:this.observation};}
  retainedQuarantineInfo(){return this.retainedRecoveries.map(target=>({id:target.id,bytes:target.raw.length*2,capturedAt:target.capturedAt,reason:target.reason}));}
  backupStatus(){
    try{const meta=parseMeta(this.storage.getItem(META_KEY));return meta.confirmed?{kind:'confirmed',at:meta.confirmed.at}:{kind:meta.engaged===null?'unknown':'unconfirmed'};}
    catch{return {kind:'unknown'};}
  }
  async confirmBackup(snapshot){
    if(this.protection)return {ok:false,reason:'unverified',message:messages.unverified};
    // The receipt always describes this prepared file, never current data.
    const digest=await dataDigest(snapshot.data);
    if(digest!==snapshot.digest)throw Error('バックアップの識別情報を確認できません');
    return this._lock(()=>{
      if(this.protection)return {ok:false,reason:'unverified',message:messages.unverified};
      const at=this.now().getTime();
      const warning=this._metadata(meta=>({...meta,confirmed:{at,digest,id:snapshot.id}}));
      if(warning)return {ok:false,message:'ファイルの保存確認日時を記録できませんでした。再試行してください'};
      this.clockBack=false;this.lastWall=at;return {ok:true};
    });
  }
  async reminder(){
    const now=this.now().getTime();if(now<this.lastWall)this.clockBack=true;this.lastWall=Math.max(now,this.lastWall);
    let meta;try{meta=parseMeta(this.storage.getItem(META_KEY));}catch{return {kind:'unknown'};}
    if(this.status!=='ready')return {kind:'none'};
    if(!meta.confirmed)return {kind:meta.engaged===true||this.engagedInSession?'first':meta.engaged===null?'unknown':'none'};
    if(this.clockBack||now<meta.confirmed.at)return {kind:'clock'};
    const digest=await dataDigest(this.state);
    return {kind:now-meta.confirmed.at>=BACKUP_INTERVAL&&digest!==meta.confirmed.digest?'due':'none'};
  }
}
