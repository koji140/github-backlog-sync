# TODO — github-backlog-sync

このファイルを、このリポジトリの同期運用に関する残タスクの入口にする。

最終更新: 2026-04-28

---

## 開いている Todo

### [ ] Backlog → GitHub の担当者同期方針を決める

`管理方法: TODO`

**背景**  
現在の `config/mapping.json` の `assigneeMap` は GitHub login ではなく、GitHub Project の Owner 表示名（`石丸`, `大野`, `潮田`）を使っている。Backlog → GitHub 同期でこれを GitHub Issue assignee に送ると 422 になるため、無効 login はスキップするガードを入れた。

**作業内容**
- [ ] `assigneeMap` を実 GitHub login に直すか判断する
- [ ] 実 GitHub login が使えない場合、Backlog → GitHub の担当者同期を正式に無効化するか判断する
- [ ] 方針を `README.md` / `docs/mapping.md` に反映する

---

### [ ] GitHub Issue state と Project Status の不整合点検手順を作る

`管理方法: TODO`

**背景**  
`I-62` と `I-12` で、Project Status は `Todo` / `In Progress` なのに GitHub Issue 本体が `Closed` になっている例が見つかった。全件調査はコストが大きく、当日は中止した。

**作業内容**
- [ ] 文字化けしにくい Node.js スクリプトまたは npm script で一覧化する
- [ ] `Closed` かつ Project Status が `Todo` / `In Progress` の Issue を検出する
- [ ] reopen するか、Status を Done に寄せるかの判断手順を残す

---

### [ ] 旧 Epic 親課題未照合の扱いを決める

`管理方法: TODO`

**背景**  
旧 Epic #56 / #57 を親に持つ Issue は、Backlog 側に対応する親課題がないため `親課題未照合` 警告になる。

**作業内容**
- [ ] 旧 Epic の親子関係を現在の親Issue構造に付け替えるか判断する
- [ ] 履歴として残す場合、警告を既知のものとして扱う運用を README に明記する

---

### [ ] 同期運用 skill を作成する

`管理方法: TODO`

**背景**  
GitHub → Backlog / Backlog → GitHub の同期は、向き・dry-run・本番・親子関係・日付集計・担当者同期警告など判断点が多い。Cursor skill として残す依頼文は作成済み。

**作業内容**
- [ ] `github-backlog-sync-operations` skill を作成する
- [ ] dry-run / 本番 / 既知警告 / トラブルシュートを skill に含める
- [ ] 作成後に README から skill の存在を参照する

---

## 最近完了したもの

### [x] GitHub parent issue を Backlog parentIssueId に同期する

**完了日**  
2026-04-28

**内容**
- GitHub Issue の parent issue を取得
- Backlog sync metadata の GitHub Issue URL で親課題を照合
- 子課題の `parentIssueId` を更新

**参照**
- [docs/session-logs/session-log-2026-04-28-03.md](docs/session-logs/session-log-2026-04-28-03.md)

---

### [x] 親Issueの日付を子Issueから集計する

**完了日**  
2026-04-28

**内容**
- 親Issueの `startDate` を子Issueの最小 `startDate` にする
- 親Issueの `dueDate` を子Issueの最大 `dueDate` にする
- self-test を追加

**参照**
- [docs/mapping.md](docs/mapping.md)
- [docs/session-logs/session-log-2026-04-28-03.md](docs/session-logs/session-log-2026-04-28-03.md)
