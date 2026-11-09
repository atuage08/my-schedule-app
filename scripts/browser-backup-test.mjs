import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {PUBLIC_FILES,PROJECT_ROOT,readSource} from './files.mjs';

// Optional real-browser test, no dependencies/downloads. Supply an installed
// Chromium-family executable through MY_SCHEDULE_BROWSER if not using Edge.
const executable=process.env.MY_SCHEDULE_BROWSER||(process.platform==='win32'?'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe':null);
if(!executable)throw Error('Specify an installed browser via MY_SCHEDULE_BROWSER');
const source=new Map(await Promise.all([...PUBLIC_FILES,'test/fixtures/browser-backup.js'].map(async name=>[name,await readSource(PROJECT_ROOT,name)])));
const html=source.get('index.html').toString('utf8').replace('./src/app.js','./test/fixtures/browser-backup.js');
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
  console.log('Real-browser phase-2 integration passed: '+result.slice(7)+' checks');
  await command('Runtime.evaluate',{expression:'document.querySelector("#backup-open").click()'},sessionId);
  await new Promise(resolveWait=>setTimeout(resolveWait,400));
  const layout=await command('Runtime.evaluate',{expression:'(()=>{const d=document.querySelector("#backup-panel"),r=d.getBoundingClientRect();return {viewport:document.documentElement.clientWidth,width:d.clientWidth,scroll:d.scrollWidth,left:r.left,right:r.right};})()',returnByValue:true},sessionId);
  console.log('Backup panel layout: '+JSON.stringify(layout.result.value));
  const bounds=layout.result.value;
  if(bounds.width>bounds.viewport||bounds.scroll>bounds.width||bounds.left<0||bounds.right>bounds.viewport)throw Error('Backup panel overflows the narrow viewport');
}finally{
  socket?.close();
  server.close();
  if(dirname(resolve(profile))!==resolve(tmpdir())||!basename(profile).startsWith('my-schedule-browser-'))throw Error('Invalid browser-profile cleanup path');
  // Only the isolated test profile is removed after the browser exits.
  if(browser&&browser.exitCode===null)await new Promise(resolveExit=>{browser.once('close',resolveExit);browser.kill();});
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
