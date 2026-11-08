# GitHub Pages準備・保存領域の分離

この文書は公開前の設計です。GitHub設定、DNS、公開、mainへの反映は行っていません。

## ビルドと公開パス

外部依存なしの静的サイトとして `node scripts/build.mjs` を実行し、`dist/` を公開対象にします。出力は `index.html`、`styles.css`、`src/` の3モジュール、`.nojekyll` の6ファイルだけです。サーバー、テスト、文書、Gitデータ、ZIPは配信しません。

HTMLのCSS・スクリプトと、JavaScriptのimportは相対参照です。ルート直下と `/my-schedule-app/` のようなリポジトリ配下の両方で解決されることを自動テストします。SPAの独自URLルーターはなく、画面切り替えでURLを書き換えないため、Pages用の404リライトは不要です。リポジトリ名を変えてもビルド時のbase設定は不要です。プロジェクトURL末尾の `/` はPagesの通常のリダイレクトを利用します。

GitHub Actionsはテスト・ソース検査・ビルド・通常の成果物アップロードだけを行います。`deploy-pages`、`configure-pages`、Pages環境、`pages: write`、`id-token: write` は含めていません。`actions/upload-artifact` は検査用の保存であり、Web公開ではありません。

将来公開するときは、このアプリ専用の新規リポジトリを用意し、PR・CodeQL・iPhone評価の手順を決めたうえで、別途Pages用デプロイを追加します。公開ソースはActionsとし、対象ディレクトリは `dist/` に限定します。[GitHub公式のPagesカスタムワークフロー](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) を参照してください。今回は追加・実行しません。

## 同じオリジンのリスク

たとえば同一ホストの `/karada-log-app/` と `/my-schedule-app/` は、パスが異なっても同じオリジンです。オリジンはスキーム・ホスト・ポートで決まり、パスは含みません。[MDN: Origin](https://developer.mozilla.org/en-US/docs/Glossary/Origin)

localStorageはオリジンごとに共有されます。保存キーを分けることは誤上書きの防止には有効ですが、アクセス制御にはなりません。同じオリジンの別アプリのJavaScriptは、このアプリの保存データを読んだり書き換えたりできます。逆方向のアクセスも可能です。別リポジトリ・別IndexedDB名・ホーム画面への追加・PWAのscopeだけではオリジン分離になりません。[MDN: Web Storage](https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API/Using_the_Web_Storage_API)

同一オリジンでは、別アプリによる `localStorage.clear()`、保存容量の取り合い、ユーザーによるサイトデータの一括削除も両アプリに影響し得ます。また、同一ホストのルートスコープのService Workerがある場合は、他のパスへの配信にも関与し得ます。既存アプリのService Workerや保存内容の検査は今回行っていません。

## 推奨する分離方法

| 方法 | 保存領域の隔離 | 評価 |
| --- | --- | --- |
| 同じGitHubアカウントの別リポジトリ・別パス | なし | 架空データでの暫定評価に限定。実データを入れない |
| このアプリ専用のカスタムホスト名（例：schedule.example.com） | あり | 推奨。既存アプリは変更せず、新アプリ側だけに設定する |
| 別の専用GitHubアカウント／OrganizationのPagesホスト | あり | 独自ドメインを使わない場合の候補。運用管理と権限設計が必要 |

いずれも新アプリ側だけの設定で実現できます。特に、ユーザー／OrganizationのPagesに独自ドメインがあると、独自ドメイン未指定のプロジェクトサイトがその配下になる場合があります。新アプリのリポジトリに専用の独自ホスト名を設定すれば、この既定ドメインを個別に上書きできます。既存のユーザーサイトから独自ドメインを削除する必要はありません。[GitHub公式：独自ドメインとプロジェクトサイト](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/about-custom-domains-and-github-pages)

独自ホスト名を使う場合は、新アプリのリポジトリ側にCustom domainを設定し、所有するDNSでそのホストだけを設定します。HTTPSとドメイン所有確認も新アプリ側で確認します。Actions方式ではCNAMEファイル自体は不要で、リポジトリのCustom domain設定を使います。DNSは広範囲なワイルドカードにせず、専用ホストのレコードを管理します。今回は設定していません。[GitHub公式：独自ドメインの管理](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)

既存アプリがすでに別の専用ホストで運用されている場合は、新アプリの標準Pagesホストを使うだけで分離できる可能性もあります。ただし、最終リダイレクト先まで含めた実際のoriginが異なることを公開前に確認する必要があります。今回は既存アプリの設定を調査・変更していないため、この条件が満たされるとは断定しません。

HTTPSの専用ホスト名を最初のiPhone試験から使う方法が最も明確です。同じ親ドメインのサブドメインでもlocalStorageのオリジンは分かれますが、将来Cookieを追加する場合は親ドメイン共有Cookieを避け、ホスト限定Cookie等を検討します。別ブラウザ／別プロファイルの使い分けは利用者の操作に依存するため、アプリの境界としては採用しません。

既存アプリの保存キーやドメイン設定を変更する提案ではありません。このアプリのホストを分ける方針です。

## 現段階の対策と限界

このアプリが扱う保存キーは `my-schedule.prototype.v1` だけで、他の保存領域を列挙・移行・削除しません。旧LANで使ったデータは別オリジンになるためPagesへ自動移行されず、Pagesでは架空の初期データから始まります。

外部フォント、画像、計測、API通信はなく、CSPで `connect-src 'none'` 等を指定しています。ただし、このアプリのCSPは同じオリジンの別アプリを制限するものではありません。ブラウザ保存は暗号化・バックアップ・永続性を保証していません。本番前に保存方針と復元方法を決める必要があります。

## CodeQL

手動実行・PR・対象ブランチへのpushと定期実行に対応する構成です。JavaScript/TypeScript、build-mode:none、security-extendedを指定しています。GitHub上では未実行です。専用リポジトリで、利用可能な契約／可視性とActions権限を確認し、デフォルト設定との重複を避けて有効化してください。[GitHub公式CodeQL設定](https://docs.github.com/en/code-security/reference/code-scanning/workflow-configuration-options)
