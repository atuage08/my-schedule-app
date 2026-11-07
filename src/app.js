import {createDom} from './dom.js';
import {enhanceTimeFields} from './time-controls.js';
import {MIN_DATE,MAX_DATE,REPEATS,calendarIndicators,deletionPlan,editEventOccurrence,clampDate,dueGroups,parseState,serializeState,restore,removeItem,newId,STORAGE_KEY,dateKey,localDate,addDays,defaults,shiftEnd,validateState,validateItem,rollTasks,complete,eventOn,seed} from './model.js';
const {h,replace}=createDom(document),$=selector=>document.querySelector(selector);
const fmt=(date,options={month:'long',day:'numeric',weekday:'short'})=>localDate(date).toLocaleDateString('ja-JP',options);
let selected=dateKey(),mode='week',view='home',search='',showAllHistory=false,state,storageBlocked=false;
try{const saved=localStorage.getItem(STORAGE_KEY);state=saved===null?seed():parseState(saved);rollTasks(state);}
catch{state={version:1,items:[],history:[]};storageBlocked=true;}
function notify(message){$('#notice').textContent=message;clearTimeout(notify.timer);notify.timer=setTimeout(()=>$('#notice').textContent='',4500);}
function save(){
  validateState(state);
  if(storageBlocked)throw Error('保存領域を読み込めないため保存できません。元データを保護しています');
  localStorage.setItem(STORAGE_KEY,serializeState(state));
}
function mutate(action){
  let before;
  try{before=structuredClone(state);action();if(JSON.stringify(before)!==JSON.stringify(state))save();return true;}
  catch(error){if(before)state=before;notify('保存できませんでした：'+error.message);return false;}
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
  replace($('#app'),h('div',{class:'app-shell'},h('header',{},h('div',{class:'brand'},h('span',{class:'brand-mark'},'m',h('span',{},'・')),h('div',{},h('h1',{},'マイスケジュール'),h('p',{},'毎日に、ちょうどいい余白を。'))),h('span',{class:'prototype'},'PROTOTYPE')),h('main',{},heading,storageBlocked&&h('p',{class:'error'},'保存データを読み込めませんでした。元データは上書きせず保護しています。ブラウザの保存設定やデータを確認してください。'),content,h('footer',{},h('span',{class:'local-dot'}),' この端末だけに保存 · 架空データの試作品',h('br'),h('small',{},'ChatGPT・Apple通知連携は未実装です'))),h('div',{class:'add-dock'},h('button',{class:'add-button',id:'add'},'＋ ',h('span',{},'追加')))));
  bind();
}
function bind(){
  document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{view=button.dataset.view;search='';render();window.scrollTo(0,0);});
  document.querySelectorAll('[data-mode]').forEach(button=>button.onclick=()=>{mode=button.dataset.mode;render();});
  document.querySelectorAll('[data-day]').forEach(button=>button.onclick=()=>{selected=button.dataset.day;render();});
  document.querySelectorAll('[data-nav]').forEach(button=>button.onclick=()=>{if(mode==='week')selected=clampDate(addDays(selected,7*Number(button.dataset.nav)));else{const date=localDate(selected);date.setDate(1);date.setMonth(date.getMonth()+Number(button.dataset.nav));selected=clampDate(dateKey(date));}render();});
  if($('[data-today]'))$('[data-today]').onclick=()=>{selected=dateKey();render();};
  document.querySelectorAll('[data-complete]').forEach(button=>button.onclick=()=>{if(mutate(()=>complete(state,button.dataset.complete))){render();notify('タスクを完了しました');}});
  document.querySelectorAll('[data-restore]').forEach(button=>button.onclick=()=>{if(mutate(()=>restore(state,button.dataset.restore))){render();notify('未完了に戻しました。繰り返しは現在の1件に統合します');}});
  document.querySelectorAll('[data-pin]').forEach(button=>button.onclick=()=>{if(mutate(()=>{const task=state.items.find(item=>item.id===button.dataset.pin);task.pinned=!task.pinned;}))render();});
  document.querySelectorAll('[data-edit]').forEach(button=>button.onclick=()=>openEditor(state.items.find(item=>item.id===button.dataset.edit),button.dataset.occurrence));
  $('#add').onclick=()=>openEditor();
  if($('#search'))$('#search').oninput=event=>{const position=event.target.selectionStart;search=event.target.value;render();$('#search').focus();try{$('#search').setSelectionRange(position,position);}catch{}};
  if($('#all-history'))$('#all-history').onchange=event=>{showAllHistory=event.target.checked;render();};
}
function openEditor(original=null,occurrence=null){
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
      if(await confirmDeletion(original,deletionScope,occurrence))if(mutate(()=>{if(JSON.stringify(state.items.find(item=>item.id===original.id))!==expected)throw Error('項目が変更されました。開き直してから削除してください');removeItem(state,original.id,deletionScope,occurrence||original.start?.slice(0,10));})){dialog.close();render();notify('削除しました');}
    };
    form.onsubmit=event=>{
      event.preventDefault();
      try{
        capture();const date=type==='event'?data.start:data.due||selected;
        let item={...data,type,title:data.title.trim(),anchorDay:original&&data.due===original.due&&type==='task'?original.anchorDay??Number(date.slice(8,10)):Number(date.slice(8,10)),anchorMonth:original&&data.due===original.due&&type==='task'?original.anchorMonth??Number(date.slice(5,7)):Number(date.slice(5,7))};validateItem(item);
        const one=original&&original.repeat!=='none'&&scope()==='one';
        if(one){item={...item,id:newId(),repeat:'none',excluded:[]};delete item.seriesId;}
        else if(original&&original.repeat!=='none'&&type==='event'&&occurrence){const days=Math.round((localDate(item.start.slice(0,10))-localDate(occurrence))/86400000),start=addDays(original.start.slice(0,10),days)+item.start.slice(10);item.end=shiftEnd(item.start,item.end,start);item.start=start;item.anchorDay=Number(start.slice(8,10));item.anchorMonth=Number(start.slice(5,7));}
        if(mutate(()=>{if(one){if(type==='event')editEventOccurrence(state,original.id,item,occurrence||original.start.slice(0,10));else{removeItem(state,original.id,scope());state.items.push(item);}}else{state.items=state.items.filter(existing=>existing.id!==item.id);state.items.push(item);}rollTasks(state);})){dialog.close();render();notify('保存しました');}
      }catch(error){$('#form-error').textContent=error.message;}
    };
  }
  draw();dialog.showModal();
}
$('#editor').addEventListener('click',event=>{if(event.target===$('#editor')){const rect=event.target.getBoundingClientRect();if(event.clientY<rect.top||event.clientX<rect.left||event.clientX>rect.right)event.target.close();}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)return;const previous=JSON.stringify(state);if(mutate(()=>rollTasks(state))&&previous!==JSON.stringify(state))render();});
window.addEventListener('storage',event=>{
  if(event.key!==STORAGE_KEY)return;
  try{state=event.newValue===null?seed():parseState(event.newValue);storageBlocked=false;rollTasks(state);$('#delete-confirm').close('cancel');$('#editor').close();render();notify('別の画面での変更を反映しました');}
  catch{storageBlocked=true;$('#delete-confirm').close('cancel');$('#editor').close();render();notify('保存データの形式を確認できません');}
});
render();
