import assert from 'node:assert/strict';

// Run with the documented browser-use tab API. Only UI actions and DOM reads are used.
// Creates uniquely named fictional records; it never clears storage or touches other apps.
export async function runBrowserSmoke(tab) {
  const url=new URL(await tab.url());
  assert.equal(url.hostname,'127.0.0.1','Use the desktop-only test preview');
  const page=tab.playwright, checks=[];
  const verify=(label,condition)=>{assert.ok(condition,label);checks.push(label);};
  const button=name=>page.getByRole('button',{name,exact:true});
  const editor=page.locator('#editor');
  const title=`架空ブラウザ試験-${Date.now()}`;
  const cards=name=>page.locator('.event').filter({hasText:name});
  const open=async()=>{await button('＋ 追加').click();};
  const details=async()=>{await editor.locator('summary').click();};
  const confirm=page.locator('#delete-confirm');
  const confirmDelete=async(scopeText,cancel=false,exceptionCount=null)=>{
    await button('この項目を削除').click();
    verify(`削除確認の範囲：${scopeText}`,(await confirm.innerText({})).includes(scopeText));
    if(exceptionCount!==null)verify('確認画面に関連する例外の件数を表示',(await confirm.innerText({})).includes(`関連する例外予定 ${exceptionCount} 件`));
    await confirm.getByRole('button',{name:cancel?'キャンセル':'削除する',exact:true}).click();
  };
  if(await button('‹ ホームに戻る').count())await button('‹ ホームに戻る').click();
  await button('今日へ ↗').click();await open();
  await editor.getByPlaceholder('どんな予定？').fill(title);
  const date=await editor.getByLabel('開始日',{exact:true}).evaluate(el=>el.value);
  const hour=editor.getByLabel('開始時（24時間）',{exact:true});
  verify('時が数値入力',await hour.getAttribute('type')==='number');
  await hour.fill('24');await button('保存する ✓').click();
  verify('24時を拒否して未保存',await editor.isVisible()&&await cards(title).count()===0);
  await hour.fill('0');await hour.press('Tab');
  await details();
  await editor.getByLabel('1分単位で入力',{exact:true}).check();
  await editor.getByLabel('開始分',{exact:true}).selectOption('07');
  verify('0時7分の入力と終了連動',await hour.evaluate(el=>el.value)==='0'&&await editor.getByLabel('終了時（24時間）',{exact:true}).evaluate(el=>el.value)==='1'&&await editor.getByLabel('終了分',{exact:true}).evaluate(el=>el.value)==='07');
  await editor.locator('select[name="repeat"]').selectOption('biweekly');
  await button('保存する ✓').click();verify('予定を登録',await cards(title).count()===1);
  const markerTask=title+'印';
  await open();await button('タスク').click();await editor.getByPlaceholder('やることをひとつ').fill(markerTask);
  await editor.locator('input[name="due"]').fill(date);await button('保存する ✓').click();
  const dayButton=page.locator(`[data-day="${date}"]`);
  const checkMarks=async(label)=>verify(label,await dayButton.locator('.event-mark').count()===1&&await dayButton.locator('.task-mark').count()===1&&(await dayButton.getAttribute('aria-label')).includes('期限付きタスクあり'));
  await checkMarks('週表示で丸と四角を両方表示');
  await page.locator('[data-mode="month"]').click();await checkMarks('月表示でも丸と四角を両方表示');
  await page.locator('[data-mode="week"]').click();
  verify('日付を残して凡例を表示',(await page.locator('.calendar-legend').innerText({})).includes('期限付きタスク'));
  await page.locator('.task-row').filter({hasText:markerTask}).locator('.item-title').click();await confirmDelete('この項目だけ');
  await cards(title).click();await editor.getByPlaceholder('どんな予定？').fill(title+'編集');
  await button('変更を保存 ✓').click();verify('今回だけの編集',await cards(title+'編集').count()===1);
  await cards(title+'編集').click();verify('例外の削除範囲は今回だけが初期値',await editor.locator('select[name="deleteScope"]').evaluate(el=>el.value)==='one');await button('閉じる').click();
  await button('次の週').click();await button('次の週').click();
  verify('2週間後の元の回を維持',await cards(title).count()===1);
  await cards(title).click();await confirmDelete('今回だけ',true);
  verify('削除キャンセルで編集を維持',await editor.isVisible());
  await confirmDelete('今回だけ');verify('今回だけを削除',await cards(title).count()===0);
  await button('次の週').click();await button('次の週').click();
  verify('次の2週間後の回は残る',await cards(title).count()===1);
  await cards(title).click();await editor.locator('select[name="scope"]').selectOption('all');
  await confirmDelete('シリーズ全体',false,1);verify('シリーズ全体を削除',await cards(title).count()===0);
  await button('今日へ ↗').click();verify('全体削除で今回だけ編集した例外も消える',await cards(title+'編集').count()===0);

  const taskTitle=title+'タスク';
  await open();await button('タスク').click();await editor.getByPlaceholder('やることをひとつ').fill(taskTitle);
  await editor.locator('input[name="due"]').fill(date);await details();
  await editor.locator('select[name="repeat"]').selectOption('daily');await button('保存する ✓').click();
  await button(taskTitle+'を完了').click();verify('繰り返しの未完了は1件',await page.locator('.task-row').filter({hasText:taskTitle}).count()===1);
  await button('✓ 完了したタスクを見る').click();
  const history=page.locator('.history-row').filter({hasText:taskTitle});
  await history.getByRole('button',{name:'未完了に戻す',exact:true}).click();
  verify('履歴を残して完了を取り消す',(await history.innerText({})).includes('完了取り消し済み'));
  verify('二重復元ボタンがない',await history.getByRole('button',{name:'未完了に戻す',exact:true}).count()===0);
  await button('‹ ホームに戻る').click();
  const taskCard=page.locator('.task-row').filter({hasText:taskTitle});
  verify('復元後も未完了は1件',await taskCard.count()===1);
  await taskCard.locator('.item-title').click();await editor.locator('select[name="scope"]').selectOption('all');await confirmDelete('シリーズ全体');

  const singleTitle=title+'期限なし';
  await open();await button('タスク').click();await editor.getByPlaceholder('やることをひとつ').fill(singleTitle);await button('保存する ✓').click();
  await page.locator('[data-view="someday"]').click();await button(singleTitle+'を完了').click();
  await button('‹ ホームに戻る').click();await button('✓ 完了したタスクを見る').click();
  await page.locator('.history-row').filter({hasText:singleTitle}).getByRole('button',{name:'未完了に戻す',exact:true}).click();
  await button('‹ ホームに戻る').click();await page.locator('[data-view="someday"]').click();
  verify('期限なしタスクを復元',await button(singleTitle).count()===1);
  await button(singleTitle).click();await confirmDelete('この項目だけ');await button('‹ ホームに戻る').click();
  await page.locator('[data-view="due"]').click();
  verify('全件一覧は4グループ',JSON.stringify(await page.locator('.tasks h3').allTextContents({}))===JSON.stringify(['期限超過','今日','今後7日以内','それ以降']));
  await button('‹ ホームに戻る').click();
  return {passed:checks.length,checks};
}
