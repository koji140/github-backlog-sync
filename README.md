# github-backlog-sync

GitHub Projects を正本として、Backlog に課題を同期するための専用リポジトリです。

## 目的

GitHub Projects 上で管理されているタスクを、Backlog に自動反映することで、
GitHub を使わないメンバーも Backlog 上で進捗を確認できるようにします。

## 方針

| 項目 | 内容 |
|------|------|
| 正本 | GitHub Projects |
| 反映先 | Backlog |
| 同期方向 | GitHub → Backlog（片方向） |
| トリガー | 手動（workflow_dispatch）および定期実行（schedule） |

## 初期スコープ

**対象**
- GitHub Project のアイテム（Issue）を Backlog の課題として作成・更新する
- ステータス、タイトル、担当者、説明を同期対象とする

**対象外**
- Backlog → GitHub の逆方向同期
- コメント・添付ファイルの同期
- 双方向リアルタイム同期

## ディレクトリ構成

```
github-backlog-sync/
├── README.md
├── .env.example              # 環境変数のサンプル
├── .gitignore
├── package.json
├── config/
│   └── mapping.example.json  # フィールドマッピングの設定例
├── docs/
│   ├── overview.md           # 背景・スコープ・拡張方針
│   ├── mapping.md            # GitHub ↔ Backlog フィールド対応表
│   └── setup.md              # セットアップ手順
├── scripts/
│   └── sync-github-project-to-backlog.js  # 同期スクリプト本体
└── .github/
    └── workflows/
        └── sync.yml          # GitHub Actions ワークフロー
```

## セットアップ

詳細は [docs/setup.md](docs/setup.md) を参照してください。

```bash
# 1. リポジトリをクローン
git clone https://github.com/<org>/github-backlog-sync.git
cd github-backlog-sync

# 2. 依存パッケージをインストール
npm install

# 3. 環境変数を設定
cp .env.example .env
# .env を編集して各 API キー・ID を入力

# 4. 手動実行でテスト
npm start
```

## 今後の次ステップ

- [ ] `scripts/sync-github-project-to-backlog.js` の GitHub API 呼び出し実装
- [ ] `scripts/sync-github-project-to-backlog.js` の Backlog API 呼び出し実装
- [ ] `config/mapping.example.json` をもとに本番用 `config/mapping.json` を作成
- [ ] GitHub Secrets に API キーを登録し、Actions での自動実行を確認
- [ ] ステータスマッピング・担当者マッピングの調整
- [ ] エラーハンドリングとリトライロジックの追加
- [ ] 同期済み課題の追跡（重複作成防止）ロジックの実装

## 関連ドキュメント

- [概要・背景](docs/overview.md)
- [フィールドマッピング仕様](docs/mapping.md)
- [セットアップ手順](docs/setup.md)
