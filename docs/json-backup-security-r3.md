# JSONバックアップ 独立レビューP2対応（r3）

これはr3時点の記録です。追加レビューで見つかった退避対象の取り違えについては [r4対応](json-backup-security-r4.md) を参照してください。現在の退避API・状態遷移・検証結果はr4の記載を優先します。

2026年11月9日。C:\my-schedule-app、feature/json-backup-restoreで作業しました。前回の未コミット変更を保持して修正しています。HEADとmainは開始時・終了時とも6f64d00で、コミット・push・PR作成・マージ・Cloudflareデプロイは行っていません。karada-log-appは変更していません。

## 1. 確認不能後の保護停止と退避対象

旧版ではrefresh()とbackup()から_adopt()が呼ばれ、後の読み取りが成功するとstatusがreadyへ戻っていました。また退避対象の選択がstatusに依存していました。

修正版は、書き込み結果を確認できなかった状態をprotectionに保持し、元の破損文字列は独立したquarantineTargetに取得日時とともに固定します。復旧後の確認不能と通常保存後の確認不能も区別します。setItemが戻っただけでは保存先の状態を断定せず、読み戻し不能の結果はcommitted:null、verified:falseです。通常の保存例外はcommitted:falseと区別します。

- 同じページ内では、refresh・initialize・JSON準備・画面復帰・再描画で保護を解除しません。暗黙に解除するAPIは設けていません。
- _adopt自体にも保護チェックを置き、別の読み取り経路からも解除できないようにしました。
- 編集・削除・完了・取り消し・繰り越し・追加の復元を停止します。元データの自動書き戻しはしません。バックアップ保存確認の記録更新も停止します。
- 現在の保存先が正常に読み取れれば、そのスナップショットをJSONとして準備できますが、復旧成功の確認とは表示しません。元の破損文字列とは混同しません。
- 元の破損文字列を同じページでUTF-16LEの.binとして退避できます。取得日時とバイト数、8MiB上限、信頼できない診断用ファイルであることを表示します。
- メモリーだけの保持です。再読み込み・ページ終了・ブラウザの強制終了で失われるリスクを、ホームとバックアップ画面に明示しました。先に.binを保存するよう案内します。
- ページを明示的に読み直すと、新しいページは現在の保存先を検証しますが、元ページの退避対象は引き継げません。退避対象の永続化や、確認不能な保存先への追加上書きは行いません。

## 2. 旧版終了の案内

src/upgrade-notice.jsに、書き込み方式の版に対応した確認記録を追加しました。キーはmy-schedule.write-protocol-ack.v1です。予定・タスクやバックアップJSONには混ぜません。

未確認の場合、ホームだけでなく予定・タスク・履歴の通常画面でも案内を表示します。他の旧タブ・旧ホーム画面版を閉じて新版を開き直す説明、自己申告であり旧版との競合を完全に検出・防止できない説明、チェックと明示的な確認ボタンがあります。画面遷移・通常の再描画では消しません。チェックだけでも消えません。

確認は同じWeb Lock内で記録し、読み戻し確認後に閉じます。記録済みなら次回以降は繰り返し表示しません。記録の欠損・非対応値・読み書き失敗時は表示を維持します。別タブの記録変更はイベント値を採用せず読み直します。これは旧版の存在を検出する機能ではなく、旧版の非協調的な書き込みを完全に防ぐものではありません。

## 3. 独立レビューの6件の失敗

修正前の全181件をWindowsの制限付きサンドボックス、UTCで実行し、174成功・6失敗・1スキップを再現しました。6件すべてがテスト用リンク作成時のEPERM（errno -4048）でした。通常のWindows環境では同じリンク作成と安全性検証が成功します。独立レビュー環境そのものを操作した結果ではありませんが、報告と同じ件数・失敗箇所をローカルで再現できました。

| テスト名 | 失敗した準備操作 |
| --- | --- |
| real output junctions/symlinks outside the project stay rejected and untouched | 外部出力ジャンクションのsymlink作成 |
| an output link to another directory inside the project is also refused | 内部出力ジャンクションのsymlink作成 |
| hard links to an outside file are rejected without exposing its bytes | ハードリンクのlink作成 |
| parent directory links/junctions cannot escape the project | 親ディレクトリのジャンクション作成 |
| a project-root link is rejected rather than silently canonicalized outside | プロジェクトルートのジャンクション作成 |
| concurrent parent replacement never reads an outside source | ワーカー内の攻撃用ジャンクション作成 |

拒否されていたのはアプリのセキュリティ検証ではなく、検証用の攻撃環境を作る操作です。既存の1スキップはleaf file symlinkの作成権限によるものです。

test/fixtures/link-capability.jsを追加し、Windowsで実際の準備操作がEPERMまたはEACCESになった場合だけ、検証不能として理由付きスキップにします。成功件数に含めません。Linuxの権限エラー、EIO・ENOENT・EBUSY・EEXIST、製品コードの検査失敗、リンク削除・復元の失敗はスキップしません。

競合テストはワーカー起動前に同じfixture内でジャンクション作成能力を確認します。準備できた後のワーカーの失敗は引き続き失敗です。権限のある環境では本来の実リンク攻撃・拒否検証をすべて実行します。MY_SCHEDULE_REQUIRE_LINKS=1を設定すれば、Windowsでも権限スキップを許さず失敗にできます。完全なリンク検証が必要な環境で使用してください。OSのセキュリティ設定は変更していません。

scripts/secure-source.mjs、windows-source-worker.ps1、build.mjs、src/model.jsは変更していません。no-follow、共有モード、リンク拒否、保存データ検証を弱めていません。

## 4. 変更ファイル

- src/storage.js：確認不能状態のラッチ、成否不確定の結果、退避対象の分離、追加書き込み禁止。
- src/upgrade-notice.js（新規）：旧版終了の明示的な確認記録。
- src/app.js / src/backup-ui.js / styles.css：通常画面の案内、保護停止と退避の説明、失敗時に前の成功通知を置き換える表示。
- scripts/files.mjs：新モジュールを公開許可リストへ追加。ブラウザ資産10件と.nojekyll、合計11ファイル。
- test/storage.test.js / test/backup-ui.test.js：保護・退避の回帰テスト追加と成否不確定の期待値更新。
- test/upgrade-notice.test.js / test/link-capability.test.js（新規）：案内と条件付きスキップ自体の検証。
- test/fixtures/link-capability.js（新規）、test/build-platform.test.js / test/files-security.test.js：権限制約の識別。
- test/fixtures/browser-backup.js：実画面での案内・不確定状態・復帰・JSON準備・退避・再起動の検証。
- README、レビューガイド、実装報告、iPhone確認手順、本報告。

## 5. 検証結果

既存181件を維持し21件追加、合計202件です。

| 実行環境 | タイムゾーン | 成功 | 失敗 | スキップ |
| --- | --- | ---: | ---: | ---: |
| Windows制限付きサンドボックス | Asia/Tokyo | 195 | 0 | 7 |
| Windows制限付きサンドボックス | UTC | 195 | 0 | 7 |
| Windows通常環境 | Asia/Tokyo | 201 | 0 | 1 |
| Windows通常環境 | UTC | 201 | 0 | 1 |

7スキップは上記6件と既存のファイルシンボリックリンク1件です。通常環境では6件を実行して成功しました。残る1件はファイルシンボリックリンク作成権限がないためです。未実行の防御を成功扱いにはしていません。

追加21件は、確認不能後のrefresh（正常・破損・削除された保存先）、JSON準備、追加書き込み拒否、通常保存との区別、ページ再読み込みによる保持対象の消失、画面の再描画・再表示、案内の初回表示・確認・記録失敗・別タブ更新、権限識別と厳格モードを含みます。

既存Edgeの専用一時プロファイルで42項目成功。実際のvisibilitychangeを発火し、JSON準備後も操作停止が維持されること、元の破損文字列が退避Fileのコード単位と一致すること、追加のデータ書き込みがないことを確認しました。案内の画面遷移後の維持と確認後の再起動も確認しています。390px幅でパネル幅370px、左右10px内に収まり、横スクロールがないことも確認しました。

構文・秘密情報の簡易検査、ビルド、git diff --checkを確認しました。公開物は許可した11ファイルです。レビューZIPもハッシュ検証し、展開コピーでテスト・ビルド・Edge試験を再現します。

## 6. 残存リスクとレビュー入口

退避対象はメモリー保持であり、ページ終了・クラッシュでは失われます。元データの退避保存確認をアプリだけで実証できません。確認後の再読み込みは利用者の判断となります。旧版終了も自己申告であり、旧版や悪意ある同一オリジンの書き込みを完全に防ぐものではありません。JSON・退避ファイルは平文で、構造が正常な改変の認証は行いません。

UbuntuとiPhone実機は未検証です。コミット・pushしていないため、今回のGitHub Actions・CodeQL再解析も未実施です。既存の通常保存・通常復元・緊急復旧のテストは維持しています。独立レビューでは、保護状態の全遷移、退避対象の寿命、成功通知、案内記録の寿命、スキップの範囲を重点確認してください。

最新ZIP：artifacts/my-schedule-source-review-phase2-security-r3.zip。ソース・テスト・設定・文書・SHA-256一覧だけを含み、.git、node_modules、dist、artifacts、画像、保存データ、認証情報は含めません。旧ZIPは保持します。
