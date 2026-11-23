import {NOTIFICATIONS_ENABLED,NOTIFICATION_DISABLED_MESSAGE} from './features.js';
import {createDom} from './dom.js';
import {NotificationConnection,CONNECTION_ITEM_ID,CONNECTION_TITLE,CONNECTION_INITIAL_MEMO,resultFromFragment,hasResultFragment,MAX_RESULT_BYTES,parseResult} from './notification-connection.js';
import {V3_ORIGIN} from './notification-v3.js';

export function createConnectionUI({store,onChange,notify}){
  if(!NOTIFICATIONS_ENABLED)return Object.freeze({open(){notify(NOTIFICATION_DISABLED_MESSAGE);},changed(){},async receiveLocation(){return {disabled:true};}});
  const {h,replace}=createDom(document),dialog=document.createElement('dialog');dialog.id='connection-panel';dialog.setAttribute('aria-label','架空データだけの通知接続試験');document.body.append(dialog);
  const connection=new NotificationConnection({store,origin:()=>window.location.origin});
  let busy=false,consent=false,inspectionConfirmed=false,ticket=null,buffer='',message='',requestText='',lastFragment='';
  const button=(text,action,disabled=false)=>{const node=h('button',{type:'button',disabled,class:'notification-button'},text);node.onclick=action;return node;};
  const hint=text=>h('p',{class:'hint'},text);
  function cleanupFragment(){
    if(!hasResultFragment(window.location.hash))return;
    // Remove only the result that was actually saved; never discard a newer URL.
    if(window.location.hash===lastFragment)try{history.replaceState(history.state,'',window.location.pathname+window.location.search);}catch{message+='。URLの除去は未完了です。再実行はしません';}
  }
  async function work(action){if(busy)return;busy=true;draw();try{await action();}catch(error){message=error.message||'接続試験を停止しました';}finally{busy=false;onChange();draw();}}
  async function applyResult(){
    ticket=null;
    const parsed=parseResult(buffer);
    const result=await connection.accept(buffer,{consent,inspectionConfirmed,verificationConfirmed:inspectionConfirmed});
    if(!result.ok){message=result.message||'結果を保存確認できません。結果URL・依頼を保持しています';return;}
    ticket=null;cleanupFragment();
    message=result.reported?(parsed.kind==='inspection'?'現在の世代・状態を照合しました。まだ通知依頼は送信していません':parsed.kind==='verification'?'変更後の読み戻し報告が保存済み依頼と一致しました。通知配信の保証ではありません':'ショートカットから反映確認の報告を受け保存しました。通知配信の保証ではありません'):'キャンセル・拒否・不明の報告です。結果不明の依頼を保持し、自動再送しません';
  }
  function draw(){
    const r=store.state?.notificationLink?.records.find(r=>r.itemId===CONNECTION_ITEM_ID);
    const permission=h('input',{type:'checkbox',checked:consent,disabled:busy});permission.onchange=()=>{consent=permission.checked;draw();};
    const inspected=h('input',{type:'checkbox',checked:inspectionConfirmed,disabled:busy});inspected.onchange=()=>{inspectionConfirmed=inspected.checked;};
    const input=h('textarea',{rows:5,maxlength:MAX_RESULT_BYTES,value:buffer,'aria-label':'読み戻し結果JSON',disabled:busy});input.oninput=()=>{buffer=input.value;inspectionConfirmed=false;inspected.checked=false;};
    replace(dialog,h('div',{class:'backup-body'},h('h2',{},'通知接続試験（架空データ限定）'),hint('通常の通知連携は未有効です。固定IDと固定タイトル以外は送れません。'),hint(CONNECTION_ITEM_ID+' ／ '+CONNECTION_TITLE),hint('保存先照合：'+(r?.pending?.operationId||'対応する保留依頼なし。別の保存領域では作成・移行しないでください。')),
      h('label',{class:'backup-check'},permission,' 架空データの接続試験であることを確認しました'),
      button('架空の接続試験予定を追加',()=>work(async()=>{const result=await connection.createFixture(consent);message=result.ok?'架空予定を追加しました。既存データは初期化していません':result.message;}),busy||!consent),
      button('初回・再接続の照合依頼を準備',()=>work(async()=>{ticket=null;inspectionConfirmed=false;const result=await connection.prepareInspection(consent);message=result.ok?'照合依頼を保存確認しました。次のボタンで1回だけ開けます。リマインダーは読み取りだけです':result.message;requestText=result.request?JSON.stringify(result.request):'';ticket=result.ticket||null;}),busy||!consent||!r||r.pending?.status==='unknown'),
      button('変更後の反映確認を準備',()=>work(async()=>{ticket=null;inspectionConfirmed=false;const result=await connection.prepareVerification(consent);message=result.ok?'保存済みの変更依頼を保持して読み取り確認を準備しました。変更命令は再送しません':result.message;requestText=result.request?JSON.stringify(result.request):'';ticket=result.ticket||null;}),busy||!consent||r?.pending?.status!=='unknown'||store.state?.notificationLink?.mode!=='ready'),
      h('details',{},h('summary',{},'新規の架空リマインダー用・正式初期メモ'),hint('既存のv3-test-event-001は変更しません。新しい対象1件だけに使用し、期限・時刻なし、完了済みにします。再初期化には使いません。'),h('textarea',{rows:6,value:JSON.stringify(CONNECTION_INITIAL_MEMO,null,2),readOnly:true,'aria-label':'接続試験用初期メモ'})),
      requestText&&h('textarea',{rows:4,value:requestText,'aria-label':'照合依頼JSON',readOnly:true}),
      hint('通常の予定編集画面で、この架空予定だけの通知ON/OFF・日時を保存してから送信依頼を準備してください。'),
      button('送信する依頼を確定・保存',()=>work(async()=>{const result=await connection.prepare(consent);ticket=result.ticket||null;message=result.ok?'依頼を保存確認しました。次のボタンで1回だけ開けます。開かず閉じても自動送信しません':result.message;}),busy||!consent||!r||r.pending?.status==='unknown'),
      ticket&&button(ticket.kind==='inspection'?'保存した照合依頼でショートカットを開く':ticket.kind==='verification'?'読み取り専用で反映を確認する':'保存した依頼でショートカットを開く',()=>{try{connection.launch(ticket,consent,url=>{window.location.href=url;});message=ticket.kind!=='operation'?'読み取り照合の起動を要求しました。結果は未確認です':'起動を要求しました。反映結果は未確認です';}catch(error){message=error.message;}ticket=null;draw();},busy||!consent),
      h('h3',{},'読み戻し結果を照合'),input,
      h('label',{class:'backup-check'},inspected,' 初回・再接続／変更後確認：実行中のShortcutsを終了し、直前に専用リストの実状態と確定メモを読み戻したことを確認しました'),
      button('結果JSONを検証して保存',()=>work(applyResult),busy||!consent),
      h('p',{role:'status'},message),hint('結果URL受信だけでは成功にしません。保存できない場合はURLを残します。再読み込みは送信を再開しません。'),button('閉じる',()=>dialog.close(),busy)));
  }
  return {
    open(){if(window.location.origin!==V3_ORIGIN){notify('テスト環境以外では接続試験できません');return;}draw();if(!dialog.open)dialog.showModal();},
    changed(){if(dialog.open)draw();},
    async receiveLocation(){
      const fragment=window.location.hash;
      if(!hasResultFragment(fragment)||fragment===lastFragment)return;
      if(busy)return;lastFragment=fragment;ticket=null;
      try{const decoded=resultFromFragment(fragment);buffer=decoded.text;
        if(window.location.origin!==V3_ORIGIN)throw Error('テスト環境以外からの結果は受け付けません');
        if(decoded.result.kind==='operation'){
          // A matching persisted, fixed-test unknown request is required below;
          // this is not consent to send or to create/initialize any data.
          busy=true;try{const result=await connection.accept(buffer,{consent:true});if(result.ok){cleanupFragment();message=result.reported?'反映確認の報告を保存しました（通知配信は別途確認）':'結果不明として保持しました';}else message=result.message;}finally{busy=false;}
        }else{inspectionConfirmed=false;message=decoded.result.kind==='verification'?'変更後の読み戻し報告を受信しました。未確定です。内容を確認し、チェックして取り込んでください':'初回・再接続の照合結果を受信しました。内容を確認し、チェックして取り込んでください';}
      }catch(error){message=error.message;}
      onChange();draw();if(!dialog.open)dialog.showModal();
    },
  };
}
