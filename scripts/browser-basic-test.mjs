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
const source=new Map(await Promise.all([...PUBLIC_FILES,'test/fixtures/browser-basic.js'].map(async name=>[name,await readSource(PROJECT_ROOT,name)])));
const html=source.get('index.html').toString('utf8').replace('./src/app.js','./test/fixtures/browser-basic.js');
const profile=await mkdtemp(join(tmpdir(),'my-schedule-browser-'));
const server=createServer((request,response)=>{
  const path=new URL(request.url,'http://127.0.0.1').pathname.slice(1);
  const data=path===''?html:source.get(path);
  if(data===undefined){response.writeHead(404);response.end();return;}
  response.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store'});response.end(data);
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
  await command('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:1,mobile:true},sessionId);
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9},sessionId);
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9},sessionId);
  for(const view of ['someday','history','due']){
    const evaluation=await command('Runtime.evaluate',{expression:`(()=>{document.querySelector('[data-view=${view}]').click();const back=document.querySelector('.back');back.style.fontSize='32px';back.focus();const r=back.getBoundingClientRect();return document.activeElement===back&&r.width>=44&&r.height>=44&&r.left>=0&&r.right<=innerWidth&&getComputedStyle(back).outlineStyle!=='none';})()`,returnByValue:true},sessionId);
    if(evaluation.result?.value!==true)throw Error('Narrow/large-text back button or focus check failed: '+view);
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'},sessionId);
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},sessionId);
    const home=await command('Runtime.evaluate',{expression:"!document.querySelector('.back')&&!!document.querySelector('#backup-open')",returnByValue:true},sessionId);
    if(home.result?.value!==true)throw Error('Keyboard home navigation failed: '+view);
  }
  console.log('Narrow/200% back-button layout, focus and Enter navigation passed: 6 checks');
  const dateLayout=await command('Runtime.evaluate',{expression:`(()=>{
    document.querySelector('#add').click();
    const fits=()=>[...document.querySelectorAll('#entry-form input[type=date],#entry-form .date-hint:not([hidden])')].every(node=>{const r=node.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&node.scrollWidth<=node.clientWidth+1;});
    if(!fits())return false;
    let form=document.querySelector('#entry-form');form.elements.allDay.checked=true;form.elements.allDay.dispatchEvent(new Event('change'));
    if(!fits())return false;
    document.querySelector('[data-type=task]').click();form=document.querySelector('#entry-form');form.elements.due.value='2028-02-29';form.elements.due.dispatchEvent(new Event('input'));
    return fits();
  })()`,returnByValue:true},sessionId);
  if(dateLayout.result?.value!==true)throw Error('Narrow date input/hint layout failed');
  console.log('320px timed/all-day/task date input and hint layout passed: 3 checks');
  await mkdir(join(PROJECT_ROOT,'artifacts'),{recursive:true});
  const metrics=await command('Page.getLayoutMetrics',{},sessionId);
  const screenshot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:390,height:Math.min(4096,metrics.cssContentSize.height),scale:1}},sessionId);
  await writeFile(join(PROJECT_ROOT,'artifacts','basic-release-ui.png'),Buffer.from(screenshot.data,'base64'));
}finally{
  socket?.close();
  server.close();
  if(dirname(resolve(profile))!==resolve(tmpdir())||!basename(profile).startsWith('my-schedule-browser-'))throw Error('Invalid browser-profile cleanup path');
  // Only the isolated test profile is removed after the browser exits.
  if(browser&&browser.exitCode===null)await new Promise(resolveExit=>{browser.once('close',resolveExit);browser.kill();});
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
