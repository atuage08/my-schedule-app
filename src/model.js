export const STORAGE_KEY = 'my-schedule.prototype.v1';
// randomUUID requires HTTPS in Safari; getRandomValues also works on LAN HTTP.
export function newId(cryptoApi=globalThis.crypto) {
  if(typeof cryptoApi.randomUUID==='function')return cryptoApi.randomUUID();
  const bytes=cryptoApi.getRandomValues(new Uint8Array(16));
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}
export const dateKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
export const localDate = key => new Date(key+'T12:00:00');
export function addDays(key,n) { const d=localDate(key);d.setDate(d.getDate()+n);return dateKey(d); }
export function nextDate(key,repeat,anchorDay=Number(key.slice(8))) {
  if(repeat==='daily') return addDays(key,1);
  if(repeat==='weekly') return addDays(key,7);
  const d=localDate(key);d.setDate(1);d.setMonth(d.getMonth()+1);
  d.setDate(Math.min(anchorDay,new Date(d.getFullYear(),d.getMonth()+1,0).getDate()));return dateKey(d);
}
export function defaults(selected, now=new Date()) {
  const start=localDate(selected);
  if(selected===dateKey(now)) { start.setHours(now.getHours(),now.getMinutes(),now.getSeconds(),now.getMilliseconds());start.setTime(Math.ceil(start.getTime()/600000)*600000); }
  return {start:stamp(start),end:stamp(new Date(start.getTime()+3600000))};
}
export function stamp(d) {return dateKey(d)+'T'+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}
export function shiftEnd(oldStart,oldEnd,newStart) {return stamp(new Date(new Date(newStart).getTime()+new Date(oldEnd).getTime()-new Date(oldStart).getTime()));}
const validDate = s => typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(localDate(s).getTime()) && dateKey(localDate(s))===s;
const validStamp = s => typeof s==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) && validDate(s.slice(0,10)) && stamp(new Date(s))===s;
export function validateItem(x) {
  if(!x || typeof x.id!=='string' || !x.id || typeof x.title!=='string' || !x.title.trim() || x.title.length>160) throw Error('名称を1〜160文字で入力してください');
  if(!['event','task'].includes(x.type) || !['none','daily','weekly','monthly'].includes(x.repeat)) throw Error('項目の形式が不正です');
  if(!Array.isArray(x.excluded) || x.excluded.some(d=>!validDate(d))) throw Error('繰り返しの除外日が不正です');
  if(x.type==='event') {
    if(!validStamp(x.start)||!validStamp(x.end)||x.end<=x.start||typeof x.allDay!=='boolean') throw Error('終了日時は開始日時より後に設定してください');
  } else {
    if(x.due!==null&&!validDate(x.due)) throw Error('期限が不正です');
    if(x.repeat!=='none'&&!x.due) throw Error('繰り返しタスクには初回期限が必要です');
    if(typeof x.pinned!=='boolean') throw Error('ピン留めの形式が不正です');
  }
  if(x.anchorDay!==undefined&&(!Number.isInteger(x.anchorDay)||x.anchorDay<1||x.anchorDay>31)) throw Error('繰り返し基準日が不正です');
  return x;
}
export function validateState(s) {
  if(!s||s.version!==1||!Array.isArray(s.items)||!Array.isArray(s.history)) throw Error('保存データの形式が不正です');
  s.items.forEach(validateItem);
  if(new Set(s.items.map(x=>x.id)).size!==s.items.length) throw Error('IDが重複しています');
  s.history.forEach(h=>{if(!h||typeof h.id!=='string'||typeof h.title!=='string'||!h.title.trim()||h.title.length>160||typeof h.completedAt!=='string'||!Number.isFinite(Date.parse(h.completedAt))||(h.due!==null&&!validDate(h.due)))throw Error('完了履歴が不正です');});
  return s;
}
export function rollTasks(state,today=dateKey()) {
  for(const t of state.items) if(t.type==='task'&&t.repeat!=='none') {
    while(t.due<today || t.excluded.includes(t.due)) t.due=nextDate(t.due,t.repeat,t.anchorDay);
  }
  return state;
}
export function complete(state,id,now=new Date()) {
  const t=state.items.find(x=>x.id===id);if(!t||t.type!=='task')return;
  state.history.push({id:newId(),title:t.title,due:t.due,completedAt:now.toISOString()});
  if(t.repeat==='none')state.items=state.items.filter(x=>x.id!==id);
  else {t.due=nextDate(t.due,t.repeat,t.anchorDay);rollTasks(state,dateKey(now));}
}
export function eventOn(item,day) {
  if(item.type!=='event')return null;
  const startDay=item.start.slice(0,10), duration=new Date(item.end)-new Date(item.start);
  let occurrence=startDay;
  while(occurrence<=day) {
    const start=occurrence+item.start.slice(10);
    const end=stamp(new Date(new Date(start).getTime()+duration));
    const endDay=end.slice(0,10);
    if(!item.excluded.includes(occurrence)&&day>=occurrence&&(day<endDay||(day===endDay&&end.slice(11)!=='00:00')))return {...item,start,end,occurrence};
    if(item.repeat==='none')break;
    occurrence=nextDate(occurrence,item.repeat,item.anchorDay);
  }
  return null;
}
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
