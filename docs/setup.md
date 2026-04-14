# セットアップ手順

## 1. Backlog API Key の準備

1. Backlog にログインし、右上のアカウントアイコン → **個人設定** を開く
2. 左メニューの **API** を選択
3. **登録** ボタンから新しい API キーを発行する
4. 発行されたキーをコピーして手元に保存する（再表示不可）

また、以下の情報も事前に確認しておきます。

| 項目 | 確認方法 |
|------|---------|
| Backlog スペース名（例: `yourspace`） | Backlog の URL（`https://yourspace.backlog.com`）から確認 |
| Backlog プロジェクトキー | プロジェクトの設定画面から確認 |
| Backlog 課題種別 ID | `GET /api/v2/projects/:projectKey/issueTypes` で取得 |
| Backlog ステータス ID | `GET /api/v2/projects/:projectKey/statuses` で取得 |

## 2. GitHub Secrets の設定

GitHub リポジトリの **Settings → Secrets and variables → Actions** に以下を登録します。

| Secret 名 | 内容 |
|-----------|------|
| `BACKLOG_API_KEY` | Backlog の API キー |
| `BACKLOG_SPACE` | Backlog スペース名（例: `yourspace`） |
| `BACKLOG_PROJECT_KEY` | Backlog プロジェクトキー（例: `PROJ`） |
| `GH_TOKEN` | GitHub Personal Access Token（`read:project` スコープ必須） |
| `GH_ORG` | GitHub 組織名またはユーザー名 |
| `GH_PROJECT_NUMBER` | 同期対象の GitHub Project 番号 |

### GitHub Token のスコープ

- `read:org` — Organization Projects の読み取り
- `read:project` — Projects v2 の読み取り
- `repo` — プライベートリポジトリの Issue 読み取り（必要な場合）

## 3. ローカルでの環境変数設定

```bash
cp .env.example .env
```

`.env` を編集し、各値を入力します。

```env
BACKLOG_API_KEY=your_backlog_api_key
BACKLOG_SPACE=yourspace
BACKLOG_PROJECT_KEY=PROJ
GH_TOKEN=ghp_xxxxxxxxxx
GH_ORG=your-org
GH_PROJECT_NUMBER=1
```

> `.env` は `.gitignore` で除外されています。コミットしないよう注意してください。

## 4. 依存パッケージのインストール

```bash
npm install
```

## 5. workflow_dispatch での手動実行方法

GitHub リポジトリの **Actions** タブを開きます。

1. 左サイドバーから **Sync GitHub Project to Backlog** を選択
2. **Run workflow** ボタンをクリック
3. ブランチを選択して **Run workflow** を実行

## 6. 初回テスト手順

### ローカルでの動作確認

```bash
# スクリプトを直接実行
npm start
```

現時点ではスクリプトのスケルトンのみのため、以下の点を確認します。

- 環境変数の読み込みバリデーションが通ること
- 「同期開始 → 0件取得 → 同期完了」のログが出力されること

> **注意**: スクリプトは `type: module`（ESM）です。ローカル実行時は
> `scripts/sync-github-project-to-backlog.js` 冒頭の `import 'dotenv/config'` の
> コメントアウトを外してから `npm start` を実行してください。
> `.env` ファイルの各項目が設定済みであることを事前に確認してください。

### Actions での確認

1. workflow_dispatch で手動実行する
2. Actions ログを確認し、エラーなく完了することを確認する
3. Backlog に課題が作成されていることを確認する（実装完了後）

## トラブルシューティング

| 症状 | 確認ポイント |
|------|------------|
| GitHub API 認証エラー | `GH_TOKEN` のスコープ・有効期限を確認 |
| Backlog API 403 | `BACKLOG_API_KEY` が正しいか、IP 制限がないか確認 |
| Project アイテムが取得できない | `GH_PROJECT_NUMBER` が正しいか、Token に `read:project` があるか確認 |
| Backlog 課題が重複作成される | sync metadata の存在チェックロジックを確認（未実装の場合は手動で重複削除） |
