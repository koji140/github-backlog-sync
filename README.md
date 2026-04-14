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

# 4. mapping.json を作成
cp config/mapping.example.json config/mapping.json
# mapping.json を編集して Backlog の各 ID を実際の値に書き換える（docs/mapping.md 参照）

# 5. dry-run でテスト（Backlog への書き込みなし）
npm run dry-run

# 6. 出力 payload を確認してから本番同期へ（Backlog API 実装後）
# npm start
```

## 現在どこまで動くか（Phase 1）

| ステップ | 状態 | 説明 |
|----------|------|------|
| GitHub GraphQL でアイテム取得 | **動作** | Issue / PR / Draft を取得 |
| Draft のスキップ | **動作** | `DRAFT_ISSUE` は同期対象外 |
| 中間形式へ normalize | **動作** | title / body / assignees / labels / status / dueDate |
| Backlog ペイロードへ変換 | **動作** | statusMap / assigneeMap / sync metadata 付与 |
| Backlog 既存課題の取得 | **動作** | offset ページネーションで全件取得 |
| sync metadata 解析 | **動作** | description から projectItemId / URL / lastSynced を抽出 |
| 既存課題との照合 | **動作** | projectItemId → URL の優先順で create/update を判定 |
| 差分チェック | **動作** | `buildBacklogUpdateParams` で変更フィールドのみ抽出・差分なしはスキップ（`Last synced` は比較対象外） |
| DRY_RUN ログ出力 | **動作** | 照合結果・create/update/skip 予定一覧・変更フィールド名を表示 |
| Backlog 課題作成 | **動作** | `POST /api/v2/issues`（form-urlencoded） |
| Backlog 課題更新 | **動作** | `PATCH /api/v2/issues/:id`（差分フィールドのみ送信） |

## 差分判定の仕様

`buildBacklogUpdateParams` は以下のルールで差分を判定します。

| フィールド | 比較方法 |
|-----------|---------|
| `summary` | 文字列完全一致 |
| `description` | `Last synced:` 行を除いた正規化後の文字列で比較 |
| `assigneeId` | `backlogIssue.assignee?.id` との数値比較 |
| `dueDate` | 日付部分 (YYYY-MM-DD) のみ比較 |
| `statusId` | `backlogIssue.status?.id` との数値比較 |

**`Last synced:` は差分比較の対象外** のため、タイムスタンプの更新だけでは update されません。
他のフィールドに差分があって Backlog を更新する場合は、description も一緒に送信して
Last synced を自動的にリフレッシュします。

## create / update で送るパラメータの違い

Backlog の create API（`POST /api/v2/issues`）は `statusId` を受け付けません。
update API（`PATCH /api/v2/issues/:id`）では `statusId` を送ることができます。

| パラメータ | create | update |
|-----------|--------|--------|
| `projectId` | 送る（必須） | 送らない |
| `summary` | 送る（必須） | 差分ありの場合のみ |
| `issueTypeId` | 送る（必須） | 送らない |
| `priorityId` | 送る（必須） | 送らない |
| `description` | 値があれば送る | 差分ありの場合のみ |
| `assigneeId` | 値があれば送る | 差分ありの場合のみ |
| `dueDate` | 値があれば送る | 差分ありの場合のみ |
| `statusId` | **送らない** | 差分ありの場合のみ |

**初回 create 後の期待挙動:**
課題は Backlog のデフォルト状態（通常「未対応」）で作成されます。
次回同期実行時に GitHub の Status と差分が検出され、update で `statusId` が同期されます。

## DRY_RUN モード

環境変数 `DRY_RUN=true` を設定すると、Backlog への書き込みをすべてスキップし、
create / update / skip（差分なし）の予定件数と変更フィールド名をログに出力します。

```bash
# 方法 1: npm スクリプト（推奨・Windows 対応）
npm run dry-run

# 方法 2: 環境変数を直接指定（Mac/Linux）
DRY_RUN=true node scripts/sync-github-project-to-backlog.js

# 方法 3: .env に記載
# DRY_RUN=true
```

**初回テストは必ず `DRY_RUN=true` で実行し、内容を確認してから本番運用してください。**

## LIMIT モード（処理件数の制限）

環境変数 `LIMIT=N`（N は正の整数）を設定すると、Draft 除外後の先頭 N 件のみ処理します。
未指定または空（`LIMIT=`）にすると全件対象になります。

```bash
# .env に追加して使う例
LIMIT=1
```

**用途:** 初回本番テスト時に 1 件だけ create / update して動作確認する。

## 担当者の強制再同期（一時運用）

GitHub 側を変更せずに Backlog の担当者だけを 1 件だけ再同期したい場合に使います。
通常の差分判定をスキップして `assigneeId` を強制的に update に含めます。

```
# .env に追加
FORCE_ASSIGNEE_SYNC=true
FORCE_SYNC_ITEM_URL=https://github.com/<owner>/<repo>/issues/<n>
```

手順:
1. `.env` に上記 2 行を追加する（URL は対象 GitHub Issue の URL）
2. `npm run dry-run` で `[ForceAssignee]` ログが出て update 対象になることを確認
3. 問題なければ `DRY_RUN=false` で `npm start` を実行
4. **使用後は必ず両変数をコメントアウトまたは削除すること**

制約:
- 対象は URL が一致する **1 件のみ**（全件への影響なし）
- `ASSIGNEE_UNMAPPED`（未マッピングユーザー）は force 時も送らない
- `assigneeId` 以外のフィールドは通常の差分判定のまま

## DRY_RUN=false にする前に確認すべきこと

| チェック項目 | 確認方法 |
|-------------|----------|
| `mapping.json` が作成済みか | `cat config/mapping.json` |
| `projectId` が正の整数か | `GET /api/v2/projects/:projectKey` のレスポンス `"id"` |
| `assigneeMap` にすべての担当者が登録済みか | dry-run ログで `[Map] 担当者マッピングなし` 警告が出ていないか確認 |
| `statusMap` にすべてのステータスが登録済みか | dry-run ログで `[Map] ステータスマッピングなし` 警告が出ていないか確認 |
| `[Match] 重複候補あり` が出ていないか | dry-run ログを確認 |
| **初回は `LIMIT=1` で 1 件だけ試すこと** | 下記「推奨テスト手順」参照 |

## 推奨テスト手順

1. `config/mapping.json` を作成し、各 ID を実際の Backlog 値に設定する
   - `projectId` は **Backlog プロジェクト ID**（数値）が必要。`GET /api/v2/projects/:projectKey` で確認。
   - `statusMap` / `assigneeMap` は `docs/mapping.md` を参照して設定。
2. `npm run dry-run`（`DRY_RUN=true`）を全件で実行する
   - GitHub からアイテムを取得
   - Backlog の既存課題を取得して sync metadata で照合
   - create / update / skip（差分なし）の件数と変更フィールドをログに表示（書き込みなし）
3. 出力ログで以下を確認する
   - `[Backlog] 総取得件数` と `sync metadata あり` の件数が正しいか
   - create / update / skip の件数・内容が想定通りか
   - `[Map] 担当者マッピングなし` や `[Match] 重複候補あり` の警告が出ていないか
   - update 予定の「変更フィールド」が意図通りか
4. `.env` に `LIMIT=1` を追加し、再度 `npm run dry-run` で 1 件の内容を確認する
5. 問題なければ `.env` の `DRY_RUN=false` のまま `LIMIT=1` で `npm start` を実行する
   - **Backlog に 1 件だけ create / update されることを確認する**
6. Backlog 上で作成・更新された課題の内容が正しければ、`.env` の `LIMIT` をコメントアウトまたは削除して全件同期へ

```
# 初回本番テストの .env 設定例
DRY_RUN=false
LIMIT=1

# 全件同期時（テスト完了後）
DRY_RUN=false
# LIMIT=     ← コメントアウトまたは空にすると全件処理
```

## 今後の次ステップ

### 実装済み（Phase 1）

- [x] `fetchGitHubProjectItems()` ── GitHub GraphQL API でアイテム取得（1 ページ分）
- [x] `normalizeGitHubProjectItem()` ── GraphQL 生レスポンスを中間形式へ整形
- [x] `mapGitHubItemToBacklogIssue()` ── normalize 済みアイテムを Backlog ペイロードへ変換
- [x] `buildSyncMetadataBlock()` / `appendSyncMetadata()` ── sync metadata ブロックの生成と付与
- [x] `extractSyncMetadata()` ── Backlog description から sync metadata を解析（照合キー抽出）
- [x] `fetchBacklogIssues()` ── Backlog 課題一覧の全件取得（offset ページネーション）
- [x] `findExistingBacklogIssue()` ── projectItemId → URL 優先順での照合、重複警告
- [x] `normalizeDueDate()` / `buildBacklogUpdateParams()` ── 差分チェック（Last synced を除外した比較）
- [x] `normalizeDescriptionForComparison()` ── Last synced 行を除去した description 比較用正規化
- [x] `runDescriptionNormalizationTests()` ── 正規化ロジックの自己確認テスト（`npm run self-test`）
- [x] `createBacklogIssue()` ── `POST /api/v2/issues`（form-urlencoded、DRY_RUN 対応）
- [x] `updateBacklogIssue()` ── `PATCH /api/v2/issues/:id`（差分フィールドのみ、DRY_RUN 対応）
- [x] DRY_RUN モード ── 照合結果・create/update/skip(差分なし)・変更フィールドを表示
- [x] `config/mapping.example.json` の整備 ── `projectId` / `syncMetadata` 含む全フィールドに説明

### 残りの TODO

詳細は [同期レポート「残タスク / 今後の拡張」](docs/github-backlog-sync-report.md#残タスク--今後の拡張) を参照してください。

## 関連ドキュメント

- [概要・背景](docs/overview.md)
- [フィールドマッピング仕様](docs/mapping.md)
- [セットアップ手順](docs/setup.md)
- [同期レポート](docs/github-backlog-sync-report.md)
- [assigneeMap 未定義ユーザーの運用ポリシー](docs/unmapped-assignee-policy.md)
