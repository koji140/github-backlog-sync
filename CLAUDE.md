# CLAUDE.md — github-backlog-sync 作業前提

## リポジトリの概要

GitHub Projects ↔ Backlog のステータス同期スクリプト群。

| スクリプト | 方向 | コマンド |
|-----------|------|---------|
| `scripts/sync-github-project-to-backlog.js` | GitHub → Backlog | `npm start` / `npm run dry-run` |
| `scripts/sync-backlog-to-github.js` | Backlog → GitHub | `npm run sync-to-github` / `npm run sync-to-github:dry` |

---

## 変更時の更新ルール（漏れ防止）

### mapping.json に新しいフィールドを追加したとき
- `config/mapping.json`（実値、gitignore 対象）
- `config/mapping.example.json`（テンプレート、**必ず同期する**）

### スクリプトに新しい npm コマンドを追加したとき
- `scripts/*.js`（スクリプト本体）
- `package.json`（scripts セクション）
- `README.md`（実行方法セクション）

### 同期ロジックの仕様を変えたとき
- スクリプト本体
- `docs/overview.md`（設計概要）
- `docs/github-backlog-sync-report.md`（実装状況ログ）

### 環境変数を追加・変更したとき
- `.env`（実値、gitignore 対象）
- `.env.example`（テンプレート、**必ず同期する**）
- `docs/setup.md`（セットアップ手順）

---

## 主要ファイルの役割

| ファイル | 役割 |
|---------|------|
| `config/mapping.json` | 本番用マッピング設定（gitignore） |
| `config/mapping.example.json` | テンプレート（コミット対象） |
| `.env` | 本番用環境変数（gitignore） |
| `.env.example` | テンプレート（コミット対象） |
| `docs/mapping.md` | mapping.json の各 ID の調べ方 |
| `docs/setup.md` | 初期セットアップ手順 |
| `docs/overview.md` | 設計概要・同期フロー |

---

## 同期設計のポイント

### last-modified wins（ステータス）
- `sync-github-project-to-backlog.js`: `backlogIssue.updated > lastSynced` なら GitHub の statusId で上書きしない
- `sync-backlog-to-github.js`: `backlogIssue.updated - lastSynced > 5分` の場合のみ GitHub へ反映
- 5分閾値の理由: 同期処理自体が Backlog の updated を lastSynced の数秒後に設定するため

### reverseStatusMap の生成
- `statusMap`（GitHub Status名 → Backlog statusId）を自動逆引き（先着優先）
- `mapping.json` の `reverseStatusMap` で追加・上書き可能
- statusId=3（処理済み）は statusMap に現れないため reverseStatusMap で明示する

### DRY_RUN
- 両スクリプトとも `DRY_RUN=true` で書き込みなしの確認が可能
- 本番実行前に必ずドライランで update 対象を確認すること
