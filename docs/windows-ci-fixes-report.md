# Windows CI失敗への対応（r5）

対象はPR #1のコミット `ccf15fc`、作業ブランチは `prototype/phase-1` です。今回の変更はローカルのみです。push、mainへのマージ、Pages公開、既存のkarada-log-appへの変更は行っていません。

## 調査と修正

### 出力ディレクトリの誤判定

[失敗したActions実行](https://github.com/atuage08/my-schedule-app/actions/runs/42449561315) のWindows / Asia/Tokyoログには、一時ディレクトリに `RUNNER~1` という短縮名が記録されていました。旧build.mjsは、リンクでなくても `realpath(output) !== output` なら拒否していました。

ローカルWindowsでもWin32のGetShortPathNameで取得した `C:\MY-SCH~1\dist` に対し、lstatのisSymbolicLinkはfalse、realpathは `C:\my-schedule-app\dist` でした。旧条件の誤判定を再現でき、修正後はこの短縮パスからのビルドが成功しました。

`scripts/build.mjs` はパス文字列だけで判断せず、非ゼロのファイルID（dev・ino）でプロジェクト、正規化後の出力親、出力の実体を照合します。入力読み込み前に元のプロジェクトIDを固定し、後で変わっていないことも検査します。出力名はdistに限定し、リンク、ジャンクション、通常ファイル、異なる実体は拒否します。実体を確認できない場合も拒否します。Linuxでは名前を小文字化しません。

新しい `test/build-platform.test.js` の4件で、Windowsの大文字・小文字の別表記を持つ通常出力の再ビルド、外部へのリンク、内部の別ディレクトリへのリンク、distという通常ファイルを検証します。拒否時にリンク先やファイルが残ることも確認します。元の再ビルドテストも維持しています。

### 競合テストの後片付けとWindowsロック

同じActionsログのEBUSYは、読み込みAPIではなく `test/fixtures/fs-race.js` のジャンクションunlinkで発生していました。保護された読み込みが親ディレクトリのハンドルを保持している間は、Windowsがリンクの削除やディレクトリ名の復元を一時的に拒否する場合があります。

`test/fixtures/race-operations.js` にテスト専用の操作を分離しました。後片付けのunlinkとrenameについて、EBUSY・EPERM・EACCESのみ最大40回、待ち時間は最大50msで再試行します。ほかのエラー、継続するロックはテスト失敗です。リンク自体だけをunlinkし、再帰削除でリンク先へ進みません。リンク削除が終わってから元ディレクトリを戻します。

実際にリンクを作成してからreadyを通知し、停止時は復元完了通知とワーカー終了を待ちます。実際の差し替えが一度も成功しなければ失敗します。60回の読み込みが「信頼した内容」または拒否であること、外部の内容が返らないこと、終了後に元の内容を再読込できることを確認します。ロックを理由にテスト全体をスキップしません。

新しい `test/race-fixture.test.js` の7件で、一時ロックの再試行、継続ロックの失敗、想定外エラーの伝播、復元順序、リンク生成失敗時の復元を決定的に検証します。読み込み本体の `secure-source.mjs` と `windows-source-worker.ps1` は変更していません。

## 検証結果

Windows / Node.js v24.22.1で確認しました。

- 既存95件を維持し、新規11件を追加。Asia/TokyoとUTCそれぞれ106件中105成功、失敗0、スキップ1。
- スキップ1件は既存のファイルシンボリックリンク作成権限チェックです。ローカルOSがEPERMを返すためです。ジャンクション・ハードリンク・実際の親差し替え競合テストは実行して成功しています。新しいスキップはありません。
- 実際の親差し替え競合テストを追加で5回実行し、すべて成功、スキップ0。
- Windows 8.3短縮パスからのビルド成功。通常のGitHub Pages用ビルド成功。
- 構文・秘密情報／連絡先の簡易検査、git diff --check成功。自動スキャンは秘密情報の不在を完全に保証するものではありません。
- `.github/workflows/checks.yml` にfail-fast: falseを追加し、1ジョブが失敗してもほかのOS・タイムゾーンの結果を確認できるようにしました。検査やテストを無効化していません。CodeQLワークフローと.gitignoreは変更していません。

Linuxの今回の変更はローカルでは未実行です。ccf15fcではGitHub上のUbuntu両タイムゾーンとCodeQL解析が成功していましたが、今回の修正のGitHub再検査はpush後に必要です。Windows CIのファイルシンボリックリンク権限もローカルと異なるため、CI結果を最終確認してください。

## レビュー用ZIP

`artifacts/my-schedule-source-review-r5-windows-ci.zip` を新規作成します。ソース・テスト・設定・文書とSHA-256マニフェストを含み、.git、node_modules、dist、artifacts、画像、認証情報、保存データを含めません。既存ZIPは保持します。ZIP作成時に全ソースのハッシュを検証し、展開したコピーでも検査・テスト・ビルドを実行します。
