# 独立コードレビュー用メモ

## レビュー対象

個人向け「マイスケジュール」の第1段階試作品です。CodeQLのHigh警告2件に対応したr4版です。ファイルの検査後にパスを開き直す処理と、DOM由来文字列をHTMLへ戻す処理を修正しています。データはすべて架空で、外部API・通知・同期は未実装です。

このZIPにはソース、スタイル、テスト、ビルド／検査スクリプト、GitHub Actions設定、文書を含めています。node_modules、.git、dist、画像、保存データ、ZIP自身、認証情報・環境設定は含めていません。Git作者・リモート・会話ログも含めません。`REVIEW-MANIFEST.json` に各ファイルのSHA-256があります。

## 再現

Node.js 22以上（推奨24）を使用します。WindowsまたはLinuxが対象で、外部パッケージのインストールは不要です。Windowsでは標準のWindows PowerShellと.NETが必要です。リンク生成を制限された実行環境では、その制限を解消したテスト環境が必要です。OS設定や実行ポリシーを回避するオプションは使用しません。

```sh
node scripts/check.mjs
node --test test/*.test.js
node scripts/build.mjs
```

必要な場合のみ `node server.mjs` でPCの127.0.0.1上にビルド済みdistを表示できます。LANにはバインドしません。GitHubへの送信や公開処理はありません。

## 特に確認してほしい点

1. 選択日と時刻初期値、開始変更時の所要時間維持、終日・複数日の境界。
2. 月末の基準日、未完了繰り越し、「今回だけ／すべて」の編集・削除と完了履歴の整合性。
3. localStorage検証と保存失敗時の復元、複数タブの競合、名称・DOM入力値の安全なテキスト表示。
4. Pagesのリポジトリ配下パスでの参照解決、配信・ZIP対象の限定、Actions権限。
5. iPhoneのキーボード、フォームのラベル、片手操作、文字サイズとコントラスト。

Nodeテストは95件（既存77件を維持＋新規18件）です。今回のWindows環境ではAsia/Tokyo・UTCとも94件成功、失敗0、ファイルシンボリックリンク作成権限がない1件はスキップしました。ジャンクション・ハードリンク・親の差し替え競合は実行して成功しています。Linux側の実行はローカル未確認で、CIにWindowsとUbuntuの両方を追加しました。

ブラウザ操作ツールのTab APIを受け取る関数 `runBrowserSmoke(tab)` は28項目、`runBrowserSecurity(tab)` は不正HTML・特殊文字の25項目が成功しています。単独Node実行ではブラウザを起動しません。モジュールはそれぞれ `scripts/browser-smoke.mjs` と `scripts/browser-security.mjs` です。127.0.0.1の試作品で架空データを使用し、自分で作った未完了項目だけを削除します。保存領域へテストから直接書き込みません。GitHub CIのブラウザ実行環境は未導入です。

最新の変更・互換性の制限は `docs/codeql-fixes-report.md`、入力・保存件数の上限と探索方式は `docs/review-fixes-report.md` を参照してください。確認前のpushを行っていないため、修正後のGitHub CodeQL再実行はまだです。実際のPagesでの読込、iPhone/Safari実機評価も未実施です。

同一Pagesホストの別パスは保存領域のセキュリティ境界になりません。詳細と提案は `docs/pages-preparation.md` を参照してください。

コードレビューは、このZIP単体で行い、別アプリのリポジトリ・公開環境へ変更を加えない前提です。
