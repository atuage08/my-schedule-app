import {NOTIFICATIONS_ENABLED,assertBasicMutation} from './features.js';
import {validateLink,stageV3} from './notification-v3.js';
export const STORAGE_KEY = 'my-schedule.prototype.v1';
export const MIN_DATE = '2000-01-01';
export const MAX_DATE = '2100-12-31';
export const MAX_EVENT_END = '2101-01-01T00:00';
export const LIMITS = Object.freeze({ items: 1000, history: 10000, excluded: 512, totalExcluded: 4096, storageChars: 2000000, eventDays: 366 });
export const REPEATS = Object.freeze({ none: '繰り返さない', daily: '毎日', weekly: '毎週', biweekly: '2週間ごと', monthly: '毎月', yearly: '毎年' });
const DAY = 86400000;
const DAY_STEPS = {daily:1, weekly:7, biweekly:14};
const pad = n => String(n).padStart(2, '0');
const idValid = id => typeof id === 'string' && id.length > 0 && id.length <= 128;
function knownKeys(value, allowed) { if (Object.keys(value).some(key=>!allowed.includes(key))) throw Error('未対応の保存データ項目があります'); }
export const dateKey = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
export const localDate = key => new Date(key + 'T12:00:00');
export const clampDate = key => key < MIN_DATE ? MIN_DATE : key > MAX_DATE ? MAX_DATE : key;
function realDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(localDate(s).getTime()) && dateKey(localDate(s)) === s; }
export const validDate = s => realDate(s) && s >= MIN_DATE && s <= MAX_DATE;
function requireDate(s) { if (!realDate(s)) throw Error('日付の形式が不正です'); }
function calendarOrdinal(s) { return Date.UTC(Number(s.slice(0,4)), Number(s.slice(5,7))-1, Number(s.slice(8,10))) / DAY; }
function calendarDate(n) { return new Date(n*DAY).toISOString().slice(0,10); }
function ordinal(s) { requireDate(s); return calendarOrdinal(s); }
export function addDays(key, n) {
  requireDate(key);
  if (!Number.isInteger(n) || Math.abs(n) > 40000) throw Error('日数が範囲外です');
  const d = localDate(key); d.setDate(d.getDate()+n); return dateKey(d);
}
export function previousLocalDate(key) {
  let day=ordinal(key)-1;
  // A skipped civil date must not normalize forward to the exclusive end.
  while(!realDate(calendarDate(day)))day--;
  return calendarDate(day);
}
export function newId(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return Array.from(cryptoApi.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2,'0')).join('');
}
export function stamp(d) { return dateKey(d)+'T'+pad(d.getHours())+':'+pad(d.getMinutes()); }
export function validStamp(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) && realDate(s.slice(0,10)) && stamp(new Date(s)) === s; }
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
// Recurrence indices refer to nominal calendar dates, even in a timezone
// that skipped a whole day. A null here means the series has no later slot.
function recurrenceDate(base, repeat, index, day, month, baseDay=calendarOrdinal(base)) {
  if (index < 0) return null;
  let result;
  const step = DAY_STEPS[repeat];
  if (step) result = calendarDate(baseDay + index * step);
  else if (repeat === 'none') result = index === 0 ? base : null;
  else {
    const total = Number(base.slice(0,4))*12 + Number(base.slice(5,7))-1 + (repeat === 'monthly' ? index : index*12);
    const year = Math.floor(total/12), m = repeat === 'yearly' ? month-1 : total%12;
    if (year > 2100) return null;
    result = `${year}-${pad(m+1)}-${pad(Math.min(day, new Date(Date.UTC(year,m+1,0)).getUTCDate()))}`;
  }
  return result && result<=MAX_DATE ? result : null;
}
function indexNear(base, target, repeat) {
  const step = DAY_STEPS[repeat];
  if (step) return Math.max(0, Math.floor((calendarOrdinal(target)-calendarOrdinal(base))/step));
  if (repeat === 'monthly') return Math.max(0, (Number(target.slice(0,4))-Number(base.slice(0,4)))*12+Number(target.slice(5,7))-Number(base.slice(5,7)));
  if (repeat === 'yearly') return Math.max(0, Number(target.slice(0,4))-Number(base.slice(0,4)));
  return 0;
}
export function nextDate(key, repeat, anchorDay = Number(key?.slice(8)), anchorMonth = Number(key?.slice(5,7))) {
  if (!validDate(key)) throw Error('日付は2000〜2100年で指定してください');
  checkRepeat(repeat); anchors(anchorDay, anchorMonth);
  return repeat === 'none' ? null : nextTaskSlot(key,repeat,1,anchorDay,anchorMonth);
}
function nextTaskSlot(base,repeat,index,day,month,accept=()=>true){
  const baseDay=calendarOrdinal(base);
  // A missing local date is skipped without changing the series origin.
  // recurrenceDate ends the search at the supported calendar boundary.
  for(;;index++){
    const date=recurrenceDate(base,repeat,index,day,month,baseDay);
    if(!date)return null;
    if(validDate(date)&&accept(date))return date;
  }
}
function firstOnOrAfter(t, today, completed = new Set()) {
  const day = t.anchorDay ?? Number(t.due.slice(8)), month = t.anchorMonth ?? Number(t.due.slice(5,7));
  return nextTaskSlot(t.due,t.repeat,indexNear(t.due,today,t.repeat),day,month,
    date=>date>=today&&!t.excluded.includes(date)&&!completed.has(date));
}
export function validateItem(x) {
  if (!x || !idValid(x.id) || typeof x.title !== 'string' || !x.title.trim() || x.title.length > 160) throw Error('名称を1〜160文字で入力してください');
  knownKeys(x,['id','title','type','start','end','allDay','due','pinned','repeat','excluded','anchorDay','anchorMonth','seriesId','eventSeriesId','exceptionDate','notification']);
  if ([x.start,x.end].some(value=>value!==undefined&&(typeof value!=='string'||value.length>16))) throw Error('日時の形式が不正です');
  if ((x.due!==undefined&&x.due!==null&&!validDate(x.due)) || (x.pinned!==undefined&&typeof x.pinned!=='boolean') || (x.allDay!==undefined&&typeof x.allDay!=='boolean')) throw Error('項目の補助データが不正です');
  if (!['event','task'].includes(x.type)) throw Error('項目の形式が不正です');
  checkRepeat(x.repeat);
  if (!Array.isArray(x.excluded) || x.excluded.length > LIMITS.excluded || x.excluded.some(d=>!validDate(d)) || new Set(x.excluded).size !== x.excluded.length) throw Error('除外日が不正または多すぎます');
  if (x.type === 'event') {
    if (!validStamp(x.start) || !validDate(x.start.slice(0,10)) || !validStamp(x.end) || x.end > MAX_EVENT_END || x.end <= x.start || typeof x.allDay !== 'boolean') throw Error('開始・終了日時を2000〜2100年の範囲で指定してください');
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
  if(Object.hasOwn(x,'notification')){
    if(x.type!=='event'||x.repeat!=='none'||x.eventSeriesId!==undefined||x.exceptionDate!==undefined)throw Error('通知設定は通常予定だけに対応します');
    validateNotification(x.notification);
  }
  return x;
}
export function validateNotification(value){
  if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='enabled,notifyAt'||typeof value.enabled!=='boolean')throw Error('通知設定の形式が不正です');
  if(!value.enabled){if(value.notifyAt!==null)throw Error('通知なしの日時は空にしてください');return value;}
  if(typeof value.notifyAt!=='string'||!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(value.notifyAt))throw Error('通知日時が不正です');
  const date=new Date(value.notifyAt);
  if(!Number.isFinite(date.getTime())||date.toISOString()!==value.notifyAt)throw Error('通知日時が不正です');
  return value;
}
export function notificationSettings(item){return item.notification===undefined?{enabled:false,notifyAt:null}:{...validateNotification(item.notification)};}
export function notificationFromLocal(enabled,value,previous,now=new Date()){
  if(typeof enabled!=='boolean')throw Error('通知の有無を確認してください');
  if(!enabled)return {enabled:false,notifyAt:null};
  if(typeof value!=='string'||!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw Error('通知日時を指定してください');
  const date=new Date(value);
  if(!Number.isFinite(date.getTime())||stamp(date)!==value)throw Error('通知日時が不正です');
  const result=validateNotification({enabled:true,notifyAt:date.toISOString()});
  if(!Number.isFinite(now.getTime())||(date<=now&&previous?.notifyAt!==result.notifyAt))throw Error('通知日時は未来を指定してください');
  return result;
}
export function validateState(s) {
  if (!s || ![1,2,3].includes(s.version) || !Array.isArray(s.items) || !Array.isArray(s.history) || s.items.length > LIMITS.items || s.history.length > LIMITS.history) throw Error('保存形式が不正、または保存件数の上限です');
  knownKeys(s,s.version===3?['version','items','history','notificationLink']:['version','items','history']);
  if(s.version===3)validateLink(s.notificationLink);
  s.items.forEach(validateItem);

  if(s.version===1&&s.items.some(item=>Object.hasOwn(item,'notification')))throw Error('通知設定には保存形式v2が必要です');
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
function validateNotificationState(s){
  if(s.version===3)for(const record of s.notificationLink.records){
    const item=s.items.find(item=>item.id===record.itemId),d=record.desired;
    if(d.enabled&&(!item||item.type!=='event'||item.repeat!=='none'||!item.notification?.enabled||item.title!==d.title||item.notification.notifyAt!==d.notifyAt)||!d.enabled&&item?.notification?.enabled)throw Error('通知希望と予定が一致しません');
  }
  return s;
}
export function parseState(raw) {
  if (typeof raw !== 'string' || raw.length > LIMITS.storageChars) throw Error('保存データが大きすぎます');
  return validateNotificationState(validateState(JSON.parse(raw)));
}
export function serializeState(state) {
  validateNotificationState(validateState(state));
  const raw = JSON.stringify(state);
  if (raw.length > LIMITS.storageChars) throw Error('保存容量の上限です。データは変更していません');
  return raw;
}
function completedTaskDates(state) {
  const completed=new Map();
  for(const h of state.history) if(h.task&&h.task.repeat!=='none'&&!h.restoredAt){
    if(!completed.has(h.seriesId))completed.set(h.seriesId,new Set());
    completed.get(h.seriesId).add(h.due);
  }
  return completed;
}
export function taskRecurrences(state, today = dateKey()) {
  const results = new Map();
  if (!validDate(today)) return results;
  const completed = completedTaskDates(state);
  for (const t of state.items) if (t.type === 'task' && t.repeat !== 'none') {
    const dates = completed.get(t.seriesId || t.id);
    results.set(t.id, {
      due: firstOnOrAfter(t, today, dates),
      blocked: t.excluded.includes(t.due) || dates?.has(t.due) === true,
    });
  }
  return results;
}
export function rollTasks(state, today = dateKey()) {
  if (!validDate(today)) throw Error('日付が範囲外です');
  validateState(state);
  const recurrences = taskRecurrences(state, today);
  for (const task of state.items) {
    const due = recurrences.get(task.id)?.due;
    if (!due) continue;
    task.anchorDay ??= Number(task.due.slice(8));
    task.anchorMonth ??= Number(task.due.slice(5,7));
    task.due = due;
  }
  return state;
}
function completeDraft(state, id, now) {
  validateState(state);
  const t = state.items.find(x=>x.id === id);
  if (!t || t.type !== 'task') return;
  if (t.repeat !== 'none' && (t.excluded.includes(t.due) || completedTaskDates(state).get(t.seriesId || t.id)?.has(t.due))) {
    throw Error('完了済みまたは除外済みの回は完了できません');
  }
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
  const restored = state.items.find(x=>x.type==='task' && (x.id===h.sourceId || (x.seriesId||x.id)===h.seriesId));
  if (!restored || (restored.repeat !== 'none' && firstOnOrAfter(restored, dateKey(now), completedTaskDates(state).get(restored.seriesId || restored.id)) === null)) {
    throw Error('日付範囲内に復元できる回がありません');
  }
  return h;
}
function localCalendarDate(dayNumber){
  const day=calendarDate(dayNumber);
  return validDate(day)?day:null;
}
function eventSlot(item, base, index, localDay=localCalendarDate, baseDay=calendarOrdinal(base)) {
  const step=DAY_STEPS[item.repeat];
  if(step){
    // Advance the nominal calendar date first. A missing local day is an
    // absent slot and must not be normalized onto the next scheduled day.
    return localDay(baseDay+index*step);
  }
  const date=recurrenceDate(base,item.repeat,index,item.anchorDay??Number(base.slice(8)),item.anchorMonth??Number(base.slice(5,7)),baseDay);
  return validDate(date)?date:null;
}
function repeatedLocalTime(instant, value){
  const nextDay=new Date(instant.getTime()+DAY);
  const minutes=nextDay.getTimezoneOffset()-instant.getTimezoneOffset();
  return minutes>0&&stamp(new Date(instant.getTime()+minutes*60_000))===value;
}
function eventTimes(item) {
  const base=item.start.slice(0,10),clock=item.start.slice(10);
  if(item.allDay){
    const days=ordinal(item.end.slice(0,10))-ordinal(item.start.slice(0,10));
    return day=>{
      const start=day+clock,end=calendarDate(calendarOrdinal(day)+days)+'T00:00';
      if(day!==base&&(!validStamp(start)||!validStamp(end)))return {start,end,warning:'clock'};
      return {start,end,warning:end>MAX_EVENT_END?'end-limit':null};
    };
  }
  const duration=new Date(item.end)-new Date(item.start);
  return day=>{
    if(day===base)return {start:item.start,end:item.end};
    const start=day+clock;
    const instant=new Date(start),endInstant=new Date(instant.getTime()+duration),end=stamp(endInstant);
    // A gap normalizes the start. A clock change can also make the end
    // round-trip to the wrong instant when saved as a local timestamp.
    if(stamp(instant)!==start||end<=start||new Date(end).getTime()!==endInstant.getTime()||
      repeatedLocalTime(instant,start)||repeatedLocalTime(endInstant,end))
      return {start,end,warning:'clock'};
    return {start,end,warning:end>MAX_EVENT_END?'end-limit':null};
  };
}
// A moved exception keeps its original slot in exceptionDate. occurrence is its actual start day.
export function eventOccurrence(item, originalDay) {
  if (item.type !== 'event' || !validDate(originalDay)) return null;
  validateItem(item);
  const base=item.start.slice(0,10);
  const day=item.exceptionDate === undefined ? originalDay : base;
  if (day<base || (item.exceptionDate!==undefined&&item.exceptionDate!==originalDay) || item.excluded.includes(day)) return null;
  const index=indexNear(base,day,item.repeat);
  if (eventSlot(item,base,index)!==day) return null;
  const {start,end,warning}=eventTimes(item)(day);
  return warning?null:{...item,start,end,occurrence:day};
}
function* eventsInRange(item, first, last, {ascending=false, from=null, includeWarnings=false, localDay, incremental=false}={}) {
  if (item.type !== 'event') return;
  validateItem(item);
  const base=item.start.slice(0,10),timesAt=eventTimes(item);
  if (last<base) return;
  const baseDay=ordinal(base);
  const slotAt=index=>eventSlot(item,base,index,localDay,baseDay);
  const warningRow=includeWarnings&&(!from||base>=from)&&item.end>first+'T00:00'&&
    slotAt(0)!==base&&!item.excluded.includes(base)
    ? {...item,occurrence:base,warning:'anchor',storedStart:item.start,storedEnd:item.end} : null;
  // The timed duration can cross a clock change. Leave room for the change
  // and for occurrences that start late in the preceding calendar day.
  const days=Math.max(ordinal(item.end.slice(0,10))-baseDay,
    Math.ceil((new Date(item.end)-new Date(item.start))/DAY))+2;
  const firstDay=ordinal(first);
  const earliest=calendarDate(firstDay-Math.min(days,Math.max(0,firstDay-baseDay)));
  const lower=ascending&&from&&from>earliest?from:earliest;
  const firstIndex=ascending?indexNear(base,lower,item.repeat):0;
  const lastIndex=indexNear(base,last,item.repeat);
  if(ascending&&warningRow)yield warningRow;
  for(let index=ascending?firstIndex:lastIndex;index>=firstIndex&&index<=lastIndex;index+=ascending?1:-1){
    if(incremental)yield null;
    const occurrence=slotAt(index);
    if (!occurrence || occurrence>last) continue;
    // A legacy anchor may point before the persisted start. That slot has no editable identity.
    if(occurrence<base||(ascending&&occurrence<lower))continue;
    const {start,end,warning}=timesAt(occurrence);
    const overlaps=end>first+'T00:00';
    if(!overlaps&&occurrence<first){
      if(!ascending)break;
      continue;
    }
    if(item.excluded.includes(occurrence))continue;
    if(!warning)yield {...item,start,end,occurrence};
    else if(includeWarnings&&(warning==='end-limit'?overlaps:occurrence>=first))
      yield {...item,start,end,occurrence,warning,storedStart:item.start,storedEnd:item.end};
  }
  if(!ascending&&warningRow)yield warningRow;
}
export function eventOn(item, day) {
  return validDate(day) ? eventsInRange(item,day,day).next().value??null : null;
}
export function eventOccurrences(item, first, last) {
  if (!realDate(first)||!realDate(last)||first>last||ordinal(last)-ordinal(first)>=42)
    throw Error('カレンダーの表示範囲が不正です');
  if(last<MIN_DATE||first>MAX_DATE)return [];
  return [...eventsInRange(item,clampDate(first),clampDate(last))].reverse();
}

const CALENDAR_PRIORITY={'multi-day':0,timed:1,task:2,'all-day':3};
function compareCalendarEntries(a,b){
  const byKind=CALENDAR_PRIORITY[a.kind]-CALENDAR_PRIORITY[b.kind];
  if(byKind)return byKind;
  if(a.start!==b.start)return a.start<b.start?-1:1;
  if(a.occurrenceDate!==b.occurrenceDate)return a.occurrenceDate<b.occurrenceDate?-1:1;
  return a.id===b.id?0:a.id<b.id?-1:1;
}
function keepCalendarEntry(top,entry){
  if(!top[0]||compareCalendarEntries(entry,top[0])<0){
    if(top[0])top[1]=top[0];
    top[0]=entry;
  }else if(!top[1]||compareCalendarEntries(entry,top[1])<0)top[1]=entry;
}

// Dates are inclusive grid bounds. Keep nominal cells, including disabled
// cells at the supported limits or on a day missing in the local timezone.
function* calendarSummarySteps(items, first, last, incremental=false){
  const gridDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&
    calendarDate(calendarOrdinal(value))===value;
  if(!Array.isArray(items)||items.length>LIMITS.items||!gridDate(first)||!gridDate(last))
    throw Error('カレンダーの表示範囲が不正です');
  const origin=calendarOrdinal(first),length=calendarOrdinal(last)-origin+1;
  if(length<1||length>42)throw Error('カレンダーの表示範囲が不正です');
  const days=Array.from({length},(_,i)=>{
    const date=calendarDate(origin+i);
    return {date,enabled:validDate(date),totalCount:0,top:[],hiddenCount:0,hasWarning:false,hasEvent:false,hasTask:false};
  });
  const firstValid=days.find(day=>day.enabled)?.date,lastValid=days.findLast(day=>day.enabled)?.date;
  const bars=[];
  if(!firstValid)return {days,bars};

  const counts=new Int32Array(length+1),warnings=new Int32Array(length+1),tasks=new Int32Array(length+1);
  // Store top candidates on disjoint tree intervals. Long events covering
  // the whole grid compete at the root once, without visiting every day.
  const tree=Array.from({length:4*length},()=>[]);
  function addCandidate(node,left,right,from,to,entry){
    if(from<=left&&right<=to){keepCalendarEntry(tree[node],entry);return;}
    const mid=Math.floor((left+right)/2);
    if(from<mid)addCandidate(node*2,left,mid,from,to,entry);
    if(to>mid)addCandidate(node*2+1,mid,right,from,to,entry);
  }
  function record(entry,startDay,endDay,count=1,second=null){
    const from=Math.max(0,startDay-origin),to=Math.min(length,endDay-origin+1);
    if(from>=to)return;
    counts[from]+=count;counts[to]-=count;
    if(entry.warning){warnings[from]+=count;warnings[to]-=count;}
    if(entry.kind==='task'){tasks[from]++;tasks[to]--;}
    addCandidate(1,0,length,from,to,entry);
    if(second)addCandidate(1,0,length,from,to,second);
  }
  const ids=new Set(),patterns=new Map();
  for(const item of items){
    if(incremental)yield;
    validateItem(item);
    if(ids.has(item.id))throw Error('IDが重複しています');
    ids.add(item.id);
    if(item.type!=='event'){
      if(item.due&&item.due>=firstValid&&item.due<=lastValid){
        const due=calendarOrdinal(item.due);
        record({id:item.id,title:item.title,kind:'task',start:item.due+'T00:00',due:item.due,occurrenceDate:null},due,due);
      }
      continue;
    }
    // Identical slot schedules share their projection. Only the two lowest
    // IDs could win a tie, but each saved event contributes to the counts.
    const key=JSON.stringify([item.start,item.end,item.allDay,item.repeat,item.anchorDay,item.anchorMonth,
      item.exceptionDate,item.excluded]);
    let group=patterns.get(key);
    if(!group){group={count:0,first:item,second:null};patterns.set(key,group);}
    group.count++;
    if(item.id<group.first.id){group.second=group.first;group.first=item;}
    else if(item!==group.first&&(!group.second||item.id<group.second.id))group.second=item;
  }
  // The projected start dates are shared across schedules, even when their
  // clock times differ. The cache covers the grid and its bounded lookback.
  const slotDays=new Map();
  const localDay=number=>{
    if(!slotDays.has(number))slotDays.set(number,localCalendarDate(number));
    return slotDays.get(number);
  };
  for(const group of patterns.values()){
    if(incremental)yield;
    for(const event of eventsInRange(group.first,firstValid,lastValid,{includeWarnings:true,localDay,incremental})){
      if(!event){yield;continue;}
      const startDay=calendarOrdinal(event.start.slice(0,10));
      // A clock warning identifies the affected start day only; it has no
      // reliable projected end. Other warnings keep the known interval.
      const endDay=event.warning==='clock'?startDay:
        calendarOrdinal(event.end.slice(0,10))-Number(event.end.endsWith('T00:00'));
      const entry={id:event.id,title:event.title,kind:endDay>startDay?'multi-day':event.allDay?'all-day':'timed',
        start:event.start,end:event.warning==='clock'?null:event.end,occurrenceDate:event.exceptionDate??event.occurrence};
      if(event.warning)Object.assign(entry,{warning:event.warning,storedStart:event.storedStart,storedEnd:event.storedEnd});
      const second=group.second?{...entry,id:group.second.id,title:group.second.title}:null;
      record(entry,startDay,endDay,group.count,second);
    }
  }
  function collect(node,left,right,parent){
    const top=tree[node];
    for(const entry of parent)keepCalendarEntry(top,entry);
    if(right-left===1){if(days[left].enabled)days[left].top=top;return;}
    const mid=Math.floor((left+right)/2);
    collect(node*2,left,mid,top);collect(node*2+1,mid,right,top);
  }
  collect(1,0,length,[]);

  let total=0,warningCount=0,taskCount=0,previousBars=new Map();
  for(const [index,day] of days.entries()){
    total+=counts[index];warningCount+=warnings[index];taskCount+=tasks[index];
    const activeBars=new Map();
    if(day.enabled){
      day.totalCount=total;day.hiddenCount=total-day.top.length;day.hasWarning=warningCount>0;
      day.hasEvent=total>taskCount;day.hasTask=taskCount>0;
      const ordinalDay=origin+index;
      const column=((ordinalDay+3)%7+7)%7; // Monday is column 0.
      for(const entry of day.top){
        if(entry.kind!=='multi-day')continue;
        let bar=column===0?null:previousBars.get(entry);
        if(bar){bar.lastDay=day.date;bar.lastColumn=column;}
        else{
          bar={entry,weekStart:calendarDate(ordinalDay-column),firstDay:day.date,lastDay:day.date,
            firstColumn:column,lastColumn:column};
          bars.push(bar);
        }
        activeBars.set(entry,bar);
      }
    }
    previousBars=activeBars;
  }
  return {days,bars};
}

export function calendarSummary(items,first,last){
  return calendarSummarySteps(items,first,last).next().value;
}

export async function calendarSummaryAsync(items,first,last,{signal,sliceMs=5}={}){
  const work=calendarSummarySteps(items,first,last,true);
  for(;;){
    // A timer returns control to the browser between slices.
    await new Promise(resolve=>setTimeout(resolve,0));
    signal?.throwIfAborted();
    const deadline=performance.now()+sliceMs;
    do{
      const step=work.next();
      if(step.done)return step.value;
    }while(performance.now()<deadline);
  }
}

export function createCalendarSummaryRequests(onChange,calculate=calendarSummaryAsync){
  const cache=new Map();
  let revision,timeZone,active,requestNumber=0;
  function cancel(clear=false){
    active?.controller?.abort();
    active=null;
    if(clear)cache.clear();
  }
  function request(items,first,last,nextRevision,nextTimeZone){
    if(revision!==nextRevision||timeZone!==nextTimeZone){
      cancel(true);revision=nextRevision;timeZone=nextTimeZone;
    }
    const key=first+'/'+last;
    if(active?.key===key)return active;
    cancel();
    if(cache.has(key)){
      const result=cache.get(key);
      cache.delete(key);cache.set(key,result);
      active={key,status:'ready',result};
      return active;
    }
    const controller=new AbortController(),number=++requestNumber;
    active={key,status:'loading',controller,number};
    calculate(items,first,last,{signal:controller.signal}).then(result=>{
      if(active?.number!==number||controller.signal.aborted)return;
      cache.set(key,result);
      if(cache.size>4)cache.delete(cache.keys().next().value);
      active={key,status:'ready',result};
      onChange();
    },()=>{
      if(active?.number!==number||controller.signal.aborted)return;
      active={key,status:'error'};
      onChange();
    });
    return active;
  }
  return {request,cancel};
}

const AGENDA_PAGE_SIZE=50;
function compareAgenda(a,b){
  if(a.start!==b.start)return a.start<b.start?-1:1;
  return a.id===b.id?0:a.id<b.id?-1:1;
}
export function agendaPage(items, day, after=null){
  if(!validDate(day))return {rows:[],next:null};
  const heads=[];
  for(const item of items){
    if(item.type!=='event')continue;
    const stream=eventsInRange(item,day,day,{ascending:true,from:after?.start.slice(0,10),includeWarnings:true});
    let row=stream.next().value;
    while(row&&after&&compareAgenda(row,after)<=0)row=stream.next().value;
    if(row)heads.push({row,stream});
  }
  // Merge sorted streams without collecting or sorting their tails. One head
  // per saved event and one page of rows are retained regardless of overlap.
  const rows=[];
  while(heads.length&&rows.length<AGENDA_PAGE_SIZE){
    let next=0;
    for(let i=1;i<heads.length;i++)if(compareAgenda(heads[i].row,heads[next].row)<0)next=i;
    const head=heads[next];
    rows.push(head.row);
    head.row=head.stream.next().value;
    if(!head.row){heads[next]=heads[heads.length-1];heads.pop();}
  }
  const last=rows.at(-1);
  return {rows,next:heads.length?{start:last.start,id:last.id}:null};
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
    return [day,{hasEvent:validDate(day)&&events.some(item=>eventsInRange(item,day,day,{includeWarnings:true}).next().value!==undefined),hasTask:validDate(day)&&deadlines.has(day)}];
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
      const active=eventOccurrence(item,occurrence);
      if(!validDate(occurrence)||(!active&&!(item.excluded.includes(occurrence)&&replacements.length)))throw Error('削除する回の日付が不正です');
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
  assertBasicMutation(state,draft);
  if(NOTIFICATIONS_ENABLED&&draft.version===3)stageV3(state,draft);
  serializeState(draft);
  state.items=draft.items;
  state.history=draft.history;
  state.version=draft.version;
  if(draft.version===3)state.notificationLink=draft.notificationLink;
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
