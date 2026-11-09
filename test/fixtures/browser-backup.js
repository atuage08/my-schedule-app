// Browser-only integration test on a fresh loopback origin and isolated profile.
import '../../src/app.js';
import {createBackup,readBackupFile} from '../../src/backup.js';
import {STORAGE_KEY} from '../../src/model.js';
import {META_KEY,ScheduleStore} from '../../src/storage.js';
const wait=async condition=>{for(let i=0;i<200;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('UI wait timed out');};
const buttons=()=>[...document.querySelectorAll('button')];
const action=label=>{const button=buttons().find(node=>node.textContent.trim()===label);if(!button||button.disabled)throw Error('Action unavailable');button.click();};
let passed=0,step='start';
const verify=condition=>{if(!condition)throw Error('Integration assertion failed');passed++;};
try{
  await wait(()=>!document.querySelector('#add').disabled);
  const continuation=sessionStorage.getItem('phase2-reload-check');
  if(continuation){
    const saved=JSON.parse(continuation);passed=saved.passed;
    verify(JSON.parse(localStorage.getItem(STORAGE_KEY)).history.length===saved.history);
    verify(!document.querySelector('#add').disabled);
    verify(!document.querySelector('svg')&&!globalThis.phase2Executed);
    verify(!document.querySelector('#upgrade-notice'));
    document.body.dataset.phase2Result='passed:'+passed;
  }else{
  verify(!!navigator.locks?.request);
  const initial=JSON.parse(localStorage.getItem(STORAGE_KEY));
  verify(!document.querySelector('.backup-reminder'));
  verify(!!document.querySelector('#upgrade-notice'));
  document.querySelector('[data-view="someday"]').click();verify(!!document.querySelector('#upgrade-notice'));action('‹ ホームに戻る');
  verify(document.querySelector('#upgrade-confirm').disabled);
  document.querySelector('#upgrade-checked').click();action('確認を記録して案内を閉じる');await wait(()=>!document.querySelector('#upgrade-notice'));
  verify(!document.querySelector('#upgrade-notice'));
  // Real form submission must wait for the asynchronous storage result.
  document.querySelector('#add').click();
  const form=document.querySelector('#entry-form');form.elements.title.value='架空ブラウザ登録';form.requestSubmit();
  await wait(()=>!document.querySelector('#editor').open);
  verify(JSON.parse(localStorage.getItem(STORAGE_KEY)).items.length===initial.items.length+1);
  verify(document.querySelector('#notice').textContent==='保存しました');
  const entry=JSON.parse(localStorage.getItem(STORAGE_KEY)).items.find(item=>item.title==='架空ブラウザ登録');
  document.querySelector(`[data-edit="${entry.id}"]`).click();
  const edit=document.querySelector('#entry-form');edit.elements.title.value='架空ブラウザ編集';edit.requestSubmit();
  await wait(()=>!document.querySelector('#editor').open);
  verify(JSON.parse(localStorage.getItem(STORAGE_KEY)).items.find(item=>item.id===entry.id).title==='架空ブラウザ編集');
  document.querySelector(`[data-edit="${entry.id}"]`).click();action('この項目を削除');
  await wait(()=>document.querySelector('#delete-confirm').open);action('キャンセル');
  await wait(()=>!document.querySelector('#delete-confirm').open);verify(JSON.parse(localStorage.getItem(STORAGE_KEY)).items.some(item=>item.id===entry.id));
  action('この項目を削除');await wait(()=>document.querySelector('#delete-confirm').open);action('削除する');
  await wait(()=>!document.querySelector('#editor').open);verify(!JSON.parse(localStorage.getItem(STORAGE_KEY)).items.some(item=>item.id===entry.id));
  document.querySelector('[data-complete]').click();await wait(()=>JSON.parse(localStorage.getItem(STORAGE_KEY)).history.length===1);
  verify(document.querySelector('#notice').textContent==='タスクを完了しました');
  action('✓ 完了したタスクを見る');document.querySelector('[data-restore]').click();
  await wait(()=>JSON.parse(localStorage.getItem(STORAGE_KEY)).history[0].restoredAt);
  verify(JSON.parse(localStorage.getItem(STORAGE_KEY)).items.length===initial.items.length);action('‹ ホームに戻る');
  // Exercise real browser Web Locks, not the deterministic unit-test lock fake.
  const a=new ScheduleStore({storage:localStorage,locks:navigator.locks}),b=new ScheduleStore({storage:localStorage,locks:navigator.locks});
  await a.refresh();await b.refresh();const concurrent=await Promise.all([a.mutate(d=>{d.items[0].title='架空の競合A';}),b.mutate(d=>{d.items[0].title='架空の競合B';})]);
  verify(concurrent.filter(result=>result.ok).length===1);verify(concurrent.some(result=>result.reason==='conflict'));
  window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));await wait(()=>document.body.textContent.includes('架空の競合A')||document.body.textContent.includes('架空の競合B'));
  action('バックアップ・復元');action('保存済みデータのJSONを準備');
  await wait(()=>buttons().some(b=>b.textContent==='このJSONファイルを保存できました'&&!b.disabled));
  verify(JSON.parse(localStorage.getItem(META_KEY)).confirmed===null);
  verify(buttons().some(b=>b.textContent==='ダウンロードで保存'&&!b.disabled));
  action('このJSONファイルを保存できました');await wait(()=>JSON.parse(localStorage.getItem(META_KEY)).confirmed);
  const receipt=localStorage.getItem(META_KEY);
  const data=JSON.parse(localStorage.getItem(STORAGE_KEY));
  data.history.push({id:'browser-legacy',title:'架空の古い履歴',due:null,completedAt:'2000-01-01T00:00:00Z'});
  data.items[0].title='<svg onload="globalThis.phase2Executed=true">';
  const expectedHistory=data.history.length;
  const artifact=await createBackup(data);verify((await readBackupFile(artifact.file)).data.history.length===expectedHistory);
  async function select(file){
    const chooser=document.querySelector('#backup-file'),transfer=new DataTransfer();transfer.items.add(file);chooser.files=transfer.files;chooser.dispatchEvent(new Event('change',{bubbles:true}));
    await wait(()=>document.querySelector('#replace-ack'));
  }
  async function captureQuarantine(){
    let file;const originalURL=URL.createObjectURL,originalClick=HTMLAnchorElement.prototype.click;
    URL.createObjectURL=value=>{file=value;return originalURL(value);};HTMLAnchorElement.prototype.click=function(){};
    try{
      const section=[...document.querySelectorAll('.file-actions')].find(node=>node.textContent.includes('.bin'));
      [...section.querySelectorAll('button')].find(node=>node.textContent==='ダウンロードで保存').click();
    }finally{URL.createObjectURL=originalURL;HTMLAnchorElement.prototype.click=originalClick;}
    const units=new Uint8Array(await file.arrayBuffer());let text='';for(let i=0;i<units.length;i+=2)text+=String.fromCharCode(units[i]|units[i+1]<<8);
    return {file,text};
  }
  const binReady=()=>[...document.querySelectorAll('.file-actions')].some(node=>node.textContent.includes('.bin')&&[...node.querySelectorAll('button')].some(button=>button.textContent==='ダウンロードで保存'&&!button.disabled));
  step='normal-select';await select(artifact.file);
  verify(buttons().find(b=>b.textContent==='現在データを置き換える').disabled);
  const before=localStorage.getItem(STORAGE_KEY);action('復元をキャンセル');verify(localStorage.getItem(STORAGE_KEY)===before);
  await select(artifact.file);const ack=document.querySelector('#replace-ack');ack.click();action('現在データを置き換える');
  await wait(()=>JSON.parse(localStorage.getItem(STORAGE_KEY)).history.length===expectedHistory&&!document.querySelector('#replace-ack'));
  verify(!document.querySelector('svg'));verify(!globalThis.phase2Executed);verify(localStorage.getItem(META_KEY)===receipt);
  // Corruption is test-owned, only within this unique temporary origin.
  action('閉じる');localStorage.setItem(STORAGE_KEY,'{browser-corrupt');
  window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY,newValue:'a delayed value'}));
  await wait(()=>document.querySelector('#add').disabled);action('バックアップ・復元');
  verify(document.querySelector('#backup-panel').textContent.includes('破損・検証エラー'));
  step='emergency-select';await select(artifact.file);step='emergency-acknowledgments';
  document.querySelector('#replace-ack').click();document.querySelector('#loss-ack').click();
  verify(buttons().find(b=>b.textContent==='このバックアップで復旧する').disabled);
  document.querySelector('#skip-ack').click();step='emergency-commit';action('このバックアップで復旧する');
  await wait(()=>localStorage.getItem(STORAGE_KEY)!=='{browser-corrupt'&&!document.querySelector('#replace-ack'));
  verify(JSON.parse(localStorage.getItem(STORAGE_KEY)).history.length===expectedHistory);
  verify(!document.querySelector('#add').disabled);
  step='new-corruption-after-success';action('閉じる');const afterSuccessB='{browser-B-after-success';localStorage.setItem(STORAGE_KEY,afterSuccessB);
  window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));await wait(()=>document.querySelector('#add').disabled);action('バックアップ・復元');
  action('現在の破損データの退避ファイルを準備');await wait(binReady);
  const currentB=await captureQuarantine();verify(currentB.text===afterSuccessB);verify(currentB.file.name.includes('current'));verify(!document.querySelector('.retained-targets'));
  // Simulate one failed verification read on this isolated origin, then let
  // later reads succeed. Neither visibility nor backup may unlock the page.
  step='unverified-recovery';action('閉じる');const originalRaw='{browser-original-corrupt\ud800';localStorage.setItem(STORAGE_KEY,originalRaw);
  window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));await new Promise(resolve=>setTimeout(resolve,100));await wait(()=>document.querySelector('#add').disabled);action('バックアップ・復元');await select(artifact.file);
  const originalGet=Storage.prototype.getItem,originalSet=Storage.prototype.setItem;let failNext=false,dataWrites=0;
  Storage.prototype.setItem=function(key,value){const result=originalSet.call(this,key,value);if(key===STORAGE_KEY){dataWrites++;failNext=true;}return result;};
  Storage.prototype.getItem=function(key){if(key===STORAGE_KEY&&failNext){failNext=false;throw Error('test verification failure');}return originalGet.call(this,key);};
  for(const id of ['replace-ack','loss-ack','skip-ack'])document.querySelector('#'+id).click();action('このバックアップで復旧する');
  await wait(()=>document.querySelector('.recovery-protection'));
  verify(document.querySelector('#add').disabled);verify(document.querySelector('#notice').textContent.includes('不確定'));
  document.dispatchEvent(new Event('visibilitychange'));await new Promise(resolve=>setTimeout(resolve,100));
  verify(document.querySelector('#add').disabled);verify(!!document.querySelector('.recovery-protection'));
  action('保存済みデータのJSONを準備');await wait(()=>buttons().some(b=>b.textContent==='このJSONファイルを保存できました'&&!b.disabled));
  verify(document.querySelector('#add').disabled);verify(!!document.querySelector('.recovery-protection'));verify(dataWrites===1);
  document.querySelector('[data-retained-id]').click();await wait(binReady);
  const retained=await captureQuarantine();verify(retained.text===originalRaw);verify(document.querySelector('.recovery-protection').textContent.includes('再読み込み'));verify(dataWrites===1);
  verify(buttons().find(b=>b.textContent==='このバックアップで復旧する').disabled);
  step='distinct-current-and-protected';const protectedB='{browser-B-while-protected';originalSet.call(localStorage,STORAGE_KEY,protectedB);
  window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));await new Promise(resolve=>setTimeout(resolve,100));
  action('現在の破損データの退避ファイルを準備');await wait(binReady);const observedB=await captureQuarantine();
  verify(observedB.text===protectedB);verify(document.querySelector('#add').disabled);verify(!!document.querySelector('.recovery-protection'));
  document.querySelector('[data-retained-id]').click();await wait(binReady);const historicalA=await captureQuarantine();
  verify(historicalA.text===originalRaw);verify(historicalA.file.name.includes('retained'));verify(dataWrites===1);
  // Simulate a cooperating external recovery before the explicit page reload;
  // even this must not clear the old page's uncertainty latch.
  originalSet.call(localStorage,STORAGE_KEY,JSON.stringify(artifact.data));window.dispatchEvent(new StorageEvent('storage',{key:STORAGE_KEY}));
  await new Promise(resolve=>setTimeout(resolve,100));verify(document.querySelector('#add').disabled);
  Storage.prototype.getItem=originalGet;Storage.prototype.setItem=originalSet;
  step='reload';sessionStorage.setItem('phase2-reload-check',JSON.stringify({passed,history:expectedHistory}));location.reload();
  }
}catch{
  // No backup, raw data, exception values or filenames are logged.
  document.body.dataset.phase2Result='failed:'+passed;
  document.body.dataset.phase2Step=step;
}
