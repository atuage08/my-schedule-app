import {enhanceTimeFields} from './time-controls.js';
import {MIN_DATE,MAX_DATE,REPEATS,calendarIndicators,deletionPlan,editEventOccurrence,clampDate,dueGroups,parseState,serializeState,restore,removeItem,newId,STORAGE_KEY,dateKey,localDate,addDays,defaults,shiftEnd,validateState,validateItem,rollTasks,complete,eventOn,seed} from './model.js';
const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(d,options={month:'long',day:'numeric',weekday:'short'})=>localDate(d).toLocaleDateString('ja-JP',options);
const repeatLabel=REPEATS;
let selected=dateKey(),mode='week',view='home',search='',showAllHistory=false,state,storageBlocked=false;
try {const saved=localStorage.getItem(STORAGE_KEY);state=saved===null?seed():parseState(saved);rollTasks(state);} catch {state={version:1,items:[],history:[]};storageBlocked=true;}
function notify(message){$('#notice').textContent=message;clearTimeout(notify.timer);notify.timer=setTimeout(()=>$('#notice').textContent='',4500);}
function save(){try{validateState(state);if(storageBlocked)throw Error('保存領域を読み込めないため保存できません。元データを保護しています');localStorage.setItem(STORAGE_KEY,serializeState(state));}catch(e){throw Error('保存できませんでした：'+e.message);}}
function mutate(action){let before;try{before=structuredClone(state);action();if(JSON.stringify(before)!==JSON.stringify(state))save();return true;}catch(e){if(before)state=before;notify(e.message);return false;}}
function confirmDeletion(item,scope,occurrence){
 const panel=$('#delete-confirm');
 const plan=deletionPlan(state,item.id,scope,occurrence||item.start?.slice(0,10));
 const target=plan.kind==='event-series'?`シリーズ全体（過去・今後のすべての回と関連する例外予定 ${plan.exceptionCount} 件）`
   :plan.kind==='task-series'?'繰り返しタスクのシリーズ全体（現在と今後の回）'
   :plan.kind==='event-exception'?`${fmt(item.start.slice(0,10))}のこの例外予定だけ（元の回：${fmt(plan.occurrence)}）`
   :plan.kind==='event-occurrence'?`${fmt(plan.occurrence)}開始の今回だけ（関連する例外予定 ${plan.exceptionCount} 件を含む）`
   :plan.kind==='task-occurrence'?`${fmt(plan.occurrence)}期限の今回だけ`:'この項目だけ';
 const onlyOne=['event-exception','event-occurrence','task-occurrence'].includes(plan.kind);
 panel.innerHTML=`<form method="dialog"><h2 id="delete-title">削除の確認</h2><p>「${esc(item.title)}」を削除しますか？</p><p><strong>削除範囲：${esc(target)}</strong></p><p class="hint">${onlyOne?'元シリーズのほかの回は残ります。':'この操作は取り消せません。'}完了履歴は削除しません。</p><div class="confirm-actions"><button value="cancel">キャンセル</button><button value="delete" class="danger">削除する</button></div></form>`;
 return new Promise(resolve=>{panel.returnValue='cancel';panel.addEventListener('close',()=>resolve(panel.returnValue==='delete'),{once:true});panel.showModal();});
}
function taskRow(t){return `<div class="task-row"><button class="checkbox" data-complete="${esc(t.id)}" aria-label="${esc(t.title)}を完了"></button><button class="item-title" data-edit="${esc(t.id)}"><span>${esc(t.title)}</span>${t.due?`<small class="${t.due<dateKey()?'overdue':''}">${fmt(t.due,{month:'short',day:'numeric'})}${t.repeat!=='none'?' · '+repeatLabel[t.repeat]:''}</small>`:''}</button>${!t.due?`<button class="pin ${t.pinned?'active':''}" data-pin="${esc(t.id)}" aria-label="${t.pinned?'ピンを外す':'ピン留め'}">${t.pinned?'◆':'◇'}</button>`:''}</div>`;}
function calendar(){
 const d=localDate(selected),first=mode==='week'?addDays(selected,-((d.getDay()+6)%7)):addDays(dateKey(new Date(d.getFullYear(),d.getMonth(),1)),-((new Date(d.getFullYear(),d.getMonth(),1).getDay()+6)%7));
 const count=mode==='week'?7:Math.ceil((((new Date(d.getFullYear(),d.getMonth(),1).getDay()+6)%7)+new Date(d.getFullYear(),d.getMonth()+1,0).getDate())/7)*7;
 const days=Array.from({length:count},(_,i)=>addDays(first,i));
 const marks=calendarIndicators(state.items,days);
 const buttons=days.map(key=>{
   const {hasEvent,hasTask}=marks.get(key);
   return `<button class="day ${key===selected?'selected':''} ${key===dateKey()?'today':''} ${localDate(key).getMonth()!==d.getMonth()?'outside':''}" data-day="${key}" ${key<MIN_DATE||key>MAX_DATE?'disabled':''} aria-pressed="${key===selected}" aria-label="${fmt(key)}${hasEvent?'、予定あり':''}${hasTask?'、期限付きタスクあり':''}">
     <span>${localDate(key).getDate()}</span><span class="day-marks" aria-hidden="true">${hasEvent?'<i class="event-mark"></i>':''}${hasTask?'<i class="task-mark"></i>':''}</span></button>`;
 }).join('');
 return `<section class="calendar" aria-label="カレンダー"><div class="calendar-heading"><div><span class="eyebrow">YOUR DAYS, YOUR PACE</span><h2>${d.getFullYear()}<small>年</small> ${d.getMonth()+1}<small>月</small></h2></div><div class="segment"><button data-mode="week" aria-pressed="${mode==='week'}">週</button><button data-mode="month" aria-pressed="${mode==='month'}">月</button></div></div><div class="calendar-nav"><button data-nav="-1" aria-label="前の${mode==='week'?'週':'月'}">‹</button><span>${mode==='week'?fmt(first,{month:'numeric',day:'numeric'})+' — '+fmt(addDays(first,6),{month:'numeric',day:'numeric'}):'日付を選んで予定を確認'}</span><button data-nav="1" aria-label="次の${mode==='week'?'週':'月'}">›</button></div><div class="weekdays">${['月','火','水','木','金','土','日'].map(x=>`<span>${x}</span>`).join('')}</div><div class="days">${buttons}</div><div class="calendar-legend"><span><i class="event-mark" aria-hidden="true"></i>予定</span><span><i class="task-mark" aria-hidden="true"></i>期限付きタスク</span></div></section>`;
}
function render(){
 const today=dateKey(),due=state.items.filter(x=>x.type==='task'&&x.due).sort((a,b)=>a.due.localeCompare(b.due)),someday=state.items.filter(x=>x.type==='task'&&!x.due).sort((a,b)=>Number(b.pinned)-Number(a.pinned));
 let content='';
 if(view==='home') {
 const events=state.items.map(x=>eventOn(x,selected)).filter(Boolean).sort((a,b)=>a.start.localeCompare(b.start));
 content=`${calendar()}<section class="agenda"><div class="section-title"><h2>${selected===today?'今日':fmt(selected,{month:'short',day:'numeric'})}<span>の予定</span></h2><span class="count">${events.length}件</span></div>${events.length?events.map(e=>`<button class="event" data-edit="${esc(e.id)}" data-occurrence="${e.occurrence}"><div class="event-time">${e.allDay?'終日':e.start.slice(0,10)<selected?'継続中':e.start.slice(11)}<small>${e.allDay?'':e.end.slice(0,10)>selected?'翌日以降まで':e.end.slice(11)}</small></div><div class="event-body"><strong>${esc(e.title)}</strong><small>${e.allDay?'日付だけの予定':e.repeat!=='none'?repeatLabel[e.repeat]:'自分の時間'}${e.end.slice(0,10)>e.start.slice(0,10)?' · '+fmt(e.allDay?addDays(e.end.slice(0,10),-1):e.end.slice(0,10),{month:'numeric',day:'numeric'})+'まで':''}</small></div><span>›</span></button>`).join(''):'<div class="empty">予定のない、余白のある一日。<br><small>＋追加から予定を入れられます</small></div>'}</section><section class="tasks"><div class="section-title"><h2>期限のあるタスク</h2><button class="text-button" data-view="due">すべて ${due.length} <span>↗</span></button></div>${due.slice(0,5).map(taskRow).join('')||'<p class="empty">期限のあるタスクはありません</p>'}</section><button class="someday-card" data-view="someday"><span class="someday-symbol">☷</span><span><strong>いつかやる</strong><small>思いついたことを、ひとまずここに。</small></span><span class="count">${someday.length}</span><span>›</span></button><button class="history-link" data-view="history">✓ 完了したタスクを見る</button>`;
 } else if(view==='due') {
 const groups=dueGroups(due,today);
 content=`<div class="page-intro"><span class="eyebrow">ONE THING AT A TIME</span><h2>期限のあるタスク</h2><p>小さな一歩を、ひとつずつ。</p></div>${[...groups].map(([label,tasks])=>`<section class="tasks"><h3>${label}</h3>${tasks.map(taskRow).join('')||'<p class="empty">該当するタスクはありません</p>'}</section>`).join('')||'<p class="empty">すべて片づいています</p>'}`;
 } else if(view==='someday') {
 const filtered=someday.filter(t=>t.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
 content=`<div class="page-intro"><span class="eyebrow">ROOM FOR POSSIBILITIES</span><h2>いつかやる</h2><p>まだ日付のない、あなたのアイデア。</p></div><label class="search"><span>⌕</span><input id="search" type="search" placeholder="タスクを検索" value="${esc(search)}" aria-label="いつかやるを検索"></label><div class="tasks">${filtered.map(taskRow).join('')||'<p class="empty">タスクが見つかりません</p>'}</div><p class="hint">◇ でピン留め。タップして期限を設定できます。</p>`;
 } else {
 const cutoff=new Date();cutoff.setDate(cutoff.getDate()-90);
 const history=state.history.filter(h=>showAllHistory||new Date(h.completedAt)>=cutoff).sort((a,b)=>b.completedAt.localeCompare(a.completedAt));
 content=`<div class="page-intro"><span class="eyebrow">LOOK HOW FAR YOU’VE COME</span><h2>完了したタスク</h2><p>完了履歴は削除期限を設けず端末内に保存します。</p><p class="hint">繰り返しの復元は、現在の未完了1件に統合し最新期限を維持します。</p></div><label class="history-toggle"><input type="checkbox" id="all-history" ${showAllHistory?'checked':''}> 90日より前の履歴も表示</label><section class="tasks">${history.map(h=>`<div class="history-row"><span>${h.restoredAt?'↶':'✓'}</span><div>${esc(h.title)}<small>${new Date(h.completedAt).toLocaleString('ja-JP',{hour12:false})} 完了${h.restoredAt?' · 完了取り消し済み':''}</small>${!h.task?'<small>旧形式のため元タスクを特定できず復元できません</small>':''}</div>${h.task&&!h.restoredAt?`<button class="restore" data-restore="${esc(h.id)}">未完了に戻す</button>`:''}</div>`).join('')||`<p class="empty">${showAllHistory?'': '直近90日に'}完了したタスクはありません</p>`}</section>`;
 }
 $('#app').innerHTML=`<div class="app-shell"><header><div class="brand"><span class="brand-mark">m<span>・</span></span><div><h1>マイスケジュール</h1><p>毎日に、ちょうどいい余白を。</p></div></div><span class="prototype">PROTOTYPE</span></header><main>${view!=='home'?'<button class="back" data-view="home">‹ ホームに戻る</button>':'<div class="welcome"><span>こんにちは。<br><strong>今日は、どんな一日に？</strong></span><button class="today-button" data-today>今日へ ↗</button></div>'}${storageBlocked?'<p class="error">保存データを読み込めませんでした。元データは上書きせず保護しています。ブラウザの保存設定やデータを確認してください。</p>':''}${content}<footer><span class="local-dot"></span> この端末だけに保存 · 架空データの試作品<br><small>ChatGPT・Apple通知連携は未実装です</small></footer></main><div class="add-dock"><button class="add-button" id="add">＋ <span>追加</span></button></div></div>`;
 bind();
}
function bind(){
 document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{view=b.dataset.view;search='';render();window.scrollTo(0,0);});
 document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{mode=b.dataset.mode;render();});
 document.querySelectorAll('[data-day]').forEach(b=>b.onclick=()=>{selected=b.dataset.day;render();});
 document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>{if(mode==='week')selected=clampDate(addDays(selected,7*Number(b.dataset.nav)));else{const d=localDate(selected);d.setDate(1);d.setMonth(d.getMonth()+Number(b.dataset.nav));selected=clampDate(dateKey(d));}render();});
 if($('[data-today]'))$('[data-today]').onclick=()=>{selected=dateKey();render();};
 document.querySelectorAll('[data-complete]').forEach(b=>b.onclick=()=>{if(mutate(()=>complete(state,b.dataset.complete))){render();notify('タスクを完了しました');}});
 document.querySelectorAll('[data-restore]').forEach(b=>b.onclick=()=>{if(mutate(()=>restore(state,b.dataset.restore))){render();notify('未完了に戻しました。繰り返しは現在の1件に統合します');}});
 document.querySelectorAll('[data-pin]').forEach(b=>b.onclick=()=>{if(mutate(()=>{const t=state.items.find(x=>x.id===b.dataset.pin);t.pinned=!t.pinned;}))render();});
 document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openEditor(state.items.find(x=>x.id===b.dataset.edit),b.dataset.occurrence));
 $('#add').onclick=()=>openEditor();
 if($('#search'))$('#search').oninput=e=>{const pos=e.target.selectionStart;search=e.target.value;render();$('#search').focus();try{$('#search').setSelectionRange(pos,pos);}catch{}};
 if($('#all-history'))$('#all-history').onchange=e=>{showAllHistory=e.target.checked;render();};
}
function openEditor(original=null,occurrence=null){
 const dialog=$('#editor');let type=original?.type||'event',data=original?structuredClone(original):{id:newId(),title:'',...defaults(selected),allDay:false,due:null,pinned:false,repeat:'none',excluded:[]};
 if(original?.type==='event'&&occurrence){const current=eventOn(original,selected);if(current){data.start=current.start;data.end=current.end;}}
 function draw(){dialog.innerHTML=`<form id="entry-form"><div class="sheet-handle"></div><div class="sheet-heading"><h2 id="editor-title">${original?'編集':'新しく追加'}</h2><button type="button" class="close" id="close" aria-label="閉じる">×</button></div><label class="title-input"><span>名称</span><input name="title" maxlength="160" required placeholder="${type==='event'?'どんな予定？':'やることをひとつ'}" value="${esc(data.title)}" autocomplete="off"></label><div class="entry-fields">${type==='event'?`<label class="toggle-row">終日<input name="allDay" type="checkbox" ${data.allDay?'checked':''}></label><label>開始<input name="start" type="${data.allDay?'date':'datetime-local'}" value="${data.allDay?data.start.slice(0,10):data.start}" step="${data.allDay?1:600}" min="${MIN_DATE}${data.allDay?'': 'T00:00'}" max="${MAX_DATE}${data.allDay?'': 'T23:59'}" required></label><label>終了<input name="end" type="${data.allDay?'date':'datetime-local'}" value="${data.allDay?addDays(data.end.slice(0,10),data.end.slice(11)==='00:00'?-1:0):data.end}" step="${data.allDay?1:600}" min="${MIN_DATE}${data.allDay?'': 'T00:00'}" max="${MAX_DATE}${data.allDay?'': 'T23:59'}" required></label><p class="hint">${data.allDay?'終了日を含みます':'24時間表記 · 通常は10分単位'}</p>`:`<label>期限 <span class="optional">任意</span><input name="due" type="date" min="${MIN_DATE}" max="${MAX_DATE}" value="${data.due||''}"></label><p class="hint">名称だけでも保存できます。期限なしは「いつかやる」へ。</p>`}<details><summary>詳細設定</summary><label>繰り返し<select name="repeat">${Object.entries(repeatLabel).filter(([key])=>!data.exceptionDate||key==='none').map(([key,label])=>`<option value="${key}" ${data.repeat===key?'selected':''}>${label}</option>`).join('')}</select></label>${type==='event'?'<label class="toggle-row">1分単位で入力<input type="checkbox" id="minute-step"></label>':''}<p class="hint">毎月・毎年は基準日を維持し、存在しない日は月末にします。日付は2000〜2100年、予定は最大366日間です。</p></details>${original?.repeat!=='none'&&original?'<label>繰り返しの変更範囲<select name="scope"><option value="one">今回だけ</option><option value="all">すべて</option></select></label>':''}${original?.exceptionDate?'<label>削除の範囲<select name="deleteScope"><option value="one">この例外予定だけ</option><option value="all">元シリーズとすべての例外予定</option></select></label><p class="hint">保存はこの例外予定だけを変更します。元シリーズとの関連付けは維持します。</p>':''}<p id="form-error" class="error" role="alert"></p></div><div class="sheet-bottom">${!original?`<div class="segment type-switch"><button type="button" data-type="event" aria-pressed="${type==='event'}">予定</button><button type="button" data-type="task" aria-pressed="${type==='task'}">タスク</button></div>`:''}<button class="save" type="submit">${original?'変更を保存':'保存する'} <span>✓</span></button>${original?'<button type="button" class="delete" id="delete">この項目を削除</button>':''}</div></form>`;
 const form=$('#entry-form');
 function capture(){const fd=new FormData(form);data.title=fd.get('title');data.repeat=fd.get('repeat');if(type==='task')data.due=fd.get('due')||null;else {data.allDay=fd.has('allDay');data.start=fd.get('start')+(data.allDay?'T00:00':'');data.end=data.allDay?addDays(fd.get('end'),1)+'T00:00':fd.get('end');}}
 $('#close').onclick=()=>dialog.close();
 document.querySelectorAll('[data-type]').forEach(b=>b.onclick=()=>{capture();type=b.dataset.type;if(!data.start)Object.assign(data,defaults(selected),{allDay:false});draw();});
 if(type==='event'){
  const timeControls = data.allDay ? null : enhanceTimeFields(form);
  form.elements.start.onchange=()=>{const start=form.elements.start.value;if(!start)return;try{if(data.allDay){const duration=Math.max(0,Math.round((localDate(form.elements.end.value)-localDate(data.start.slice(0,10)))/86400000));form.elements.end.value=addDays(start,duration);}else form.elements.end.value=shiftEnd(data.start,form.elements.end.value,start);data.start=start+(data.allDay?'T00:00':'');timeControls?.refresh();}catch(error){$('#form-error').textContent=error.message;}};
  form.elements.allDay.onchange=()=>{capture();if(data.allDay){data.start=data.start.slice(0,10)+'T00:00';data.end=addDays(data.start.slice(0,10),1)+'T00:00';}else Object.assign(data,defaults(data.start.slice(0,10)));draw();};
  if(timeControls){$('#minute-step').checked=timeControls.precise;$('#minute-step').onchange=e=>timeControls.setPrecise(e.target.checked);}
 }
 function scope(){return form.elements.deleteScope?.value||form.elements.scope?.value||'all';}
 function applyRemoval(){removeItem(state,original.id,scope(),occurrence||original.start?.slice(0,10));}
 if($('#delete'))$('#delete').onclick=async()=>{
   const deletionScope=scope(),expected=JSON.stringify(state.items.find(x=>x.id===original.id));
   if(await confirmDeletion(original,deletionScope,occurrence)){
     if(mutate(()=>{
       if(JSON.stringify(state.items.find(x=>x.id===original.id))!==expected)throw Error('項目が変更されました。開き直してから削除してください');
       removeItem(state,original.id,deletionScope,occurrence||original.start?.slice(0,10));
     })){dialog.close();render();notify('削除しました');}
   }
 };
 form.onsubmit=e=>{e.preventDefault();try{capture();let item={...data,type,title:data.title.trim(),anchorDay:original&&data.due===original.due&&type==='task'?original.anchorDay??Number((data.due||selected).slice(8,10)):Number((type==='event'?data.start:data.due||selected).slice(8,10)),anchorMonth:original&&data.due===original.due&&type==='task'?original.anchorMonth??Number((data.due||selected).slice(5,7)):Number((type==='event'?data.start:data.due||selected).slice(5,7))};validateItem(item);
 const one=original&&original.repeat!=='none'&&scope()==='one';
 if(one){item={...item,id:newId(),repeat:'none',excluded:[]};delete item.seriesId;}
 else if(original?.repeat!=='none'&&original&&type==='event'&&occurrence){const days=Math.round((localDate(item.start.slice(0,10))-localDate(occurrence))/86400000);const start=addDays(original.start.slice(0,10),days)+item.start.slice(10);item.end=shiftEnd(item.start,item.end,start);item.start=start;item.anchorDay=Number(start.slice(8,10));item.anchorMonth=Number(start.slice(5,7));}
 if(mutate(()=>{if(one){if(type==='event')editEventOccurrence(state,original.id,item,occurrence||original.start.slice(0,10));else{applyRemoval();state.items.push(item);}}else{state.items=state.items.filter(x=>x.id!==item.id);state.items.push(item);}rollTasks(state);})){dialog.close();render();notify('保存しました');}
 }catch(error){$('#form-error').textContent=error.message;}};
 }
 draw();dialog.showModal();
}
$('#editor').addEventListener('click',e=>{if(e.target===$('#editor')){const r=e.target.getBoundingClientRect();if(e.clientY<r.top||e.clientX<r.left||e.clientX>r.right)e.target.close();}});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden)return;
  const previous=JSON.stringify(state);
  if(mutate(()=>rollTasks(state))&&previous!==JSON.stringify(state))render();
});
window.addEventListener('storage',e=>{if(e.key===STORAGE_KEY){try{state=e.newValue===null?seed():parseState(e.newValue);storageBlocked=false;rollTasks(state);$('#delete-confirm').close('cancel');$('#editor').close();render();notify('別の画面での変更を反映しました');}catch{storageBlocked=true;$('#delete-confirm').close('cancel');$('#editor').close();render();notify('保存データの形式を確認できません');}}});
render();
