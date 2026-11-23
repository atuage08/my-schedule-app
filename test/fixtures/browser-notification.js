// Runs only in the disposable loopback test origin/profile.
import {seed,STORAGE_KEY,stamp} from '../../src/model.js';
import {CONNECTION_ITEM_ID,CONNECTION_TITLE,CONNECTION_INITIAL_MEMO,RESULT_PREFIX} from '../../src/notification-connection.js';
import {V3_LIST} from '../../src/notification-v3.js';
const wait=async condition=>{for(let i=0;i<200;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('UI wait timed out');};
let checks=0;
const verify=condition=>{if(!condition)throw Error('Notification UI assertion '+(checks+1)+' failed');checks++;};
try{
  localStorage.setItem(STORAGE_KEY,JSON.stringify(seed()));
  await import('../../src/app.js');await wait(()=>!document.querySelector('#add').disabled);
  const backup=document.querySelector('#backup-open'),history=document.querySelector('.history-link');
  verify(document.querySelectorAll('#backup-open').length===1);
  verify(backup.getBoundingClientRect().top>history.getBoundingClientRect().bottom);
  for(const button of [backup,history]){const style=getComputedStyle(button);verify(button.getBoundingClientRect().height>=48);verify(style.borderTopStyle==='solid'&&style.backgroundColor!=='rgba(0, 0, 0, 0)');}
  document.querySelector('#add').click();let form=document.querySelector('#entry-form');
  form.elements.title.value='架空・解除連携UI試験';
  document.querySelector('#event-notify-enabled').click();
  document.querySelector('#event-notify-at').value=stamp(new Date(Date.now()+3600000));form.requestSubmit();
  await wait(()=>document.querySelector('#event-shortcut')&&JSON.parse(localStorage.getItem(STORAGE_KEY)).version===3);
  let link=document.querySelector('#event-shortcut');verify(link.disabled&&getComputedStyle(link).backgroundColor==='rgb(232, 235, 228)');verify(link.getBoundingClientRect().height>=48);
  const id=JSON.parse(localStorage.getItem(STORAGE_KEY)).items.find(item=>item.title==='架空・解除連携UI試験').id;
  document.querySelector('#event-notify-enabled').click();document.querySelector('#entry-form').requestSubmit();
  await wait(()=>JSON.parse(localStorage.getItem(STORAGE_KEY)).notificationLink.records[0].desired.enabled===false);await wait(()=>!document.querySelector('#editor').open);
  const entries=JSON.parse(localStorage.getItem(STORAGE_KEY)).notificationLink.records;
  verify(entries.length===1&&entries[0].itemId===id&&entries[0].pending.operation==='deactivate');
  verify(JSON.parse(localStorage.getItem(STORAGE_KEY)).notificationLink.mode==='review');
  const card=[...document.querySelectorAll('.event')].find(node=>node.textContent.includes('架空・解除連携UI試験'));card.click();
  link=document.querySelector('#event-shortcut');verify(link.disabled);verify(getComputedStyle(link).backgroundColor==='rgb(232, 235, 228)');verify(link.getBoundingClientRect().height>=48);
  document.querySelector('#event-notify-enabled').click();document.querySelector('#event-notify-at').value=stamp(new Date(Date.now()+7200000));document.querySelector('#entry-form').requestSubmit();
  await wait(()=>JSON.parse(localStorage.getItem(STORAGE_KEY)).notificationLink.records[0].desired.enabled===true);
  verify(JSON.parse(localStorage.getItem(STORAGE_KEY)).notificationLink.records[0].itemId===id);
  verify(document.querySelector('#event-shortcut').disabled);
  document.querySelector('#event-notify-enabled').click();document.querySelector('#entry-form').requestSubmit();await wait(()=>!document.querySelector('#editor').open);
  // Deletion retains the same notification record after the item disappears.
  card.click();document.querySelector('#delete').click();await wait(()=>document.querySelector('#delete-confirm').open);
  document.querySelector('#delete-confirm button[value="delete"]').click();
  await wait(()=>!JSON.parse(localStorage.getItem(STORAGE_KEY)).items.some(item=>item.id===id));
  verify(JSON.parse(localStorage.getItem(STORAGE_KEY)).notificationLink.records.some(entry=>entry.itemId===id&&!entry.desired.enabled&&entry.pending.operation==='deactivate'));
  verify(JSON.parse(localStorage.getItem(STORAGE_KEY)).notificationLink.records.every(entry=>entry.status==='unverified'));
  verify(document.querySelector('#backup-open').getBoundingClientRect().top>document.querySelector('.history-link').getBoundingClientRect().bottom);
  document.querySelector('.removal-panel details').open=true;
  // App-side connection flow only. No real shortcut or external navigation.
  document.body.dataset.phase2Step='connection-open';document.querySelector('#connection-test-open').click();
  const panel=document.querySelector('#connection-panel');
  const click=text=>{const button=[...panel.querySelectorAll('button')].find(node=>node.textContent===text);if(!button||button.disabled)throw Error('Unavailable connection action');button.click();};
  panel.querySelector('input[type=checkbox]').click();click('架空の接続試験予定を追加');
  const record=()=>JSON.parse(localStorage.getItem(STORAGE_KEY)).notificationLink.records.find(r=>r.itemId===CONNECTION_ITEM_ID);
  await wait(()=>!!record());click('初回・再接続の照合依頼を準備');await wait(()=>!!panel.querySelector('textarea[aria-label="照合依頼JSON"]'));
  const request=JSON.parse(panel.querySelector('textarea[aria-label="照合依頼JSON"]').value);
  verify(!![...panel.querySelectorAll('button')].find(node=>node.textContent==='保存した照合依頼でショートカットを開く'&&!node.disabled));
  verify(JSON.parse(panel.querySelector('textarea[aria-label="接続試験用初期メモ"]').value).previousGenerationId===CONNECTION_INITIAL_MEMO.previousGenerationId);
  const inspection={format:'my-schedule-notification-result',formatVersion:1,kind:'inspection',itemId:CONNECTION_ITEM_ID,operationId:request.operationId,operation:'inspect',expectedGenerationId:null,generationId:'browser-bootstrap-gen',outcome:'observed',observed:{listName:V3_LIST,title:CONNECTION_TITLE,notifyAt:null,completed:true,state:'inactive',phase:'confirmed',pending:null,generationId:'browser-bootstrap-gen',previousGenerationId:null,operationId:'browser-bootstrap-op'}};
  const paste=text=>{const input=panel.querySelector('textarea[aria-label="読み戻し結果JSON"]');input.value=text;input.dispatchEvent(new Event('input'));};
  document.body.dataset.phase2Step='inspection-apply';paste(JSON.stringify(inspection));panel.querySelectorAll('input[type=checkbox]')[1].click();click('結果JSONを検証して保存');await wait(()=>record().status==='inactive');verify(record().pending===null);click('閉じる');
  [...document.querySelectorAll('.event')].find(node=>node.textContent.includes(CONNECTION_TITLE)).click();document.querySelector('#event-notify-enabled').click();document.querySelector('#event-notify-at').value=stamp(new Date(Date.now()+3600000));document.querySelector('#entry-form').requestSubmit();
  await wait(()=>record().desired.enabled);document.querySelector('#close').click();document.querySelector('#connection-test-open').click();click('送信する依頼を確定・保存');await wait(()=>record().pending?.status==='unknown');verify(!![...panel.querySelectorAll('button')].find(node=>node.textContent==='保存した依頼でショートカットを開く'));
  document.body.dataset.phase2Step='dispatch-prepared';const pending=record().pending;
  click('変更後の反映確認を準備');await wait(()=>!![...panel.querySelectorAll('button')].find(node=>node.textContent==='読み取り専用で反映を確認する'));
  verify(JSON.parse(panel.querySelector('textarea[aria-label="照合依頼JSON"]').value).purpose==='verification');
  const result={format:'my-schedule-notification-readback',formatVersion:1,purpose:'verification',itemId:CONNECTION_ITEM_ID,operationId:pending.operationId,reminder:{listName:V3_LIST,title:CONNECTION_TITLE,notifyAtText:pending.notifyAt,completed:false,notesText:JSON.stringify({app:'my-schedule',metadataVersion:2,itemId:CONNECTION_ITEM_ID,generationId:pending.generationId,previousGenerationId:pending.expectedGenerationId,operationId:pending.operationId,state:'active',phase:'confirmed',pending:null})}};
  document.body.dataset.phase2Step='result-fragment';window.location.hash=RESULT_PREFIX+encodeURIComponent(JSON.stringify(result));await wait(()=>panel.textContent.includes('変更後の読み戻し報告を受信'));
  verify(record().pending?.status==='unknown');verify(window.location.hash.startsWith(RESULT_PREFIX));
  panel.querySelectorAll('input[type=checkbox]')[1].click();click('結果JSONを検証して保存');await wait(()=>record().pending===null);await wait(()=>window.location.hash==='');verify(record().generationId===pending.generationId);verify(![...panel.querySelectorAll('button')].some(node=>node.textContent==='保存した依頼でショートカットを開く'));verify(panel.getBoundingClientRect().width<=document.documentElement.clientWidth);
  click('閉じる');
  document.body.dataset.phase2Result='passed:'+checks;
}catch{document.body.dataset.phase2Result='failed:'+checks;}
