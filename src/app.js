import {createDom} from './dom.js';
import {enhanceTimeFields} from './time-controls.js';
import {ScheduleStore,META_KEY} from './storage.js';
import {createBackupUI} from './backup-ui.js';
import {UpgradeNotice,UPGRADE_KEY} from './upgrade-notice.js';
import {MIN_DATE,MAX_DATE,REPEATS,calendarIndicators,deletionPlan,editEventOccurrence,clampDate,dueGroups,restore,removeItem,newId,STORAGE_KEY,dateKey,localDate,addDays,defaults,shiftEnd,validateItem,rollTasks,complete,eventOn} from './model.js';
const {h,replace}=createDom(document),$=selector=>document.querySelector(selector);
const fmt=(date,options={month:'long',day:'numeric',weekday:'short'})=>localDate(date).toLocaleDateString('ja-JP',options);
const storage={getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)};
const store=new ScheduleStore({storage,locks:navigator.locks}),upgrade=new UpgradeNotice({storage,locks:navigator.locks});
let upgradeChecked=false,upgradeBusy=false;
let selected=dateKey(),mode='week',view='home',search='',showAllHistory=false,state={version:1,items:[],history:[]},storageBlocked=true,processing=false,reminderKind='none',reminderDismissed=false,reminderSequence=0,lastSaveWarning='';
function notify(message){$('#notice').textContent=message;clearTimeout(notify.timer);notify.timer=setTimeout(()=>$('#notice').textContent='',4500);}
const backupUI=createBackupUI({store,onChange:updateApp,notify});
function updateApp(){
  state=store.state||{version:1,items:[],history:[]};storageBlocked=store.status!=='ready'||!store.locks?.request;render();backupUI.changed();
  const sequence=++reminderSequence;
  store.reminder().then(result=>{if(sequence===reminderSequence){reminderKind=result.kind;render();}},()=>{});
}
async function mutate(action,base=store.token()){
  if(processing)return false;processing=true;render();
  try{
    const result=await store.mutate(action,base);lastSaveWarning=result.warning||'';if(!result.ok)notify(result.message);else if(result.warning)notify(result.warning);
    return result.ok;
  }finally{processing=false;updateApp();}
}
const empty=text=>h('p',{class:'empty'},text);
const hint=text=>h('p',{class:'hint'},text);
const textButton=(text,attributes={})=>h('button',attributes,text);
function confirmDeletion(item,scope,occurrence){
  const panel=$('#delete-confirm'),plan=deletionPlan(state,item.id,scope,occurrence||item.start?.slice(0,10));
  const target=plan.kind==='event-series'?`シリーズ全体（過去・今後のすべての回と関連する例外予定 ${plan.exceptionCount} 件）`
    :plan.kind==='task-series'?'繰り返しタスクのシリーズ全体（現在と今後の回）'
    :plan.kind==='event-exception'?`${fmt(item.start.slice(0,10))}のこの例外予定だけ（元の回：${fmt(plan.occurrence)}）`
    :plan.kind==='event-occurrence'?`${fmt(plan.occurrence)}開始の今回だけ（関連する例外予定 ${plan.exceptionCount} 件を含む）`
    :plan.kind==='task-occurrence'?`${fmt(plan.occurrence)}期限の今回だけ`:'この項目だけ';
  const onlyOne=['event-exception','event-occurrence','task-occurrence'].includes(plan.kind);
  replace(panel,h('form',{method:'dialog'},h('h2',{id:'delete-title'},'削除の確認'),h('p',{},`「${item.title}」を削除しますか？`),h('p',{},h('strong',{},'削除範囲：'+target)),hint((onlyOne?'元シリーズのほかの回は残ります。':'この操作は取り消せません。')+'完了履歴は削除しません。'),h('div',{class:'confirm-actions'},textButton('キャンセル',{value:'cancel'}),textButton('削除する',{value:'delete',class:'danger'}))));
  return new Promise(resolve=>{panel.returnValue='cancel';panel.addEventListener('close',()=>resolve(panel.returnValue==='delete'),{once:true});panel.showModal();});
}
function taskRow(task){
  const due=task.due?fmt(task.due,{month:'short',day:'numeric'})+(task.repeat!=='none'?' · '+REPEATS[task.repeat]:''):null;
  return h('div',{class:'task-row'},textButton('',{class:'checkbox','data-complete':task.id,'aria-label':task.title+'を完了'}),h('button',{class:'item-title','data-edit':task.id},h('span',{},task.title),due&&h('small',{class:task.due<dateKey()?'overdue':''},due)),!task.due&&textButton(task.pinned?'◆':'◇',{class:'pin '+(task.pinned?'active':''),'data-pin':task.id,'aria-label':task.pinned?'ピンを外す':'ピン留め'}));
}
function calendar(){
  const date=localDate(selected);
  const first=mode==='week'?addDays(selected,-((date.getDay()+6)%7)):addDays(dateKey(new Date(date.getFullYear(),date.getMonth(),1)),-((new Date(date.getFullYear(),date.getMonth(),1).getDay()+6)%7));
  const count=mode==='week'?7:Math.ceil((((new Date(date.getFullYear(),date.getMonth(),1).getDay()+6)%7)+new Date(date.getFullYear(),date.getMonth()+1,0).getDate())/7)*7;
  const days=Array.from({length:count},(_,i)=>addDays(first,i)),marks=calendarIndicators(state.items,days);
  const buttons=days.map(key=>{
    const {hasEvent,hasTask}=marks.get(key);
    return h('button',{class:`day ${key===selected?'selected':''} ${key===dateKey()?'today':''} ${localDate(key).getMonth()!==date.getMonth()?'outside':''}`,'data-day':key,disabled:key<MIN_DATE||key>MAX_DATE,'aria-pressed':key===selected,'aria-label':fmt(key)+(hasEvent?'、予定あり':'')+(hasTask?'、期限付きタスクあり':'')},h('span',{},localDate(key).getDate()),h('span',{class:'day-marks','aria-hidden':'true'},hasEvent&&h('i',{class:'event-mark'}),hasTask&&h('i',{class:'task-mark'})));
  });
  return h('section',{class:'calendar','aria-label':'カレンダー'},
    h('div',{class:'calendar-heading'},h('div',{},h('span',{class:'eyebrow'},'YOUR DAYS, YOUR PACE'),h('h2',{},date.getFullYear(),h('small',{},'年'),' ',date.getMonth()+1,h('small',{},'月'))),h('div',{class:'segment'},textButton('週',{'data-mode':'week','aria-pressed':mode==='week'}),textButton('月',{'data-mode':'month','aria-pressed':mode==='month'}))),
    h('div',{class:'calendar-nav'},textButton('‹',{'data-nav':'-1','aria-label':'前の'+(mode==='week'?'週':'月')}),h('span',{},mode==='week'?fmt(first,{month:'numeric',day:'numeric'})+' — '+fmt(addDays(first,6),{month:'numeric',day:'numeric'}):'日付を選んで予定を確認'),textButton('›',{'data-nav':'1','aria-label':'次の'+(mode==='week'?'週':'月')})),
    h('div',{class:'weekdays'},['月','火','水','木','金','土','日'].map(day=>h('span',{},day))),h('div',{class:'days'},buttons),
    h('div',{class:'calendar-legend'},h('span',{},h('i',{class:'event-mark','aria-hidden':'true'}),'予定'),h('span',{},h('i',{class:'task-mark','aria-hidden':'true'}),'期限付きタスク')));
}
function eventRow(event){
  const time=event.allDay?'終日':event.start.slice(0,10)<selected?'継続中':event.start.slice(11);
  const end=event.allDay?'':event.end.slice(0,10)>selected?'翌日以降まで':event.end.slice(11);
  let subtitle=event.allDay?'日付だけの予定':event.repeat!=='none'?REPEATS[event.repeat]:'自分の時間';
  if(event.end.slice(0,10)>event.start.slice(0,10))subtitle+=' · '+fmt(event.allDay?addDays(event.end.slice(0,10),-1):event.end.slice(0,10),{month:'numeric',day:'numeric'})+'まで';
  return h('button',{class:'event','data-edit':event.id,'data-occurrence':event.occurrence},h('div',{class:'event-time'},time,h('small',{},end)),h('div',{class:'event-body'},h('strong',{},event.title),h('small',{},subtitle)),h('span',{},'›'));
}
function home(due,someday){
  const events=state.items.map(item=>eventOn(item,selected)).filter(Boolean).sort((a,b)=>a.start.localeCompare(b.start));
  return [calendar(),h('section',{class:'agenda'},h('div',{class:'section-title'},h('h2',{},selected===dateKey()?'今日':fmt(selected,{month:'short',day:'numeric'}),h('span',{},'の予定')),h('span',{class:'count'},events.length+'件')),events.length?events.map(eventRow):h('div',{class:'empty'},'予定のない、余白のある一日。',h('br'),h('small',{},'＋追加から予定を入れられます'))),
    h('section',{class:'tasks'},h('div',{class:'section-title'},h('h2',{},'期限のあるタスク'),h('button',{class:'text-button','data-view':'due'},'すべて '+due.length+' ',h('span',{},'↗'))),due.length?due.slice(0,5).map(taskRow):empty('期限のあるタスクはありません')),
    h('button',{class:'someday-card','data-view':'someday'},h('span',{class:'someday-symbol'},'☷'),h('span',{},h('strong',{},'いつかやる'),h('small',{},'思いついたことを、ひとまずここに。')),h('span',{class:'count'},someday.length),h('span',{},'›')),textButton('✓ 完了したタスクを見る',{class:'history-link','data-view':'history'})];
}
const intro=(eyebrow,title,description)=>h('div',{class:'page-intro'},h('span',{class:'eyebrow'},eyebrow),h('h2',{},title),h('p',{},description));
function historyView(){
  const cutoff=new Date();cutoff.setDate(cutoff.getDate()-90);
  const records=state.history.filter(record=>showAllHistory||new Date(record.completedAt)>=cutoff).sort((a,b)=>b.completedAt.localeCompare(a.completedAt));
  const rows=records.map(record=>h('div',{class:'history-row'},h('span',{},record.restoredAt?'↶':'✓'),h('div',{},record.title,h('small',{},new Date(record.completedAt).toLocaleString('ja-JP',{hour12:false})+' 完了'+(record.restoredAt?' · 完了取り消し済み':'')),!record.task&&h('small',{},'旧形式のため元タスクを特定できず復元できません')),record.task&&!record.restoredAt&&textButton('未完了に戻す',{class:'restore','data-restore':record.id})));
  return [intro('LOOK HOW FAR YOU’VE COME','完了したタスク','完了履歴は削除期限を設けず端末内に保存します。'),hint('繰り返しの復元は、現在の未完了1件に統合し最新期限を維持します。'),h('label',{class:'history-toggle'},h('input',{type:'checkbox',id:'all-history',checked:showAllHistory}),' 90日より前の履歴も表示'),h('section',{class:'tasks'},rows.length?rows:empty((showAllHistory?'':'直近90日に')+'完了したタスクはありません'))];
}
function render(){
  const due=state.items.filter(item=>item.type==='task'&&item.due).sort((a,b)=>a.due.localeCompare(b.due));
  const someday=state.items.filter(item=>item.type==='task'&&!item.due).sort((a,b)=>Number(b.pinned)-Number(a.pinned));
  let content;
  if(view==='home')content=home(due,someday);
  else if(view==='due')content=[intro('ONE THING AT A TIME','期限のあるタスク','小さな一歩を、ひとつずつ。'),[...dueGroups(due)].map(([label,tasks])=>h('section',{class:'tasks'},h('h3',{},label),tasks.length?tasks.map(taskRow):empty('該当するタスクはありません')))];
  else if(view==='someday'){
    const filtered=someday.filter(task=>task.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    content=[intro('ROOM FOR POSSIBILITIES','いつかやる','まだ日付のない、あなたのアイデア。'),h('label',{class:'search'},h('span',{},'⌕'),h('input',{id:'search',type:'search',placeholder:'タスクを検索',value:search,'aria-label':'いつかやるを検索'})),h('div',{class:'tasks'},filtered.length?filtered.map(taskRow):empty('タスクが見つかりません')),hint('◇ でピン留め。タップして期限を設定できます。')];
  }else content=historyView();
  const heading=view!=='home'?textButton('‹ ホームに戻る',{class:'back','data-view':'home'}):h('div',{class:'welcome'},h('span',{},'こんにちは。',h('br'),h('strong',{},'今日は、どんな一日に？')),textButton('今日へ ↗',{class:'today-button','data-today':''}));
  const reminderText={first:'データを変更しました。JSONバックアップを保存しておくと安心です。',due:'前回の保存確認から336時間以上経過し、データが変わっています。',clock:'時計が変わったため、バックアップからの経過時間を確認できません。'}[reminderKind];
  replace($('#app'),h('div',{class:'app-shell'},h('header',{},h('div',{class:'brand'},h('span',{class:'brand-mark'},'m',h('span',{},'・')),h('div',{},h('h1',{},'マイスケジュール'),h('p',{},'毎日に、ちょうどいい余白を。'))),h('span',{class:'prototype'},'PROTOTYPE')),h('main',{},heading,
    h('button',{id:'backup-open',class:'backup-entry'},'バックアップ・復元'),
    upgrade.required&&h('section',{id:'upgrade-notice',class:'upgrade-notice',role:'region','aria-label':'更新後の確認'},h('h2',{},'更新後に一度、旧版の終了を確認してください'),h('p',{},'更新前から開いている他のタブ・ホーム画面版をすべて閉じ、新版を開き直してください。旧版は同じWeb Lockに参加しません。'),h('p',{},'この確認は自己申告です。旧版との競合を完全に検出・防止できるものではありません。'),h('label',{class:'backup-check'},h('input',{type:'checkbox',id:'upgrade-checked',checked:upgradeChecked,disabled:upgradeBusy}),' 旧版を終了し、新版を開き直したことを確認しました'),h('button',{id:'upgrade-confirm',disabled:upgradeBusy||!upgradeChecked},'確認を記録して案内を閉じる')),
    lastSaveWarning&&h('p',{class:'error',role:'status'},lastSaveWarning),
    !reminderDismissed&&reminderText&&h('section',{class:'backup-reminder'},h('p',{},reminderText),h('button',{id:'backup-reminder-open'},'バックアップを開く'),h('button',{id:'backup-dismiss'},'今回は閉じる')),
    storageBlocked&&h('p',{class:'error'},store.status==='unverified'?'書き込みの成否は不確定です。この画面では通常操作・追加の復元を停止しています。バックアップ・復元から保持中の元データを退避してください。再読み込み・終了でメモリー上の退避対象は失われます。':'通常保存を停止しています。元データを削除・初期化せず保護しています。バックアップ・復元から状態を確認できます。'),content,h('footer',{},h('span',{class:'local-dot'}),' この端末だけに保存 · 架空データの試作品',h('br'),h('small',{},'ChatGPT・Apple通知連携は未実装です'))),h('div',{class:'add-dock'},h('button',{class:'add-button',id:'add'},'＋ ',h('span',{},'追加')))));
  bind();
  document.querySelectorAll('#add,[data-complete],[data-restore],[data-pin],[data-edit],#entry-form .save,#delete').forEach(node=>{node.disabled=processing||storageBlocked;});
}
function bind(){
  if($('#upgrade-checked'))$('#upgrade-checked').onchange=event=>{upgradeChecked=event.target.checked;$('#upgrade-confirm').disabled=upgradeBusy||!upgradeChecked;};
  if($('#upgrade-confirm'))$('#upgrade-confirm').onclick=async()=>{
    if(upgradeBusy)return;upgradeBusy=true;render();
    try{const result=await upgrade.acknowledge(upgradeChecked);notify(result.ok?'新版の利用確認を記録しました':result.message);if(result.ok)upgradeChecked=false;}
    finally{upgradeBusy=false;render();}
  };
  $('#backup-open').onclick=()=>backupUI.open();
  if($('#backup-reminder-open'))$('#backup-reminder-open').onclick=()=>backupUI.open();
  if($('#backup-dismiss'))$('#backup-dismiss').onclick=()=>{reminderDismissed=true;render();};
  document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{view=button.dataset.view;search='';render();window.scrollTo(0,0);});
  document.querySelectorAll('[data-mode]').forEach(button=>button.onclick=()=>{mode=button.dataset.mode;render();});
  document.querySelectorAll('[data-day]').forEach(button=>button.onclick=()=>{selected=button.dataset.day;render();});
  document.querySelectorAll('[data-nav]').forEach(button=>button.onclick=()=>{if(mode==='week')selected=clampDate(addDays(selected,7*Number(button.dataset.nav)));else{const date=localDate(selected);date.setDate(1);date.setMonth(date.getMonth()+Number(button.dataset.nav));selected=clampDate(dateKey(date));}render();});
  if($('[data-today]'))$('[data-today]').onclick=()=>{selected=dateKey();render();};
  document.querySelectorAll('[data-complete]').forEach(button=>button.onclick=async()=>{if(await mutate(draft=>complete(draft,button.dataset.complete))){render();notify('タスクを完了しました');}});
  document.querySelectorAll('[data-restore]').forEach(button=>button.onclick=async()=>{if(await mutate(draft=>restore(draft,button.dataset.restore))){render();notify('未完了に戻しました。繰り返しは現在の1件に統合します');}});
  document.querySelectorAll('[data-pin]').forEach(button=>button.onclick=async()=>{if(await mutate(draft=>{const task=draft.items.find(item=>item.id===button.dataset.pin);task.pinned=!task.pinned;}))render();});
  document.querySelectorAll('[data-edit]').forEach(button=>button.onclick=()=>openEditor(state.items.find(item=>item.id===button.dataset.edit),button.dataset.occurrence));
  $('#add').onclick=()=>openEditor();
  if($('#search'))$('#search').oninput=event=>{const position=event.target.selectionStart;search=event.target.value;render();$('#search').focus();try{$('#search').setSelectionRange(position,position);}catch{}};
  if($('#all-history'))$('#all-history').onchange=event=>{showAllHistory=event.target.checked;render();};
}
function openEditor(original=null,occurrence=null){
  const entryBase=store.token();
  const dialog=$('#editor');let type=original?.type||'event';
  const data=original?structuredClone(original):{id:newId(),title:'',...defaults(selected),allDay:false,due:null,pinned:false,repeat:'none',excluded:[]};
  if(original?.type==='event'&&occurrence){const current=eventOn(original,selected);if(current){data.start=current.start;data.end=current.end;}}
  function draw(){
    const input=(name,value,attributes={})=>h('input',{name,value,...attributes});
    const select=(name,options)=>h('select',{name},options.map(([value,label,selected])=>h('option',{value,selected},label)));
    const dateInput=name=>input(name,data.allDay?(name==='end'?addDays(data.end.slice(0,10),data.end.slice(11)==='00:00'?-1:0):data.start.slice(0,10)):data[name],{type:data.allDay?'date':'datetime-local',step:data.allDay?1:600,min:MIN_DATE+(data.allDay?'':'T00:00'),max:MAX_DATE+(data.allDay?'':'T23:59'),required:true});
    const fields=type==='event'?[h('label',{class:'toggle-row'},'終日',h('input',{name:'allDay',type:'checkbox',checked:data.allDay})),h('label',{},'開始',dateInput('start')),h('label',{},'終了',dateInput('end')),hint(data.allDay?'終了日を含みます':'24時間表記 · 通常は10分単位')]:[h('label',{},'期限 ',h('span',{class:'optional'},'任意'),input('due',data.due||'',{type:'date',min:MIN_DATE,max:MAX_DATE})),hint('名称だけでも保存できます。期限なしは「いつかやる」へ。')];
    const repeat=select('repeat',Object.entries(REPEATS).filter(([key])=>!data.exceptionDate||key==='none').map(([key,label])=>[key,label,data.repeat===key]));
    const details=h('details',{},h('summary',{},'詳細設定'),h('label',{},'繰り返し',repeat),type==='event'&&h('label',{class:'toggle-row'},'1分単位で入力',h('input',{type:'checkbox',id:'minute-step'})),hint('毎月・毎年は基準日を維持し、存在しない日は月末にします。日付は2000〜2100年、予定は最大366日間です。'));
    const range=original&&original.repeat!=='none'?h('label',{},'繰り返しの変更範囲',select('scope',[['one','今回だけ',true],['all','すべて',false]])):null;
    const deleteRange=original?.exceptionDate?[h('label',{},'削除の範囲',select('deleteScope',[['one','この例外予定だけ',true],['all','元シリーズとすべての例外予定',false]])),hint('保存はこの例外予定だけを変更します。元シリーズとの関連付けは維持します。')]:null;
    const form=h('form',{id:'entry-form'},h('div',{class:'sheet-handle'}),h('div',{class:'sheet-heading'},h('h2',{id:'editor-title'},original?'編集':'新しく追加'),textButton('×',{type:'button',class:'close',id:'close','aria-label':'閉じる'})),h('label',{class:'title-input'},h('span',{},'名称'),input('title',data.title,{maxlength:160,required:true,placeholder:type==='event'?'どんな予定？':'やることをひとつ'})),h('div',{class:'entry-fields'},fields,details,range,deleteRange,h('p',{id:'form-error',class:'error',role:'alert'})),h('div',{class:'sheet-bottom'},!original&&h('div',{class:'segment type-switch'},textButton('予定',{type:'button','data-type':'event','aria-pressed':type==='event'}),textButton('タスク',{type:'button','data-type':'task','aria-pressed':type==='task'})),h('button',{class:'save',type:'submit'},original?'変更を保存':'保存する',h('span',{},'✓')),original&&textButton('この項目を削除',{type:'button',class:'delete',id:'delete'})));
    replace(dialog,form);
    function capture(){
      const values=new FormData(form);data.title=values.get('title');data.repeat=values.get('repeat');
      if(type==='task')data.due=values.get('due')||null;
      else{data.allDay=form.elements.start.type==='date';data.start=values.get('start')+(data.allDay?'T00:00':'');data.end=data.allDay?addDays(values.get('end'),1)+'T00:00':values.get('end');}
    }
    $('#close').onclick=()=>dialog.close();
    document.querySelectorAll('[data-type]').forEach(button=>button.onclick=()=>{capture();type=button.dataset.type;if(!data.start)Object.assign(data,defaults(selected),{allDay:false});draw();});
    if(type==='event'){
      const timeControls=data.allDay?null:enhanceTimeFields(form);
      form.elements.start.onchange=()=>{
        const start=form.elements.start.value;if(!start)return;
        try{
          if(data.allDay){const duration=Math.max(0,Math.round((localDate(form.elements.end.value)-localDate(data.start.slice(0,10)))/86400000));form.elements.end.value=addDays(start,duration);}
          else form.elements.end.value=shiftEnd(data.start,form.elements.end.value,start);
          data.start=start+(data.allDay?'T00:00':'');timeControls?.refresh();
        }catch(error){$('#form-error').textContent=error.message;}
      };
      form.elements.allDay.onchange=()=>{const allDay=form.elements.allDay.checked;capture();data.allDay=allDay;if(allDay){data.start=data.start.slice(0,10)+'T00:00';data.end=addDays(data.start.slice(0,10),1)+'T00:00';}else Object.assign(data,defaults(data.start.slice(0,10)));draw();};
      if(timeControls){$('#minute-step').checked=timeControls.precise;$('#minute-step').onchange=event=>timeControls.setPrecise(event.target.checked);}
    }
    const scope=()=>form.elements.deleteScope?.value||form.elements.scope?.value||'all';
    if($('#delete'))$('#delete').onclick=async()=>{
      const deletionScope=scope(),expected=JSON.stringify(state.items.find(item=>item.id===original.id));
      if(await confirmDeletion(original,deletionScope,occurrence))if(await mutate(draft=>{if(JSON.stringify(draft.items.find(item=>item.id===original.id))!==expected)throw Error('項目が変更されました。開き直してから削除してください');removeItem(draft,original.id,deletionScope,occurrence||original.start?.slice(0,10));},entryBase)){dialog.close();render();notify('削除しました');}
    };
    form.onsubmit=async event=>{
      event.preventDefault();
      try{
        capture();const date=type==='event'?data.start:data.due||selected;
        let item={...data,type,title:data.title.trim(),anchorDay:original&&data.due===original.due&&type==='task'?original.anchorDay??Number(date.slice(8,10)):Number(date.slice(8,10)),anchorMonth:original&&data.due===original.due&&type==='task'?original.anchorMonth??Number(date.slice(5,7)):Number(date.slice(5,7))};validateItem(item);
        const one=original&&original.repeat!=='none'&&scope()==='one';
        if(one){item={...item,id:newId(),repeat:'none',excluded:[]};delete item.seriesId;}
        else if(original&&original.repeat!=='none'&&type==='event'&&occurrence){const days=Math.round((localDate(item.start.slice(0,10))-localDate(occurrence))/86400000),start=addDays(original.start.slice(0,10),days)+item.start.slice(10);item.end=shiftEnd(item.start,item.end,start);item.start=start;item.anchorDay=Number(start.slice(8,10));item.anchorMonth=Number(start.slice(5,7));}
        if(await mutate(draft=>{if(one){if(type==='event')editEventOccurrence(draft,original.id,item,occurrence||original.start.slice(0,10));else{removeItem(draft,original.id,scope());draft.items.push(item);}}else{draft.items=draft.items.filter(existing=>existing.id!==item.id);draft.items.push(item);}rollTasks(draft);},entryBase)){dialog.close();render();notify('保存しました');}
      }catch(error){$('#form-error').textContent=error.message;}
    };
  }
  draw();dialog.showModal();
}
$('#editor').addEventListener('click',event=>{if(event.target===$('#editor')){const rect=event.target.getBoundingClientRect();if(event.clientY<rect.top||event.clientX<rect.left||event.clientX>rect.right)event.target.close();}});
async function refreshAndRoll(){
  upgrade.refresh();
  const revision=store.revision;
  try{
    await store.refresh();
    if(revision!==store.revision){$('#delete-confirm').close('cancel');$('#editor').close();}
    if(store.status==='ready'&&store.locks?.request){const result=await store.rollover();if(!result.ok)notify(result.message);}
  }catch{notify('保存領域の確認を完了できませんでした');}
  updateApp();
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshAndRoll();});
window.addEventListener('storage',event=>{if(event.key===UPGRADE_KEY){upgrade.refresh();render();}else if(event.key===null||event.key===STORAGE_KEY||event.key===META_KEY)refreshAndRoll();});
render();
await store.initialize();
if(store.status==='ready'&&store.locks?.request){const result=await store.rollover();if(!result.ok)notify(result.message);}
updateApp();
