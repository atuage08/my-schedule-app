import {requireNotifications} from './features.js';
// Test-origin transport. Fixture generation is isolated; saved-event preflight
// reads the saved baseline but never writes application state or storage.
import {newId,validateItem,STORAGE_KEY} from './model.js';

export const TEST_ORIGIN='https://my-schedule-test.pages.dev';
export const SHORTCUT_NAME='マイスケジュール通知連携テスト';
export const TEST_ITEM_ID='my-schedule-test-event-001';
const keys=['formatVersion','itemId','operationId','operation','title','notifyAt'];
export function validatePayload(value){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw Error('連携データの形式が不正です');
  if(value.formatVersion!==1||value.operation!=='upsert')throw Error('未対応の連携操作です');
  for(const key of ['itemId','operationId'])if(typeof value[key]!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value[key]))throw Error('連携IDが不正です');
  if(typeof value.title!=='string'||!value.title.trim()||value.title.length>160||/[\u0000-\u001f\u007f]/.test(value.title))throw Error('連携タイトルが不正です');
  if(typeof value.notifyAt!=='string'||!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value.notifyAt))throw Error('通知日時が不正です');
  const date=new Date(value.notifyAt);
  if(!Number.isFinite(date.getTime())||date.toISOString()!==value.notifyAt)throw Error('通知日時が不正です');
  return value;
}
export function createTestPayload(now=new Date(),cryptoApi=globalThis.crypto){
  requireNotifications();
  if(!Number.isFinite(now.getTime()))throw Error('現在時刻を確認できません');
  const notifyAt=new Date(Math.ceil((now.getTime()+10*60*1000)/60000)*60000).toISOString();
  return Object.freeze(validatePayload({formatVersion:1,itemId:TEST_ITEM_ID,operationId:newId(cryptoApi),operation:'upsert',title:'架空の予定：通知連携テスト',notifyAt}));
}
export function shortcutURL(payload){
  requireNotifications();
  const text=JSON.stringify(validatePayload(payload));
  return 'shortcuts://run-shortcut?name='+encodeURIComponent(SHORTCUT_NAME)+'&input=text&text='+encodeURIComponent(text);
}
export function eligibleEvent(item){
  return !!item&&item.type==='event'&&item.repeat==='none'&&item.eventSeriesId===undefined&&item.exceptionDate===undefined;
}
// Synchronous preflight keeps custom-scheme navigation in the user's click.
// No writes or awaits: the exact saved baseline must still be present.
export function savedEventURL({origin,store,base,item,confirmed,blocked=false,now=new Date(),cryptoApi=globalThis.crypto}){
  requireNotifications();
  if(origin!==TEST_ORIGIN||blocked||!confirmed||!store.writable||store.protection)throw Error('連携できません。保存状態と架空予定の確認を見直してください');
  if(!store.matches(base)||store.storage.getItem(STORAGE_KEY)!==base.raw)throw Error('保存データが変わりました。予定を開き直してください');
  const saved=store.state.items.find(value=>value.id===item?.id);
  if(!saved||JSON.stringify(saved)!==JSON.stringify(item)||!eligibleEvent(saved))throw Error('保存済みの通常予定だけを連携できます');
  validateItem(saved);
  if(!saved.notification?.enabled)throw Error('通知設定を保存してください');
  const date=new Date(saved.notification.notifyAt);
  if(!Number.isFinite(now.getTime())||date<=now)throw Error('通知日時は未来の日時にしてください');
  const payload=validatePayload({formatVersion:1,itemId:saved.id,operationId:newId(cryptoApi),operation:'upsert',title:saved.title,notifyAt:date.toISOString()});
  return shortcutURL(payload);
}
