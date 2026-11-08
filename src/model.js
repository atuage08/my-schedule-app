export const STORAGE_KEY = 'my-schedule.prototype.v1';
export const MIN_DATE = '2000-01-01';
export const MAX_DATE = '2100-12-31';
export const LIMITS = Object.freeze({ items: 1000, history: 10000, excluded: 512, totalExcluded: 4096, storageChars: 2000000, eventDays: 366 });
export const REPEATS = Object.freeze({ none: '繰り返さない', daily: '毎日', weekly: '毎週', biweekly: '2週間ごと', monthly: '毎月', yearly: '毎年' });
const DAY = 86400000;
const pad = n => String(n).padStart(2, '0');
const idValid = id => typeof id === 'string' && id.length > 0 && id.length <= 128;
function knownKeys(value, allowed) { if (Object.keys(value).some(key=>!allowed.includes(key))) throw Error('未対応の保存データ項目があります'); }
export const dateKey = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
export const localDate = key => new Date(key + 'T12:00:00');
export const clampDate = key => key < MIN_DATE ? MIN_DATE : key > MAX_DATE ? MAX_DATE : key;
function realDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(localDate(s).getTime()) && dateKey(localDate(s)) === s; }
export const validDate = s => realDate(s) && s >= MIN_DATE && s <= MAX_DATE;
function requireDate(s) { if (!realDate(s)) throw Error('日付の形式が不正です'); }
function ordinal(s) { requireDate(s); return Date.UTC(Number(s.slice(0,4)), Number(s.slice(5,7))-1, Number(s.slice(8,10))) / DAY; }
export function addDays(key, n) {
  requireDate(key);
  if (!Number.isInteger(n) || Math.abs(n) > 40000) throw Error('日数が範囲外です');
  const d = localDate(key); d.setDate(d.getDate()+n); return dateKey(d);
}
export function newId(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return Array.from(cryptoApi.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2,'0')).join('');
}
export function stamp(d) { return dateKey(d)+'T'+pad(d.getHours())+':'+pad(d.getMinutes()); }
function validStamp(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) && realDate(s.slice(0,10)) && stamp(new Date(s)) === s; }
export function defaults(selected, now = new Date()) {
  if (!validDate(selected)) throw Error('日付は2000〜2100年で指定してください');
  const start = localDate(selected);
  if (selected === dateKey(now)) {
    start.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
    start.setTime(Math.ceil(start.getTime()/600000)*600000);
  }
  return { start: stamp(start), end: stamp(new Date(start.getTime()+3600000)) };
}
export function shiftEnd(oldStart, oldEnd, newStart) {
  if (![oldStart, oldEnd, newStart].every(validStamp)) throw Error('時刻が不正です');
  return stamp(new Date(new Date(newStart).getTime()+new Date(oldEnd).getTime()-new Date(oldStart).getTime()));
}
function checkRepeat(repeat) { if (!Object.hasOwn(REPEATS, repeat)) throw Error('繰り返しの形式が不正です'); }
function anchors(day, month) {
  if (!Number.isInteger(day) || day < 1 || day > 31 || !Number.isInteger(month) || month < 1 || month > 12) throw Error('繰り返し基準日が不正です');
}
// Arithmetic indexing avoids walking through every occurrence since the series began.
function at(base, repeat, index, day, month) {
  if (index < 0) return null;
  let result;
  const step = {daily: 1, weekly: 7, biweekly: 14}[repeat];
  if (step) result = addDays(base, index * step);
  else if (repeat === 'none') result = index === 0 ? base : null;
  else {
    const total = Number(base.slice(0,4))*12 + Number(base.slice(5,7))-1 + (repeat === 'monthly' ? index : index*12);
    const year = Math.floor(total/12), m = repeat === 'yearly' ? month-1 : total%12;
    if (year > 2100) return null;
    result = `${year}-${pad(m+1)}-${pad(Math.min(day, new Date(year,m+1,0).getDate()))}`;
  }
  return result && validDate(result) ? result : null;
}
function indexNear(base, target, repeat) {
  const step = {daily:1, weekly:7, biweekly:14}[repeat];
  if (step) return Math.max(0, Math.floor((ordinal(target)-ordinal(base))/step));
  if (repeat === 'monthly') return Math.max(0, (Number(target.slice(0,4))-Number(base.slice(0,4)))*12+Number(target.slice(5,7))-Number(base.slice(5,7)));
  if (repeat === 'yearly') return Math.max(0, Number(target.slice(0,4))-Number(base.slice(0,4)));
  return 0;
}
export function nextDate(key, repeat, anchorDay = Number(key?.slice(8)), anchorMonth = Number(key?.slice(5,7))) {
  if (!validDate(key)) throw Error('日付は2000〜2100年で指定してください');
  checkRepeat(repeat); anchors(anchorDay, anchorMonth);
  return repeat === 'none' ? null : at(key, repeat, 1, anchorDay, anchorMonth);
}
function firstOnOrAfter(t, today, completed = new Set()) {
  const day = t.anchorDay ?? Number(t.due.slice(8)), month = t.anchorMonth ?? Number(t.due.slice(5,7));
  let index = indexNear(t.due, today, t.repeat);
  for (let attempts = 0; attempts <= t.excluded.length+completed.size+1; attempts++, index++) {
    const date = at(t.due, t.repeat, index, day, month);
    if (date === null) return null;
    if (date >= today && !t.excluded.includes(date) && !completed.has(date)) return date;
  }
  throw Error('除外日が多すぎます');
}
export function validateItem(x) {
  if (!x || !idValid(x.id) || typeof x.title !== 'string' || !x.title.trim() || x.title.length > 160) throw Error('名称を1〜160文字で入力してください');
  knownKeys(x,['id','title','type','start','end','allDay','due','pinned','repeat','excluded','anchorDay','anchorMonth','seriesId','eventSeriesId','exceptionDate']);
  if ([x.start,x.end].some(value=>value!==undefined&&(typeof value!=='string'||value.length>16))) throw Error('日時の形式が不正です');
  if ((x.due!==undefined&&x.due!==null&&!validDate(x.due)) || (x.pinned!==undefined&&typeof x.pinned!=='boolean') || (x.allDay!==undefined&&typeof x.allDay!=='boolean')) throw Error('項目の補助データが不正です');
  if (!['event','task'].includes(x.type)) throw Error('項目の形式が不正です');
  checkRepeat(x.repeat);
  if (!Array.isArray(x.excluded) || x.excluded.length > LIMITS.excluded || x.excluded.some(d=>!validDate(d)) || new Set(x.excluded).size !== x.excluded.length) throw Error('除外日が不正または多すぎます');
  if (x.type === 'event') {
    if (!validStamp(x.start) || !validDate(x.start.slice(0,10)) || !validStamp(x.end) || x.end > '2101-01-01T00:00' || x.end <= x.start || typeof x.allDay !== 'boolean') throw Error('開始・終了日時を2000〜2100年の範囲で指定してください');
    if (new Date(x.end)-new Date(x.start) > LIMITS.eventDays*DAY) throw Error('予定は最大366日間です');
    if (x.allDay && (x.start.slice(11) !== '00:00' || x.end.slice(11) !== '00:00')) throw Error('終日予定の時刻が不正です');
  } else {
    if (x.due !== null && !validDate(x.due)) throw Error('期限は2000〜2100年で指定してください');
    if (x.repeat !== 'none' && !x.due) throw Error('繰り返しタスクには初回期限が必要です');
    if (typeof x.pinned !== 'boolean') throw Error('ピン留めの形式が不正です');
  }
  if (x.anchorDay !== undefined || x.anchorMonth !== undefined) anchors(x.anchorDay ?? 1, x.anchorMonth ?? 1);
  if (x.seriesId !== undefined && !idValid(x.seriesId)) throw Error('シリーズIDが不正です');
  if (x.eventSeriesId !== undefined && (x.type !== 'event' || !idValid(x.eventSeriesId))) throw Error('予定シリーズIDが不正です');
  if (x.exceptionDate !== undefined && (x.type !== 'event' || !validDate(x.exceptionDate) || !x.eventSeriesId || x.eventSeriesId === x.id || x.repeat !== 'none')) throw Error('例外予定の関連付けが不正です');
  if (x.eventSeriesId !== undefined && x.eventSeriesId !== x.id && x.exceptionDate === undefined) throw Error('例外予定の元の日付が必要です');
  return x;
}
export function validateState(s) {
  if (!s || s.version !== 1 || !Array.isArray(s.items) || !Array.isArray(s.history) || s.items.length > LIMITS.items || s.history.length > LIMITS.history) throw Error('保存形式が不正、または保存件数の上限です');
  knownKeys(s,['version','items','history']);
  s.items.forEach(validateItem);
  if (new Set(s.items.map(x=>x.id)).size !== s.items.length) throw Error('IDが重複しています');
  const byId=new Map(s.items.map(item=>[item.id,item])), slots=new Set();
  for(const item of s.items) if(item.exceptionDate!==undefined){
    const parent=byId.get(item.eventSeriesId), slot=JSON.stringify([item.eventSeriesId,item.exceptionDate]);
    if(!parent||parent.type!=='event'||parent.exceptionDate!==undefined||(parent.eventSeriesId||parent.id)!==item.eventSeriesId)throw Error('例外予定の元シリーズが見つかりません');
    if(!parent.excluded.includes(item.exceptionDate)||slots.has(slot))throw Error('例外予定の対象回が不正または重複しています');
    slots.add(slot);
  }
  const series = s.items.filter(x=>x.type==='task' && x.repeat!=='none').map(x=>x.seriesId||x.id);
  if (new Set(series).size !== series.length) throw Error('未完了の繰り返しタスクが重複しています');
  let exclusions = s.items.reduce((sum,x)=>sum+x.excluded.length,0);
  const ids = new Set();
  for (const h of s.history) {
    if (!h || !idValid(h.id) || ids.has(h.id) || typeof h.title !== 'string' || !h.title.trim() || h.title.length > 160 || typeof h.completedAt !== 'string' || h.completedAt.length > 32 || !Number.isFinite(Date.parse(h.completedAt)) || (h.due !== null && !validDate(h.due))) throw Error('完了履歴が不正です');
    ids.add(h.id);
    knownKeys(h,['id','title','due','completedAt','sourceId','seriesId','task','restoredAt']);
    if(h.task===undefined&&(h.sourceId!==undefined||h.seriesId!==undefined||h.restoredAt!==undefined))throw Error('履歴の復元情報が不足しています');
    if (h.task !== undefined) {
      validateItem(h.task);
      if (h.task.type !== 'task' || h.title !== h.task.title || h.due !== h.task.due || h.sourceId !== h.task.id || h.seriesId !== (h.task.seriesId||h.task.id)) throw Error('復元情報が一致しません');
      exclusions += h.task.excluded.length;
    }
    if (h.restoredAt !== undefined && (typeof h.restoredAt !== 'string' || h.restoredAt.length > 32 || !Number.isFinite(Date.parse(h.restoredAt)))) throw Error('復元履歴が不正です');
  }
  if (exclusions > LIMITS.totalExcluded) throw Error('繰り返しの除外データが多すぎます');
  return s;
}
export function parseState(raw) {
  if (typeof raw !== 'string' || raw.length > LIMITS.storageChars) throw Error('保存データが大きすぎます');
  return validateState(JSON.parse(raw));
}
export function serializeState(state) {
  validateState(state);
  const raw = JSON.stringify(state);
  if (raw.length > LIMITS.storageChars) throw Error('保存容量の上限です。データは変更していません');
  return raw;
}
export function rollTasks(state, today = dateKey()) {
  if (!validDate(today)) throw Error('日付が範囲外です');
  validateState(state);
  const completed=new Map();
  for(const h of state.history) if(h.task&&h.task.repeat!=='none'&&!h.restoredAt){
    if(!completed.has(h.seriesId))completed.set(h.seriesId,new Set());
    completed.get(h.seriesId).add(h.due);
  }
  const exhausted = new Set();
  for (const t of state.items) if (t.type === 'task' && t.repeat !== 'none') {
    t.anchorDay ??= Number(t.due.slice(8)); t.anchorMonth ??= Number(t.due.slice(5,7));
    const due = firstOnOrAfter(t, today, completed.get(t.seriesId||t.id));
    if (due === null) exhausted.add(t.id); else t.due = due;
  }
  state.items = state.items.filter(t=>!exhausted.has(t.id));
  return state;
}
function completeDraft(state, id, now) {
  validateState(state);
  const t = state.items.find(x=>x.id === id);
  if (!t || t.type !== 'task') return;
  if (state.history.length >= LIMITS.history) throw Error('完了履歴の保存上限です');
  const snapshot = structuredClone(t);
  const history = {id:newId(), title:t.title, due:t.due, completedAt:now.toISOString(), sourceId:t.id, seriesId:t.seriesId||t.id, task:snapshot};
  const due = t.repeat === 'none' ? null : nextDate(t.due,t.repeat,t.anchorDay,t.anchorMonth);
  if (due === null) state.items = state.items.filter(x=>x.id!==id);
  else { t.anchorDay ??= Number(t.due.slice(8)); t.anchorMonth ??= Number(t.due.slice(5,7)); t.due=due; }
  state.history.push(history);
  rollTasks(state,dateKey(now));
}
function restoreDraft(state, historyId, now) {
  validateState(state);
  const h = state.history.find(x=>x.id===historyId);
  if (!h || h.restoredAt) throw Error('この履歴は復元済み、または見つかりません');
  if (!h.task) throw Error('旧形式の履歴には元タスクの情報がなく、安全に復元できません');
  const pending = state.items.find(x=>x.type==='task' && (x.id===h.sourceId || (x.seriesId||x.id)===h.seriesId));
  if (!pending) {
    if (state.items.length >= LIMITS.items) throw Error('タスク件数の上限です');
    if (state.items.some(x=>x.id===h.sourceId)) throw Error('元タスクIDがほかの項目で使用されています');
    const t = structuredClone(h.task);
    if (t.repeat !== 'none') t.seriesId=h.seriesId;
    state.items.push(t);
  }
  // Mark this completion as undone before calculating; other completed occurrences stay skipped.
  h.restoredAt=now.toISOString();
  // A recurring series retains one latest incomplete task; don't rewind another occurrence.
  rollTasks(state,dateKey(now));
  if (!state.items.some(x=>x.type==='task' && (x.id===h.sourceId || (x.seriesId||x.id)===h.seriesId))) throw Error('日付範囲内に復元できる回がありません');
  return h;
}
export function eventOn(item, day) {
  if (item.type !== 'event') return null;
  validateItem(item);
  if (!realDate(day) || day < MIN_DATE || day > MAX_DATE) return null;
  const base=item.start.slice(0,10), duration=new Date(item.end)-new Date(item.start);
  if (day < base) return null;
  let index=indexNear(base,day,item.repeat);
  for (let checks=0; checks<=LIMITS.eventDays+1 && index>=0; checks++,index--) {
    const occurrence=at(base,item.repeat,index,item.anchorDay??Number(base.slice(8)),item.anchorMonth??Number(base.slice(5,7)));
    if (!occurrence || occurrence>day) continue;
    const start=occurrence+item.start.slice(10), end=stamp(new Date(new Date(start).getTime()+duration));
    if (end <= day+'T00:00') break;
    if (!item.excluded.includes(occurrence)) return {...item,start,end,occurrence};
  }
  return null;
}
export function dueGroups(tasks, today=dateKey()) {
  if (!validDate(today)) throw Error('日付が範囲外です');
  const groups=new Map(['期限超過','今日','今後7日以内','それ以降'].map(label=>[label,[]]));
  const end=addDays(today,7);
  for (const task of tasks) {
    validateItem(task);
    if (task.type!=='task' || !task.due) continue;
    const label=task.due<today?'期限超過':task.due===today?'今日':task.due<=end?'今後7日以内':'それ以降';
    groups.get(label).push(task);
  }
  for (const list of groups.values()) list.sort((a,b)=>a.due.localeCompare(b.due));
  return groups;
}
// Week and month views use this same bounded, presentation-independent calculation.
export function calendarIndicators(items,days){
  if(!Array.isArray(items)||items.length>LIMITS.items||!Array.isArray(days)||days.length>42)throw Error('カレンダーの表示範囲が大きすぎます');
  items.forEach(validateItem);
  const events=items.filter(item=>item.type==='event');
  const deadlines=new Set(items.filter(item=>item.type==='task'&&item.due!==null).map(item=>item.due));
  return new Map(days.map(day=>{
    requireDate(day);
    return [day,{hasEvent:validDate(day)&&events.some(item=>eventOn(item,day)!==null),hasTask:validDate(day)&&deadlines.has(day)}];
  }));
}
// Shared by the confirmation UI and the actual deletion. No title/date guessing.
export function deletionPlan(state,id,scope='all',occurrence=null){
  validateState(state);
  const item=state.items.find(x=>x.id===id);
  if(!item)throw Error('削除対象が見つかりません');
  if(!['one','all'].includes(scope))throw Error('削除範囲が不正です');
  if(item.type==='event'){
    const family=item.eventSeriesId||item.id;
    const related=state.items.filter(x=>x.type==='event'&&(x.id===family||x.eventSeriesId===family));
    if(scope==='all'&&(item.repeat!=='none'||item.eventSeriesId!==undefined))return {kind:'event-series',itemIds:related.map(x=>x.id),exceptionCount:related.filter(x=>x.exceptionDate!==undefined).length};
    if(item.exceptionDate!==undefined)return {kind:'event-exception',itemIds:[item.id],exceptionCount:0,occurrence:item.exceptionDate};
    if(item.repeat!=='none'){
      const replacements=related.filter(x=>x.exceptionDate===occurrence);
      const active=validDate(occurrence)?eventOn(item,occurrence):null;
      if(!validDate(occurrence)||(!(active&&active.occurrence===occurrence)&&!(item.excluded.includes(occurrence)&&replacements.length)))throw Error('削除する回の日付が不正です');
      return {kind:'event-occurrence',itemIds:replacements.map(x=>x.id),exceptionCount:replacements.length,occurrence};
    }
    if(related.some(x=>x.id!==item.id))throw Error('関連する例外予定があるため「すべて」を選んでください');
  }
  return {kind:item.type==='task'&&item.repeat!=='none'?(scope==='one'?'task-occurrence':'task-series'):'item',itemIds:[item.id],exceptionCount:0,occurrence:item.due};
}
function removeDraft(state,id,scope,occurrence) {
  const plan=deletionPlan(state,id,scope,occurrence);
  const item=state.items.find(x=>x.id===id);
  if(plan.kind==='event-occurrence'){
    if(!item.excluded.includes(occurrence)){
      if(item.excluded.length>=LIMITS.excluded)throw Error('除外日の上限です');
      item.excluded.push(occurrence);
    }
    const ids=new Set(plan.itemIds);
    state.items=state.items.filter(x=>!ids.has(x.id));
  } else if(plan.kind==='task-occurrence') {
    const due=nextDate(item.due,item.repeat,item.anchorDay,item.anchorMonth);
    if (due) {item.anchorDay??=Number(item.due.slice(8));item.anchorMonth??=Number(item.due.slice(5,7));item.due=due;}
    else state.items=state.items.filter(x=>x.id!==id);
  } else {
    const ids=new Set(plan.itemIds);
    state.items=state.items.filter(x=>!ids.has(x.id));
  }
}
function editEventOccurrenceDraft(state,id,replacement,occurrence){
  validateState(state);
  const parent=state.items.find(x=>x.id===id);
  if(!parent||parent.type!=='event'||parent.repeat==='none'||parent.exceptionDate!==undefined)throw Error('繰り返し予定の元シリーズを選んでください');
  if(replacement.type!=='event')throw Error('例外予定の形式が不正です');
  removeDraft(state,id,'one',occurrence);
  parent.eventSeriesId=parent.id;
  const exception={...structuredClone(replacement),id:newId(),repeat:'none',excluded:[],eventSeriesId:parent.id,exceptionDate:occurrence};
  state.items.push(exception);
  return exception.id;
}
function transaction(state, action) {
  validateState(state);
  const draft=structuredClone(state);
  const result=action(draft);
  serializeState(draft);
  state.items=draft.items;
  state.history=draft.history;
  return result;
}
export function complete(state,id,now=new Date()) { return transaction(state,draft=>completeDraft(draft,id,now)); }
export function restore(state,id,now=new Date()) { return transaction(state,draft=>restoreDraft(draft,id,now)); }
export function removeItem(state,id,scope='all',occurrence=null) { return transaction(state,draft=>removeDraft(draft,id,scope,occurrence)); }
export function editEventOccurrence(state,id,replacement,occurrence){return transaction(state,draft=>editEventOccurrenceDraft(draft,id,replacement,occurrence));}
export function seed(today=dateKey()) {
  return {version:1,items:[
    {id:'sample-event-1',type:'event',title:'週末のプランを考える',start:today+'T10:00',end:today+'T11:00',allDay:false,repeat:'none',excluded:[]},
    {id:'sample-event-2',type:'event',title:'カフェでひと休み',start:today+'T15:00',end:today+'T16:00',allDay:false,repeat:'none',excluded:[]},
    {id:'sample-task-1',type:'task',title:'来週の買いものリスト',due:today,pinned:false,repeat:'none',excluded:[]},
    {id:'sample-task-2',type:'task',title:'読みたい本を探す',due:addDays(today,1),pinned:false,repeat:'none',excluded:[]},
    {id:'sample-task-3',type:'task',title:'行ってみたい場所をまとめる',due:null,pinned:true,repeat:'none',excluded:[]},
    {id:'sample-task-4',type:'task',title:'写真をアルバムにする',due:null,pinned:false,repeat:'none',excluded:[]}
  ],history:[]};
}
