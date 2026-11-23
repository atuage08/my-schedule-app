// Release policy is a source constant, never controlled by a URL or storage.
export const NOTIFICATIONS_ENABLED=false;
export const NOTIFICATION_DISABLED_MESSAGE='基本機能先行版では通知連携を停止しています';
export const PROTECTED_ITEM_MESSAGE='通知情報付きの既存項目は保護中です。基本機能先行版では閲覧・バックアップのみ利用できます。Apple側の通知は変更しません';
const protectedError=()=>Object.assign(Error(PROTECTED_ITEM_MESSAGE),{code:'notification-protected'});
export function requireNotifications(){if(!NOTIFICATIONS_ENABLED)throw Error(NOTIFICATION_DISABLED_MESSAGE);}
export function isProtectedItem(state,item){
  if(NOTIFICATIONS_ENABLED||!item)return false;
  return Object.hasOwn(item,'notification')||!!state.notificationLink?.records.some(r=>r.itemId===item.id)||!!state.notificationLink?.legacyRemovals.some(r=>r.itemId===item.id);
}
export function assertBasicMutation(before,after){
  if(NOTIFICATIONS_ENABLED)return;
  if(before.version!==after.version||JSON.stringify(before.notificationLink)!==JSON.stringify(after.notificationLink))throw protectedError();
  const previous=new Map(before.items.map(item=>[item.id,item])),next=new Map(after.items.map(item=>[item.id,item]));
  for(const item of before.items)if(isProtectedItem(before,item)&&JSON.stringify(item)!==JSON.stringify(next.get(item.id)))throw protectedError();
  for(const item of after.items)if((!previous.has(item.id)&&isProtectedItem(before,item))||(Object.hasOwn(item,'notification')&&!Object.hasOwn(previous.get(item.id)||{},'notification')))throw protectedError();
}
