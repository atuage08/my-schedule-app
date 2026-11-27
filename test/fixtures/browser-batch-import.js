import {STORAGE_KEY,addDays} from '../../src/model.js';

const task=(title,due=null,repeat='none')=>({type:'task',title,due,repeat});
const event=(title,start,end)=>({type:'event',title,allDay:false,start,end,repeat:'none'});
const encode=items=>JSON.stringify({format:'my-schedule-import',formatVersion:1,items},null,2);

export async function checkBatchImport({verify,wait,today}){
  const $=selector=>document.querySelector(selector);
  const click=id=>$('#'+id).click();
  const modal=()=>$('#batch-import');
  const stage=value=>modal().dataset.stage===value;
  const text=()=>$('#batch-status').textContent;
  const form=()=>$('#entry-form');
  const snapshot=()=>localStorage.getItem(STORAGE_KEY);
  const originalSet=Storage.prototype.setItem;
  const originalGet=Storage.prototype.getItem;
  const originalLock=navigator.locks.request;
  const baseline=snapshot();
  const nextDay=addDays(today,1);
  const fill=value=>{
    const box=$('#batch-json');
    box.value=value;box.dispatchEvent(new Event('input',{bubbles:true}));click('batch-parse');
  };
  const reopen=()=>{click('add');click('batch-open');};
  const cancel=async()=>{
    click('batch-cancel');
    if(stage('discard'))click('batch-discard');
    await wait(()=>!modal().open&&document.activeElement===$('#batch-open'));
  };
  const decline=()=>verify($('#batch-review').disabled&&!$('#batch-save'));
  const approve=()=>{
    const box=$('#batch-duplicates');
    box.checked=true;box.dispatchEvent(new Event('change',{bubbles:true}));
  };
  const saved=()=>JSON.parse(snapshot());
  const painted=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const locateRow=i=>$('[data-batch-row="'+i+'"]');
  const storeChanged=()=>window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
  const change=control=>control.dispatchEvent(new Event('change',{bubbles:true}));
  const waitForRefresh=async()=>{
    await wait(()=>$('#schedule-calendar')?.dataset.calendarStatus==='ready');
  };
  async function holdRefresh({fail=false}={}){
    let release,entered=false;
    const gate=new Promise(resolve=>{release=resolve;});
    navigator.locks.request=function(name,options,action){
      navigator.locks.request=originalLock;
      return originalLock.call(this,name,options,async lock=>{
        entered=true;await gate;
        if(fail)throw new DOMException('fictional refresh rejection','AbortError');
        return action(lock);
      });
    };
    storeChanged();
    await wait(()=>entered);
    return release;
  }

  try{
    document.body.dataset.phase2Step='batch import paste and cancel';
    click('add');
    form().elements.title.value='保持する架空の下書き';
    form().elements.start.value=today+'T08:17';
    click('batch-open');
    verify(modal().open&&$('#editor').open&&document.activeElement===$('#batch-json'));
    const sample=encode([task('架空')]);
    for(const bad of ['```json\n'+sample+'\n```','説明\n'+sample,'{"format":',
      '{"format":"my-schedule-backup","formatVersion":1,"data":{}}',encode([{type:'bad',notification:{}}]),
      sample.replace('"due": null','"due": null, "due": null')]){
      fill(bad);
      verify(stage('paste')&&text().length>0&&$('#batch-json').value===bad);
      verify(snapshot()===baseline);
    }
    fill(encode([task('外す'),task('これも外す')]));
    click('batch-toggle-1');click('batch-toggle-2');
    decline();
    verify(modal().textContent.includes('取り込み対象 0件 ／ 除外 2件'));
    click('batch-cancel');verify(stage('discard')&&document.activeElement===$('#batch-keep'));
    click('batch-keep');verify(stage('preview')&&modal().textContent.includes('除外 2件'));
    await cancel();
    verify(form().elements.title.value==='保持する架空の下書き'&&form().elements.start.value===today+'T08:17');
    verify(snapshot()===baseline);
    click('close');

    document.body.dataset.phase2Step='batch date corrections preserve invalid source fields';
    reopen();
    fill(encode([task('','2026-02-30'),event('不正な時刻','2026-02-30T09:07',nextDay+'T11:00'),
      {type:'event',title:'不正な終日',allDay:true,startDate:nextDay,endDate:'存在しない日付',repeat:'none'}]));
    click('batch-edit-1');
    let invalidForm=$('#batch-item-form');
    const errorsFor=field=>$('#'+invalidForm.elements[field].getAttribute('aria-describedby'));
    verify(invalidForm.elements.title===document.activeElement&&errorsFor('title').textContent.includes('名称'));
    verify(invalidForm.elements.due.value===''&&invalidForm.elements.due.getAttribute('aria-invalid')==='true'&&
      errorsFor('due').textContent.includes('2026-02-30'));
    verify(errorsFor('due').id!==errorsFor('title').id);
    invalidForm.elements.title.value='名称だけ修正';click('batch-apply');decline();
    verify(locateRow(1).textContent.includes('2026-02-30')&&locateRow(1).textContent.includes('実在する日付'));
    click('batch-edit-1');invalidForm=$('#batch-item-form');
    verify(invalidForm.elements.due===document.activeElement&&!invalidForm.elements.title.hasAttribute('aria-describedby'));
    invalidForm.elements.due.value=nextDay;change(invalidForm.elements.due);click('batch-apply');
    verify(locateRow(1).textContent.includes('期限：'+nextDay)&&!locateRow(1).querySelector('.error'));
    click('batch-edit-1');invalidForm=$('#batch-item-form');
    verify(invalidForm.elements.title===document.activeElement&&!invalidForm.elements.due.hasAttribute('aria-invalid')&&
      !invalidForm.elements.due.hasAttribute('aria-describedby'));
    click('batch-edit-back');
    for(const [row,key,value] of [[2,'start','2026-02-30T09:07'],[3,'endDate','存在しない日付']]){
      click('batch-edit-'+row);invalidForm=$('#batch-item-form');
      verify(invalidForm.elements[key]===document.activeElement&&errorsFor(key).textContent.includes(value));
      invalidForm.elements.title.value+='・名称を修正';click('batch-apply');
      verify(locateRow(row).textContent.includes(value)&&!!locateRow(row).querySelector('.error'));
      click('batch-toggle-'+row);
    }
    click('batch-toggle-2');decline();verify(locateRow(2).textContent.includes('2026-02-30T09:07'));
    click('batch-toggle-2');
    verify(snapshot()===baseline);
    await cancel();click('close');

    document.body.dataset.phase2Step='batch parent survives a pending external refresh';
    click('add');
    const draft=form();
    draft.elements.title.value='架空の復帰下書き';
    draft.elements.start.value=today+'T08:10';
    draft.elements.end.value=today+'T09:10';
    const draftValues=()=>[draft.elements.title.value,draft.elements.start.value,draft.elements.end.value,draft.elements.repeat.value];
    const beforeDraft=draftValues();
    click('batch-open');fill(encode([task('破棄する架空の取り込み')]));
    const remote=saved();
    remote.items.push({...task('架空の他タブ項目'),id:'batch-draft-remote',pinned:false,excluded:[]});
    const remoteRaw=JSON.stringify(remote);
    originalSet.call(localStorage,STORAGE_KEY,remoteRaw);
    const release=await holdRefresh();
    click('batch-cancel');click('batch-discard');
    verify(!modal().open&&$('#editor').open&&form()===draft&&draft.querySelector('.save').disabled);
    verify(JSON.stringify(draftValues())===JSON.stringify(beforeDraft)&&snapshot()===remoteRaw);
    release();
    await wait(()=>!draft.querySelector('.save').disabled||!$('#editor').open);
    verify($('#editor').open&&form()===draft&&JSON.stringify(draftValues())===JSON.stringify(beforeDraft));
    verify(snapshot()===remoteRaw);
    draft.requestSubmit();await wait(()=>!$('#editor').open);
    const afterDraft=saved(),addedDraft=afterDraft.items.at(-1);
    verify(addedDraft.title===beforeDraft[0]&&addedDraft.start===beforeDraft[1]&&addedDraft.end===beforeDraft[2]);
    verify(JSON.stringify(afterDraft)===JSON.stringify({...remote,items:[...remote.items,addedDraft]}));

    for(const scenario of ['close','failure','edit']){
      document.body.dataset.phase2Step='batch parent storage refresh '+scenario;
      if(scenario==='edit'){
        $('[data-today]').click();
        $('[data-edit="'+addedDraft.id+'"]').click();
        verify($('#editor').open&&form().elements.title.value===beforeDraft[0]&&!$('#batch-open'));
      }else{
        reopen();form().elements.title.value='架空の失敗確認';fill(encode([task('取り込み下書き')]));
      }
      const during=saved();
      during.items.push({...task('他タブ更新 '+scenario),id:'batch-draft-'+scenario,pinned:false,excluded:[]});
      const duringRaw=JSON.stringify(during);
      if(scenario!=='failure')originalSet.call(localStorage,STORAGE_KEY,duringRaw);
      const releaseRead=await holdRefresh({fail:scenario==='failure'});
      if(scenario!=='edit'){
        click('batch-cancel');click('batch-discard');
        if(scenario==='close')click('close');
      }
      releaseRead();
      if(scenario==='failure'){
        await wait(()=>$('#schedule-calendar')?.dataset.calendarStatus==='unavailable');
        verify($('#editor').open&&form().querySelector('.save').disabled&&form().elements.title.value==='架空の失敗確認');
        const unchanged=snapshot();
        form().dispatchEvent(new Event('submit',{cancelable:true}));
        verify($('#form-error').textContent.includes('登録を停止')&&snapshot()===unchanged);
        click('close');storeChanged();await waitForRefresh();
      }else{
        await waitForRefresh();
        verify(!$('#editor').open&&snapshot()===duringRaw);
      }
    }
    originalSet.call(localStorage,STORAGE_KEY,baseline);storeChanged();
    await waitForRefresh();

    document.body.dataset.phase2Step='batch import edits duplicates and external update';
    reopen();
    const protectedEvent=saved().items.find(item=>item.type==='event'&&item.notification?.enabled);
    verify(!!protectedEvent);
    const special='<img src=x onerror=alert(1)>'+ 'Z'.repeat(132);
    const oldDay=addDays(today,-14);
    fill(encode([
      event(protectedEvent.title,protectedEvent.start,protectedEvent.end),
      task('架空の同一バッチ',today),task('架空の同一バッチ',today,'weekly'),
      task('架空の不正期限','2026-02-30'),
      event(special,nextDay+'T09:07',nextDay+'T10:29'),
      task('架空の初回期限',oldDay,'daily'),
      {type:'event',title:'架空の終日',allDay:true,startDate:nextDay,endDate:nextDay,repeat:'none'},
    ]));
    decline();
    verify(locateRow(1).textContent.includes('保存済み 1件と一致'));
    verify(locateRow(3).textContent.includes('取り込み内 2件が一致（繰り返さない、毎週）'));
    verify(locateRow(4).textContent.includes('期限')&&locateRow(4).textContent.includes('実在する日付'));
    verify(special.length===160&&locateRow(5).querySelector('.batch-name').textContent===special&&!locateRow(5).querySelector('img'));
    verify(locateRow(6).textContent.includes('初回期限：'+oldDay+' → 登録期限：'+today));
    click('batch-edit-4');
    let edit=$('#batch-item-form');
    verify(edit.elements.due.getAttribute('aria-invalid')==='true');
    edit.elements.title.value='架空の修正済みタスク';edit.elements.due.value=nextDay;edit.elements.repeat.value='monthly';
    click('batch-apply');
    verify(document.activeElement===$('#batch-edit-4')&&locateRow(4).textContent.includes('毎月'));
    approve();verify(!$('#batch-review').disabled);
    click('batch-edit-4');
    edit=$('#batch-item-form');
    edit.elements.repeat.value='none';edit.elements.dueMode.value='none';change(edit.elements.dueMode);
    click('batch-apply');decline();
    verify(locateRow(4).textContent.includes('期限：なし')&&!$('#batch-duplicates').checked);
    click('batch-edit-5');
    edit=$('#batch-item-form');
    verify(edit.elements.start.value===nextDay+'T09:07'&&edit.elements.end.value===nextDay+'T10:29');
    edit.elements.start.value=nextDay+'T09:09';edit.elements.end.value=nextDay+'T10:37';
    click('batch-apply');decline();verify(!$('#batch-duplicates').checked);
    approve();click('batch-toggle-3');decline();verify(!$('#batch-duplicates').checked);
    click('batch-edit-7');
    edit=$('#batch-item-form');edit.elements.endDate.value=addDays(nextDay,1);click('batch-apply');
    verify(locateRow(7).textContent.includes('最終日：'+addDays(nextDay,1)));
    approve();click('batch-review');
    verify(stage('final')&&modal().textContent.includes('予定 3件 ／ タスク 3件 ／ 合計 6件')&&
      modal().textContent.includes('除外 1件 ／ 重複承認 1件'));
    verify(snapshot()===baseline);
    const external=saved();
    external.items.push({...task('架空の別タブ追加',nextDay),id:'batch-external',excluded:[],pinned:false});
    external.items.push({...task('架空の同一バッチ',today),id:'batch-second-duplicate',excluded:[],pinned:false});
    localStorage.setItem(STORAGE_KEY,JSON.stringify(external));storeChanged();
    await wait(()=>stage('preview')&&text().includes('もう一度確認'));
    verify(locateRow(4).textContent.includes('架空の修正済みタスク')&&locateRow(3).textContent.includes('除外'));
    decline();verify(!$('#batch-duplicates').checked);
    approve();click('batch-review');
    verify(modal().textContent.includes('除外 1件 ／ 重複承認 2件')&&
      new Set([...modal().querySelectorAll('.batch-warning')].map(node=>node.textContent.match(/グループ \d+/)?.[0])).size===2);
    const expectedPreview=[
      [1,protectedEvent.title,protectedEvent.start.replace('T',' ')],
      [2,'架空の同一バッチ','期限：'+today],
      [4,'架空の修正済みタスク','期限：なし'],
      [5,special,'終了：'+nextDay+' 10:37'],
      [6,'架空の初回期限','登録期限：'+today],
      [7,'架空の終日','最終日：'+addDays(nextDay,1)],
    ];
    verify(expectedPreview.every(([number,title,when])=>locateRow(number)?.querySelector('.batch-name').textContent===title&&
      locateRow(number).textContent.includes(when))&&!locateRow(3));
    click('batch-save');verify($('#batch-save').disabled&&text().includes('登録中'));
    modal().dispatchEvent(new Event('cancel',{cancelable:true}));
    verify(modal().open&&stage('final'));
    click('batch-save');
    await wait(()=>stage('done'));
    const after=saved();
    const added=after.items.slice(external.items.length);
    verify(added.length===6&&JSON.stringify(after)===JSON.stringify({...external,items:[...external.items,...added]}));
    verify(added.every(item=>!Object.hasOwn(item,'notification')));
    const fields=item=>[item.title,item.type,item.repeat,item.due??null,item.start??null,item.end??null,item.allDay??null];
    verify(JSON.stringify(added.map(fields))===JSON.stringify([
      [protectedEvent.title,'event','none',null,protectedEvent.start,protectedEvent.end,false],
      ['架空の同一バッチ','task','none',today,null,null,null],
      ['架空の修正済みタスク','task','none',null,null,null,null],
      [special,'event','none',null,nextDay+'T09:09',nextDay+'T10:37',false],
      ['架空の初回期限','task','daily',today,null,null,null],
      ['架空の終日','event','none',null,nextDay+'T00:00',addDays(nextDay,2)+'T00:00',true],
    ]));
    verify(!$('#batch-save')&&text().includes('6件'));
    click('batch-done');await wait(()=>!modal().open);click('close');
    await wait(()=>$('#schedule-calendar')?.dataset.calendarStatus==='ready');
    $('[data-today]').click();
    if(!$('[data-day="'+nextDay+'"]'))$('[data-nav="1"]').click();
    const nextButton=$('[data-day="'+nextDay+'"]');
    nextButton.click();verify(!!$('.agenda [data-edit="'+added.find(item=>item.title===special).id+'"]'));
    await wait(()=>$('[data-day="'+nextDay+'"] .event-mark')&&$('[data-day="'+nextDay+'"] .task-mark'));
    verify($('[data-day="'+nextDay+'"]').getAttribute('aria-label').includes('期限付きタスクあり'));

    document.body.dataset.phase2Step='batch import lock conflict and definitive failures';
    reopen();fill(encode([task('架空の再検証')]));
    click('batch-review');
    const beforeFailure=snapshot();
    Storage.prototype.setItem=function(key,value){
      if(key===STORAGE_KEY)throw new DOMException('fictional quota','QuotaExceededError');
      return originalSet.call(this,key,value);
    };
    click('batch-save');
    await wait(()=>stage('preview')&&!!$('#batch-refresh')).catch(()=>{
      throw Error('Quota result: '+modal().dataset.stage+' '+text());
    });
    verify(snapshot()===beforeFailure&&!$('#batch-save')&&$('#batch-review').disabled);
    Storage.prototype.setItem=originalSet;
    click('batch-refresh');await wait(()=>!$('#batch-review').disabled);
    click('batch-review');
    navigator.locks.request=async()=>{throw new DOMException('fictional lock rejection','AbortError');};
    click('batch-save');
    await wait(()=>stage('preview')&&!!$('#batch-refresh'));
    verify(snapshot()===beforeFailure&&$('#batch-review').disabled);
    navigator.locks.request=originalLock;
    click('batch-refresh');await wait(()=>!$('#batch-review').disabled);
    click('batch-review');
    navigator.locks.request=function(name,options,action){
      navigator.locks.request=originalLock;
      return originalLock.call(this,name,options,()=>{
        const writer=JSON.parse(beforeFailure);
        writer.items.push({...task('架空のロック待ち中の変更'),id:'batch-queued-writer',pinned:false,excluded:[]});
        originalSet.call(localStorage,STORAGE_KEY,JSON.stringify(writer));
        return action();
      });
    };
    click('batch-save');
    await wait(()=>stage('preview')&&!!$('#batch-refresh'));
    verify(saved().items.at(-1).id==='batch-queued-writer'&&!saved().items.some(item=>item.title==='架空の再検証'));
    click('batch-refresh');await wait(()=>!$('#batch-review').disabled);
    click('batch-review');
    const Clock=globalThis.Date;
    const midnight=new Clock(nextDay+'T12:00:00').getTime();
    globalThis.Date=class extends Clock{constructor(...args){super(...(args.length?args:[midnight]));}static now(){return midnight;}};
    try{click('batch-save');verify(stage('preview')&&text().includes('日付'));}finally{globalThis.Date=Clock;}
    click('batch-review');
    verify(stage('preview')&&text().includes('日付'));
    click('batch-review');verify(stage('final'));
    const Format=Intl.DateTimeFormat;
    Intl.DateTimeFormat=function(...args){
      const format=new Format(...args),options=format.resolvedOptions.bind(format);
      format.resolvedOptions=()=>({...options(),timeZone:'Pacific/Apia'});
      return format;
    };
    try{click('batch-save');verify(stage('preview')&&text().includes('タイムゾーン'));}finally{Intl.DateTimeFormat=Format;}
    verify(!saved().items.some(item=>item.title==='架空の再検証'));
    await cancel();click('close');

    document.body.dataset.phase2Step='100-entry batch import load';
    const bulk=Array.from({length:100},(_,index)=>task('架空の一括負荷 '+index,null));
    reopen();
    const start=performance.now();fill(encode(bulk));await painted();
    const previewMs=Math.round(performance.now()-start);
    verify(modal().querySelectorAll('.batch-row').length===100&&!$('#batch-item-form'));
    click('batch-edit-100');verify(modal().querySelectorAll('form').length===1);
    click('batch-edit-back');click('batch-review');
    verify(modal().querySelectorAll('.batch-row').length===100&&$('#batch-save').textContent==='確認した100件を一括登録');
    const beforeBulk=saved(), commitStart=performance.now();
    click('batch-save');await wait(()=>stage('done'));await painted();
    const saveMs=Math.round(performance.now()-commitStart);
    const afterBulk=saved();
    verify(afterBulk.items.length===beforeBulk.items.length+100&&JSON.stringify(afterBulk.items.slice(0,-100))===JSON.stringify(beforeBulk.items));
    document.body.dataset.batchLoad=JSON.stringify({rows:100,previewMs,saveMs});
    click('batch-done');await wait(()=>!modal().open);click('close');

    document.body.dataset.phase2Step='batch import unverified readback';
    reopen();fill(encode([task('架空の保存成否不明')]));
    click('batch-review');
    let wrote=false;
    Storage.prototype.setItem=function(key,value){
      originalSet.call(this,key,value);if(key===STORAGE_KEY)wrote=true;
    };
    Storage.prototype.getItem=function(key){
      if(key===STORAGE_KEY&&wrote)throw Error('fictional readback error');
      return originalGet.call(this,key);
    };
    try{click('batch-save');await wait(()=>stage('unknown'));}finally{
      Storage.prototype.setItem=originalSet;Storage.prototype.getItem=originalGet;
    }
    verify(text().includes('登録された可能性')&&!$('#batch-save')&&!$('#batch-refresh'));
    verify(saved().items.filter(item=>item.title==='架空の保存成否不明').length===1);
    click('batch-done');await wait(()=>!modal().open);
    verify($('#entry-form .save').disabled);
    click('close');
  }finally{
    Storage.prototype.setItem=originalSet;Storage.prototype.getItem=originalGet;
    navigator.locks.request=originalLock;
    originalSet.call(localStorage,STORAGE_KEY,baseline);
  }
}
