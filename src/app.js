import {NOTIFICATIONS_ENABLED,isProtectedItem,PROTECTED_ITEM_MESSAGE} from './features.js';
import {bootNotificationStore,refreshNotificationStore,hasResultFragment} from './notification-connection.js';
import {createConnectionUI} from './notification-connection-ui.js';
import {V3_READY,v3URL} from './notification-v3.js';
import {REMOVAL_READY,REMOVAL_KEY,removalEligible,removalURL} from './notification-removals.js';
import {TEST_ORIGIN,createTestPayload,shortcutURL,eligibleEvent,savedEventURL} from './shortcut-test.js';
import {createDom} from './dom.js';
import {enhanceTimeFields,enhanceDateFields} from './time-controls.js';
import {ScheduleStore,META_KEY} from './storage.js';
import {createBackupUI} from './backup-ui.js';
import {createBatchImportUI} from './batch-import-ui.js';
import {UpgradeNotice,UPGRADE_KEY} from './upgrade-notice.js';
import {notificationSettings,notificationFromLocal,stamp,MIN_DATE,MAX_DATE,MAX_EVENT_END,REPEATS,createCalendarSummaryRequests,validDate,deletionPlan,editEventOccurrence,clampDate,dueGroups,restore,removeItem,newId,STORAGE_KEY,dateKey,localDate,addDays,defaults,shiftEnd,validateItem,rollTasks,taskRecurrences,complete,agendaPage,eventOccurrence} from './model.js';
const {h,replace}=createDom(document),$=selector=>document.querySelector(selector);
const fmt=(date,options={month:'long',day:'numeric',weekday:'short'})=>localDate(date).toLocaleDateString('ja-JP',options);
const storage={getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)};
const store=new ScheduleStore({storage,locks:navigator.locks}),upgrade=new UpgradeNotice({storage,locks:navigator.locks});
let upgradeChecked=false,upgradeBusy=false,lastMutationFailed=false;
let selected=clampDate(dateKey()),mode='week',view='home',search='',showAllHistory=false,state={version:1,items:[],history:[]},storageBlocked=true,processing=false,reminderKind='none',reminderDismissed=false,reminderSequence=0,lastSaveWarning='';
let agendaDay,agendaItems;
const agendaCursors=[null];
const TASK_PAGE_SIZE=50;
let taskPageDay,taskPage=1;
const calendarRequests=createCalendarSummaryRequests(updateCalendar);
let calendarBooting=true,calendarRefreshes=0,calendarReadFailed=false,calendarTimeZone;
let editorReadGeneration=0,editorReadFailed=false;
const calendarAnnouncement=h('p',{id:'calendar-announcement',class:'visually-hidden',role:'status'});
document.body.append(calendarAnnouncement);
function notify(message){$('#notice').textContent=message;clearTimeout(notify.timer);notify.timer=setTimeout(()=>$('#notice').textContent='',4500);}
const backupUI=createBackupUI({store,onChange:updateApp,notify});
const batchImport=createBatchImportUI({store,onChange:readConfirmed=>{
  if(readConfirmed&&!calendarRefreshes)editorReadFailed=false;
  updateApp();
}});
const connectionUI=NOTIFICATIONS_ENABLED?createConnectionUI({store,onChange:updateApp,notify}):null;
function updateApp(){
  if(store.status!=='ready')calendarRequests.cancel(true);
  state=store.state||{version:1,items:[],history:[]};storageBlocked=store.status!=='ready'||!store.locks?.request;render();backupUI.changed();connectionUI?.changed();batchImport.changed();
  const sequence=++reminderSequence;
  store.reminder().then(result=>{if(sequence===reminderSequence){reminderKind=result.kind;render();}},()=>{});
}
async function mutate(action,base=store.token()){
  if(processing)return false;processing=true;render();
  try{
    const result=await store.mutate(action,base,{queueRemovals:NOTIFICATIONS_ENABLED&&window.location.origin===TEST_ORIGIN,notificationV3:NOTIFICATIONS_ENABLED&&window.location.origin===TEST_ORIGIN});lastSaveWarning=result.warning||'';lastMutationFailed=!result.ok;if(!result.ok)notify(result.message);else if(result.warning)notify(result.warning);
    return result.ok;
  }finally{processing=false;updateApp();}
}
const empty=text=>h('p',{class:'empty'},text);
const hint=text=>h('p',{class:'hint'},text);
const textButton=(text,attributes={})=>h('button',attributes,text);
function confirmDeletion(item,scope,occurrence){
  const panel=$('#delete-confirm'),plan=deletionPlan(state,item.id,scope,occurrence);
  const target=plan.kind==='event-series'?`シリーズ全体（過去・今後のすべての回と関連する例外予定 ${plan.exceptionCount} 件）`
    :plan.kind==='task-series'?'繰り返しタスクのシリーズ全体（現在と今後の回）'
    :plan.kind==='event-exception'?`${fmt(item.start.slice(0,10))}のこの例外予定だけ（元の回：${fmt(plan.occurrence)}）`
    :plan.kind==='event-occurrence'?`${fmt(plan.occurrence)}開始の今回だけ（関連する例外予定 ${plan.exceptionCount} 件を含む）`
    :plan.kind==='task-occurrence'?`${fmt(plan.occurrence)}期限の今回だけ`:'この項目だけ';
  const onlyOne=['event-exception','event-occurrence','task-occurrence'].includes(plan.kind);
  replace(panel,h('form',{method:'dialog'},h('h2',{id:'delete-title'},'削除の確認'),h('p',{},`「${item.title}」を削除しますか？`),h('p',{},h('strong',{},'削除範囲：'+target)),hint((onlyOne?'元シリーズのほかの回は残ります。':'この操作は取り消せません。')+'完了履歴は削除しません。'+(NOTIFICATIONS_ENABLED&&item.type==='event'?' Apple側のリマインダーは自動削除されません。連携済みの場合は専用一覧で確認してください。':'' )),h('div',{class:'confirm-actions'},textButton('キャンセル',{value:'cancel'}),textButton('削除する',{value:'delete',class:'danger'}))));
  return new Promise(resolve=>{panel.returnValue='cancel';panel.addEventListener('close',()=>resolve(panel.returnValue==='delete'),{once:true});panel.showModal();});
}
function taskRow(task,recurrence){
  const due=task.due?fmt(task.due,{month:'short',day:'numeric'})+(task.repeat!=='none'?' · '+REPEATS[task.repeat]:''):null;
  return h('div',{class:'task-row'},
    textButton('',{class:'checkbox','data-complete':task.id,'data-blocked-occurrence':recurrence?.blocked?'':null,'aria-label':task.title+'を完了'}),
    h('button',{class:'item-title','data-edit':task.id},h('span',{},task.title),
      due&&h('small',{class:task.due<dateKey()?'overdue':''},due),
      recurrence?.due===null&&h('small',{},'対応範囲内に次回なし')),
    !task.due&&textButton(task.pinned?'◆':'◇',{class:'pin '+(task.pinned?'active':''),'data-pin':task.id,'aria-label':task.pinned?'ピンを外す':'ピン留め'}));
}
const calendarDateLabel=new Intl.DateTimeFormat('ja-JP',{timeZone:'UTC',month:'long',day:'numeric',weekday:'short'});
const calendarShortDate=new Intl.DateTimeFormat('ja-JP',{timeZone:'UTC',month:'numeric',day:'numeric'});
const calendarUTC=date=>new Date(date+'T00:00:00Z');
function calendarGrid(){
  const start=calendarUTC(mode==='month'?selected.slice(0,7)+'-01':selected);
  const offset=(start.getUTCDay()+6)%7;
  const monthEnd=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,0)).getUTCDate();
  const count=mode==='week'?7:Math.ceil((offset+monthEnd)/7)*7;
  start.setUTCDate(start.getUTCDate()-offset);
  return Array.from({length:count},(_,i)=>{
    const date=new Date(start.getTime()+i*86400000).toISOString().slice(0,10);
    return {date,enabled:validDate(date)};
  });
}
function currentCalendar(first,last){
  if(calendarBooting||calendarRefreshes){
    calendarRequests.cancel();return {status:'loading'};
  }
  if(calendarReadFailed||store.status!=='ready'||!store.state){
    calendarRequests.cancel(true);return {status:'unavailable'};
  }
  calendarTimeZone=new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return calendarRequests.request(store.state.items,first,last,store.revision,calendarTimeZone);
}
function calendarWeek(days,bars,today,isReadOnly){
  const laneEnds=[-1,-1],occupied=days.map(()=>[false,false]);
  const layer=bars.map(bar=>{
    const lane=laneEnds.findIndex(end=>end<bar.firstColumn);
    laneEnds[lane]=bar.lastColumn;
    for(let column=bar.firstColumn;column<=bar.lastColumn;column++)occupied[column][lane]=true;
    const warning=isReadOnly(bar.entry);
    return h('span',{class:'calendar-bar'+(warning?' calendar-warning':''),'data-calendar-start':bar.firstColumn+1,
      'data-calendar-end':bar.lastColumn+2,'data-calendar-lane':lane+1},bar.entry.title);
  });
  const buttons=days.map((day,column)=>{
    const key=day.date,entries=day.top||[],singles=entries.filter(entry=>entry.kind!=='multi-day');
    const readOnly=day.hasWarning||entries.some(isReadOnly);
    const label=[
      calendarDateLabel.format(calendarUTC(key)), day.totalCount===undefined?null:day.totalCount+'件',
      day.hasEvent?'予定あり':null,day.hasTask?'期限付きタスクあり':null,
      ...entries.map(entry=>(entry.kind==='timed'?entry.start.slice(11)+' ':'' )+entry.title),
      day.hiddenCount?'ほか'+day.hiddenCount+'件':null,readOnly?'閲覧のみの予定あり':null
    ].filter(Boolean).join('、');
    return h('button',{type:'button',class:`day calendar-day ${key===selected?'selected':''} ${key===today?'today':''} ${key.slice(0,7)!==selected.slice(0,7)?'outside':''}`,
      'data-day':key,disabled:!day.enabled,'aria-pressed':key===selected,'aria-label':label},
      h('span',{class:'calendar-day-head','aria-hidden':'true'},Number(key.slice(8)),
        h('span',{class:'day-marks'},day.hasEvent&&h('i',{class:'event-mark'}),day.hasTask&&h('i',{class:'task-mark'}))),
      occupied[column].map(filled=>{
        const entry=filled?null:singles.shift();
        return h('span',{class:entry?'calendar-entry calendar-entry-'+entry.kind+
          (isReadOnly(entry)?' calendar-warning':''):'calendar-entry','aria-hidden':'true'},
          entry?.kind==='timed'&&h('span',{class:'calendar-entry-time'},entry.start.slice(11)),
          entry&&h('span',{class:'calendar-entry-title'},entry.title));
      }),
      h('span',{class:'calendar-more','aria-hidden':'true'},day.hiddenCount?'+'+day.hiddenCount+'件':''));
  });
  return h('div',{class:'calendar-week'},buttons,h('div',{class:'calendar-bars','aria-hidden':'true'},layer));
}
function calendar(){
  const grid=calendarGrid(),first=grid[0].date,last=grid.at(-1).date;
  const {status,result}=currentCalendar(first,last),days=result?.days||grid,today=dateKey(),weeks=[];
  const snapshot=store.state||state;
  const items=new Map((result?snapshot.items:[]).map(item=>[item.id,item]));
  const isReadOnly=entry=>!!entry.warning||isProtectedItem(snapshot,items.get(entry.id));
  for(let i=0;i<days.length;i+=7){
    const week=days.slice(i,i+7);
    weeks.push(calendarWeek(week,result?.bars.filter(bar=>bar.weekStart===week[0].date)||[],today,isReadOnly));
  }
  const message={loading:'予定を集計中…',unavailable:'保存済みの予定を読み込めません。',error:'予定を集計できませんでした。'}[status]||'';
  const announcement=message||'予定の集計が完了しました。';
  if(calendarAnnouncement.textContent!==announcement)calendarAnnouncement.textContent=announcement;
  return h('section',{id:'schedule-calendar',class:'calendar','aria-label':'カレンダー',
    'data-calendar-status':status,'data-calendar-first':first,'data-calendar-last':last},
    h('div',{class:'calendar-heading'},h('div',{},h('span',{class:'eyebrow'},'YOUR DAYS, YOUR PACE'),h('h2',{},Number(selected.slice(0,4)),h('small',{},'年'),' ',Number(selected.slice(5,7)),h('small',{},'月'))),h('div',{class:'segment'},textButton('週',{'data-mode':'week','aria-pressed':mode==='week'}),textButton('月',{'data-mode':'month','aria-pressed':mode==='month'}))),
    h('div',{class:'calendar-nav'},textButton('‹',{'data-nav':'-1','aria-label':'前の'+(mode==='week'?'週':'月')}),h('span',{},mode==='week'?calendarShortDate.format(calendarUTC(first))+' — '+calendarShortDate.format(calendarUTC(last)):'日付を選んで予定を確認'),textButton('›',{'data-nav':'1','aria-label':'次の'+(mode==='week'?'週':'月')})),
    h('p',{class:'calendar-status','aria-hidden':'true'},message),
    h('div',{class:'weekdays'},['月','火','水','木','金','土','日'].map(day=>h('span',{},day))),
    h('div',{class:'days calendar-days','aria-busy':status==='loading'},weeks),
    result?.days.find(day=>day.date===selected)?.hasWarning&&h('p',{class:'calendar-warning-note'},'選択日に閲覧のみの予定があります。'),
    h('div',{class:'calendar-legend'},h('span',{},h('i',{class:'event-mark','aria-hidden':'true'}),'予定'),h('span',{},h('i',{class:'task-mark','aria-hidden':'true'}),'期限付きタスク')));
}
function calendarFocus(root){
  const control=document.activeElement;
  if(!root?.contains(control))return null;
  const attribute=['data-day','data-mode','data-nav'].find(name=>control.hasAttribute(name));
  return attribute?{attribute,value:control.getAttribute(attribute)}:null;
}
function focusCalendarControl(focus,root=$('#schedule-calendar')){
  if(!focus||!root)return;
  const {attribute,value}=focus;
  const match=[...root.querySelectorAll('button['+attribute+']:not(:disabled)')].find(button=>button.getAttribute(attribute)===value);
  (match||root.querySelector('[data-day][aria-pressed="true"]:not(:disabled)')||
    root.querySelector('[data-mode][aria-pressed="true"]:not(:disabled)'))?.focus({preventScroll:true});
}
function updateCalendar(){
  const previous=$('#schedule-calendar');
  if(!previous||view!=='home')return;
  const focused=calendarFocus(previous);
  const next=calendar();
  previous.replaceWith(next);bindCalendar(next);focusCalendarControl(focused,next);
}
function bindCalendar(root){
  root.querySelectorAll('[data-day],[data-mode],[data-nav]').forEach(button=>button.onclick=()=>{
    if(button.disabled)return;
    if(button.dataset.day)selected=button.dataset.day;
    else if(button.dataset.mode)mode=button.dataset.mode;
    else if(mode==='week')selected=clampDate(addDays(selected,7*Number(button.dataset.nav)));
    else{
      const date=calendarUTC(selected);
      date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+Number(button.dataset.nav));
      selected=clampDate(date.toISOString().slice(0,10));
    }
    render();
  });
}
function eventRow(event){
  if(event.warning){
    const reason={
      anchor:'繰り返しの基準日と保存済み日時が一致しないため、編集対象を特定できません。',
      clock:'夏時間などによる時刻の切り替えで、この回の現地日時を安全に特定できません。',
      'end-limit':'この回の終了日時は対応範囲を超えています。'
    }[event.warning];
    return h('div',{class:'event event-readonly','data-agenda-warning':event.warning},h('div',{class:'event-body'},
      h('strong',{},event.title),
      h('small',{},'保存日時 '+event.storedStart+' 〜 '+event.storedEnd),
      event.warning!=='anchor'&&h('small',{},'この回の開始日時 '+event.start),
      h('small',{},reason+' 閲覧のみ')));
  }
  const time=event.allDay?'終日':event.start.slice(0,10)<selected?'継続中':event.start.slice(11);
  const end=event.allDay?'':event.end.slice(0,10)>selected?'翌日以降まで':event.end.slice(11);
  let subtitle=event.allDay?'日付だけの予定':event.repeat!=='none'?REPEATS[event.repeat]:'自分の時間';
  if(event.end.slice(0,10)>event.start.slice(0,10))subtitle+=' · '+fmt(event.allDay?addDays(event.end.slice(0,10),-1):event.end.slice(0,10),{month:'numeric',day:'numeric'})+'まで';
  if(isProtectedItem(state,event))subtitle+=' · 保護中（閲覧のみ）';
  return h('button',{class:'event','data-edit':event.id,'data-occurrence':event.exceptionDate??event.occurrence},h('div',{class:'event-time'},time,h('small',{},end)),h('div',{class:'event-body'},h('strong',{},event.title),h('small',{},subtitle)),h('span',{},'›'));
}
function home(due,someday,row){
  if(agendaDay!==selected||agendaItems!==state.items){
    agendaDay=selected;agendaItems=state.items;agendaCursors.length=1;
  }
  const {rows,next}=agendaPage(state.items,selected,agendaCursors.at(-1));
  const pageNumber=agendaCursors.length;
  const pageButton=(label,direction,disabled,change)=>{
    const button=textButton(label,{type:'button',class:'agenda-page-button',disabled,'data-agenda-page':direction,'aria-describedby':'agenda-page-position'});
    button.onclick=()=>{
      change();render();
      ($('.agenda-pages [data-agenda-page="'+direction+'"]:not(:disabled)')||$('.agenda-pages button:not(:disabled)'))?.focus();
    };
    return button;
  };
  const pagination=(pageNumber>1||next)&&h('div',{class:'agenda-pages',role:'group','aria-label':'予定一覧のページ'},
    pageButton('前へ','previous',pageNumber===1,()=>agendaCursors.pop()),
    h('span',{id:'agenda-page-position',role:'status'},pageNumber+'ページ'+(next?'':'（最終）')),
    pageButton('次へ','next',!next,()=>agendaCursors.push(next)));
  const selectedTasks=due.filter(task=>task.due===selected).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const otherTasks=due.filter(task=>task.due!==selected);
  if(taskPageDay!==selected){taskPageDay=selected;taskPage=1;}
  const lastTaskPage=Math.max(1,Math.ceil(selectedTasks.length/TASK_PAGE_SIZE));
  taskPage=Math.min(taskPage,lastTaskPage);
  const visibleTasks=selectedTasks.slice((taskPage-1)*TASK_PAGE_SIZE,taskPage*TASK_PAGE_SIZE);
  const taskPageButton=(label,direction,delta,disabled)=>{
    const button=textButton(label,{type:'button',class:'agenda-page-button',disabled,
      'data-task-page':direction,'aria-describedby':'task-page-position'});
    button.onclick=()=>{
      taskPage+=delta;render();
      ($('[data-task-page="'+direction+'"]:not(:disabled)')||$('[data-task-page]:not(:disabled)'))?.focus();
    };
    return button;
  };
  const taskPagination=lastTaskPage>1&&h('div',{class:'agenda-pages',role:'group','aria-label':'選択日のタスク一覧のページ'},
    taskPageButton('前へ','previous',-1,taskPage===1),
    h('span',{id:'task-page-position',role:'status'},taskPage+' / '+lastTaskPage+'ページ'),
    taskPageButton('次へ','next',1,taskPage===lastTaskPage));
  return [calendar(),h('section',{class:'agenda'},h('div',{class:'section-title'},h('h2',{},selected===dateKey()?'今日':fmt(selected,{month:'short',day:'numeric'}),h('span',{},'の予定')),h('span',{class:'count'},(pagination?'このページ ':'')+rows.length+'件')),rows.length?rows.map(eventRow):h('div',{class:'empty'},'予定のない、余白のある一日。',h('br'),h('small',{},'＋追加から予定を入れられます')),pagination),
    selectedTasks.length&&h('section',{class:'tasks selected-date-tasks'},h('h2',{},'選択日が期限のタスク',h('span',{class:'count'},selectedTasks.length+'件')),visibleTasks.map(row),taskPagination),
    h('section',{class:'tasks'},h('div',{class:'section-title due-title'},h('h2',{},'期限のあるタスク',h('span',{class:'count'},due.length+'件')),textButton('すべて見る ›',{class:'due-button','data-view':'due'})),otherTasks.length?otherTasks.slice(0,5).map(row):empty(selectedTasks.length?'選択日以外に期限付きタスクはありません':'期限のあるタスクはありません')),
    h('button',{class:'someday-card','data-view':'someday'},h('span',{class:'someday-symbol'},'☷'),h('span',{},h('strong',{},'いつかやる'),h('small',{},'思いついたことを、ひとまずここに。')),h('span',{class:'count'},someday.length),h('span',{},'›')),textButton('✓ 完了したタスクを見る',{class:'history-link action-card','data-view':'history'})];
}
const intro=(eyebrow,title,description)=>h('div',{class:'page-intro'},h('span',{class:'eyebrow'},eyebrow),h('h2',{},title),h('p',{},description));
function historyView(){
  const cutoff=new Date();cutoff.setDate(cutoff.getDate()-90);
  const records=state.history.filter(record=>showAllHistory||new Date(record.completedAt)>=cutoff).sort((a,b)=>b.completedAt.localeCompare(a.completedAt));
  const rows=records.map(record=>h('div',{class:'history-row'},h('span',{},record.restoredAt?'↶':'✓'),h('div',{},record.title,h('small',{},new Date(record.completedAt).toLocaleString('ja-JP',{hour12:false})+' 完了'+(record.restoredAt?' · 完了取り消し済み':'')),!record.task&&h('small',{},'旧形式のため元タスクを特定できず復元できません')),record.task&&!record.restoredAt&&textButton('未完了に戻す',{class:'restore','data-restore':record.id})));
  return [intro('LOOK HOW FAR YOU’VE COME','完了したタスク','完了履歴は削除期限を設けず端末内に保存します。'),hint('繰り返しの復元は、現在の未完了1件に統合し最新期限を維持します。'),h('label',{class:'history-toggle'},h('input',{type:'checkbox',id:'all-history',checked:showAllHistory}),' 90日より前の履歴も表示'),h('section',{class:'tasks'},rows.length?rows:empty((showAllHistory?'':'直近90日に')+'完了したタスクはありません'))];
}
function removalPanel(){
  if(!NOTIFICATIONS_ENABLED||window.location.origin!==TEST_ORIGIN)return null;
  const pending=store.removalStatus();
  if(state.version===3){
    const link=state.notificationLink;
    const rows=link.records.map(record=>h('div',{class:'removal-entry'},h('strong',{},record.desired.title),hint(record.desired.enabled?'希望状態：通知ON':'希望状態：通知休止'),hint('対象ID：'+record.itemId),hint('反映状態：'+({unverified:'未照合',active:'ON確認済み',inactive:'休止確認済み',unknown:'結果不明'}[record.status])),record.pending&&hint('依頼ID：'+record.pending.operationId+' ／ '+({pending:'未送信',unknown:'結果不明',suspended:'復元後の確認待ち'}[record.pending.status]))));
    return h('section',{class:'removal-panel'},h('h3',{},'通知休止・再開（v3）'),hint('アプリ内設定と依頼は保存済みです。世代対応ショートカットの実機検証が終わるまで送信しません。'),h('details',{},h('summary',{},'対象IDと連携状態を確認（'+link.records.length+'件）'),rows),hint('旧解除待ちID：'+link.legacyRemovals.length+'件（保留して保持）'));
  }
  if(!pending.unavailable&&!pending.entries.length)return null;
  return h('section',{class:'removal-panel'},h('h3',{},'通知の解除待ち'),hint('アプリ内の変更とApple側の解除は別です。解除用ショートカットは未有効です。IDは自動削除しません。'),pending.unavailable?hint('解除待ちを読み取れません。既存内容は削除せず、解除連携を停止しています。'):h('details',{},h('summary',{},pending.entries.length+'件の対象IDを確認'),pending.entries.map(entry=>h('div',{class:'removal-entry'},h('strong',{},entry.title),hint('対象ID：'+entry.itemId),hint('操作ID：'+entry.operationId),hint(entry.phase==='prepared'?'アプリ内変更の成否が未確定です。解除禁止。':removalEligible(entry,state)?'アプリ内の変更は保存確認済み。Apple側の解除は未確認。':'現在の予定と一致しません。解除禁止。'),h('button',{type:'button',class:'notification-button','data-removal':entry.operationId,disabled:!REMOVAL_READY||processing||storageBlocked||lastMutationFailed||!removalEligible(entry,state)},'解除連携（準備中）')))));
}
function render(){
  const previousCalendar=$('#schedule-calendar');
  const focusedCalendar=previousCalendar&&calendarFocus(previousCalendar);
  if(view!=='home'){
    calendarRequests.cancel();
    if(calendarAnnouncement.textContent)calendarAnnouncement.textContent='';
  }
  const recurrences=taskRecurrences(state);
  const row=task=>taskRow(task,recurrences.get(task.id));
  const due=state.items.filter(item=>item.type==='task'&&item.due).sort((a,b)=>a.due.localeCompare(b.due));
  const someday=state.items.filter(item=>item.type==='task'&&!item.due).sort((a,b)=>Number(b.pinned)-Number(a.pinned));
  let content;
  if(view==='home')content=home(due,someday,row);
  else if(view==='due')content=[intro('ONE THING AT A TIME','期限のあるタスク','小さな一歩を、ひとつずつ。'),[...dueGroups(due)].map(([label,tasks])=>h('section',{class:'tasks'},h('h3',{},label),tasks.length?tasks.map(row):empty('該当するタスクはありません')))];
  else if(view==='someday'){
    const filtered=someday.filter(task=>task.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    content=[intro('ROOM FOR POSSIBILITIES','いつかやる','まだ日付のない、あなたのアイデア。'),h('label',{class:'search'},h('span',{},'⌕'),h('input',{id:'search',type:'search',placeholder:'タスクを検索',value:search,'aria-label':'いつかやるを検索'})),h('div',{class:'tasks'},filtered.length?filtered.map(row):empty('タスクが見つかりません')),hint('◇ でピン留め。タップして期限を設定できます。')];
  }else content=historyView();
  const heading=view!=='home'?textButton('← ホームに戻る',{class:'back','data-view':'home'}):h('div',{class:'welcome'},h('span',{},'こんにちは。',h('br'),h('strong',{},'今日は、どんな一日に？')),textButton('今日へ ↗',{class:'today-button','data-today':''}));
  const reminderText={first:'データを変更しました。JSONバックアップを保存しておくと安心です。',due:'前回の保存確認から336時間以上経過し、データが変わっています。',clock:'時計が変わったため、バックアップからの経過時間を確認できません。'}[reminderKind];
  replace($('#app'),h('div',{class:'app-shell'},h('header',{},h('div',{class:'brand'},h('span',{class:'brand-mark','aria-hidden':'true'}),h('div',{},h('h1',{},'マイスケジュール'),h('p',{},'毎日に、ちょうどいい余白を。'))),h('span',{class:'prototype'},'PROTOTYPE')),h('main',{},heading,
    NOTIFICATIONS_ENABLED&&window.location.origin===TEST_ORIGIN&&h('section',{'aria-label':'ショートカット連携の検証'},h('button',{id:'shortcut-test',type:'button',class:'text-button action-card',disabled:state.version===3},'ショートカット連携テスト'),h('p',{class:'hint'},state.version===3?'旧形式の検証送信はv3では停止しています。':'架空の予定をJSONで渡します。通知日時は操作時から約10分後です。通知連携の成功は未確認です。')),
    upgrade.required&&h('section',{id:'upgrade-notice',class:'upgrade-notice',role:'region','aria-label':'更新後の確認'},h('h2',{},'更新後に一度、旧版の終了を確認してください'),h('p',{},'更新前から開いている他のタブ・ホーム画面版をすべて閉じ、新版を開き直してください。旧版は同じWeb Lockに参加しません。'),h('p',{},'この確認は自己申告です。旧版との競合を完全に検出・防止できるものではありません。'),h('label',{class:'backup-check'},h('input',{type:'checkbox',id:'upgrade-checked',checked:upgradeChecked,disabled:upgradeBusy}),' 旧版を終了し、新版を開き直したことを確認しました'),h('button',{id:'upgrade-confirm',disabled:upgradeBusy||!upgradeChecked},'確認を記録して案内を閉じる')),
    lastSaveWarning&&h('p',{class:'error',role:'status'},lastSaveWarning),
    !reminderDismissed&&reminderText&&h('section',{class:'backup-reminder'},h('p',{},reminderText),h('button',{id:'backup-reminder-open'},'バックアップを開く'),h('button',{id:'backup-dismiss'},'今回は閉じる')),
    !NOTIFICATIONS_ENABLED&&hasResultFragment(window.location.hash)&&h('p',{class:'error',role:'status'},'通知結果URLは基本機能先行版では処理しません。初期化・結果保存・自動繰り越しを停止しています。'),
    storageBlocked&&h('p',{class:'error'},store.status==='unverified'?'書き込みの成否は不確定です。この画面では通常操作・追加の復元を停止しています。バックアップ・復元から保持中の元データを退避してください。再読み込み・終了でメモリー上の退避対象は失われます。':'通常保存を停止しています。元データを削除・初期化せず保護しています。バックアップ・復元から状態を確認できます。'),content,view==='home'&&removalPanel(),view==='home'&&h('section',{class:'home-settings'},h('button',{id:'backup-open',type:'button',class:'backup-entry action-card'},'▣ バックアップ・復元'),NOTIFICATIONS_ENABLED&&window.location.origin===TEST_ORIGIN&&h('details',{},h('summary',{},'開発用の接続試験（架空予定のみ）'),h('button',{id:'connection-test-open',type:'button',class:'action-card'},'通知接続試験を開く'))),h('footer',{},h('span',{class:'local-dot'}),NOTIFICATIONS_ENABLED?' この端末だけに保存 · 架空データの試作品':' この端末内に保存 · 基本機能先行版',h('br'),h('small',{},'通知・ChatGPT連携は提供していません'))),h('div',{class:'add-dock'},h('button',{class:'add-button',id:'add'},'＋ ',h('span',{},'追加')))));
  bind();
  const itemsById=new Map(state.items.map(item=>[item.id,item]));
  const entry=$('#editor')?.entrySession;
  const waitingForRead=entry?.usedImport&&(calendarRefreshes>0||editorReadFailed);
  document.querySelectorAll('#add,[data-complete],[data-restore],[data-pin],[data-edit],#entry-form .save,#delete,#batch-open').forEach(node=>{node.disabled=processing||storageBlocked||(waitingForRead&&node.closest('#entry-form'))||node.dataset?.blockedOccurrence!==undefined||!!((node.dataset?.complete||node.dataset?.pin)&&isProtectedItem(state,itemsById.get(node.dataset.complete||node.dataset.pin)));});
  if(focusedCalendar)focusCalendarControl(focusedCalendar);
}
function bind(){
  if($('#shortcut-test'))$('#shortcut-test').onclick=()=>{
    if(!NOTIFICATIONS_ENABLED||window.location.origin!==TEST_ORIGIN)return;
    try{window.location.href=shortcutURL(createTestPayload());}catch{notify('連携データを作成できませんでした。ショートカットは起動していません');}
  };
  if($('#upgrade-checked'))$('#upgrade-checked').onchange=event=>{upgradeChecked=event.target.checked;$('#upgrade-confirm').disabled=upgradeBusy||!upgradeChecked;};
  if($('#upgrade-confirm'))$('#upgrade-confirm').onclick=async()=>{
    if(upgradeBusy)return;upgradeBusy=true;render();
    try{const result=await upgrade.acknowledge(upgradeChecked);notify(result.ok?'新版の利用確認を記録しました':result.message);if(result.ok)upgradeChecked=false;}
    finally{upgradeBusy=false;render();}
  };
  if($('#connection-test-open'))$('#connection-test-open').onclick=()=>connectionUI.open();
  if($('#backup-open'))$('#backup-open').onclick=()=>backupUI.open();
  document.querySelectorAll('[data-removal]').forEach(button=>button.onclick=()=>{try{if(!NOTIFICATIONS_ENABLED||processing||storageBlocked||lastMutationFailed)throw Error('Stopped');const url=removalURL({origin:window.location.origin,store,operationId:button.dataset.removal});window.location.href=url;}catch{notify('解除連携は未有効、または対象を確認できません。対象IDは保持しています');}});
  if($('#backup-reminder-open'))$('#backup-reminder-open').onclick=()=>backupUI.open();
  if($('#backup-dismiss'))$('#backup-dismiss').onclick=()=>{reminderDismissed=true;render();};
  document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{view=button.dataset.view;search='';render();window.scrollTo(0,0);});
  const calendarRoot=$('#schedule-calendar');
  if(calendarRoot)bindCalendar(calendarRoot);
  if($('[data-today]'))$('[data-today]').onclick=()=>{selected=clampDate(dateKey());render();};
  document.querySelectorAll('[data-complete]').forEach(button=>button.onclick=async()=>{if(await mutate(draft=>complete(draft,button.dataset.complete))){render();notify('タスクを完了しました');}});
  document.querySelectorAll('[data-restore]').forEach(button=>button.onclick=async()=>{if(await mutate(draft=>restore(draft,button.dataset.restore))){render();notify('未完了に戻しました。繰り返しは現在の1件に統合します');}});
  document.querySelectorAll('[data-pin]').forEach(button=>button.onclick=async()=>{if(await mutate(draft=>{const task=draft.items.find(item=>item.id===button.dataset.pin);task.pinned=!task.pinned;}))render();});
  document.querySelectorAll('[data-edit]').forEach(button=>button.onclick=()=>{
    const item=state.items.find(item=>item.id===button.dataset.edit);
    if(item)openEditor(item,button.dataset.occurrence);
    else notify('対象の項目が見つかりません。画面を開き直してください');
  });
  $('#add').onclick=()=>openEditor();
  if($('#search'))$('#search').oninput=event=>{const position=event.target.selectionStart;search=event.target.value;render();$('#search').focus();try{$('#search').setSelectionRange(position,position);}catch{}};
  if($('#all-history'))$('#all-history').onchange=event=>{showAllHistory=event.target.checked;render();};
}
function openEditor(original=null,occurrence=null){
  let entryBase=store.token();
  const dialog=$('#editor');
  const session={isNew:!original,usedImport:false,rebase(){entryBase=store.token();}};
  dialog.entrySession=session;
  const hasOccurrence=original?.type==='event'&&(original.repeat!=='none'||original.exceptionDate!==undefined||occurrence!==null);
  const current=hasOccurrence?eventOccurrence(original,occurrence):null;
  const missingTarget='対象の回が見つかりません。予定を開き直してください';
  if(hasOccurrence&&!current){notify(missingTarget);return;}
  const assertTarget=items=>{
    if(!original)return;
    const item=items.find(item=>item.id===original.id);
    if(!item||item.type!==original.type||(hasOccurrence&&!eventOccurrence(item,occurrence)))throw Error(missingTarget);
  };
  if(isProtectedItem(state,original)){
    replace(dialog,h('div',{class:'backup-body'},h('h2',{},original.title),h('p',{},original.type==='event'?original.start+' 〜 '+original.end:original.due||'期限なし'),h('p',{role:'status'},PROTECTED_ITEM_MESSAGE),h('p',{},'バックアップ・復元から通知情報を含めて書き出せます。Apple側の状態との一致は確認していません。'),h('button',{type:'button',id:'protected-close',class:'action-card'},'閉じる')));
    $('#protected-close').onclick=()=>dialog.close();dialog.showModal();return;
  }
  let type=original?.type||'event';
  const noNext=original?.type==='task'&&original.repeat!=='none'&&taskRecurrences(state).get(original.id)?.due===null;
  const data=original?structuredClone(original):{id:newId(),title:'',...defaults(selected),allDay:false,due:null,pinned:false,repeat:'none',excluded:[]};
  if(current){data.start=current.start;data.end=current.end;}
  function draw(){
    const input=(name,value,attributes={})=>h('input',{name,value,...attributes});
    const select=(name,options)=>h('select',{name},options.map(([value,label,selected])=>h('option',{value,selected},label)));
    const dateInput=name=>input(name,data.allDay?(name==='end'?addDays(data.end.slice(0,10),data.end.slice(11)==='00:00'?-1:0):data.start.slice(0,10)):data[name],{type:data.allDay?'date':'datetime-local',step:data.allDay?1:600,min:MIN_DATE+(data.allDay?'':'T00:00'),max:data.allDay?MAX_DATE:name==='end'?MAX_EVENT_END:MAX_DATE+'T23:59',required:true});
    const fields=type==='event'?[h('label',{class:'toggle-row'},'終日',h('input',{name:'allDay',type:'checkbox',checked:data.allDay})),h('label',{},'開始',dateInput('start')),h('label',{},'終了',dateInput('end')),hint(data.allDay?'終了日を含みます':'24時間表記 · 通常は10分単位')]:[h('label',{},'期限 ',h('span',{class:'optional'},'任意'),input('due',data.due||'',{type:'date',min:MIN_DATE,max:MAX_DATE})),hint('名称だけでも保存できます。期限なしは「いつかやる」へ。')];
    const repeat=select('repeat',Object.entries(REPEATS).filter(([key])=>!data.exceptionDate||key==='none').map(([key,label])=>[key,label,data.repeat===key]));
    const details=h('details',{},h('summary',{},'詳細設定'),h('label',{},'繰り返し',repeat),type==='event'&&h('label',{class:'toggle-row'},'1分単位で入力',h('input',{type:'checkbox',id:'minute-step'})),hint('毎月・毎年は基準日を維持し、存在しない日は月末にします。日付は2000〜2100年、予定は最大366日間です。'));
    const range=original&&original.repeat!=='none'?h('label',{},'繰り返しの変更範囲',select('scope',[['one','今回だけ',!noNext],['all','すべて',noNext]])):null;
    const deleteRange=original?.exceptionDate?[h('label',{},'削除の範囲',select('deleteScope',[['one','この例外予定だけ',true],['all','元シリーズとすべての例外予定',false]])),hint('保存はこの例外予定だけを変更します。元シリーズとの関連付けは維持します。')]:null;
    const supportsNotification=NOTIFICATIONS_ENABLED&&window.location.origin===TEST_ORIGIN&&type==='event'&&data.repeat==='none'&&data.eventSeriesId===undefined&&data.exceptionDate===undefined;
    const setting=notificationSettings(data);
    const notification=supportsNotification&&h('section',{'aria-label':'予定の通知設定'},h('h3',{},'通知設定（テスト）'),h('label',{},input('notifyEnabled','',{id:'event-notify-enabled',type:'checkbox',checked:setting.enabled}),' 通知する'),h('label',{},'通知日時（端末の現地時刻）',input('notifyLocal',setting.enabled?stamp(new Date(setting.notifyAt)):data.start.slice(0,16),{id:'event-notify-at',type:'datetime-local',step:60,min:'2000-01-01T00:00',max:'2099-12-31T23:59',disabled:!setting.enabled})),hint('通知日時は開始日時の変更には追従しません。保存はアプリ内だけです。通知連携を保存するとv3になります。旧版では読めません。更新前の他のタブ・ホーム画面版は閉じてください。'),hint('通知の変更は保存後に連携してください。通知OFF・予定削除では解除待ちIDを保持します。解除用ショートカットの準備中はApple側を手動で確認・解除してください。'),original&&h('div',{},h('p',{},original.notification?.enabled?'アプリ内：通知設定保存済み。リマインダーへの反映結果は未確認です。':'アプリ内：通知なし。以前のリマインダーが残っている可能性があります。'),h('label',{},h('input',{id:'event-notify-confirm',type:'checkbox'}),' 架空の予定であり、保存済みのタイトル・ID・通知日時を渡すことを確認しました'),textButton('🔔 保存済み設定を通知連携する',{id:'event-shortcut',type:'button',class:'notification-button',disabled:!V3_READY||processing||storageBlocked||lastMutationFailed||!original.notification?.enabled}),h('p',{id:'event-shortcut-status',role:'status'},'世代対応ショートカットの検証待ちです。送信は無効です。通知OFFはアプリ内で保存できますが、iPhone側の休止はまだ実行しません。')));
    let importEntry;
    if(!original){
      const entry=textButton('まとめて取り込む',{id:'batch-open',type:'button',class:'batch-secondary',
        disabled:storageBlocked||session.usedImport&&(calendarRefreshes>0||editorReadFailed)});
      entry.onclick=()=>{
        session.usedImport=true;
        batchImport.open(entry,()=>{
          if(dialog.open&&dialog.entrySession===session&&store.status==='ready'&&!calendarRefreshes&&!editorReadFailed)
            session.rebase();
        });
      };
      importEntry=h('div',{class:'batch-entry'},entry);
    }
    const form=h('form',{id:'entry-form'},h('div',{class:'sheet-handle'}),h('div',{class:'sheet-heading'},h('h2',{id:'editor-title'},original?'編集':'新しく追加'),textButton('×',{type:'button',class:'close',id:'close','aria-label':'閉じる'})),importEntry,h('label',{class:'title-input'},h('span',{},'名称'),input('title',data.title,{maxlength:160,required:true,placeholder:type==='event'?'どんな予定？':'やることをひとつ'})),h('div',{class:'entry-fields'},fields,details,range,deleteRange,notification,h('p',{id:'form-error',class:'error',role:'alert'})),h('div',{class:'sheet-bottom'},!original&&h('div',{class:'segment type-switch'},textButton('予定',{type:'button','data-type':'event','aria-pressed':type==='event'}),textButton('タスク',{type:'button','data-type':'task','aria-pressed':type==='task'})),h('button',{class:'save',type:'submit'},original?'変更を保存':'保存する',h('span',{},'✓')),original&&textButton('この項目を削除',{type:'button',class:'delete',id:'delete'})));
    replace(dialog,form);
    if(noNext)form.querySelector('.entry-fields').prepend(h('p',{class:'hint'},'対応範囲内に次回なし。期限や繰り返しを変更できます。'));
    function capture(){
      const values=new FormData(form);data.title=values.get('title');data.repeat=values.get('repeat');
      if(supportsNotification){const setting=notificationFromLocal($('#event-notify-enabled').checked,$('#event-notify-at').value,original?.notification);if(setting.enabled||data.notification!==undefined)data.notification=setting;}
      if(type!=='event'||data.repeat!=='none'){if(data.notification?.enabled)throw Error('先に通知を解除し、Apple側のリマインダーも確認してください');delete data.notification;}
      if(type==='task')data.due=values.get('due')||null;
      else{data.allDay=form.elements.start.type==='date';data.start=values.get('start')+(data.allDay?'T00:00':'');data.end=data.allDay?addDays(values.get('end'),1)+'T00:00':values.get('end');}
    }
    if($('#event-notify-enabled'))$('#event-notify-enabled').onchange=()=>{$('#event-notify-at').disabled=!$('#event-notify-enabled').checked;};
    $('#close').onclick=()=>dialog.close();
    document.querySelectorAll('[data-type]').forEach(button=>button.onclick=()=>{try{capture();type=button.dataset.type;if(!data.start)Object.assign(data,defaults(selected),{allDay:false});draw();}catch(error){$('#form-error').textContent=error.message;}});
    if(type==='event'){
      const timeControls=data.allDay?null:enhanceTimeFields(form);
      form.elements.start.onchange=()=>{
        const start=form.elements.start.value;if(!start)return;
        try{
          if(data.allDay){const duration=Math.max(0,Math.round((localDate(form.elements.end.value)-localDate(data.start.slice(0,10)))/86400000));form.elements.end.value=addDays(start,duration);}
          else form.elements.end.value=shiftEnd(data.start,form.elements.end.value,start);
          data.start=start+(data.allDay?'T00:00':'');timeControls?.refresh();dateControls.refresh();
        }catch(error){$('#form-error').textContent=error.message;}
      };
      form.elements.allDay.onchange=()=>{try{const allDay=form.elements.allDay.checked;capture();data.allDay=allDay;if(allDay){data.start=data.start.slice(0,10)+'T00:00';data.end=addDays(data.start.slice(0,10),1)+'T00:00';}else Object.assign(data,defaults(data.start.slice(0,10)));draw();}catch(error){$('#form-error').textContent=error.message;}};
      if(timeControls){$('#minute-step').checked=timeControls.precise;$('#minute-step').onchange=event=>timeControls.setPrecise(event.target.checked);}
    }
    const dateControls=enhanceDateFields(form);
    if($('#event-shortcut'))$('#event-shortcut').onclick=()=>{
      try{
        capture();
        if(JSON.stringify(data)!==JSON.stringify(original))throw Error('変更を先に保存し、予定を開き直してください');
        if(!NOTIFICATIONS_ENABLED||!V3_READY||processing||storageBlocked||lastMutationFailed||!$('#event-notify-confirm').checked)throw Error('世代対応の受信側を未検証です');
        const url=v3URL({origin:window.location.origin,store,itemId:original.id});
        $('#event-shortcut-status').textContent='ショートカットの起動を要求します。リマインダーへの反映・通知受信は未確認です。';
        window.location.href=url;
      }catch{$('#event-shortcut-status').textContent='連携を開始できません。変更の保存・保存状態・未来の通知日時・架空予定の確認を見直し、必要なら予定を開き直してください。';}
    };
    const scope=()=>form.elements.deleteScope?.value||form.elements.scope?.value||'all';
    if($('#delete'))$('#delete').onclick=async()=>{
      try{
        assertTarget(state.items);
        const deletionScope=scope(),expected=JSON.stringify(state.items.find(item=>item.id===original.id));
        if(!await confirmDeletion(original,deletionScope,occurrence))return;
        if(await mutate(draft=>{
          assertTarget(draft.items);
          if(JSON.stringify(draft.items.find(item=>item.id===original.id))!==expected)throw Error('項目が変更されました。開き直してから削除してください');
          removeItem(draft,original.id,deletionScope,occurrence);
        },entryBase)){dialog.close();render();notify('削除しました');}
      }catch(error){$('#form-error').textContent=error.message;}
    };
    form.onsubmit=async event=>{
      event.preventDefault();
      try{
        if(session.usedImport&&(calendarRefreshes>0||editorReadFailed))throw Error('保存先を確認できるまで登録を停止しています');
        assertTarget(state.items);
        capture();const date=type==='event'?data.start:data.due||selected;
        const keepTaskAnchor=type==='task'&&original&&data.due===original.due&&data.repeat===original.repeat;
        const one=original&&original.repeat!=='none'&&scope()==='one';
        const keepEventAnchor=type==='event'&&current&&!one&&data.repeat===original.repeat&&
          (original.repeat!=='none'||original.exceptionDate!==undefined)&&date.slice(0,10)===current.start.slice(0,10);
        const dueDay=Number(date.slice(8,10)),dueMonth=Number(date.slice(5,7));
        let item={...data,type,title:data.title.trim()};
        if(!keepEventAnchor){
          item.anchorDay=keepTaskAnchor?(original.anchorDay??dueDay):dueDay;
          item.anchorMonth=keepTaskAnchor?(original.anchorMonth??dueMonth):dueMonth;
        }
        validateItem(item);
        if(one){item={...item,id:newId(),repeat:'none',excluded:[]};delete item.seriesId;}
        else if(original&&original.repeat!=='none'&&type==='event'&&current){
          if(item.start===current.start&&item.end===current.end&&item.allDay===original.allDay){
            item.start=original.start;item.end=original.end;
          }else{
            const days=Math.round((localDate(item.start.slice(0,10))-localDate(occurrence))/86400000);
            const start=addDays(original.start.slice(0,10),days)+item.start.slice(10);
            item.end=shiftEnd(item.start,item.end,start);item.start=start;
          }
          if(!keepEventAnchor){item.anchorDay=Number(item.start.slice(8,10));item.anchorMonth=Number(item.start.slice(5,7));}
        }
        if(await mutate(draft=>{assertTarget(draft.items);if(item.notification!==undefined)draft.version=Math.max(draft.version,2);if(one){if(type==='event')editEventOccurrence(draft,original.id,item,occurrence);else{removeItem(draft,original.id,scope());draft.items.push(item);}}else{draft.items=draft.items.filter(existing=>existing.id!==item.id);draft.items.push(item);}rollTasks(draft);},entryBase)){dialog.close();render();notify(NOTIFICATIONS_ENABLED?'アプリ内に保存しました。通知の反映は別操作です':'保存と読み戻し確認が完了しました');if(NOTIFICATIONS_ENABLED&&window.location.origin===TEST_ORIGIN&&eligibleEvent(item)&&item.notification?.enabled)openEditor(store.state.items.find(saved=>saved.id===item.id));}
      }catch(error){$('#form-error').textContent=error.message;}
    };
  }
  draw();dialog.showModal();
}
$('#editor').addEventListener('click',event=>{if(event.target===$('#editor')){const rect=event.target.getBoundingClientRect();if(event.clientY<rect.top||event.clientX<rect.left||event.clientX>rect.right)event.target.close();}});
async function refreshAndRoll(){
  const editor=$('#editor'),initialSession=editor.open?editor.entrySession:null;
  const generation=++editorReadGeneration;
  calendarRefreshes++;
  updateCalendar();
  const revision=store.revision;
  if(initialSession?.usedImport){
    $('#entry-form .save').disabled=true;
    $('#batch-open').disabled=true;
  }
  let readFailed=true;
  try{
    upgrade.refresh();
    const result=await refreshNotificationStore(store,()=>window.location.hash);
    calendarReadFailed=false;
    readFailed=store.status!=='ready';
    if(revision!==store.revision){
      $('#delete-confirm').close('cancel');
      if(editor.open&&!editor.entrySession?.usedImport&&
        (editor.entrySession===initialSession||!editor.entrySession?.isNew))editor.close();
    }
    if(!result.ok)notify(result.message);
  }catch{calendarReadFailed=true;calendarRequests.cancel(true);notify('保存領域の確認を完了できませんでした');}
  finally{
    calendarRefreshes--;
    if(generation===editorReadGeneration)editorReadFailed=readFailed;
    if(!calendarRefreshes){
      if(!editorReadFailed&&store.status==='ready'&&editor.open&&editor.entrySession?.usedImport)
        editor.entrySession.rebase();
      batchImport.changed(editorReadFailed);
    }
  }
  updateApp();
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshAndRoll();});
window.addEventListener('focus',()=>{
  if(calendarTimeZone!==new Intl.DateTimeFormat().resolvedOptions().timeZone)updateCalendar();
  batchImport.changed();
});
window.addEventListener('storage',event=>{if(event.key===UPGRADE_KEY){upgrade.refresh();render();}else if(event.key===null||event.key===STORAGE_KEY||event.key===META_KEY||event.key===REMOVAL_KEY)refreshAndRoll();});
render();
const bootResult=await bootNotificationStore(store,()=>window.location.hash);
calendarBooting=false;
if(!bootResult.ok)notify(bootResult.message);
updateApp();

if(NOTIFICATIONS_ENABLED){
  window.addEventListener('hashchange',()=>connectionUI.receiveLocation());
  window.addEventListener('pageshow',()=>connectionUI.receiveLocation());
  await connectionUI.receiveLocation();
}
