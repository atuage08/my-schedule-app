import assert from 'node:assert/strict';

// UI-only regression for js/xss-through-dom. No direct storage mutation, eval, or HTML sinks.
export async function runBrowserSecurity(tab){
  assert.equal(new URL(await tab.url()).hostname,'127.0.0.1');
  const page=tab.playwright,editor=page.locator('#editor'),results=[];
  const button=name=>page.getByRole('button',{name,exact:true});
  const payloads=['<img src=x onerror="alert(1)">','</input><svg onload="alert(1)">','&lt;script&gt;alert(1)&lt;/script&gt;','" autofocus onfocus="alert(1)" x="',"日本語 & < > \" ' 文字"];
  const verify=async(label)=>{
    assert.equal(await page.locator('#app img,#app svg,#app script,#app iframe,#editor img,#editor svg,#editor script,#editor iframe,#delete-confirm img,#delete-confirm svg,#delete-confirm script').count(),0,label);
    assert.equal(await editor.locator('[autofocus],[onfocus],[onerror],[onload]').count(),0,label);
    results.push(label);
  };
  if(await button('‹ ホームに戻る').count())await button('‹ ホームに戻る').click();
  await button('今日へ ↗').click();
  for(let i=0;i<payloads.length;i++){
    const title=`架空安全試験${Date.now()}-${i} `+payloads[i];
    await button('＋ 追加').click();await editor.getByPlaceholder('どんな予定？').fill(title);
    // This roundtrip used to interpolate DOM/FormData content back into markup.
    await editor.getByLabel('終日',{exact:true}).check();
    assert.equal(await editor.locator('input[name="title"]').evaluate(el=>el.value),title);
    await verify('終日切替でDOM文字列をそのまま維持 '+i);
    await button('タスク').click();assert.equal(await editor.locator('input[name="title"]').evaluate(el=>el.value),title);
    await verify('予定・タスク切替でHTMLを生成しない '+i);
    await button('保存する ✓').click();
    await page.locator('[data-view="someday"]').click();
    await page.getByLabel('いつかやるを検索',{exact:true}).fill(payloads[i]);
    assert.equal(await page.getByLabel('いつかやるを検索',{exact:true}).evaluate(el=>el.value),payloads[i]);
    await verify('検索の再描画で特殊文字をそのまま維持 '+i);
    await button(title).click();assert.equal(await editor.locator('input[name="title"]').evaluate(el=>el.value),title);
    await verify('保存データの編集でHTMLを生成しない '+i);
    await button('この項目を削除').click();
    assert.ok((await page.locator('#delete-confirm').innerText({})).includes(title));
    await verify('削除確認で名称を文字列として表示 '+i);
    await page.locator('#delete-confirm').getByRole('button',{name:'削除する',exact:true}).click();
    await button('‹ ホームに戻る').click();
  }
  return {passed:results.length,checks:results};
}
