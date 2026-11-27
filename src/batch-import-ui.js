import {createBatchImporter,parseBatchImport} from './batch-import.js';
import {createDom} from './dom.js';
import {MAX_DATE,MAX_EVENT_END,MIN_DATE,REPEATS,dateKey} from './model.js';

const fieldLabels={type:'種類',title:'名称',allDay:'終日指定',start:'開始日時',end:'終了日時',
  startDate:'開始日',endDate:'最終日',due:'期限',repeat:'繰り返し'};
const dateFieldsKeys=['due','start','end','startDate','endDate'];
const updateMessage='保存済みデータ、日付、またはタイムゾーンが変わりました。取り込み内容をもう一度確認してください。';
const asText=value=>typeof value==='string'?value:'';
const repeatLabel=repeat=>Object.hasOwn(REPEATS,repeat)?REPEATS[repeat]:'未指定';
const rowIssue=(error,line)=>'JSON '+line+'行目'+(error.field?'・'+
  (Object.hasOwn(fieldLabels,error.field)?fieldLabels[error.field]:error.field.slice(0,60)):'')+'：'+error.message;
const rowErrors=entry=>entry?.errors??(entry?.error?[entry.error]:[]);

export function createBatchImportUI({store,onChange}){
  const {h,replace}=createDom(document);
  const dialog=document.createElement('dialog');
  dialog.id='batch-import';dialog.className='batch-dialog';
  dialog.setAttribute('aria-labelledby','batch-title');
  const title=h('h2',{id:'batch-title'});
  title.tabIndex=-1;
  const status=h('p',{id:'batch-status',role:'status'});
  const content=h('div',{class:'batch-content'});
  const actions=h('div',{class:'batch-actions'});
  dialog.append(title,status,content,actions);
  document.body.append(dialog);

  let importer,source='',rows=[],excluded=new Set(),plan,baseline,opener,onReturn;
  let stage='paste',dirty=false,acknowledged=false,busy=false,blocked=false,readUnconfirmed=false;
  const currentDay=()=>dateKey();
  const zone=()=>new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const speak=message=>{if(status.textContent!==message)status.textContent=message;};
  function button(id,label,action,{primary=false,disabled=false}={}){
    const element=h('button',{id,type:'button',class:primary?'batch-primary':'batch-secondary',disabled},label);
    element.onclick=action;
    return element;
  }
  function show(heading,body,buttons,{focus='#batch-title',scroll=0}={}){
    title.textContent=heading;dialog.dataset.stage=stage;
    replace(content,body);replace(actions,buttons);
    (dialog.querySelector(focus)||title).focus({preventScroll:true});
    content.scrollTop=scroll;
  }
  function close(){
    if(busy)return;
    if(!dirty||stage==='done'||stage==='unknown')finish();
    else{
      // Keep the form and its unsaved values intact until discard is confirmed.
      const previousFocus=document.activeElement,previousTitle=title.textContent;
      const previousActions=[...actions.children];
      content.hidden=true;
      title.textContent='取り込みを中止しますか？';
      stage='discard';dialog.dataset.stage=stage;
      replace(actions,button('batch-keep','編集に戻る',()=>{
        stage=previousStage;dialog.dataset.stage=stage;content.hidden=false;
        title.textContent=previousTitle;replace(actions,previousActions);
        (previousFocus?.isConnected?previousFocus:title).focus({preventScroll:true});
        changed();
      }),button('batch-discard','下書きを破棄して戻る',finish));
      dialog.querySelector('#batch-keep').focus();
    }
  }
  let previousStage;
  function requestClose(){
    if(stage==='discard')return dialog.querySelector('#batch-keep')?.click();
    previousStage=stage;
    close();
  }
  dialog.addEventListener('cancel',event=>{event.preventDefault();requestClose();});
  function finish(){
    dialog.close();
    const target=opener,restore=onReturn;
    importer=null;plan=null;baseline=null;rows=[];excluded.clear();source='';
    dirty=false;blocked=false;acknowledged=false;content.hidden=false;
    replace(content);replace(actions);speak('');
    opener=null;onReturn=null;restore?.();
    if(target?.isConnected){
      (target.disabled?target.closest('dialog')?.querySelector('#close'):target)?.focus({preventScroll:true});
    }
  }
  function paste(message='',focus='#batch-json'){
    stage='paste';plan=null;baseline=null;acknowledged=false;
    const input=h('textarea',{id:'batch-json',rows:8,'aria-describedby':'batch-format batch-status'});
    input.value=source;
    input.spellcheck=false;
    input.oninput=()=>{source=input.value;dirty=true;speak('');};
    const check=()=>{
      source=input.value;dirty=dirty||source.length>0;
      try{
        const parsed=parseBatchImport(source);
        const tested=importer.prepare(parsed);
        if(routeUnknownKeys(tested))return;
        rows=parsed;excluded.clear();setPlan(readUnconfirmed?null:tested);preview();
      }catch(error){
        speak(error.line?'JSON '+error.line+'行目：'+error.message:error.message);
        input.focus();
      }
    };
    speak(message);
    show('まとめて取り込む',[
      h('p',{id:'batch-format'},'ChatGPTから専用JSONの本文を貼り付けます。my-schedule-import、バージョン1、最大100件・128 KiBです。コードフェンス、説明文、バックアップJSONは取り込めません。'),
      rows.length&&h('p',{},'JSONを読み直すと、一覧での修正と除外がリセットされます。'),
      h('label',{class:'batch-field'},'取り込み用JSON',input),
    ],[
      button('batch-cancel','新規追加へ戻る',requestClose),
      button('batch-parse','内容を確認',check,{primary:true}),
    ],{focus});
  }
  function routeUnknownKeys(tested){
    const unknown=tested.rows.filter(row=>row.error?.code==='key');
    if(!unknown.length)return false;
    paste(rowIssue(unknown[0].error,unknown[0].line)+'。'+(unknown.length>1?'他 '+(unknown.length-1)+'行。':'')+
      '貼り付けたJSONを修正してください。');
    return true;
  }
  function setPlan(tested){
    plan=tested;acknowledged=false;
    baseline={revision:store.revision,status:store.status,day:tested?.day??currentDay(),zone:tested?.zone??zone()};
  }
  function prepare(){
    const included=rows.filter(row=>!excluded.has(row.index));
    try{
      const tested=included.length&&!readUnconfirmed?importer.prepare(included):null;
      if(tested&&routeUnknownKeys(tested))return false;
      setPlan(tested);return true;
    }catch(error){setPlan(null);speak(error.message);return true;}
  }
  function changed(unconfirmed){
    if(typeof unconfirmed==='boolean')readUnconfirmed=unconfirmed;
    if(!dialog.open||busy||blocked||!baseline||['discard','paste','done','unknown'].includes(stage))return false;
    if(!readUnconfirmed&&baseline.revision===store.revision&&baseline.status===store.status&&baseline.day===currentDay()&&baseline.zone===zone())return false;
    const message=readUnconfirmed?'保存領域を確認できませんでした。下書きは保持しています。':updateMessage;
    if(stage==='edit'){
      plan=null;baseline=null;acknowledged=false;speak(message);
    }else{
      speak(message);
      const scroll=content.scrollTop;
      if(readUnconfirmed){plan=null;baseline=null;acknowledged=false;preview('#batch-title',scroll);}
      else if(prepare())preview('#batch-title',scroll);
    }
    return true;
  }
  function details(item,row){
    const kind=item.type==='task'?'タスク':item.allDay?'予定（終日）':'予定（時刻指定）';
    const showBoth=item.type==='task'&&item.repeat!=='none'&&row.originalDue<plan.day;
    const time=item.type==='task'?
      (showBoth?'初回期限：'+row.originalDue+' → 登録期限：'+row.registeredDue:
        '期限：'+(item.due||'なし')):
      item.allDay?'開始日：'+item.start.slice(0,10)+' ／ 最終日：'+row.endDate:
        '開始：'+item.start.replace('T',' ')+' ／ 終了：'+item.end.replace('T',' ');
    return [h('p',{},kind),h('p',{},time),row.noNext&&h('p',{},'対応範囲内に次回なし'),
      h('p',{},'繰り返し：'+repeatLabel(item.repeat))];
  }
  function sourceDetails(input){
    if(input?.type==='task')return [h('p',{},'タスク'),
      h('p',{},'指定された期限：'+(input.due===null?'なし':asText(input.due)||'未指定')),
      h('p',{},'繰り返し：'+repeatLabel(input.repeat))];
    if(input?.type!=='event')return h('p',{},'種類：未確定');
    const allDay=input.allDay===true;
    return [h('p',{},'予定（'+(allDay?'終日':input.allDay===false?'時刻指定':'終日指定未確定')+'）'),
      h('p',{},'指定された開始：'+(asText(allDay?input.startDate:input.start)||'未指定')+
        ' ／ 指定された終了：'+(asText(allDay?input.endDate:input.end)||'未指定')),
      h('p',{},'繰り返し：'+repeatLabel(input.repeat))];
  }
  function list(final=false){
    const entries=new Map(plan?.rows.map(row=>[row.index,row]));
    const warnings=new Map();
    for(const [index,group] of (plan?.duplicates??[]).entries()){
      const repeats=items=>[...new Set(items.map(item=>repeatLabel(item.repeat)))].join('、');
      const description=['グループ '+(index+1),
        group.existing.length?'保存済み '+group.existing.length+'件と一致（'+repeats(group.existing)+'）':null,
        group.candidates.length>1?'取り込み内 '+group.candidates.length+'件が一致（'+repeats(group.candidates)+'）':null,
      ].filter(Boolean).join(' ／ ');
      for(const candidate of group.candidates)warnings.set(candidate.index,description);
    }
    return h('div',{class:'batch-list',role:'list','aria-label':final?'追加する項目':'取り込み項目'},rows.filter(row=>!final||!excluded.has(row.index)).map(row=>{
      const entry=entries.get(row.index),isExcluded=excluded.has(row.index),number=row.index+1;
      const name=entry?.item?.title||asText(row.input?.title)||'名称未入力';
      const toggle=!final&&button('batch-toggle-'+number,isExcluded?number+'番を対象に戻す':number+'番を除外',()=>{
        const scroll=content.scrollTop;
        if(isExcluded)excluded.delete(row.index);else excluded.add(row.index);
        if(prepare()){speak(isExcluded?number+'番を取り込み対象に戻しました。':number+'番を除外しました。');preview('#'+toggle.id,scroll);}
      });
      return h('div',{class:'batch-row',role:'listitem','data-batch-row':number},
        h('h3',{},number+'番　',h('span',{class:'batch-name'},name)),
        h('p',{},(isExcluded?'除外':'取り込み対象')+' · JSON '+row.line+'行目'),
        entry?.item?details(entry.item,entry):sourceDetails(row.input),
        rowErrors(entry).map(error=>h('p',{class:'error'},rowIssue(error,row.line))),
        warnings.has(row.index)&&h('p',{class:'batch-warning'},'重複候補：'+warnings.get(row.index)),
        !final&&h('div',{class:'batch-row-actions'},button('batch-edit-'+number,number+'番を修正',()=>edit(row)),toggle));
    }));
  }
  function preview(focus='#batch-title',scroll=0){
    stage='preview';
    const targetCount=rows.length-excluded.size;
    const invalid=!plan||plan.errors.length||plan.rows.some(row=>row.error);
    const next=button('batch-review','最終確認へ',()=>{
      if(changed())return;
      if(plan.duplicates.length&&(!acknowledged||!importer.approveDuplicates(plan))){
        speak('重複候補を確認してください。');return;
      }
      finalReview();
    },{primary:true,disabled:!!invalid||plan.duplicates.length>0&&!acknowledged});
    const consent=plan?.duplicates.length?h('input',{id:'batch-duplicates',type:'checkbox',checked:acknowledged}):null;
    if(consent)consent.onchange=()=>{acknowledged=consent.checked;next.disabled=!!invalid||!acknowledged;};
    show('取り込み内容を確認',[
      h('p',{},'表示 '+rows.length+'件 ／ 取り込み対象 '+targetCount+'件 ／ 除外 '+excluded.size+'件'),
      targetCount===0&&h('p',{class:'error'},'取り込み対象を1件以上選んでください。'),
      plan?.errors.map(error=>h('p',{class:'error'},error.message)),
      list(),
      consent&&h('label',{class:'batch-consent'},consent,' 重複を承知して追加'),
    ],[
      button('batch-cancel','取り込みを中止',requestClose),
      button('batch-paste','JSONを編集',()=>paste()),
      targetCount>0&&(!plan||plan.errors.some(error=>error.code==='blocked'))&&
        button('batch-refresh','最新データで再検証',refresh),
      next,
    ],{focus,scroll});
  }
  function edit(row){
    stage='edit';
    const scroll=content.scrollTop,number=row.index+1;
    const raw=row.input??{};
    const errors=rowErrors(plan?.rows.find(entry=>entry.index===row.index));
    const errorsByField=new Map(errors.map(error=>[error.field,error]));
    function select(name,value,options){
      return h('select',{name},options.map(([key,label])=>h('option',{value:key,selected:key===value},label)));
    }
    const type=select('type',asText(raw.type),[['','選択してください'],['event','予定'],['task','タスク']]);
    const kind=select('allDay',typeof raw.allDay==='boolean'?String(raw.allDay):'',
      [['','選択してください'],['false','時刻指定'],['true','終日']]);
    const name=h('input',{name:'title',value:asText(raw.title),maxlength:160});
    const repeat=select('repeat',asText(raw.repeat),[['','選択してください'],...Object.entries(REPEATS)]);
    const dueMode=select('dueMode',raw.due===null?'none':'dated',[['dated','日付を指定する'],['none','期限なし']]);
    const label=(key,input,text=fieldLabels[key],errorKey=key)=>{
      const field=h('label',{class:'batch-field'},text,input);
      if(errorKey===null)return field;
      const error=errorsByField.get(errorKey);
      if(!error)return field;
      const id='batch-field-error-'+number+'-'+key;
      input.setAttribute('aria-invalid','true');
      input.setAttribute('aria-describedby',id);
      const original=raw[errorKey]!==undefined&&dateFieldsKeys.includes(errorKey)?
        ' 元の入力値：'+JSON.stringify(raw[errorKey]).slice(0,160):'';
      return h('div',{},field,h('p',{class:'error',id},rowIssue(error,row.line)+original));
    };
    const dateValues=new Map();
    const date=(key,dateOnly,end=false)=>{
      const control=h('input',{name:key,value:asText(raw[key]),type:dateOnly?'date':'datetime-local',
        min:dateOnly?MIN_DATE:MIN_DATE+'T00:00',max:dateOnly?MAX_DATE:end?MAX_EVENT_END:MAX_DATE+'T23:59',step:dateOnly?1:60});
      const initial=control.value;
      let touched=false;
      control.oninput=control.onchange=()=>{touched=true;};
      dateValues.set(key,()=>touched||control.value!==initial?control.value:raw[key]);
      return label(key,control);
    };
    // Keep each set of controls alive when switching kinds so returning to it
    // restores any values typed in this edit.
    const due=date('due',true),timed=[date('start',false),date('end',false,true)],
      allDay=[date('startDate',true),date('endDate',true)];
    const dateFields=h('div',{class:'batch-fields'}),kindField=label('allDay',kind);
    const dueFields=h('div',{class:'batch-fields'});
    const dueModeField=label('dueMode',dueMode,'期限の指定',raw.due===null?'due':null);
    const fields=h('div',{class:'batch-fields'});
    const syncType=()=>{
      replace(fields,type.value==='task'?[dueModeField,dueFields]:type.value==='event'?[kindField,dateFields]:null);
      syncKind();
    };
    const syncKind=()=>{
      replace(dateFields,kind.value==='true'?allDay:kind.value==='false'?timed:null);
      replace(dueFields,dueMode.value==='dated'?due:null);
    };
    type.onchange=syncType;kind.onchange=syncKind;
    dueMode.onchange=syncKind;
    syncType();
    const form=h('form',{id:'batch-item-form'},label('title',name),label('type',type),fields,label('repeat',repeat));
    form.noValidate=true;
    const apply=()=>{
      const input={type:type.value,title:name.value,repeat:repeat.value};
      const copyDate=key=>{
        const value=dateValues.get(key)();
        if(value!==undefined)input[key]=value;
      };
      if(type.value==='task'){
        if(dueMode.value==='none')input.due=null;
        else{
          copyDate('due');
          if(input.due===null)input.due='';
        }
      }
      if(type.value==='event'){
        input.allDay=kind.value===''?null:kind.value==='true';
        if(kind.value==='true'){copyDate('startDate');copyDate('endDate');}
        else if(kind.value==='false'){copyDate('start');copyDate('end');}
      }
      row.input=input;
      if(prepare()){
        const attempted=plan?.rows.find(entry=>entry.index===row.index)?.error;
        speak(attempted?rowIssue(attempted,row.line):number+'番の修正を反映しました。');
        preview('#batch-edit-'+number,scroll);
      }
    };
    form.onsubmit=event=>{event.preventDefault();apply();};
    show(number+'番を修正',[errors.filter(error=>!error.field).map(error=>h('p',{class:'error'},rowIssue(error,row.line))),form],[
      button('batch-edit-back','修正せず戻る',()=>{
        if(!baseline&&!prepare())return;
        preview('#batch-edit-'+number,scroll);
      }),
      button('batch-apply','修正を反映',apply,{primary:true}),
    ],{focus:form.querySelector('[aria-invalid="true"]')?'[aria-invalid="true"]':'[name="title"]'});
  }
  function finalReview(){
    stage='final';speak('');
    const events=plan.rows.filter(row=>row.item.type==='event').length;
    const duplicates=plan.duplicates.reduce((sum,group)=>sum+group.candidates.length,0);
    show('登録前の最終確認',[
      h('p',{},'予定 '+events+'件 ／ タスク '+(plan.rows.length-events)+'件 ／ 合計 '+plan.rows.length+'件'),
      h('p',{},'除外 '+excluded.size+'件 ／ 重複承認 '+duplicates+'件'),list(true),
    ],[button('batch-back','一覧に戻る',()=>preview()),button('batch-save','確認した'+plan.rows.length+'件を一括登録',save,{primary:true})]);
  }
  async function refresh(){
    if(busy||blocked)return;
    busy=true;dialog.querySelectorAll('button').forEach(control=>{control.disabled=true;});
    speak('保存済みデータを確認しています…');
    try{
      await store.refresh();
      readUnconfirmed=store.status!=='ready';
      onChange(!readUnconfirmed);
      speak(store.status==='ready'?'最新のデータで再検証しました。取り込み内容を確認してください。':
        '保存領域を確認できませんでした。下書きは保持しています。');
      if(prepare())preview();
    }catch{
      setPlan(null);speak('保存領域を確認できませんでした。下書きは保持しています。');preview();
    }finally{busy=false;}
  }
  async function save(){
    if(busy||blocked||stage!=='final'||changed())return;
    busy=true;dialog.querySelectorAll('button').forEach(control=>{control.disabled=true;});
    speak('一括登録中です…');
    let result;
    try{result=await importer.save(plan);}
    catch{result={reason:'unverified',committed:null};}
    if(result.ok&&result.verified&&result.committed===true){
      stage='done';dirty=false;
      speak(result.count+'件を登録しました。'+(result.warning?' '+result.warning:''));
      show('一括登録が完了しました',null,button('batch-done','新規追加へ戻る',requestClose,{primary:true}));
    }else if(result.committed===null||result.reason==='unverified'){
      blocked=true;stage='unknown';plan=null;
      speak('登録された可能性があります。再登録せず、バックアップ・復元から保存状態を確認してください。');
      show('登録結果を確認できません',h('p',{},'同じ候補の再確定を停止しました。'),
        button('batch-done','新規追加へ戻る',requestClose));
    }else{
      acknowledged=false;
      if(!result.reusable){plan=null;baseline=null;}
      speak((result.message||'一括登録できませんでした。')+
        (result.recheck?' 最新のデータで再検証してから確認してください。':''));
      preview();
    }
    try{onChange();}finally{busy=false;}
  }
  return {
    open(trigger,restore){
      if(dialog.open||busy)return;
      opener=trigger;onReturn=restore;importer=createBatchImporter(store);
      dialog.showModal();paste();
    },
    isOpen:()=>dialog.open,
    changed,
  };
}
