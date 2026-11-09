# 独立コードレビュー用メモ

## レビュー対象

個人向け「マイスケジュール」の第2段階、JSONバックアップ・通常復元・緊急復旧を実装した版です。作業ブランチはfeature/json-backup-restoreで、コミット・push・公開は行っていません。第1段階のソース読み込み保護と機能を維持しています。試験データは架空で、外部API・OS通知・同期は未実装です。

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

Nodeテストは220件（既存202件＋r4回帰18件）です。WindowsのAsia/Tokyo・UTCとも、通常環境は219成功・失敗0・権限制約スキップ1、制限付きサンドボックスは213成功・失敗0・権限制約スキップ7です。r3で確認したリンクテストとスキップ条件は変更していません。MY_SCHEDULE_REQUIRE_LINKS=1でスキップを禁止できます。Ubuntuは未検証です。最新の状態管理と結果はdocs/json-backup-security-r4.mdを参照してください。

第2段階の実ブラウザ試験は `node scripts/browser-backup-test.mjs` です。既存Edge（またはMY_SCHEDULE_BROWSERで指定した既存Chromium系）を専用の一時プロファイルで起動します。127.0.0.1の一時オリジンで架空データだけを使い、破損状態の試験もその領域だけに設定します。従来の操作と保護停止に加え、現在の破損Bと過去の保持Aを別々に退避する52項目と390px幅を確認します。公開環境と既存ブラウザプロファイルは使いません。iPhoneの実ファイル保存とは別の検証です。

過去の第1段階では `runBrowserSmoke(tab)` の28項目と `runBrowserSecurity(tab)` の25項目を確認しています。今回この2つは再実行していません。GitHub CIのブラウザ実行環境は未導入です。

最新の変更・検証の制限・独立レビュー重点箇所は `docs/json-backup-security-r4.md`、以前のP2対応は `docs/json-backup-security-r3.md` を参照してください。今回の修正はpushしていないためGitHub Actions・CodeQL再実行はまだです。公開中のCloudflare Pagesには変更していません。iPhone/Safari実機評価も未実施です。

同一Pagesホストの別パスは保存領域のセキュリティ境界になりません。詳細と提案は `docs/pages-preparation.md` を参照してください。

コードレビューは、このZIP単体で行い、別アプリのリポジトリ・公開環境へ変更を加えない前提です。
