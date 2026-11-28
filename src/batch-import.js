import {LIMITS,MAX_EVENT_END,REPEATS,addDays,dateKey,newId,serializeState,taskRecurrences,validDate,validStamp,validateItem} from './model.js';

const MAX_BYTES=128*1024,MAX_ROWS=100,MAX_DEPTH=4;
const FORBIDDEN_KEYS=new Set(['__proto__','constructor','prototype']);
const COMMON_KEYS=['type','title','repeat'];
const TASK_KEYS=[...COMMON_KEYS,'due'];
const EVENT_KEYS=[...COMMON_KEYS,'allDay','start','end'];
const ALL_DAY_KEYS=[...COMMON_KEYS,'allDay','startDate','endDate'];
const INPUT_KEYS=new Set([...TASK_KEYS,...EVENT_KEYS,...ALL_DAY_KEYS]);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const issue=(code,message,field=null)=>({code,message,field});
function reject(code,message,line,field){
  throw Object.assign(new Error(message),{code,line,field});
}
const syntax=line=>reject('json','JSONの構文を確認してください',line);

// Inspect keys before JSON.parse can discard duplicates, and record the start
// line of each direct element of the root items array. JSON.parse owns grammar.
function inspect(text){
  const stack=[],lines=[];
  let line=1,rootKey=null;
  const whitespace=char=>char===' '||char==='\t'||char==='\r'||char==='\n';
  for(let i=0;i<text.length;i++){
    const char=text[i];
    if(whitespace(char)){
      if(char==='\r'||(char==='\n'&&text[i-1]!=='\r'))line++;
      continue;
    }
    const parent=stack.at(-1);
    if(parent?.rows&&parent.next&&char!==']'){
      if(lines.length===MAX_ROWS)reject('count','取り込みは1〜100件です',line);
      lines.push(line);parent.next=false;
    }
    if(char==='"'){
      const start=i++;
      while(i<text.length&&text[i]!=='"'){
        if(text[i]==='\\')i++;
        i++;
      }
      if(i>=text.length)syntax(line);
      if(parent?.keys){
        let after=i+1;
        while(whitespace(text[after]))after++;
        if(text[after]===':'){
          let key;
          try{key=JSON.parse(text.slice(start,i+1));}catch{syntax(line);}
          if(FORBIDDEN_KEYS.has(key))reject('key','許可されていない項目名です',line,key);
          if(parent.keys.has(key))reject('duplicate-key','同じ項目名が複数あります',line,key);
          parent.keys.add(key);
          if(stack.length===1)rootKey=key;
        }
      }
    }else if(char==='{'||char==='['){
      if(stack.length===MAX_DEPTH)reject('depth','JSONの入れ子は4階層までです',line);
      const rows=char==='['&&stack.length===1&&parent?.keys&&rootKey==='items';
      stack.push({char,keys:char==='{'?new Set():null,rows,next:true});
    }else if(char==='}'||char===']'){
      if(parent?.char!==(char==='}'?'{':'['))syntax(line);
      stack.pop();
    }else if(char===','&&parent?.rows){
      parent.next=true;
    }
  }
  if(stack.length)syntax(line);
  return lines;
}

// Rows retain their original positions. An editor can replace a row's input
// or explicitly omit the row, then prepare a fresh plan.
export function parseBatchImport(text){
  if(typeof text!=='string')reject('json','JSONの文字列を入力してください');
  if(text.length>MAX_BYTES||new TextEncoder().encode(text).byteLength>MAX_BYTES)
    reject('size','JSONはUTF-8で128KiB以下です');
  const lines=inspect(text);
  let envelope;
  try{envelope=JSON.parse(text);}catch{syntax();}
  if(!record(envelope)||Object.keys(envelope).length!==3||envelope.format!=='my-schedule-import'||
    envelope.formatVersion!==1||!Array.isArray(envelope.items))
    reject('format','一括取り込み専用JSONの形式を確認してください');
  if(!envelope.items.length||envelope.items.length>MAX_ROWS)reject('count','取り込みは1〜100件です');
  return envelope.items.map((input,index)=>({index,line:lines[index],input}));
}

function rowValues(input,report){
  if(!record(input))reject('item','項目はJSONオブジェクトで指定してください');
  // Report unknown keys even if the type itself has to be repaired. A row
  // editor must not silently discard unsupported data while fixing its type.
  for(const key of Object.keys(input)){
    if(!INPUT_KEYS.has(key))reject('key','この種類では使用できない項目です',null,key);
  }
  let keys=COMMON_KEYS,typed=false;
  if(input.type==='task'){keys=TASK_KEYS;typed=true;}
  else if(input.type==='event'&&typeof input.allDay==='boolean'){
    keys=input.allDay?ALL_DAY_KEYS:EVENT_KEYS;typed=true;
  }else if(input.type==='event')report('item','終日指定は true または false です','allDay');
  else report('item','種類は event または task です','type');
  if(typed)for(const key of Object.keys(input)){
    if(!keys.includes(key))reject('key','この種類では使用できない項目です',null,key);
  }
  for(const key of keys){
    if(!Object.hasOwn(input,key))report('required','必須項目がありません',key);
  }
  const title=typeof input.title==='string'?input.title.trim():'';
  if(!title||title.length>160)report('title','名称は1〜160文字です','title');
  if(typeof input.repeat!=='string'||!Object.hasOwn(REPEATS,input.repeat))
    report('repeat','繰り返しの指定が不正です','repeat');
  return {title,repeat:input.repeat};
}

function normalize(input,id,day){
  const errors=new Map();
  const report=(code,message,field)=>{
    if(!errors.has(field))errors.set(field,issue(code,message,field));
  };
  const {title,repeat}=rowValues(input,report);
  const item={id,type:input.type,title,repeat,excluded:[]};
  const requireDay=(key,field)=>{
    if(!validDate(key))report('date','2000〜2100年の実在する日付を指定してください',field);
  };
  if(item.type==='task'){
    if(input.due!==null)requireDay(input.due,'due');
    else if(typeof repeat==='string'&&Object.hasOwn(REPEATS,repeat)&&repeat!=='none')
      report('repeat','繰り返しタスクには初回期限が必要です','due');
    item.due=input.due;item.pinned=false;
  }else if(item.type==='event'&&typeof input.allDay==='boolean'){
    item.allDay=input.allDay;
    if(item.allDay){
      requireDay(input.startDate,'startDate');requireDay(input.endDate,'endDate');
      if(!errors.has('startDate')&&!errors.has('endDate')){
        if(input.endDate<input.startDate)report('date','終了日は開始日以降にしてください','endDate');
        item.start=input.startDate+'T00:00';item.end=addDays(input.endDate,1)+'T00:00';
        if(!validStamp(item.start))report('time','開始日の午前0時が端末のタイムゾーンに存在しません','startDate');
        if(!validStamp(item.end))report('time','最終日の翌日の午前0時が端末のタイムゾーンに存在しません','endDate');
      }
    }else{
      for(const key of ['start','end']){
        if(typeof input[key]!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input[key]))
          report('time','時刻は YYYY-MM-DDTHH:mm で指定してください',key);
        else if(!validStamp(input[key])||(key==='start'?!validDate(input[key].slice(0,10)):input[key]>MAX_EVENT_END))
          report('date','対応範囲内の実在する日時を指定してください',key);
        item[key]=input[key];
      }
    }
  }
  if(item.start&&item.end&&!errors.has('start')&&!errors.has('end')&&
    !errors.has('startDate')&&!errors.has('endDate')){
    const endField=item.allDay?'endDate':'end';
    if(item.end<=item.start)report('date','終了日時は開始日時より後にしてください',endField);
    else if(new Date(item.end)-new Date(item.start)>LIMITS.eventDays*86400000)
      report('date','予定は最大366日間です',endField);
  }
  if(errors.size)return {error:errors.values().next().value,errors:[...errors.values()]};
  const firstDay=item.type==='task'?item.due:item.start.slice(0,10);
  if(firstDay&&repeat!=='none'){
    item.anchorDay=Number(firstDay.slice(8));item.anchorMonth=Number(firstDay.slice(5,7));
  }
  validateItem(item);
  if(item.type==='event')return item.allDay?{item,endDate:input.endDate}:{item};
  const next=repeat!=='none'?taskRecurrences({items:[item],history:[]},day).get(id).due:input.due;
  // The existing rule retains an exhausted series and only advances a known due date.
  item.due=next??item.due;
  return {item,originalDue:input.due,registeredDue:item.due,noNext:repeat!=='none'&&next===null};
}

function duplicates(existing,candidates){
  const key=item=>JSON.stringify(item.type==='event'?
    [item.type,item.title.trim(),item.allDay,item.start,item.end]:
    [item.type,item.title.trim(),item.due]);
  const groups=new Map();
  for(const row of candidates){
    const identity=key(row.item);
    if(!groups.has(identity))groups.set(identity,{candidates:[],existing:[]});
    groups.get(identity).candidates.push({index:row.index,line:row.line,repeat:row.item.repeat});
  }
  for(const item of existing){
    groups.get(key(item))?.existing.push({id:item.id,repeat:item.repeat});
  }
  return [...groups.values()].filter(group=>group.existing.length||group.candidates.length>1);
}

function freeze(value){
  if(value&&typeof value==='object'){
    Object.values(value).forEach(freeze);Object.freeze(value);
  }
  return value;
}
const refusal=(reason,message,{reusable=false,recheck=false}={})=>
  ({ok:false,committed:false,verified:false,reason,message,reusable,recheck});
const dateChanged='端末の日付またはタイムゾーンが変わりました。確認し直してください';

// One importer per draft session. Plans and duplicate approval are scoped to
// this instance and never persisted.
export function createBatchImporter(store,{today=dateKey}={}){
  let active,approved=false,saving=false;
  const clock=()=>({day:today(),zone:new Intl.DateTimeFormat().resolvedOptions().timeZone});
  const sameClock=plan=>{
    const {day,zone}=clock();
    return plan.day===day&&plan.zone===zone;
  };
  function prepare(rows){
    if(saving)throw Error('一括登録の完了を待ってください');
    active=null;approved=false;
    if(!Array.isArray(rows)||!rows.length||rows.length>MAX_ROWS)reject('count','取り込みは1〜100件です');
    const {day,zone}=clock();
    if(!validDate(day))reject('date','端末の日付が対応範囲外です');
    const state=store.state,base=store.token();
    const used=new Set(state?.items.map(item=>item.id));
    for(const entry of state?.history??[]){
      used.add(entry.sourceId);used.add(entry.seriesId);
    }
    for(const entry of state?.notificationLink?.records??[])used.add(entry.itemId);
    for(const entry of state?.notificationLink?.legacyRemovals??[])used.add(entry.itemId);
    const entries=rows.map(({input,index,line})=>{
      try{
        let id;
        do{id=newId();}while(used.has(id));
        used.add(id);
        return {index,line,...normalize(input,id,day)};
      }catch(error){
        return {index,line,error:issue(error.code??'validation',error.message,error.field)};
      }
    });
    const candidates=entries.filter(row=>!row.error);
    const errors=[];
    if(!state||!store.writable)errors.push(issue('blocked','保存領域へ書き込めません'));
    if(state&&candidates.length===entries.length){
      if(state.items.length+candidates.length>LIMITS.items)errors.push(issue('capacity','予定・タスクは合計1000件までです'));
      else{
        try{serializeState({...state,items:[...state.items,...candidates.map(row=>row.item)]});}
        catch(error){errors.push(issue('state',error.message));}
      }
    }
    const plan=freeze({day,zone,rows:entries,errors,duplicates:duplicates(state?.items??[],candidates)});
    active={plan,base,items:candidates.map(row=>row.item)};
    return plan;
  }
  function approveDuplicates(plan){
    if(saving||!plan||active?.plan!==plan||!store.matches(active.base)||!sameClock(plan))return false;
    approved=true;return true;
  }
  async function save(plan){
    if(saving)return refusal('busy','一括登録中です');
    if(store.status==='unverified')return refusal('unverified','保存結果を確認できないため、一括登録を停止しています');
    if(!plan||active?.plan!==plan)return refusal('stale','取り込み内容を確認し直してください',{recheck:true});
    const {base,items}=active;
    const conflict=!store.matches(base),clockChanged=!sameClock(plan);
    if(conflict||clockChanged){
      active=null;approved=false;
      return conflict?refusal('conflict','保存データが変わりました。確認し直してください',{recheck:true}):
        refusal('date',dateChanged,{recheck:true});
    }
    if(plan.errors.length||plan.rows.some(row=>row.error))
      return refusal('validation','入力と保存上限を確認してください',{recheck:true});
    if(plan.duplicates.length&&!approved)
      return refusal('duplicates','重複候補の確認が必要です',{reusable:true});
    saving=true;active=null;approved=false;
    try{
      const result=await store.mutate(draft=>{draft.items.push(...items);},base,{
        checkBeforeWrite(){
          if(!sameClock(plan))throw Object.assign(Error(dateChanged),{reason:'date'});
        }
      });
      if(result.reason==='date')return refusal('date',dateChanged,{recheck:true});
      // Only a fresh preview may follow a definitive rejection. An uncertain
      // readback must remain blocked, even though its plan was also consumed.
      return {...result,committed:result.committed===null?null:result.committed===true,verified:result.verified===true,
        reusable:false,recheck:!result.ok&&result.committed!==null&&result.reason!=='unverified',
        count:result.ok?items.length:undefined};
    }finally{saving=false;}
  }
  return {prepare,approveDuplicates,save};
}
