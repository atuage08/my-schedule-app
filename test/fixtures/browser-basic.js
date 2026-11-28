// Fictional data only, isolated loopback browser profile. Never calls Shortcuts.
import {seed,STORAGE_KEY,dateKey,addDays,nextDate} from '../../src/model.js';
import {NOTIFICATIONS_ENABLED} from '../../src/features.js';
import {ScheduleStore} from '../../src/storage.js';
import {checkBatchImport} from './browser-batch-import.js';
const wait=async condition=>{for(let i=0;i<200;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('UI wait timed out');};
let checks=Number(sessionStorage.getItem('basic-checks')||0);
const verify=(condition,message='Basic UI check failed')=>{if(!condition)throw Error(message);checks++;};
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
    const dueButton=document.querySelector('[data-view=due]');
    verify(dueButton.textContent==='すべて見る ›');
    verify(document.querySelector('.due-title .count').textContent===saved().items.filter(item=>item.type==='task'&&item.due).length+'件');
    for(const [view,title] of [['someday','いつかやる'],['history','完了したタスク'],['due','期限のあるタスク']]){
      document.querySelector('[data-view='+view+']').click();const back=document.querySelector('.back');
      verify(document.querySelector('.page-intro h2').textContent===title);
      verify(back.textContent==='← ホームに戻る');verify(getComputedStyle(back).fontSize==='16px');
      verify(back.getBoundingClientRect().height>=44&&back.getBoundingClientRect().width>=44);
      back.focus();verify(document.activeElement===back);back.click();verify(!!document.querySelector('#backup-open'));
    }
    verify(localStorage.getItem(STORAGE_KEY)===rawBeforeHints);
    const editorForm=()=>document.querySelector('#entry-form');
    const timeSelect=(label,form=editorForm())=>form.querySelector('select[aria-label="'+label+'"]');
    const changeValue=(field,value)=>{field.value=value;field.dispatchEvent(new Event('change',{bubbles:true}));};
    const verifyTimes=(start,end)=>verify(editorForm().elements.start.value===start&&editorForm().elements.end.value===end);
    const closeEditor=()=>document.querySelector('#close').click();

    // Fix the local time while computing the defaults for a new or redrawn form.
    const actualDate=globalThis.Date;
    const withLocalTime=(stamp,action)=>{
      const instant=new actualDate(stamp).getTime();
      globalThis.Date=class extends actualDate {
        constructor(...args){super(...(args.length?args:[instant]));}
        static now(){return instant;}
      };
      try{action();}finally{globalThis.Date=actualDate;}
    };
    const openAt=time=>withLocalTime(today+'T'+time,()=>document.querySelector('#add').click());
    const verifySelection=(startHour,startMinute,endHour,endMinute)=>{
      verify(timeSelect('開始時（24時間）').value===startHour&&timeSelect('終了時（24時間）').value===endHour);
      verify(timeSelect('開始分').value===startMinute&&timeSelect('終了分').value===endMinute);
    };
    openAt('14:23');
    verifyTimes(today+'T14:30',today+'T15:30');
    verifySelection('14','30','15','30');
    const choices=Array.from({length:24},(_,hour)=>String(hour).padStart(2,'0'));
    for(const label of ['開始時（24時間）','終了時（24時間）']){
      const select=timeSelect(label);
      verify(select.type==='select-one'&&select.options.length===24&&[...select.options].every((option,index)=>
        option.value===choices[index]&&option.textContent===choices[index]+'時'));
    }
    closeEditor();
    const nextDay=addDays(today,1);
    openAt('23:58');
    verifyTimes(nextDay+'T00:00',nextDay+'T01:00');
    verifySelection('00','00','01','00');
    closeEditor();
    const otherDay=document.querySelector('.day:not(.selected):not(:disabled)');
    const otherDate=otherDay.dataset.day;
    otherDay.click();
    openAt('14:23');
    verifyTimes(otherDate+'T12:00',otherDate+'T13:00');
    verifySelection('12','00','13','00');
    closeEditor();
    document.querySelector('[data-today]').click();
    openAt('14:23');
    let dates=document.querySelectorAll('#entry-form input[type=date]');
    const setDate=(field,value)=>{field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));};
    const hint=field=>document.getElementById(field.getAttribute('aria-describedby'));
    setDate(dates[0],'2026-12-31');verify(hint(dates[0]).textContent==='2026/12/31（木）');
    verify(hint(dates[1]).textContent.startsWith(document.querySelector('#entry-form').elements.end.value.slice(0,10).replaceAll('-','/')));
    const hour=timeSelect('開始時（24時間）'),minute=timeSelect('開始分');
    changeValue(hour,'23');changeValue(minute,'50');
    verifyTimes('2026-12-31T23:50','2027-01-01T00:50');
    verifySelection('23','50','00','50');
    verify(dates[1].value==='2027-01-01');verify(hint(dates[1]).textContent==='2027/01/01（金）');
    changeValue(timeSelect('終了時（24時間）'),'01');
    verifyTimes('2026-12-31T23:50','2027-01-01T01:50');
    setDate(dates[1],'2027-01-01');verify(hint(dates[1]).textContent==='2027/01/01（金）');
    setDate(dates[0],'2028-02-29');verify(hint(dates[0]).textContent==='2028/02/29（火）');
    setDate(dates[0],'');verify(hint(dates[0]).hidden);
    closeEditor();openAt('14:23');
    changeValue(timeSelect('開始時（24時間）'),'17');changeValue(timeSelect('開始分'),'20');
    changeValue(timeSelect('終了時（24時間）'),'19');changeValue(timeSelect('終了分'),'40');
    verifyTimes(today+'T17:20',today+'T19:40');
    verifySelection('17','20','19','40');
    let editor=editorForm();editor.elements.allDay.click();
    verify(editorForm().querySelectorAll('.date-time-control select').length===0);
    editor=document.querySelector('#entry-form');setDate(editor.elements.start,'2026-12-31');
    verify(hint(editor.elements.end).textContent==='2026/12/31（木）');
    setDate(editor.elements.end,'2027-01-02');setDate(editor.elements.start,'2027-01-01');
    verify(hint(editor.elements.end).textContent==='2027/01/03（日）');
    withLocalTime('2026-12-15T14:23',()=>editor.elements.allDay.click());
    verifyTimes('2027-01-01T12:00','2027-01-01T13:00');
    verifySelection('12','00','13','00');
    document.querySelector('#minute-step').click();
    changeValue(timeSelect('開始分'),'07');changeValue(timeSelect('終了分'),'42');
    verifyTimes('2027-01-01T12:07','2027-01-01T13:42');
    document.querySelector('[data-type=task]').click();editor=document.querySelector('#entry-form');verify(hint(editor.elements.due).hidden);
    setDate(editor.elements.due,'2028-02-29');verify(hint(editor.elements.due).textContent==='2028/02/29（火）');
    setDate(editor.elements.due,'');verify(hint(editor.elements.due).hidden);
    document.querySelector('[data-type=event]').click();verify(!!document.querySelector('#entry-form .date-hint'));
    verifyTimes('2027-01-01T12:07','2027-01-01T13:42');
    verifySelection('12','07','13','42');
    document.querySelector('#close').click();verify(localStorage.getItem(STORAGE_KEY)===rawBeforeHints);
    const addEvent=async(title,setup=()=>{})=>{
      openAt('14:23');const form=editorForm();
      verify(!document.querySelector('#event-notify-enabled,#event-shortcut'));
      form.elements.title.value=title;setup(form);form.requestSubmit();
      await wait(()=>!document.querySelector('#editor').open);
      return saved().items.find(item=>item.title===title);
    };
    const {id}=await addEvent('架空の基本公開予定',()=>{
      const startMinute=timeSelect('開始分'),endMinute=timeSelect('終了分');
      const minuteValues=select=>[...select.options].map(option=>option.value).join(',');
      verify(minuteValues(startMinute)==='00,10,20,30,40,50');
      document.querySelector('#minute-step').click();
      verify(startMinute.options.length===60&&endMinute.options.length===60&&startMinute.options[59].value==='59');
      changeValue(timeSelect('開始時（24時間）'),'14');changeValue(startMinute,'07');
      changeValue(timeSelect('終了時（24時間）'),'16');changeValue(endMinute,'42');
      document.querySelector('#minute-step').click();
      verify(minuteValues(startMinute)==='00,07,10,20,30,40,50'&&minuteValues(endMinute)==='00,10,20,30,40,42,50');
      verifySelection('14','07','16','42');
      verifyTimes(today+'T14:07',today+'T16:42');
    });
    document.querySelector('[data-edit="'+id+'"]').click();
    for(const date of document.querySelectorAll('#entry-form input[type=date]'))verify(hint(date).textContent.startsWith(date.value.replaceAll('-','/')));
    verifySelection('14','07','16','42');verify(document.querySelector('#minute-step').checked);
    document.querySelector('#entry-form').elements.title.value='架空の基本公開予定・編集';document.querySelector('#entry-form').requestSubmit();await wait(()=>!document.querySelector('#editor').open);verify(saved().items.find(i=>i.id===id).title.endsWith('編集'));
    const edited=saved().items.find(item=>item.id===id);
    verify(edited.start===today+'T14:07'&&edited.end===today+'T16:42');
    document.querySelector('[data-edit="'+id+'"]').click();document.querySelector('#delete').click();await wait(()=>document.querySelector('#delete-confirm').open);verify(!document.querySelector('#delete-confirm').textContent.includes('Apple'));
    document.querySelector('#delete-confirm button[value=delete]').click();await wait(()=>!saved().items.some(i=>i.id===id));verify(saved().version===1);verify(localStorage.getItem('my-schedule.notification-removals.v1')===null);verify(localStorage.getItem('my-schedule.pre-v3.v1')===null);
    const series=await addEvent('架空の繰り返し予定',form=>{
      form.elements.repeat.value='weekly';
      changeValue(timeSelect('開始時（24時間）'),'12');
    });
    document.querySelector('[data-edit="'+series.id+'"]').click();
    verify(editorForm().elements.scope.value==='one');
    changeValue(timeSelect('開始時（24時間）'),'00');
    editorForm().requestSubmit();await wait(()=>!document.querySelector('#editor').open);
    const exception=saved().items.find(item=>item.eventSeriesId===series.id&&item.exceptionDate===today);
    verify(exception?.start===today+'T00:'+series.start.slice(-2)&&exception?.end===today+'T01:'+series.end.slice(-2));
    const parent=saved().items.find(item=>item.id===series.id);
    verify(parent.repeat==='weekly'&&parent.start===series.start&&parent.end===series.end&&parent.excluded.includes(today));
    document.body.dataset.phase2Step='overlapping event editor';
    const oldest='2026-11-23',middle='2026-11-24',overlapDay='2026-11-25',nextDayAfterOverlap='2026-11-26';
    const overlapping={id:'overlapping-event',type:'event',title:'架空の重複する連日予定',allDay:false,
      start:oldest+'T10:00',end:nextDayAfterOverlap+'T10:00',repeat:'daily',anchorDay:31,anchorMonth:1,excluded:[]};
    const withOverlap=saved();
    // Keep the weekday-dependent series and its exceptions out of the next fixture.
    withOverlap.items=withOverlap.items.filter(item=>item.id!==series.id&&item.eventSeriesId!==series.id);
    const boundaries=[['min-event','2000-01-01'],['max-event','2100-12-31']];
    withOverlap.items.push(overlapping,...boundaries.map(([id,day])=>({
      id,type:'event',title:'架空の範囲端の予定',start:day+'T10:00',end:id==='max-event'?'2101-01-01T00:00':day+'T11:00',allDay:false,repeat:'none',excluded:[]
    })),{id:'legacy-anchor',type:'event',title:'架空の旧データ <b>文字</b>',start:'2100-12-30T00:00',
      end:'2101-01-01T00:00',allDay:true,repeat:'monthly',anchorDay:29,excluded:[]});
    const endLimitSeries={id:'end-limit-series',type:'event',title:'架空の年末継続予定',start:'2100-12-23T10:00',
      end:'2100-12-28T10:00',allDay:false,repeat:'weekly',excluded:[]};
    withOverlap.items.push(endLimitSeries);
    localStorage.setItem(STORAGE_KEY,JSON.stringify(withOverlap));
    window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
    const jumpTo=day=>withLocalTime(day+'T12:00',()=>document.querySelector('[data-today]').click());
    jumpTo(overlapDay);
    const overlapRows=()=>[...document.querySelectorAll('button[data-edit="overlapping-event"]')];
    const overlapRow=day=>overlapRows().find(button=>button.dataset.occurrence===day);
    await wait(()=>overlapRows().length===3);
    const openOverlap=day=>{
      overlapRow(day).click();
      return editorForm();
    };
    const beforeOpen=localStorage.getItem(STORAGE_KEY);
    verify(overlapRows().map(row=>row.dataset.occurrence).join(',')===[oldest,middle,overlapDay].join(','));
    for(const day of [oldest,middle,overlapDay]){
      openOverlap(day);
      verifyTimes(day+'T10:00',addDays(day,3)+'T10:00');
      verifySelection('10','00','10','00');
      closeEditor();
    }
    verify(localStorage.getItem(STORAGE_KEY)===beforeOpen);
    const verifyRejected=button=>{
      const raw=localStorage.getItem(STORAGE_KEY);
      for(const [attribute,value] of [
        ['data-occurrence',null],['data-occurrence',''],['data-occurrence','2026-02-30'],
        ['data-occurrence','2026-11-22'],['data-edit',''],['data-edit','missing-event'],
      ]){
        const prior=button.getAttribute(attribute);
        if(value===null)button.removeAttribute(attribute);else button.setAttribute(attribute,value);
        button.click();
        verify(!document.querySelector('#editor').open&&!document.querySelector('#delete-confirm').open);
        verify(localStorage.getItem(STORAGE_KEY)===raw);
        button.setAttribute(attribute,prior);
      }
    };
    verifyRejected(overlapRow(oldest));
    document.body.dataset.phase2Step='stale overlapping event';
    const removedOccurrence=saved();
    removedOccurrence.items.find(item=>item.id===overlapping.id).excluded.push(oldest);
    const concurrentRaw=JSON.stringify(removedOccurrence);
    for(const action of ['save','delete']){
      const staleEditor=openOverlap(oldest);
      if(action==='delete'){
        document.querySelector('#delete').click();
        await wait(()=>document.querySelector('#delete-confirm').open);
      }
      // Simulate a competing write before its storage event reaches this editor.
      localStorage.setItem(STORAGE_KEY,concurrentRaw);
      if(action==='delete')document.querySelector('#delete-confirm button[value=delete]').click();
      else{staleEditor.elements.title.value='保存してはいけない名称';staleEditor.requestSubmit();}
      await wait(()=>!overlapRow(oldest));
      verify(localStorage.getItem(STORAGE_KEY)===concurrentRaw);
      if(document.querySelector('#editor').open)closeEditor();
      localStorage.setItem(STORAGE_KEY,beforeOpen);
      window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
      await wait(()=>overlapRows().length===3);
    }
    document.body.dataset.phase2Step='overlapping event edits and deletion';
    const saveTitle=async(form,title)=>{
      form.elements.title.value=title;form.requestSubmit();
      await wait(()=>!document.querySelector('#editor').open);
    };
    const allEditor=openOverlap(oldest);
    allEditor.elements.scope.value='all';
    await saveTitle(allEditor,'架空の重複シリーズ名称変更');
    const overlapParent=()=>saved().items.find(item=>item.id===overlapping.id);
    verify(overlapParent().title==='架空の重複シリーズ名称変更');
    verify(overlapParent().start===overlapping.start&&overlapParent().end===overlapping.end&&overlapParent().repeat==='daily');
    verify(overlapParent().anchorDay===overlapping.anchorDay&&overlapParent().anchorMonth===overlapping.anchorMonth);
    await saveTitle(openOverlap(oldest),'架空の最初の回だけ名称変更');
    const overlapException=()=>saved().items.find(item=>item.eventSeriesId===overlapping.id&&item.exceptionDate===oldest);
    const firstException=overlapException();
    verify(firstException?.title==='架空の最初の回だけ名称変更'&&firstException.start===overlapping.start&&firstException.end===overlapping.end);
    verify(overlapParent().excluded.join(',')===oldest&&overlapParent().start===overlapping.start&&overlapParent().end===overlapping.end);
    const afterException=localStorage.getItem(STORAGE_KEY);
    verify(!overlapRow(oldest)&&localStorage.getItem(STORAGE_KEY)===afterException);
    const exceptionRow=()=>document.querySelector('[data-edit="'+firstException.id+'"]');
    verifyRejected(exceptionRow());
    exceptionRow().click();
    const movedDate=middle;
    setDate(editorForm().querySelector('input[aria-label="開始日"]'),movedDate);
    changeValue(timeSelect('開始時（24時間）'),'09');
    await saveTitle(editorForm(),'架空の例外再編集');
    verify(overlapException().id===firstException.id&&overlapException().eventSeriesId===overlapping.id&&overlapException().exceptionDate===oldest);
    const movedEnd=addDays(movedDate,3)+'T09:00';
    verify(overlapException().start===movedDate+'T09:00'&&overlapException().end===movedEnd&&overlapException().title==='架空の例外再編集');
    verify(!!overlapRow(middle)&&!!overlapRow(overlapDay)&&!!exceptionRow());
    const deleteEvent=async(expected)=>{
      document.querySelector('#delete').click();
      await wait(()=>document.querySelector('#delete-confirm').open);
      const confirmation=document.querySelector('#delete-confirm');
      verify(expected.test(confirmation.textContent));
      confirmation.querySelector('button[value=delete]').click();
      await wait(()=>!document.querySelector('#editor').open);
    };
    openOverlap(middle);
    verifyTimes(middle+'T10:00',addDays(middle,3)+'T10:00');
    await deleteEvent(/11月24日.*開始の今回だけ/);
    verify(overlapParent().excluded.includes(middle)&&!overlapParent().excluded.includes(overlapDay)&&!!overlapException()&&!!overlapRow(overlapDay));
    verify(exceptionRow().dataset.occurrence===oldest);
    exceptionRow().click();
    verifyTimes(movedDate+'T09:00',movedEnd);
    await deleteEvent(/11月24日.*この例外予定だけ.*元の回：11月23日/);
    verify(!overlapException()&&overlapParent().excluded.includes(oldest)&&!!overlapRow(overlapDay));
    await saveTitle(openOverlap(overlapDay),'架空の全削除対象の例外');
    const remainingException=saved().items.find(item=>item.eventSeriesId===overlapping.id&&item.exceptionDate===overlapDay);
    verify(!!remainingException);
    document.querySelector('[data-edit="'+remainingException.id+'"]').click();
    editorForm().elements.deleteScope.value='all';
    await deleteEvent(/架空の全削除対象の例外.*シリーズ全体.*関連する例外予定 1 件/);
    verify(!saved().items.some(item=>item.id===overlapping.id||item.eventSeriesId===overlapping.id));
    document.body.dataset.phase2Step='calendar date limits';
    const beforeLimits=localStorage.getItem(STORAGE_KEY);
    for(const [id,day] of boundaries){
      jumpTo(day);
      const activeDay=()=>document.querySelector('.day[aria-pressed=true]')?.dataset.day;
      const cell=()=>document.querySelector('.day[data-day="'+day+'"]');
      for(const mode of ['week','month']){
        document.querySelector('[data-mode='+mode+']').click();
        await wait(()=>document.querySelector('#schedule-calendar[data-calendar-status="ready"]'));
        const disabled=document.querySelector('.day:disabled');
        verify(!!disabled&&activeDay()===day&&!!cell().querySelector('.event-mark'));
        disabled.click();
        verify(activeDay()===day);
      }
      document.querySelector('[data-edit="'+id+'"]').click();
      verifyTimes(day+'T10:00',id==='max-event'?'2101-01-01T00:00':day+'T11:00');closeEditor();
      document.querySelector('#add').click();
      verifyTimes(day+'T12:00',day+'T13:00');closeEditor();
    }
    verify(localStorage.getItem(STORAGE_KEY)===beforeLimits);
    const legacy=document.querySelector('[data-agenda-warning="anchor"]');
    verify(!!legacy&&legacy.textContent.includes('架空の旧データ <b>文字</b>')&&!legacy.querySelector('button,b,[data-edit]'));
    verify(legacy.textContent.includes('2100-12-30T00:00')&&legacy.textContent.includes('閲覧のみ'));
    legacy.click();verify(!document.querySelector('#editor').open);
    const endWarnings=()=>[...document.querySelectorAll('.agenda [data-agenda-warning="end-limit"]')];
    for(const day of ['2100-12-29','2100-12-30','2100-12-31']){
      jumpTo(day);
      const warnings=endWarnings();
      verify(warnings.length===(day.endsWith('29')?0:1));
      if(warnings.length){
        verify(warnings[0].textContent.includes('2100-12-30T10:00')&&!warnings[0].querySelector('button,[data-edit]'));
        warnings[0].click();verify(!document.querySelector('#editor').open);
      }
    }
    verify(localStorage.getItem(STORAGE_KEY)===beforeLimits);
    document.querySelector('[data-edit="max-event"]').click();
    editorForm().elements.title.value='範囲端の予定・名称のみ変更';
    changeValue(timeSelect('終了時（24時間）'),'01');
    verify(!editorForm().checkValidity());
    editorForm().requestSubmit();
    verify(localStorage.getItem(STORAGE_KEY)===beforeLimits);
    changeValue(timeSelect('終了時（24時間）'),'00');
    verify(editorForm().checkValidity());
    await saveTitle(editorForm(),'範囲端の予定・名称のみ変更');
    const boundarySaved=saved().items.find(item=>item.id==='max-event');
    verify(boundarySaved.title==='範囲端の予定・名称のみ変更'&&boundarySaved.start==='2100-12-31T10:00'&&boundarySaved.end==='2101-01-01T00:00');
    verify(JSON.stringify(saved().items.find(item=>item.id==='legacy-anchor'))===JSON.stringify(JSON.parse(beforeLimits).items.find(item=>item.id==='legacy-anchor')));
    document.querySelector('[data-mode=week]').click();
    document.querySelector('[data-today]').click();
    document.body.dataset.phase2Step='agenda pagination';
    const beforePages=localStorage.getItem(STORAGE_KEY);
    const pageRows=()=>[...document.querySelectorAll('.agenda [data-edit^="page-event-"]')];
    const pageKeys=()=>pageRows().map(row=>row.dataset.edit).join(',');
    const pageButton=direction=>document.querySelector('[data-agenda-page="'+direction+'"]');
    const yearEnd=JSON.parse(beforePages);
    yearEnd.items.push(...Array.from({length:51},(_,i)=>({
      id:'page-event-'+String(i).padStart(3,'0'),type:'event',title:'架空の年末ページ予定 '+i,
      start:'2100-12-29T10:00',end:'2100-12-31T12:00',allDay:false,repeat:'none',excluded:[]
    })));
    const yearEndRaw=JSON.stringify(yearEnd);
    localStorage.setItem(STORAGE_KEY,yearEndRaw);
    window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
    jumpTo('2100-12-31');
    await wait(()=>pageRows().length===50);
    verify(endWarnings().length===0);
    pageButton('next').click();
    verify(pageKeys()==='page-event-050'&&endWarnings().length===1&&!!document.querySelector('[data-edit="max-event"]'));
    verify(pageButton('next').disabled);
    endWarnings()[0].click();verify(!document.querySelector('#editor').open);
    pageButton('previous').click();verify(pageRows().length===50&&endWarnings().length===0);
    verify(localStorage.getItem(STORAGE_KEY)===yearEndRaw);
    const pageDay='2028-01-18';
    for(const count of [50,51,151]){
      const fixtures=JSON.parse(beforePages);
      fixtures.items.push(...Array.from({length:count},(_,i)=>({
        id:'page-event-'+String(i).padStart(3,'0'),type:'event',title:'架空のページ予定 '+i,
        start:pageDay+'T10:00',end:pageDay+'T11:00',allDay:false,repeat:'none',excluded:[]
      })).reverse());
      localStorage.setItem(STORAGE_KEY,JSON.stringify(fixtures));
      window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
      jumpTo(pageDay);
      await wait(()=>pageRows().length===50&&(count===50?!pageButton('next'):!pageButton('next')?.disabled&&!!pageButton('next')));
      const raw=localStorage.getItem(STORAGE_KEY),firstKeys=pageKeys();
      if(count>50){
        const ids=pageRows().map(row=>row.dataset.edit);
        pageButton('next').click();verify(pageRows()[0].dataset.edit==='page-event-050');
        pageRows()[0].click();verify(editorForm().elements.title.value==='架空のページ予定 50');
        verifyTimes(pageDay+'T10:00',pageDay+'T11:00');closeEditor();
        pageButton('previous').click();verify(pageKeys()===firstKeys);
        while(!pageButton('next').disabled){
          pageButton('next').click();
          ids.push(...pageRows().map(row=>row.dataset.edit));
        }
        verify(ids.length===count&&new Set(ids).size===count&&pageRows().at(-1).dataset.edit==='page-event-'+String(count-1).padStart(3,'0'));
        verify(document.querySelector('.agenda-pages [role=status]').textContent.includes('最終'));
      }
      verify(localStorage.getItem(STORAGE_KEY)===raw);
    }
    localStorage.setItem(STORAGE_KEY,beforePages);
    window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
    await wait(()=>!pageRows().length);
    document.querySelector('[data-today]').click();
    document.body.dataset.phase2Step='calendar names and cross-day bars';
    const beforeCalendar=localStorage.getItem(STORAGE_KEY);
    const sample=JSON.parse(beforeCalendar);
    const gridEvent=(id,title,start,end)=>({id,title,type:'event',start,end,repeat:'none',excluded:[],allDay:false});
    const gridTask=(id,title,due)=>({id,title,type:'task',due,repeat:'none',excluded:[],pinned:false});
    const longTitle='読みやすく省略する長い架空の予定 <b>文字</b>';
    sample.items.push(
      gridEvent('grid-a','架空の複数日 A','2027-01-03T10:00','2027-01-07T00:00'),
      gridEvent('grid-b','架空の複数日 B','2027-01-05T10:00','2027-01-09T00:00'),
      gridEvent('grid-c','架空の複数日 C','2027-01-06T10:00','2027-01-10T00:00'),
      gridEvent('grid-timed',longTitle,'2027-01-04T09:00','2027-01-04T10:00'),
      gridTask('grid-hidden','架空の非表示タスク','2027-01-04'),
      gridTask('grid-visible','架空の表示タスク','2027-01-09'),
    );
    const gridRaw=JSON.stringify(sample);
    localStorage.setItem(STORAGE_KEY,gridRaw);
    window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
    jumpTo('2027-01-04');
    const ready=()=>document.querySelector('#schedule-calendar[data-calendar-status="ready"]');
    const gridDay=day=>document.querySelector('.day[data-day="'+day+'"]');
    const gridWeek=()=>gridDay('2027-01-04').closest('.calendar-week');
    await wait(ready);
    const monday=gridDay('2027-01-04');
    verify(monday.querySelector('.calendar-entry-title').textContent===longTitle&&!monday.querySelector('b'));
    verify(monday.querySelector('.calendar-entry-time').textContent==='09:00');
    verify(monday.querySelector('.calendar-more').textContent==='+1件'&&!!monday.querySelector('.task-mark'));
    verify(monday.getAttribute('aria-label').includes('3件')&&monday.getAttribute('aria-label').includes('期限付きタスクあり'));
    const barSpec=()=>[...gridWeek().querySelectorAll('.calendar-bar')].map(bar=>
      [bar.textContent,bar.dataset.calendarStart,bar.dataset.calendarEnd,bar.dataset.calendarLane].join(':'));
    const expectedWeek=['架空の複数日 A:1:4:1','架空の複数日 B:2:6:2','架空の複数日 C:4:7:1'];
    verify(barSpec().join('|')===expectedWeek.join('|'));
    verify(gridDay('2027-01-06').querySelector('.calendar-more').textContent==='+1件');
    verify(gridDay('2027-01-09').querySelector('.calendar-entry-title').textContent==='架空の表示タスク');
    verify(document.querySelectorAll('.selected-date-tasks [data-edit="grid-hidden"]').length===1&&
      document.querySelectorAll('[data-edit="grid-hidden"]').length===1);
    document.querySelector('[data-mode=month]').click();
    await wait(ready);
    verify(barSpec().join('|')===expectedWeek.join('|'));
    document.querySelector('[data-mode=week]').click();verify(!!ready());
    const thursday=gridDay('2027-01-07');
    thursday.scrollIntoView({block:'center'});
    await new Promise(resolve=>requestAnimationFrame(resolve));
    const columnBox=thursday.getBoundingClientRect();
    const barBox=gridWeek().querySelectorAll('.calendar-bar')[1].getBoundingClientRect();
    const hitTarget=document.elementFromPoint(columnBox.left+columnBox.width/2,barBox.top+barBox.height/2);
    const hit=hitTarget?.closest('[data-day]');
    verify(hit===thursday,'Bar did not pass pointer input to its day: '+JSON.stringify({
      hit:hitTarget?.className,day:hit?.dataset.day,top:barBox.top,dayTop:columnBox.top,scrollY,viewport:innerHeight
    }));
    hit.click();
    verify(gridDay('2027-01-07').getAttribute('aria-pressed')==='true'&&!!ready());
    document.querySelector('#add').click();
    verifyTimes('2027-01-07T12:00','2027-01-07T13:00');closeEditor();
    verify(localStorage.getItem(STORAGE_KEY)===gridRaw);
    const updated=JSON.parse(gridRaw);
    updated.items.find(item=>item.id==='grid-b').title='別タブで更新された予定';
    const updatedRaw=JSON.stringify(updated);
    localStorage.setItem(STORAGE_KEY,updatedRaw);
    window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
    verify(!ready()&&!document.querySelector('.calendar-bar'));
    await wait(ready);
    verify(barSpec().some(bar=>bar.startsWith('別タブで更新された予定:')));
    verify(!barSpec().some(bar=>bar.startsWith('架空の複数日 B:')));
    const getItem=Storage.prototype.getItem;
    Storage.prototype.getItem=function(key){
      if(key===STORAGE_KEY)throw Error('Fictional storage read failure');
      return getItem.call(this,key);
    };
    try{
      window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
      await wait(()=>document.querySelector('#schedule-calendar[data-calendar-status="unavailable"]'));
      verify(!document.querySelector('.calendar-bar')&&!gridDay('2027-01-07').getAttribute('aria-label').includes('件'));
    }finally{Storage.prototype.getItem=getItem;}
    verify(localStorage.getItem(STORAGE_KEY)===updatedRaw);
    localStorage.setItem(STORAGE_KEY,beforeCalendar);
    window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
    document.querySelector('[data-today]').click();
    await wait(()=>!saved().items.some(item=>item.id==='grid-a')&&!!ready());
    document.body.dataset.phase2Step='selected task pagination and refresh focus';
    const taskDay='2027-01-04',oneTaskDay='2027-01-05',emptyTaskDay='2027-01-06';
    const tasks=Array.from({length:51},(_,i)=>gridTask('page-task-'+String(i).padStart(2,'0'),'架空タスク '+i,taskDay));
    const events=Array.from({length:51},(_,i)=>gridEvent('page-event-'+String(i).padStart(2,'0'),'架空予定 '+i,taskDay+'T10:00',taskDay+'T11:00'));
    const taskData={version:1,items:[...tasks.reverse(),...events,gridTask('one-task','架空の別日タスク',oneTaskDay),
      gridTask('overdue-task','架空の期限超過タスク','2000-01-01')],history:[]};
    const taskRaw=JSON.stringify(taskData);
    const taskRows=()=>[...document.querySelectorAll('.selected-date-tasks [data-edit]')];
    const taskPosition=()=>document.querySelector('#task-page-position')?.textContent;
    const taskNext=()=>document.querySelector('[data-task-page=next]');
    const calendarStatus=document.querySelector('#calendar-announcement');
    localStorage.setItem(STORAGE_KEY,taskRaw);
    window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
    jumpTo(taskDay);
    await wait(()=>!!ready()&&taskRows().length===50);
    verify(taskPosition()==='1 / 2ページ'&&taskRows()[0].dataset.edit==='page-task-00'&&taskRows().at(-1).dataset.edit==='page-task-49');
    document.querySelector('[data-agenda-page=next]').click();
    taskNext().click();
    verify(taskPosition()==='2 / 2ページ'&&taskRows().length===1&&taskRows()[0].dataset.edit==='page-task-50');
    verify(document.querySelector('#agenda-page-position').textContent==='2ページ（最終）');
    document.querySelector('[data-task-page=previous]').click();
    verify(taskRows()[0].dataset.edit==='page-task-00'&&document.querySelector('#agenda-page-position').textContent==='2ページ（最終）');
    taskNext().click();
    gridDay(oneTaskDay).click();verify(taskRows().length===1&&taskRows()[0].dataset.edit==='one-task'&&!taskNext());
    gridDay(emptyTaskDay).click();verify(taskRows().length===0&&!taskNext());
    gridDay(taskDay).click();verify(taskPosition()==='1 / 2ページ');
    verify(localStorage.getItem(STORAGE_KEY)===taskRaw);
    taskNext().click();
    taskRows()[0].click();verify(editorForm().elements.title.value==='架空タスク 50');
    await saveTitle(editorForm(),'架空の最終ページ編集');
    verify(taskPosition()==='2 / 2ページ'&&taskRows()[0].textContent.includes('架空の最終ページ編集'));
    document.querySelector('.selected-date-tasks [data-complete]').click();
    await wait(()=>saved().history.some(item=>item.sourceId==='page-task-50')&&taskRows().length===50&&!!ready());
    verify(!taskNext()&&!taskPosition()&&taskRows()[0].dataset.edit==='page-task-00'&&taskRows().at(-1).dataset.edit==='page-task-49');
    verify(gridDay(taskDay).getAttribute('aria-label').includes('101件')&&gridDay(taskDay).querySelector('.calendar-more').textContent==='+99件');
    verify(!!document.querySelector('[data-complete=overdue-task]'));
    document.querySelector('[data-view=due]').click();
    const overdue=document.querySelector('[data-complete=overdue-task]');
    verify(overdue?.closest('section').querySelector('h3').textContent==='期限超過');
    overdue.click();await wait(()=>saved().history.some(item=>item.sourceId==='overdue-task'));
    document.querySelector('[data-view=home]').click();
    document.querySelector('[data-mode=month]').click();await wait(ready);

    const reminder=ScheduleStore.prototype.reminder;
    let releaseReminder;
    ScheduleStore.prototype.reminder=async function(){
      const pending=new Promise(resolve=>{releaseReminder=resolve;});
      await pending;
      return {kind:'due'};
    };
    try{
      const originalDayButton=gridDay(taskDay);
      originalDayButton.focus();
      window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
      await wait(()=>releaseReminder&&!!ready());
      verify(document.activeElement===gridDay(taskDay)&&document.activeElement!==originalDayButton);
      const monthNext=()=>document.querySelector('[data-nav="1"]');
      monthNext().focus();const previousMonthNext=monthNext();
      releaseReminder();
      await wait(()=>monthNext()!==previousMonthNext&&!!document.querySelector('.backup-reminder'));
      verify(document.activeElement===monthNext());
      verify(document.querySelector('#calendar-announcement')===calendarStatus&&calendarStatus.textContent.includes('完了'));
    }finally{
      ScheduleStore.prototype.reminder=reminder;
      releaseReminder?.();
    }
    taskRows()[0].click();
    const titleInput=editorForm().elements.title;titleInput.focus();
    // An unchanged store refresh redraws the home behind the open editor.
    const previousCalendar=document.querySelector('#schedule-calendar');
    window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
    await wait(()=>!!ready()&&document.querySelector('#schedule-calendar')!==previousCalendar);
    verify(document.activeElement===titleInput&&document.querySelector('#editor').open);
    closeEditor();
    localStorage.setItem(STORAGE_KEY,beforeCalendar);
    window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
    document.querySelector('[data-today]').click();
    document.querySelector('[data-mode=week]').click();
    await wait(()=>!!ready()&&!saved().items.some(item=>item.id==='page-task-00'));
    document.body.dataset.phase2Step='remaining basic regressions';
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
    await checkBatchImport({verify,wait,today});
    sessionStorage.setItem('batch-load-result',document.body.dataset.batchLoad);
    const final=saved();final.items.push({id:'basic-late',type:'task',title:'架空のURL復帰試験',due:addDays(today,-7),pinned:false,repeat:'daily',excluded:[]});const raw=JSON.stringify(final);localStorage.setItem(STORAGE_KEY,raw);
    sessionStorage.setItem('basic-expected',raw);sessionStorage.setItem('basic-checks',String(checks));sessionStorage.setItem('basic-step','callback');window.location.hash='#notification-result=%ZZ';window.location.reload();
  }
}catch(error){
  document.body.dataset.phase2Step=(document.body.dataset.phase2Step||'initial checks')+' '+error.message+' '+(error.stack?.split('\n')[2]?.trim()||'');
  document.body.dataset.phase2Result='failed:'+checks;
}
