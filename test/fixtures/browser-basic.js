// Fictional data only, isolated loopback browser profile. Never calls Shortcuts.
import {seed,STORAGE_KEY,dateKey,addDays,nextDate} from '../../src/model.js';
import {NOTIFICATIONS_ENABLED} from '../../src/features.js';
const wait=async condition=>{for(let i=0;i<200;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('UI wait timed out');};
let checks=Number(sessionStorage.getItem('basic-checks')||0);
const verify=condition=>{if(!condition)throw Error('Basic UI check failed');checks++;};
const saved=()=>JSON.parse(localStorage.getItem(STORAGE_KEY));
const today=dateKey();
try{
  if(sessionStorage.getItem('basic-step')!=='callback')localStorage.setItem(STORAGE_KEY,JSON.stringify(seed(today)));
  await import('../../src/app.js');
  await wait(()=>document.querySelector('#add'));
  if(sessionStorage.getItem('basic-step')==='callback'){
    await new Promise(resolve=>setTimeout(resolve,100));
    verify(localStorage.getItem(STORAGE_KEY)===sessionStorage.getItem('basic-expected'));
    verify(!document.querySelector('#connection-panel'));verify(document.body.textContent.includes('通知結果URLは基本機能先行版では処理しません'));
    window.dispatchEvent(new Event('pageshow'));window.dispatchEvent(new Event('hashchange'));document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(resolve=>setTimeout(resolve,100));verify(localStorage.getItem(STORAGE_KEY)===sessionStorage.getItem('basic-expected'));
    document.body.dataset.phase2Result='passed:'+checks;
  }else{
    verify(NOTIFICATIONS_ENABLED===false);
    verify(!document.querySelector('#shortcut-test,#connection-test-open,#connection-panel,.removal-panel'));
    document.querySelector('[data-mode=month]').click();verify(document.querySelectorAll('.day').length>=28);
    document.querySelector('[data-mode=week]').click();verify(document.querySelectorAll('.day').length===7);
    const rawBeforeHints=localStorage.getItem(STORAGE_KEY);
    for(const view of ['someday','history','due']){
      document.querySelector('[data-view='+view+']').click();const back=document.querySelector('.back');
      verify(back.textContent==='← ホームに戻る');verify(getComputedStyle(back).fontSize==='16px');
      verify(back.getBoundingClientRect().height>=44&&back.getBoundingClientRect().width>=44);
      back.focus();verify(document.activeElement===back);back.click();verify(!!document.querySelector('#backup-open'));
    }
    document.querySelector('#add').click();
    let dates=document.querySelectorAll('#entry-form input[type=date]');
    const setDate=(field,value)=>{field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));};
    const hint=field=>document.getElementById(field.getAttribute('aria-describedby'));
    setDate(dates[0],'2026-12-31');verify(hint(dates[0]).textContent==='2026/12/31（木）');
    verify(hint(dates[1]).textContent.startsWith(document.querySelector('#entry-form').elements.end.value.slice(0,10).replaceAll('-','/')));
    const hour=document.querySelector('[aria-label="開始時（24時間）"]'),minute=document.querySelector('[aria-label="開始分"]');
    hour.value='23';hour.dispatchEvent(new Event('change'));minute.value='50';minute.dispatchEvent(new Event('change'));
    verify(dates[1].value==='2027-01-01');verify(hint(dates[1]).textContent==='2027/01/01（金）');
    setDate(dates[1],'2027-01-01');verify(hint(dates[1]).textContent==='2027/01/01（金）');
    setDate(dates[0],'2028-02-29');verify(hint(dates[0]).textContent==='2028/02/29（火）');
    setDate(dates[0],'');verify(hint(dates[0]).hidden);
    document.querySelector('#close').click();document.querySelector('#add').click();
    let editor=document.querySelector('#entry-form');editor.elements.allDay.checked=true;editor.elements.allDay.dispatchEvent(new Event('change'));
    editor=document.querySelector('#entry-form');setDate(editor.elements.start,'2026-12-31');
    verify(hint(editor.elements.end).textContent==='2026/12/31（木）');
    setDate(editor.elements.end,'2027-01-02');setDate(editor.elements.start,'2027-01-01');
    verify(hint(editor.elements.end).textContent==='2027/01/03（日）');
    document.querySelector('[data-type=task]').click();editor=document.querySelector('#entry-form');verify(hint(editor.elements.due).hidden);
    setDate(editor.elements.due,'2028-02-29');verify(hint(editor.elements.due).textContent==='2028/02/29（火）');
    setDate(editor.elements.due,'');verify(hint(editor.elements.due).hidden);
    document.querySelector('[data-type=event]').click();verify(!!document.querySelector('#entry-form .date-hint'));
    document.querySelector('#close').click();verify(localStorage.getItem(STORAGE_KEY)===rawBeforeHints);
    const addEvent=async title=>{document.querySelector('#add').click();const f=document.querySelector('#entry-form');verify(!document.querySelector('#event-notify-enabled,#event-shortcut'));f.elements.title.value=title;f.requestSubmit();await wait(()=>!document.querySelector('#editor').open);};
    await addEvent('架空の基本公開予定');const id=saved().items.find(i=>i.title==='架空の基本公開予定').id;
    document.querySelector('[data-edit="'+id+'"]').click();
    for(const date of document.querySelectorAll('#entry-form input[type=date]'))verify(hint(date).textContent.startsWith(date.value.replaceAll('-','/')));
    document.querySelector('#entry-form').elements.title.value='架空の基本公開予定・編集';document.querySelector('#entry-form').requestSubmit();await wait(()=>!document.querySelector('#editor').open);verify(saved().items.find(i=>i.id===id).title.endsWith('編集'));
    document.querySelector('[data-edit="'+id+'"]').click();document.querySelector('#delete').click();await wait(()=>document.querySelector('#delete-confirm').open);verify(!document.querySelector('#delete-confirm').textContent.includes('Apple'));
    document.querySelector('#delete-confirm button[value=delete]').click();await wait(()=>!saved().items.some(i=>i.id===id));verify(saved().version===1);verify(localStorage.getItem('my-schedule.notification-removals.v1')===null);verify(localStorage.getItem('my-schedule.pre-v3.v1')===null);
    document.querySelector('#add').click();document.querySelector('[data-type=task]').click();let form=document.querySelector('#entry-form');form.elements.title.value='架空の繰り返しタスク';form.elements.due.value=today;form.elements.repeat.value='weekly';form.requestSubmit();await wait(()=>!document.querySelector('#editor').open);
    const task=saved().items.find(i=>i.title==='架空の繰り返しタスク');document.querySelector('[data-complete="'+task.id+'"]').click();await wait(()=>saved().history.some(h=>h.sourceId===task.id));verify(saved().items.find(i=>i.id===task.id).due===addDays(today,7));
    document.querySelector('[data-view=history]').click();const history=saved().history.find(h=>h.sourceId===task.id);document.querySelector('[data-restore="'+history.id+'"]').click();await wait(()=>saved().history.find(h=>h.id===history.id).restoredAt);verify(saved().items.filter(i=>i.id===task.id).length===1);document.querySelector('[data-view=home]').click();
    const beforeRepeatEdit=saved();
    const dueMonth=Number(today.slice(5,7));
    const movingTask={id:'repeat-edit',seriesId:'repeat-edit-series',type:'task',
      title:'架空の繰り返し変更',due:today,pinned:false,repeat:'monthly',excluded:[],
      anchorDay:Number(today.slice(8,10)),anchorMonth:dueMonth===1?12:dueMonth-1};
    beforeRepeatEdit.items.push(movingTask);
    localStorage.setItem(STORAGE_KEY,JSON.stringify(beforeRepeatEdit));
    window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
    document.querySelector('[data-view=due]').click();
    const repeatRow=()=>document.querySelector('[data-edit=repeat-edit]');
    await wait(repeatRow);
    repeatRow().click();form=document.querySelector('#entry-form');
    verify(form.elements.due.value===today);
    form.elements.scope.value='all';form.elements.repeat.value='yearly';form.requestSubmit();
    await wait(()=>!document.querySelector('#editor').open);
    const changedRepeat=saved().items.find(item=>item.id===movingTask.id);
    verify(changedRepeat.repeat==='yearly'&&changedRepeat.due===today&&changedRepeat.anchorMonth===dueMonth);
    verify(changedRepeat.seriesId===movingTask.seriesId);
    verify(JSON.stringify(saved().history)===JSON.stringify(beforeRepeatEdit.history));
    document.querySelector('[data-complete=repeat-edit]').click();
    await wait(()=>saved().history.some(h=>h.sourceId===movingTask.id));
    verify(saved().items.find(item=>item.id===movingTask.id).due===nextDate(today,'yearly'));
    document.querySelector('[data-view=home]').click();
    document.querySelector('#backup-open').click();const backup=document.querySelector('#backup-panel');[...backup.querySelectorAll('button')].find(b=>b.textContent==='保存済みデータのJSONを準備').click();await wait(()=>backup.textContent.includes('準備済みJSON'));verify(backup.textContent.includes('基本機能先行版は通知を送受信しません'));[...backup.querySelectorAll('button')].find(b=>b.textContent==='閉じる').click();
    const state=saved(),protectedItem=state.items[0];state.version=3;protectedItem.notification={enabled:true,notifyAt:'2026-12-24T03:00:00.000Z'};state.notificationLink={version:1,mode:'review',legacyRemovals:[],records:[{itemId:protectedItem.id,generationId:null,operationId:null,status:'unverified',desired:{enabled:true,notifyAt:protectedItem.notification.notifyAt,title:protectedItem.title},pending:null}]};
    const link=JSON.stringify(state.notificationLink);localStorage.setItem(STORAGE_KEY,JSON.stringify(state));window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));await wait(()=>document.querySelector('[data-edit="'+protectedItem.id+'"]')?.textContent.includes('保護中'));
    document.querySelector('[data-edit="'+protectedItem.id+'"]').click();await wait(()=>document.querySelector('#protected-close'));verify(!document.querySelector('#entry-form,#delete'));verify(document.querySelector('#editor').textContent.includes('閲覧・バックアップのみ'));document.querySelector('#protected-close').click();
    for(const key of ['my-schedule.notification-removals.v1','my-schedule.pre-v2.v1','my-schedule.pre-v3.v1'])localStorage.setItem(key,'corrupt fixture');
    await addEvent('架空の通知領域異常時の基本予定');verify(JSON.stringify(saved().notificationLink)===link);
    const realDate=globalThis.Date;
    const upperDay=new realDate(2100,11,30,12).getTime();
    globalThis.Date=class extends realDate {
      constructor(...args){super(...(args.length?args:[upperDay]));}
      static now(){return upperDay;}
    };
    const boundary=saved();
    const retained={id:'boundary-task',type:'task',title:'架空の次回なしタスク',due:'2100-12-31',pinned:false,repeat:'daily',excluded:['2100-12-31']};
    boundary.items.push(retained);
    localStorage.setItem(STORAGE_KEY,JSON.stringify(boundary));
    document.dispatchEvent(new Event('visibilitychange'));
    document.querySelector('[data-view=due]').click();
    const boundaryRow=()=>document.querySelector('[data-edit=boundary-task]');
    await wait(()=>boundaryRow()?.textContent.includes('対応範囲内に次回なし'));
    verify(document.querySelector('[data-complete=boundary-task]').disabled);
    verify(boundaryRow().scrollWidth<=boundaryRow().clientWidth+1);
    boundaryRow().click();form=document.querySelector('#entry-form');
    verify(form.textContent.includes('対応範囲内に次回なし')&&!!document.querySelector('#delete'));
    verify(form.elements.scope.value==='all');
    form.elements.due.value='2100-12-30';
    form.elements.repeat.value='weekly';form.requestSubmit();
    await wait(()=>!document.querySelector('#editor').open);
    const revised=saved().items.find(i=>i.id===retained.id);
    verify(revised.repeat==='weekly'&&revised.due==='2100-12-30');
    verify(!boundaryRow().textContent.includes('対応範囲内に次回なし'));
    verify(!document.querySelector('[data-complete=boundary-task]').disabled);
    globalThis.Date=realDate;
    document.querySelector('[data-view=home]').click();
    const final=saved();final.items.push({id:'basic-late',type:'task',title:'架空のURL復帰試験',due:addDays(today,-7),pinned:false,repeat:'daily',excluded:[]});const raw=JSON.stringify(final);localStorage.setItem(STORAGE_KEY,raw);
    sessionStorage.setItem('basic-expected',raw);sessionStorage.setItem('basic-checks',String(checks));sessionStorage.setItem('basic-step','callback');window.location.hash='#notification-result=%ZZ';window.location.reload();
  }
}catch{document.body.dataset.phase2Result='failed:'+checks;}
