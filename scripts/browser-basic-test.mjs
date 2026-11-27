import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {PUBLIC_FILES,PROJECT_ROOT,readSource} from './files.mjs';

// Optional real-browser test, no dependencies/downloads. Supply an installed
// Chromium-family executable through MY_SCHEDULE_BROWSER if not using Edge.
const executable=process.env.MY_SCHEDULE_BROWSER||(process.platform==='win32'?'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe':null);
if(!executable)throw Error('Specify an installed browser via MY_SCHEDULE_BROWSER');

// Serialized into the browser so both narrow layout checks use the same measurements.
function layoutChecks(viewportWidth) {
  function textFits(element) {
    const box=element.getBoundingClientRect();
    const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
    const range=document.createRange();
    const rects=[];
    for(let text=walker.nextNode();text;text=walker.nextNode()){
      range.selectNodeContents(text);
      rects.push(...range.getClientRects());
    }
    return rects.length>0&&rects.every(rect=>
      rect.left>=box.left-1&&rect.right<=box.right+1&&rect.top>=box.top-1&&rect.bottom<=box.bottom+1);
  }
  function buttonFits(button,right) {
    const box=button.getBoundingClientRect();
    return box.width>=44&&box.height>=44&&box.left>=0&&box.right<=viewportWidth&&
      Math.abs(box.right-right)<=1&&textFits(button);
  }
  function doubleText(elements) {
    const sizes=elements.map(element=>parseFloat(getComputedStyle(element).fontSize));
    elements.forEach((element,index)=>{element.style.fontSize=sizes[index]*2+'px';});
  }
  const noHorizontalOverflow=()=>document.scrollingElement.scrollWidth<=viewportWidth;
  return {textFits,buttonFits,doubleText,noHorizontalOverflow};
}

const source=new Map(await Promise.all([...PUBLIC_FILES,'test/fixtures/browser-basic.js','test/fixtures/browser-batch-import.js'].map(async name=>[name,await readSource(PROJECT_ROOT,name)])));
const html=source.get('index.html').toString('utf8').replace('./src/app.js','./test/fixtures/browser-basic.js');
const profile=await mkdtemp(join(tmpdir(),'my-schedule-browser-'));
const server=createServer((request,response)=>{
  const path=new URL(request.url,'http://127.0.0.1').pathname.slice(1);
  const data=path===''?html:source.get(path);
  if(data===undefined){response.writeHead(404);response.end();return;}
  response.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':path.endsWith('.png')?'image/png':'text/html; charset=utf-8','Cache-Control':'no-store'});response.end(data);
});
let browser,socket;
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/`;
  source.set('src/shortcut-test.js',Buffer.from(source.get('src/shortcut-test.js').toString('utf8').replace("https://my-schedule-test.pages.dev",url.slice(0,-1))));
  source.set('src/notification-v3.js',Buffer.from(source.get('src/notification-v3.js').toString('utf8').replace('https://my-schedule-test.pages.dev',url.slice(0,-1))));
  const endpoint=await new Promise((resolveEndpoint,reject)=>{
    browser=spawn(executable,['--headless=new','--disable-background-networking','--disable-component-update','--disable-sync','--no-pings','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    let diagnostics='';const timer=setTimeout(()=>reject(Error('Browser startup timed out')),15000);
    browser.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-8192);const match=diagnostics.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/);if(match){clearTimeout(timer);resolveEndpoint(match[1]);}});
    browser.on('error',()=>{clearTimeout(timer);reject(Error('Installed browser could not be launched'));});
    browser.on('close',()=>{clearTimeout(timer);reject(Error('Browser exited before startup completed'));});
  });
  socket=new WebSocket(endpoint);await new Promise((resolveOpen,reject)=>{socket.addEventListener('open',resolveOpen,{once:true});socket.addEventListener('error',()=>reject(Error('Browser connection failed')),{once:true});});
  let sequence=0;const pending=new Map();
  socket.addEventListener('message',event=>{
    const response=JSON.parse(event.data),request=pending.get(response.id);if(!request)return;
    pending.delete(response.id);clearTimeout(request.timer);response.error?request.reject(Error('Browser protocol command failed')):request.resolve(response.result);
  });
  function command(method,params={},sessionId){
    return new Promise((resolveCommand,reject)=>{
      const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Browser command timed out'));},10000);
      pending.set(id,{resolve:resolveCommand,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
    });
  }
  const {targetId}=await command('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},sessionId);
  await command('Page.navigate',{url},sessionId);
  let result=null,step=null;
  for(let attempt=0;attempt<600;attempt++){
    const evaluation=await command('Runtime.evaluate',{expression:'({result:document.body?.dataset.phase2Result,step:document.body?.dataset.phase2Step})',returnByValue:true},sessionId);
    result=evaluation.result?.value?.result;step=evaluation.result?.value?.step;
    if(result)break;await new Promise(resolveWait=>setTimeout(resolveWait,50));
  }
  if(!/^passed:\d+$/.test(result||''))throw Error('Browser UI integration failed '+(result||'before completion')+' '+(step||'unknown step'));
  console.log('Real-browser basic release UI passed: '+result.slice(7)+' checks');
  // Real browser default keyboard activation, at a narrow width and 200% text.
  await command('Page.bringToFront',{},sessionId);
  const narrowWidth=320;
  await command('Emulation.setDeviceMetricsOverride',{width:narrowWidth,height:844,deviceScaleFactor:1,mobile:true},sessionId);
  const narrowChecks=`(${layoutChecks})(${narrowWidth})`;
  const homeLayout=await command('Runtime.evaluate',{expression:`(async()=>{
    const {textFits,buttonFits,doubleText,noHorizontalOverflow}=${narrowChecks};
    const title=document.querySelector('.due-title');
    const button=title.querySelector('.due-button'),heading=title.querySelector('h2'),count=heading.querySelector('.count');
    const fits=()=>buttonFits(button,title.getBoundingClientRect().right)&&
      textFits(heading)&&textFits(count)&&noHorizontalOverflow();
    const style=getComputedStyle(button);
    if(!fits()||style.borderTopStyle!=='solid'||parseFloat(style.borderTopLeftRadius)<=0||style.backgroundColor==='rgba(0, 0, 0, 0)')return false;
    if(heading.getBoundingClientRect().right>button.getBoundingClientRect().left+1)return false;
    const textElements=[heading,count,button];
    doubleText(textElements);
    if(!fits()||heading.getBoundingClientRect().bottom>button.getBoundingClientRect().top+1)return false;
    for(const element of textElements)element.style.removeProperty('font-size');
    const icon=document.querySelector('.brand-mark'),iconStyle=getComputedStyle(icon),box=icon.getBoundingClientRect();
    const url=new URL('./apple-touch-icon-v1.png',location.href).href;
    if(iconStyle.backgroundImage!=='url("'+url+'")'||iconStyle.backgroundSize!=='contain'||box.width<44||box.height<44)return false;
    const image=new Image();image.src=url;await image.decode();
    return image.naturalWidth===180&&image.naturalHeight===180&&document.querySelector('.brand h1').textContent==='マイスケジュール';
  })()`,awaitPromise:true,returnByValue:true},sessionId);
  if(homeLayout.result?.value!==true)throw Error('Narrow home layout or brand icon check failed');
  console.log('320px due-button layout, 200% text and brand icon passed');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9},sessionId);
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9},sessionId);
  for(const view of ['someday','history','due']){
    const evaluation=await command('Runtime.evaluate',{expression:`(()=>{
      const {buttonFits,doubleText,noHorizontalOverflow}=${narrowChecks};
      document.querySelector('[data-view=${view}]').click();
      const back=document.querySelector('.back'),right=document.querySelector('.page-intro').getBoundingClientRect().right;
      const fits=()=>buttonFits(back,right)&&noHorizontalOverflow();
      if(!fits())return false;
      doubleText([back]);back.focus();
      return fits()&&document.activeElement===back&&getComputedStyle(back).outlineStyle!=='none';
    })()`,returnByValue:true},sessionId);
    if(evaluation.result?.value!==true)throw Error('Narrow/large-text back button or focus check failed: '+view);
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'},sessionId);
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},sessionId);
    const home=await command('Runtime.evaluate',{expression:"!document.querySelector('.back')&&!!document.querySelector('#backup-open')",returnByValue:true},sessionId);
    if(home.result?.value!==true)throw Error('Keyboard home navigation failed: '+view);
  }
  console.log('Narrow/200% back-button layout, focus and Enter navigation passed: 6 checks');
  const editorSetup=await command('Runtime.evaluate',{expression:`(()=>{
    const day=document.querySelector('.day:not(.selected):not(:disabled)');
    day.click();document.querySelector('#add').click();
    return day.dataset.day;
  })()`,returnByValue:true},sessionId);
  const date=editorSetup.result.value;
  async function pressKey(key,windowsVirtualKeyCode){
    for(const type of ['keyDown','keyUp'])await command('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode},sessionId);
  }
  for(const [label,initialHour,chosenHour,endHour] of [['開始','12','13','14'],['終了','14','15','15']]){
    const readPicker=async(open=false)=>{
      const evaluation=await command('Runtime.evaluate',{expression:`(()=>{
        const form=document.querySelector('#entry-form');
        const hour=form.querySelector('select[aria-label="${label}時（24時間）"]');
        if(${open})hour.showPicker();
        return {focused:document.activeElement===hour,open:hour.matches(':open'),dialogOpen:document.querySelector('#editor').open,
          hour:hour.value,start:form.elements.start.value,end:form.elements.end.value};
      })()`,userGesture:open,returnByValue:true},sessionId);
      if(!evaluation.result?.value)throw Error('Could not read native hour picker: '+label);
      return evaluation.result.value;
    };
    let before=await readPicker();
    for(let tabs=0;!before.focused&&tabs<12;tabs++){
      await pressKey('Tab',9);
      before=await readPicker();
    }
    if(!before.focused||before.hour!==initialHour)throw Error('Tab did not reach the expected hour picker: '+label);
    if(!(await readPicker(true)).open)throw Error('Native hour picker did not open: '+label);
    // Edge can commit a moved candidate on Escape. Test Escape without moving the selection.
    await pressKey('Escape',27);
    const after=await readPicker();
    if(!after.dialogOpen||after.open||after.hour!==before.hour||after.start!==before.start||after.end!==before.end)
      throw Error('Dismissing the native hour picker changed the form: '+label);
    if(!(await readPicker(true)).open)throw Error('Native hour picker did not reopen: '+label);
    await pressKey('ArrowDown',40);
    await pressKey('Enter',13);
    const committed=await readPicker();
    if(!committed.dialogOpen||committed.open||committed.hour!==chosenHour||
      committed.start!==date+'T13:00'||committed.end!==date+'T'+endHour+':00')
      throw Error('Keyboard selection did not update the date and time fields: '+label);
  }
  console.log('Both native hour pickers passed Tab, unchanged Escape and ArrowDown/Enter selection');
  const dateLayout=await command('Runtime.evaluate',{expression:`(()=>{
    const dialog=document.querySelector('#editor'),form=document.querySelector('#entry-form');
    const fits=()=>[...document.querySelectorAll('#entry-form input[type=date],#entry-form .date-hint:not([hidden])')].every(node=>{const r=node.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&node.scrollWidth<=node.clientWidth+1;});
    const timeRows=[...form.querySelectorAll('.date-time-control')];
    const dialogBox=dialog.getBoundingClientRect();
    if(timeRows.length!==2||!timeRows.every(row=>{
      const selects=[...row.querySelectorAll('select')];
      if(selects.length!==2)return false;
      const [hour,minute]=selects.map(select=>select.getBoundingClientRect());
      return hour.top===minute.top&&hour.right<=minute.left&&[hour,minute].every(box=>
        box.width>=44&&box.height>=44&&box.left>=dialogBox.left&&box.right<=dialogBox.right);
    })||dialog.scrollWidth>dialog.clientWidth+1||getComputedStyle(form.querySelector('.sheet-bottom')).position!=='sticky')return false;
    if(!fits())return false;
    form.elements.allDay.checked=true;form.elements.allDay.dispatchEvent(new Event('change'));
    if(!fits())return false;
    document.querySelector('[data-type=task]').click();
    const due=document.querySelector('#entry-form').elements.due;
    due.value='2028-02-29';due.dispatchEvent(new Event('input'));
    return fits();
  })()`,returnByValue:true},sessionId);
  if(dateLayout.result?.value!==true)throw Error('Narrow date/time input or sticky footer layout failed');
  console.log('320px time selects, sticky footer and timed/all-day/task date layout passed');
  await mkdir(join(PROJECT_ROOT,'artifacts'),{recursive:true});
  const metrics=await command('Page.getLayoutMetrics',{},sessionId);
  const screenshot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:390,height:Math.min(4096,metrics.cssContentSize.height),scale:1}},sessionId);
  await writeFile(join(PROJECT_ROOT,'artifacts','basic-release-ui.png'),Buffer.from(screenshot.data,'base64'));

  async function measureAgenda(){
    await command('HeapProfiler.collectGarbage',{},sessionId);
    const heap=await command('Runtime.getHeapUsage',{},sessionId);
    const dom=await command('Memory.getDOMCounters',{},sessionId);
    const elements=await command('Runtime.evaluate',{expression:'document.getElementsByTagName("*").length',returnByValue:true},sessionId);
    return {heapMiB:Math.round(heap.usedSize/1024/1024*100)/100,domNodes:dom.nodes,connectedElements:elements.result.value};
  }
  const baseline=await measureAgenda();
  const initialStart=performance.now();
  const largeAgenda=await command('Runtime.evaluate',{expression:`(async()=>{
    const {STORAGE_KEY}=await import('./src/model.js');
    document.querySelector('#close').click();
    history.replaceState(null,'',location.pathname);
    const items=Array.from({length:1000},(_,i)=>({
      id:'large-'+String(i).padStart(4,'0'),type:'event',title:'架空の負荷試験 '+i,
      start:'2026-01-01T00:00',end:'2027-01-02T00:00',allDay:false,repeat:'daily',excluded:[]
    }));
    const raw=JSON.stringify({version:1,items,history:[]});
    localStorage.setItem(STORAGE_KEY,raw);
    const Clock=globalThis.Date,instant=new Clock('2027-01-01T12:00').getTime();
    globalThis.Date=class extends Clock{constructor(...args){super(...(args.length?args:[instant]));}static now(){return instant;}};
    try{document.querySelector('[data-today]').click();}finally{globalThis.Date=Clock;}
    window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
    const rows=()=>[...document.querySelectorAll('.agenda [data-edit^="large-"]')];
    for(let tries=0;!rows().length&&tries<150;tries++)await new Promise(resolve=>setTimeout(resolve,20));
    await new Promise(resolve=>requestAnimationFrame(resolve));
    return {rows:rows().length,first:rows()[0]?.dataset.edit,rawPreserved:localStorage.getItem(STORAGE_KEY)===raw,
      overflow:document.scrollingElement.scrollWidth>320};
  })()`,awaitPromise:true,returnByValue:true},sessionId);
  const initialMs=Math.round(performance.now()-initialStart);
  const loaded=largeAgenda.result?.value;
  if(loaded?.rows!==50||loaded.first!=='large-0000'||!loaded.rawPreserved||loaded.overflow)
    throw Error('Maximum-size agenda did not load a valid narrow first page: '+JSON.stringify(loaded));
  const firstPage=await measureAgenda();
  const nextStart=performance.now();
  const pagerFocused=await command('Runtime.evaluate',{expression:`(()=>{
    const button=document.querySelector('[data-agenda-page=next]');
    button.focus();
    return document.activeElement===button;
  })()`,returnByValue:true},sessionId);
  if(pagerFocused.result?.value!==true)throw Error('Could not focus the agenda pager');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'},sessionId);
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},sessionId);
  const secondPage=await command('Runtime.evaluate',{expression:`(()=>{
    const rows=document.querySelectorAll('.agenda [data-edit^="large-"]');
    return {rows:rows.length,first:rows[0]?.dataset.edit,focused:document.activeElement.dataset.agendaPage==='next'};
  })()`,returnByValue:true},sessionId);
  const pageMs=Math.round(performance.now()-nextStart);
  const second=secondPage.result?.value;
  if(second?.rows!==50||second.first!=='large-0050'||!second.focused)
    throw Error('Maximum-size agenda keyboard navigation failed: '+JSON.stringify(second));
  const editorStart=performance.now();
  const opened=await command('Runtime.evaluate',{expression:`(()=>{
    document.querySelector('.agenda [data-edit="large-0050"]').click();
    const form=document.querySelector('#entry-form');
    const correct=form?.elements.title.value==='架空の負荷試験 50'&&form.elements.start.value==='2026-01-01T00:00';
    document.querySelector('#close').click();
    document.querySelector('[data-agenda-page=previous]').click();
    return {correct,returned:document.querySelector('.agenda [data-edit]').dataset.edit==='large-0000'};
  })()`,returnByValue:true},sessionId);
  const editorAndReturnMs=Math.round(performance.now()-editorStart);
  const navigation=opened.result?.value;
  if(!navigation?.correct||!navigation.returned)
    throw Error('Maximum-size agenda page navigation or occurrence editing failed: '+JSON.stringify(navigation));
  const afterNavigation=await measureAgenda();
  console.log('1000 long daily series at 320px: '+JSON.stringify({initialMs,pageMs,editorAndReturnMs,baseline,firstPage,afterNavigation,visibleRows:loaded.rows}));

  const heavyCalendar=await command('Runtime.evaluate',{expression:`(async()=>{
    const {STORAGE_KEY}=await import('./src/model.js');
    const items=JSON.parse(localStorage.getItem(STORAGE_KEY)).items.map((item,index)=>{
      const time=String(Math.floor(index/60)).padStart(2,'0')+':'+String(index%60).padStart(2,'0');
      return {...item,id:'staggered-'+item.id,start:'2026-01-01T'+time,end:'2027-01-02T'+time};
    });
    localStorage.setItem(STORAGE_KEY,JSON.stringify({version:1,items,history:[]}));
    window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
    const Clock=globalThis.Date,may=new Clock('2027-05-01T12:00').getTime();
    globalThis.Date=class extends Clock{constructor(...args){super(...(args.length?args:[may]));}static now(){return may;}};
    try{document.querySelector('[data-today]').click();}finally{globalThis.Date=Clock;}
    document.querySelector('[data-mode=month]').click();
    for(let i=0;i<150&&!document.querySelector('.agenda [data-edit^="staggered-"]');i++)
      await new Promise(resolve=>setTimeout(resolve,20));
    const calendar=document.querySelector('#schedule-calendar');
    const loading=calendar.dataset.calendarStatus==='loading'&&!calendar.querySelector('.calendar-bar');
    calendar.querySelector('[data-nav="1"]').focus();
    return {loading,days:calendar.querySelectorAll('[data-day]').length,first:calendar.dataset.calendarFirst};
  })()`,awaitPromise:true,returnByValue:true},sessionId);
  const may=heavyCalendar.result?.value;
  if(!may?.loading||may.days!==42||may.first!=='2027-04-26')throw Error('42-day calendar did not start in a pending state: '+JSON.stringify(may));
  const inputStart=performance.now();
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'},sessionId);
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},sessionId);
  const navigated=await command('Runtime.evaluate',{expression:`(()=>{
    const calendar=document.querySelector('#schedule-calendar');
    const status=calendar.dataset.calendarStatus;
    calendar.querySelector('[data-day="2027-06-08"]')?.click();
    return {status,first:calendar.dataset.calendarFirst,selected:document.querySelector('.day[aria-pressed=true]')?.dataset.day};
  })()`,returnByValue:true},sessionId);
  const during=navigated.result?.value;
  if(during?.status!=='loading'||during.first!=='2027-05-31'||during.selected!=='2027-06-08')
    throw Error('Calendar input was unavailable during a heavy request: '+JSON.stringify(during));
  const inputMs=Math.round(performance.now()-inputStart);
  async function waitForHeavyCalendar(date){
    for(let i=0;i<350;i++){
      const check=await command('Runtime.evaluate',{expression:`(()=>{
        const calendar=document.querySelector('#schedule-calendar'),day=calendar.querySelector('[data-day="${date}"]');
        return {status:calendar.dataset.calendarStatus,first:calendar.dataset.calendarFirst,selected:day?.getAttribute('aria-pressed'),
          count:day?.getAttribute('aria-label').includes('366999件')};
      })()`,returnByValue:true},sessionId);
      const result=check.result?.value;
      if(result?.status!=='loading')return result;
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    throw Error('Heavy calendar did not finish');
  }
  const finishStart=performance.now();
  const calendarResult=await waitForHeavyCalendar('2027-06-08');
  if(calendarResult?.status!=='ready'||calendarResult.first!=='2027-05-31'||calendarResult.selected!=='true'||!calendarResult.count)
    throw Error('Heavy calendar published an incomplete or obsolete result: '+JSON.stringify(calendarResult));
  const finishMs=Math.round(performance.now()-finishStart);
  for(const width of [320,390,430]){
    await command('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true},sessionId);
    const layout=await command('Runtime.evaluate',{expression:`(()=>{
      const week=[...document.querySelectorAll('.calendar-week')];
      return document.scrollingElement.scrollWidth<=${width}&&week.length===5&&
        week.every(row=>row.querySelectorAll('.calendar-day').length===7)&&
        [...document.querySelectorAll('.calendar-bar')].every(bar=>bar.getBoundingClientRect().right<=${width});
    })()`,returnByValue:true},sessionId);
    if(layout.result?.value!==true)throw Error('Calendar horizontal layout failed at '+width+'px');
  }
  await command('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:1,mobile:true},sessionId);
  const fullStart=performance.now();
  await command('Runtime.evaluate',{expression:`document.querySelector('[data-nav="-1"]').click()`},sessionId);
  const fullCalendar=await waitForHeavyCalendar('2027-05-01');
  const full42Ms=Math.round(performance.now()-fullStart);
  if(fullCalendar?.status!=='ready'||fullCalendar.first!=='2027-04-26'||fullCalendar.selected!=='true'||!fullCalendar.count)
    throw Error('42-day calendar did not finish on the latest range: '+JSON.stringify(fullCalendar));
  console.log('Calendar month at 320/390/430px and 1000 distinct daily schedules passed: '+JSON.stringify({inputMs,finishMs,full42Ms}));

  const loadTasks=await command('Runtime.evaluate',{expression:`(async()=>{
    const {STORAGE_KEY}=await import('./src/model.js');
    const before=performance.now();
    const items=Array.from({length:1000},(_,i)=>({
      id:'bulk-task-'+String(i).padStart(4,'0'),type:'task',due:'2027-05-01',pinned:false,repeat:'none',excluded:[],
      title:i===0?'A9'.repeat(80):i===1?'長い日本語の架空タスク名'.repeat(12):'架空タスク '+i
    }));
    const raw=JSON.stringify({version:1,items,history:[]});
    sessionStorage.setItem('bulk-task-snapshot',raw);
    localStorage.setItem(STORAGE_KEY,raw);
    const active=document.querySelector('[data-nav="1"]');
    active.focus();
    window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
    const rows=()=>document.querySelectorAll('.selected-date-tasks .task-row');
    for(let i=0;i<150&&!rows().length;i++)await new Promise(resolve=>setTimeout(resolve,20));
    await new Promise(resolve=>requestAnimationFrame(resolve));
    const root=document.querySelector('.selected-date-tasks');
    return {initialMs:Math.round(performance.now()-before),rows:rows().length,
      elements:root?.querySelectorAll('*').length,pageElements:document.querySelectorAll('*').length,
      position:document.querySelector('#task-page-position')?.textContent,
      focused:document.activeElement===document.querySelector('[data-nav="1"]')&&!active.isConnected};
  })()`,awaitPromise:true,returnByValue:true},sessionId);
  const bulk=loadTasks.result?.value;
  if(bulk?.rows!==50||bulk.position!=='1 / 20ページ'||!bulk.focused)
    throw Error('Maximum-size task list or focus restoration failed: '+JSON.stringify(bulk));
  // Use a real key event after the simulated storage event to exercise restored focus.
  const enter=async()=>{
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'},sessionId);
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},sessionId);
  };
  await enter();
  const nextMonth=await command('Runtime.evaluate',{expression:`(()=>{
    if(document.querySelector('#schedule-calendar').dataset.calendarFirst!=='2027-05-31')return false;
    document.querySelector('[data-nav="-1"]').click();
    document.querySelector('[data-task-page=next]').focus();
    return true;
  })()`,returnByValue:true},sessionId);
  if(nextMonth.result?.value!==true)throw Error('Restored month navigation did not respond to Enter');
  const taskPageStart=performance.now();
  await enter();
  const focusedTaskPage=await command('Runtime.evaluate',{expression:`document.querySelector('#task-page-position')?.textContent==='2 / 20ページ'&&
    document.activeElement===document.querySelector('[data-task-page=next]')`,returnByValue:true},sessionId);
  const taskTurnMs=Math.round(performance.now()-taskPageStart);
  if(focusedTaskPage.result?.value!==true)throw Error('Keyboard task pagination did not move to page 2');
  const verifyBulkPages=await command('Runtime.evaluate',{expression:`(()=>{
    const ids=()=>[...document.querySelectorAll('.selected-date-tasks [data-edit]')].map(el=>el.dataset.edit);
    const position=()=>document.querySelector('#task-page-position').textContent;
    const pager=direction=>document.querySelector('[data-task-page='+direction+']');
    pager('previous').click();
    const seen=[];
    for(let page=1;page<=20;page++){
      const visible=ids();
      if(visible.length!==50||position()!==page+' / 20ページ')return {error:'page '+page};
      seen.push(...visible);
      if(page<20)pager('next').click();
    }
    if(!pager('next').disabled||!seen.every((id,i)=>id==='bulk-task-'+String(i).padStart(4,'0')))return {error:'order, loss, or duplication'};
    if(document.activeElement!==pager('previous'))return {error:'final-page focus'};
    while(!pager('previous').disabled)pager('previous').click();
    return {rows:ids().length,first:ids()[0]};
  })()`,returnByValue:true},sessionId);
  const taskRun=verifyBulkPages.result?.value;
  if(taskRun?.rows!==50||taskRun.first!=='bulk-task-0000')
    throw Error('Maximum-size task pagination failed: '+JSON.stringify(taskRun));
  for(const width of [320,390,430]){
    await command('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true},sessionId);
    const taskLayout=await command('Runtime.evaluate',{expression:`(()=>{
      const {doubleText,textFits,noHorizontalOverflow}=(${layoutChecks.toString()})(${width});
      const rows=[...document.querySelectorAll('.selected-date-tasks .task-row')].slice(0,2);
      const titles=rows.map(row=>row.querySelector('.item-title'));
      const fits=()=>noHorizontalOverflow()&&rows.length===2&&rows.every((row,i)=>{
        const edit=titles[i].getBoundingClientRect(),done=row.querySelector('.checkbox').getBoundingClientRect();
        return textFits(titles[i])&&edit.left>=done.right&&edit.right<=${width}&&
          edit.width>=44&&edit.height>=44&&done.width>=44&&done.height>=44;
      });
      const normal=fits();
      doubleText(titles.flatMap(title=>[title,...title.querySelectorAll('span,small')]));
      const enlarged=fits();
      titles.flatMap(title=>[title,...title.querySelectorAll('span,small')]).forEach(element=>element.style.removeProperty('font-size'));
      return {normal,enlarged};
    })()`,returnByValue:true},sessionId);
    if(!taskLayout.result?.value?.normal||!taskLayout.result?.value?.enlarged)
      throw Error('Task title overflow at '+width+'px: '+JSON.stringify(taskLayout.result?.value));
  }
  const rawPreserved=await command('Runtime.evaluate',{expression:`(async()=>{
    const {STORAGE_KEY}=await import('./src/model.js');
    return localStorage.getItem(STORAGE_KEY)===sessionStorage.getItem('bulk-task-snapshot');
  })()`,awaitPromise:true,returnByValue:true},sessionId);
  if(rawPreserved.result?.value!==true)throw Error('Task page navigation changed saved data');
  console.log('1000 same-day tasks and narrow/200% titles passed: '+JSON.stringify({...bulk,pageMs:taskTurnMs,uniqueRows:1000}));
  const batchSetup=await command('Runtime.evaluate',{expression:`(()=>{
    document.querySelector('#add').click();
    document.querySelector('#batch-open').focus();
    return JSON.parse(sessionStorage.getItem('batch-load-result'));
  })()`,returnByValue:true},sessionId);
  if(batchSetup.result?.value?.rows!==100)throw Error('The 100-entry import load fixture did not finish');
  await enter();
  const batchPreview=await command('Runtime.evaluate',{expression:`(()=>{
    const input=document.querySelector('#batch-json');
    if(document.activeElement!==input)return false;
    input.value=JSON.stringify({format:'my-schedule-import',formatVersion:1,items:[
      {type:'task',title:'W'.repeat(160),due:null,repeat:'none'},
      {type:'task',title:'',due:'2026-02-30',repeat:'none'}
    ]});
    input.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('#batch-parse').click();
    return document.activeElement===document.querySelector('#batch-title');
  })()`,returnByValue:true},sessionId);
  if(batchPreview.result?.value!==true)throw Error('The import dialog did not preserve keyboard focus');
  for(const width of [320,390,430]){
    await command('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true},sessionId);
    const layout=await command('Runtime.evaluate',{expression:`(()=>{
      const {doubleText,textFits,noHorizontalOverflow}=(${layoutChecks.toString()})(${width});
      const dialog=document.querySelector('#batch-import'),list=document.querySelector('.batch-content');
      const name=document.querySelector('.batch-name');
      const buttons=[...dialog.querySelectorAll('button')];
      const fits=()=>noHorizontalOverflow()&&dialog.scrollWidth<=dialog.clientWidth&&list.scrollWidth<=list.clientWidth&&
        textFits(name)&&buttons.every(button=>{
          const box=button.getBoundingClientRect();
          return box.width>=44&&box.height>=44&&box.left>=0&&box.right<=${width};
        });
      const plain=fits(),elements=[name,...buttons];
      doubleText(elements);
      const enlarged=fits();
      elements.forEach(element=>element.style.removeProperty('font-size'));
      return {plain,enlarged};
    })()`,returnByValue:true},sessionId);
    if(!layout.result?.value?.plain||!layout.result?.value?.enlarged)
      throw Error('Import dialog overflows at '+width+'px: '+JSON.stringify(layout.result?.value));
    const editorLayout=await command('Runtime.evaluate',{expression:`(()=>{
      const {doubleText,noHorizontalOverflow}=(${layoutChecks.toString()})(${width});
      document.querySelector('#batch-edit-2').click();
      const dialog=document.querySelector('#batch-import'),content=dialog.querySelector('.batch-content');
      const form=document.querySelector('#batch-item-form'),date=form.elements.due;
      const description=document.getElementById(date.getAttribute('aria-describedby'));
      const fits=()=>noHorizontalOverflow()&&dialog.scrollWidth<=dialog.clientWidth&&content.scrollWidth<=content.clientWidth&&
        [...form.querySelectorAll('input,select')].every(control=>{
          const box=control.getBoundingClientRect();
          return box.left>=0&&box.right<=${width}&&box.height>=44;
        });
      const plain=fits(),fields=[...form.querySelectorAll('p,input,select')];
      doubleText(fields);
      const enlarged=fits(),focus=document.activeElement===form.elements.title;
      const described=description?.textContent.includes('2026-02-30')&&date.getAttribute('aria-invalid')==='true';
      document.querySelector('#batch-edit-back').click();
      return {plain,enlarged,focus,described};
    })()`,returnByValue:true},sessionId);
    if(!Object.values(editorLayout.result?.value??{failed:false}).every(Boolean))
      throw Error('Import row editor layout or error association failed at '+width+'px: '+JSON.stringify(editorLayout.result?.value));
  }
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},sessionId);
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},sessionId);
  const escape=await command('Runtime.evaluate',{expression:`document.querySelector('#batch-import').dataset.stage==='discard'&&
    document.activeElement===document.querySelector('#batch-keep')`,returnByValue:true},sessionId);
  if(escape.result?.value!==true)throw Error('Escape should ask before discarding the import draft');
  console.log('Batch import at 320/390/430px, 200% text and keyboard checks passed: '+JSON.stringify(batchSetup.result.value));
}finally{
  socket?.close();
  server.close();
  if(dirname(resolve(profile))!==resolve(tmpdir())||!basename(profile).startsWith('my-schedule-browser-'))throw Error('Invalid browser-profile cleanup path');
  // Only the isolated test profile is removed after the browser exits.
  if(browser&&browser.exitCode===null)await new Promise(resolveExit=>{browser.once('close',resolveExit);browser.kill();});
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
