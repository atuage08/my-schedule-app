import {createDom} from './dom.js';
import {readBackupFile,counts} from './backup.js';

export function createBackupUI({store,onChange,notify}){
  const {h,replace}=createDom(document);
  const dialog=document.createElement('dialog');dialog.id='backup-panel';dialog.setAttribute('aria-labelledby','backup-title');document.body.append(dialog);
  let artifact=null,quarantine=null,quarantineSaved=false,preview=null,validatedSource=null,message='',busy=false,generation=0;
  const button=(label,action,disabled=false)=>{const node=h('button',{type:'button',disabled},label);node.onclick=action;return node;};
  const hint=text=>h('p',{class:'hint'},text);
  const describe=data=>{const c=counts(data);return `予定 ${c.events}件・タスク ${c.tasks}件・全完了履歴 ${c.history}件`;};
  const safeError=cause=>cause?.code||cause?.reason?cause.message:'処理できませんでした。ファイル・保存設定を確認してください';
  async function work(action){
    if(busy)return;busy=true;draw();
    try{await action();}catch(cause){message=safeError(cause);}finally{busy=false;onChange();draw();}
  }
  function download(file){
    const url=URL.createObjectURL(file),anchor=document.createElement('a');
    anchor.href=url;anchor.download=file.name;document.body.append(anchor);
    try{anchor.click();}finally{anchor.remove();const timer=setTimeout(()=>URL.revokeObjectURL(url),60000);timer.unref?.();}
    message='ダウンロードを開始しました。ファイルの保存を確認してから、保存確認ボタンを押してください';draw();
  }
  function checkQuarantine(item,isQuarantine){
    if(!isQuarantine)return true;
    try{const verification=store.verifyQuarantine(item);if(quarantine===item)quarantine=Object.freeze({...item,...verification});return true;}
    catch(cause){message=safeError(cause);onChange();draw();return false;}
  }
  function fileActions(item,isQuarantine=false){
    const expiredCurrent=isQuarantine&&item.source==='current'&&item.targetId!==store.quarantineInfo().id;
    let shareable=false;try{shareable=!!navigator.canShare?.({files:[item.file]});}catch{/* Download stays available. */}
    return h('section',{class:'file-actions'},hint(item.file.name),
      isQuarantine&&hint((item.source==='current'?(expiredCurrent?'以前に準備したスナップショット（現在ではありません。保存操作は停止します）':'退避直前に照合した現在の破損スナップショット'):'過去の復旧直前の保持対象（現在の破損データではありません）')+`：${item.targetId}、取得 ${item.capturedAt}、照合 ${item.checkedAt}`),
      isQuarantine&&hint(item.source==='retained'?(item.currentMatch===null?'保存先を読めず現在との一致は確認できません。保持した取得時点の内容だけを出力します。':item.currentMatch?'準備時点では保存先と同じ内容でしたが、過去の保持対象として出力します。':'準備時点の保存先とは異なります。現在データとは別の保持対象です。'):'保存直前にも照合します。一致しない場合は保存を止めます。照合後の別画面の変更までは保証しません。'),
      button('共有して「ファイル」に保存',()=>{
        if(!checkQuarantine(item,isQuarantine))return;
        // No asynchronous preparation before this call: preserve user activation.
        let promise;try{promise=navigator.share({files:[item.file]});}catch{message='共有を開始できません。ダウンロードを利用してください';draw();return;}
        promise.then(()=>{message='共有先への受け渡しが終わりました。実際の保存を確認してください';draw();},cause=>{message=cause?.name==='AbortError'?'共有を中断しました。保存確認日時は更新していません':'共有できませんでした。ダウンロードを利用してください';draw();});
      },!shareable||busy),
      button('ダウンロードで保存',()=>{if(checkQuarantine(item,isQuarantine))download(item.file);},busy),
      button(isQuarantine?'この退避ファイルを保存できました':'このJSONファイルを保存できました',()=>work(async()=>{
        if(!checkQuarantine(item,isQuarantine))return;
        if(isQuarantine){quarantineSaved=true;message='この退避ファイルの保存確認を受け付けました';}
        else{const result=await store.confirmBackup(item);message=result.ok?'このファイルの保存確認日時を記録しました。準備後の変更は含まれません':result.message;}
      }),busy),
      hint('共有キャンセルやダウンロード開始だけでは、保存確認日時を更新しません。保存先はご自身で確認してください。'));
  }
  function draw(){
    const emergency=store.status!=='ready';
    const protectedOutcome=!!store.protection,current=store.quarantineInfo(),retained=store.retainedQuarantineInfo();
    const receipt=store.backupStatus();
    const chooser=h('input',{type:'file',accept:'.json,application/json',id:'backup-file',disabled:busy,'aria-label':'復元するJSONファイル'});
    chooser.onchange=()=>{
      const file=chooser.files?.[0];if(!file)return;
      const request=++generation,base=store.token();preview=null;validatedSource=null;message='検証しています';
      work(async()=>{
        const source=await readBackupFile(file);
        if(request!==generation||!dialog.open)return;
        validatedSource=source;
        if(!['ready','corrupt','missing'].includes(store.status)){message='JSONの検証に成功しましたが、現在の保存領域を確認できないため置き換えを停止しています';return;}
        preview=store.preview(source,base);message='検証に成功しました。置き換え内容を確認してください';
      });
    };
    const panels=[h('div',{class:'sheet-heading'},h('h2',{id:'backup-title'},'バックアップ・復元'),button('閉じる',()=>dialog.close(),busy)),
      hint('初回利用時は旧版のタブとホーム画面版をすべて閉じ、新版を開き直してください。旧版は同じロックに参加しません。'),
      hint('予定・タスクと90日より前を含む全完了履歴を扱います。JSONは平文です。アプリから外部送信しませんが、iCloud等の保存先では同期される場合があります。'),
      hint(receipt.kind==='confirmed'?'前回の明示的な保存確認：'+new Date(receipt.at).toLocaleString('ja-JP',{hour12:false}):receipt.kind==='unknown'?'保存確認記録がないか、確認できません。バックアップ済みとは判定していません。':'バックアップの保存確認はまだありません。'),
      h('p',{role:'status',class:'backup-status'},'保存状態：'+({ready:'正常',corrupt:'破損・検証エラー',missing:'保存キーがありません',unavailable:'保存領域を読み取れません',unverified:'書き込み後の確認が未完了'}[store.status]||'確認中')),
      button('保存先の状態だけを再確認',()=>work(async()=>{await store.refresh();message=store.protection?'現在の保存先を観測しましたが、保護停止は解除していません。現在スナップショットと過去の保持対象は別です':'保存先の状態を再確認しました。データは書き込んでいません';}),busy),
      protectedOutcome&&h('section',{class:'recovery-protection',role:'alert'},h('h3',{},'書き込み結果が不確定なため保護停止中です'),h('p',{},'保存先の読み取りやJSON準備に成功しても、復旧成功とは扱いません。この画面では編集・削除・完了・追加の復元を再開しません。'),h('p',{},retained.length?`復旧直前の過去の保持対象は ${retained.length}件です。下の「過去の保持対象」から退避してください。現在の破損スナップショットとは別に保持しています。`:'復旧直前の破損データの保持対象はありません。現在の破損スナップショットが確認できた場合だけ、その退避を準備できます。'),h('p',{},'退避対象はこのページのメモリーだけにあります。再読み込み・ページ終了・ブラウザの強制終了で失われます。先に.bin退避ファイルを保存してください。8MiB超は完全な退避ファイルを作れません。')),
      !store.locks?.request&&h('p',{class:'error'},'Web Locksを利用できないため、通常保存・復元・確認記録の書き込みを停止しています。正常データの閲覧・書き出しは可能です。'),
      button('保存済みデータのJSONを準備',()=>work(async()=>{artifact=await store.backup();message=store.protection?'現在読み取れた保存先のJSONを固定しました。復旧成功の確認ではなく、保護停止と元データの退避対象は維持しています':'保存済みスナップショットを固定しました。以後の変更はこのファイルに含まれません';}),busy),
      hint('未保存の入力・保存に失敗した繰り越しは含みません。自動繰り越し保存が未完了の場合は完了を待ってください。'),
      artifact&&h('section',{},h('h3',{},'準備済みJSON'),hint(describe(artifact.data)),fileActions(artifact)),
      h('section',{},h('h3',{},emergency?'緊急復旧':'JSONから全置換'),h('label',{},'バックアップファイルを選択',chooser),hint('UTF-8・8MiB以下。ファイル選択と検証だけでは現在データを変更しません。'),validatedSource&&hint('検証済みファイル：'+describe(validatedSource.data)))];
    if(emergency){
      panels.push(h('p',{class:'error'},protectedOutcome?'書き込みの成否は不確定です。追加の上書きや元データの自動復元はしません。保持中の退避対象を先に保存してください。':'通常の登録・編集・保存を停止しています。元データは削除・初期化していません。保存領域を読み取れない場合は、ファイル検証後も置き換えを実行できません。'),
        hint(current.available?`現在の破損スナップショット：${current.id}、取得 ${current.capturedAt}、UTF-16LE ${current.bytes}バイト。退避直前に保存先と照合します。`:'現在の破損データを確定できていません。準備できない場合は停止理由を表示します。過去の保持対象と混同しません。'),
        button('現在の破損データの退避ファイルを準備',()=>work(async()=>{quarantine=store.quarantine();quarantineSaved=false;message='現在の破損スナップショットを直前照合しました。信頼できない診断用ファイルで、通常のJSON復元には使用できません';}),busy));
    }
    if(retained.length)panels.push(h('section',{class:'retained-targets'},h('h3',{},'過去の保持対象（現在データとは別）'),hint('失敗・確認不能の復旧直前の文字列です。現在の保存先と異なる場合や読めない場合も、取得時点の対象としてのみ退避します。正常に復旧完了したらこの破損状態の保持を終了します。保持容量に達する追加の復旧は、古い対象を捨てずに停止します。'),retained.map(target=>{
      const node=button(`過去の保持対象を退避（${target.id}）`,()=>work(async()=>{quarantine=store.retainedQuarantine(target.id);quarantineSaved=false;message='過去の保持対象を準備しました。現在の破損データとしては扱いません';}),busy);
      node.setAttribute('data-retained-id',target.id);
      return h('div',{},hint(`${target.id}：取得 ${target.capturedAt}、${target.bytes}バイト、${target.reason==='unverified'?'書き込み結果が確認不能':'書き込み失敗'}`),node);
    })));
    if(quarantine)panels.push(fileActions(quarantine,true));
    if(preview){
      const stale=protectedOutcome||!store.matches(preview.base),plan=preview.plan;
      const ack=h('input',{type:'checkbox',id:'replace-ack',disabled:busy||stale});
      const loss=h('input',{type:'checkbox',id:'loss-ack',disabled:busy||stale});
      const quarantineOK=quarantineSaved&&quarantine?.source==='current'&&quarantine.targetId===current.id&&quarantine.raw===preview.base.raw;
      const skip=h('input',{type:'checkbox',id:'skip-ack',disabled:busy||stale});
      const submit=button(preview.emergency?'このバックアップで復旧する':'現在データを置き換える',()=>work(async()=>{
        const result=await store.restore(preview,{replace:ack.checked,emergency:loss.checked,quarantine:quarantineOK?'saved':skip.checked?'skip':null});
        if(result.ok){preview=null;quarantine=null;quarantineSaved=false;message='保存と読み戻し確認が完了しました。以前の破損状態を終了しました。バックアップ保存確認日時は更新していません';notify('復元と保存後の確認が完了しました');}
        else{if(result.preview)preview=result.preview;message=result.message;notify(result.message);}
        if(result.warning)message+='。'+result.warning;
      }),true);
      function enable(){submit.disabled=busy||stale||!store.locks?.request||!ack.checked||(preview.emergency&&(!loss.checked||(!quarantineOK&&!skip.checked)));}
      ack.onchange=loss.onchange=skip.onchange=enable;
      panels.push(h('section',{class:'restore-preview'},h('h3',{},'置き換え前の最終確認'),
        hint('バックアップ作成日時：'+preview.exportedAt),
        h('p',{},'現在：'+(store.state?describe(store.state):'確認不能')),
        h('p',{},'元バックアップ：'+describe(preview.sourceData)),h('p',{},'復元後の候補：'+describe(plan.candidate)),
        hint('繰り越し基準日：'+plan.day),
        h('p',{},`期限変更 ${plan.changes.filter(change=>change.after).length}件・次回がなく除かれるタスク ${plan.changes.filter(change=>!change.after).length}件`),
        plan.changes.map(change=>h('p',{class:'rollover-change'},change.title,h('br'),`${change.before} → ${change.after||'保存候補から除外'}：${change.reason}`)),
        h('p',{class:'error'},'予定・タスク・完了履歴をすべて置き換えます。マージはしません。このバックアップ以後の変更と履歴は残りません。履歴は期限削除しませんが、件数・容量上限があります。'),
        stale&&h('p',{class:'error'},'確認中に現在データが変わりました。ファイルを選び直してください。'),
        h('label',{class:'backup-check'},ack,' 現在データをすべて置き換えることを確認しました'),
        preview.emergency&&h('label',{class:'backup-check'},loss,' 元の破損データが失われる可能性を理解しました'),
        preview.emergency&&!quarantineOK&&h('label',{class:'backup-check'},skip,' 元データの退避を確認できていませんが続行します'),
        preview.emergency&&quarantineOK&&hint('この元データの退避ファイルについて保存確認を受け付けています。'),
        h('div',{class:'backup-bottom'},button('復元をキャンセル',()=>{preview=null;message='キャンセルしました。現在データは変更していません';draw();},busy),submit)));
    }
    panels.push(h('p',{role:'alert',class:'error'},message),hint('iOS 17以降を検証対象とします。Safariとホーム画面版はそれぞれ実機確認が必要です。閉じている間のOS通知は行いません。'));
    replace(dialog,h('div',{class:'backup-body'},panels));
  }
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  dialog.addEventListener('close',()=>{generation++;preview=null;});
  return {open(){draw();if(!dialog.open)dialog.showModal();},changed(){if(dialog.open)draw();}};
}
