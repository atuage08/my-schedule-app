# PR #1 CodeQL High警告への対応（r4）

対象PRは `atuage08/my-schedule-app` の #1、作業ブランチは `prototype/phase-1` です。今回の修正はローカルコミットまでとし、ユーザー確認前のpush、mainへのマージ、Pages公開は行いません。警告のDismiss、CodeQL設定の無効化、karada-log-appへの変更は行っていません。

## 1. ファイルシステムの検査と使用の競合

旧 `scripts/files.mjs` は、各パスをlstatで検査した後に、readFileへ再びパスを渡していました。検査した対象と読み込む対象が同じであることを保証できない経路でした。[CodeQLの該当ルール](https://codeql.github.com/codeql-query-help/javascript/js-file-system-race/)

`readSource` を `scripts/secure-source.mjs` の保護された読み込みに接続しました。最終ファイルは開いたディスクリプタ／ハンドルで検査・読み込みを完結させ、パスを開き直しません。親ディレクトリの差し替えも含めて対処します。

- **Linux:** `/` のディレクトリディスクリプタから一成分ずつ開きます。`/proc/self/fd` を基点に `O_NOFOLLOW` と `O_DIRECTORY` を使用し、ユーザー指定のリンクを追いません。最終ファイルもリンク非追従・非ブロックで開き、同じFileHandleのstatとreadだけを使います。Linuxでは/procが利用可能であることが必要です。[Node.jsのファイルAPI](https://nodejs.org/api/fs.html)
- **Windows:** 標準PowerShell/.NETの読み取り専用ヘルパーを使用。ボリュームルートから各成分を、親ハンドルをRootDirectoryに指定した `NtCreateFile` で相対オープンします。`OBJ_DONT_REPARSE`・`FILE_OPEN_REPARSE_POINT` とハンドル情報でリパースポイントを拒否し、パスを再走査しません。ディレクトリ列挙も同じハンドルの `GetFileInformationByHandleEx` を使用します。読み込み完了まで祖先ハンドルを保持し、共有モードも読み取りだけに制限します。[NtCreateFile](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile)、[CreateFileの共有モード](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)

通常ファイル以外、ハードリンク、8MiB超、親への遡及、絶対名・ADS・不正文字・曖昧な区切り・過大なパスを拒否します。読み込みAPI自体はファイルの内容を実行しません。OSが必要な保護を提供しない場合は安全でないフォールバックをせず失敗します。WindowsのUNC・デバイスパス、macOS等は今回の保護されたソース処理の対象外です。Webアプリの実行対象を制限するものではありません。

ソース列挙、package.jsonのビルド読み込み、構文検査、ZIP作成にも同じ保護を適用しました。構文検査は保護済みバイト列を標準入力からNodeへ渡し、ZIPは保護済みバイト列のスナップショットを受け取ります。マニフェスト作成後にPowerShellからソースパスを再読込する経路もなくしました。マニフェスト自体にはコードのBase64を収録せず、ファイル名・サイズ・ハッシュだけを記録します。

入力が一つ失敗したビルドでも全読み込みのハンドル解放を待ってから失敗を返すようにし、一時領域の後処理との競合も防ぎました。既存のdistを保持する失敗時の動作は維持しています。

## 2. DOM文字列のHTMLとしての再解釈

旧入力パネルの描画では、FormData等から読み戻した名称・値をHTMLテンプレートへ埋め直していました。名称はエスケープしていましたが、DOM由来の日時・期限等もテンプレートの属性値へ流れる構成でした。[CodeQLの該当ルール](https://codeql.github.com/codeql-query-help/javascript/js-xss-through-dom/)

`src/dom.js` にDOM生成関数を追加し、`src/app.js` 全体と時刻選択肢をDOM APIへ変更しました。ユーザー入力・保存データ・DOM値をHTML文字列へ埋め込む経路はありません。

- 表示文字列は `createTextNode`、通知・エラーは `textContent` を使用。
- 入力は `value`、チェック状態は `checked` 等のプロパティを使用。
- 属性は許可した名前だけを `setAttribute` で設定。イベント属性、URL属性、style、srcdoc等は生成関数で拒否。
- タグは固定の許可リストだけを使用。script・img・svg・iframe等は生成不可。
- アプリ描画モジュールからinnerHTML・outerHTML代入・insertAdjacentHTML等のパーサーシンクを除去。
- CSPは維持し、CSPだけに頼ってHTML注入を防いだことにはしていません。テストでは不正要素やイベント属性が生成されないことも確認。

この回帰テストで終日切替時の日時形式判定の不具合も発見したため、チェック状態を変更する前の入力形式で値を取り込み、変換して再描画するよう修正しました。

## 検証結果

既存77件を変更せず、新規18件を追加しました。今回のWindows環境では **95件中94件成功・失敗0・スキップ1**、Asia/Tokyo・UTCで同じ結果です。スキップはファイルシンボリックリンク作成権限がないケースです。Windowsのジャンクション、ハードリンク、親の競合差し替えテストは実行し成功しました。

Node回帰テストは、不正HTML、引用符・山括弧・実体参照、日本語、危険なタグ／属性の拒否、パーサーシンク不在、異常パス、通常ファイル以外、容量超過、ルート・親のリンク、ハードリンク、親を外部ディレクトリへのリンクに差し替える競合を対象としています。競合中は元の内容か拒否のどちらかとなり、外部の内容を読み込まないことを確認しました。

ブラウザでは通常操作28項目、不正HTMLの入力・終日／予定タスク切替・検索再描画・保存後の編集・削除確認25項目が成功しました。テストは架空データをUIから操作し、保存領域へ直接書き込みません。ソース構文・簡易秘密情報検査とPages用ビルドも成功し、公開対象はDOM生成モジュールを含む7ファイルになりました。

ローカルのLinux環境がないためLinux側の実行は未確認です。`.github/workflows/checks.yml` にUbuntuとWindowsのマトリクスを追加し、確認後のpushで両方を検査できるようにしました。CodeQLワークフローは変更していません。

## レビューとGitHubへの反映

新しいZIPは `artifacts/my-schedule-source-review-r4-codeql.zip` です。旧ZIPは保持します。ソース・テスト・Windowsヘルパー・設定・文書とSHA-256一覧を含め、.git、node_modules、dist、画像、保存データ、環境ファイル・認証情報、ZIP自身は除外します。

修正は `prototype/phase-1` にローカルコミットします。確認後、通常pushすれば既存PR #1へ反映できます。**GitHub上で修正後のCodeQLを再実行するまでは、警告が解消したという判定は未確認です。** PR本文や警告状態の変更は今回行いません。
