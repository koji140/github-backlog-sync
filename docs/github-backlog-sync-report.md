# GitHub → Backlog 同期構築レポート

## 1. 目的

GitHub Projectで管理しているタスクを、Backlog側にも同期し、
以下を実現することを目的とした。

* タスクの二重管理の解消
* Backlogを現場運用の基盤として維持
* GitHubを上流の設計・整理の場として活用

---

## 2. 最終成果

以下の状態を実現した。

* GitHub 52件 ⇄ Backlog 52件 が完全一致
* 差分がある場合のみ update
* 差分がない場合は skip
* dry-run による安全な事前確認
* 担当者（Owner フィールド）も Backlog に反映済み（2026-04-15）
* **Start date（開始日）も Backlog に反映済み**（2026-04-15、update 46 件）
* **Due Date（期限日）も Backlog に反映済み**（初期同期時に設定済み）

### フェーズ1 完了時の状態（担当者同期前）

```
create: 0
update: 0
skip: 52
```

### 担当者同期完了後の最終状態（2026-04-15）

```
update: 50（Owner フィールド → Backlog assignee を全件反映）
skip:    2（Owner 未設定または未マッピング）
```

👉 担当者まで含めた完全同期状態

---

## 3. アーキテクチャ

### データフロー

```
GitHub Project
   ↓ normalize
内部データ構造
   ↓ 照合（metadata）
Backlog課題
   ↓ create / update / skip
```

---

## 4. うまくいったポイント

### ① metadataによる一意識別

Backlogのdescriptionに埋め込んだ：

```
<!-- sync: githubIssueId=XXX -->
```

これにより：

* タイトル変更に影響されない
* 重複作成が起きない
* 安定した照合が可能

👉 **この設計が最重要ポイント**

---

### ② dry-run の導入

```
DRY_RUN=true
```

により：

* いきなり本番書き込みしない
* 差分を事前に可視化できる

👉 **事故防止として非常に有効**

---

### ③ create と update の分離設計

* create時は status を送らない（Backlog制約回避）
* updateで status を反映

結果：

* エラー回避
* 後から整合が取れる

👉 **「一発で正しくやろうとしない」設計が効いた**

---

### ④ 差分検知の粒度

比較対象：

* title
* description
* dueDate
* status

結果：

* 不要な update を防止
* 実質的な同期だけが走る

---

## 5. 詰まったポイント

### ① Backlogの status 制約

問題：

* create時に status が指定できない

対応：

* create → update の2段階に分離

---

### ② 文字列差分（description）

問題：

* metadata更新で毎回差分になる

対応：

* 更新設計として許容（Last synced更新）

---

### ③ 初回同期の扱い

問題：

* 既存データとの整合

対応：

* metadataがあるものだけ照合対象にする

```
sync metadata あり: 照合対象
なし: 無視
```

👉 既存データを壊さない設計

---

### ④ Owner フィールドの型（担当者同期フェーズ）

問題：

* `assigneeLogins` が空のまま → assigneeId が常に null
* GitHub の標準 Assignees フィールドは使っておらず、カスタムフィールド "Owner" に値が入っていた
* さらに "Owner" フィールドは `ProjectV2ItemFieldSingleSelectValue`（`name`）ではなく `ProjectV2ItemFieldTextValue`（`text`）だった

対応：

```js
// name だけでは取れないケースがある
const ownerValue = ownerField?.text ?? ownerField?.name ?? null;
```

また `content.assignees` が空の場合に "Owner" フィールドへフォールバックする実装を追加。

👉 **フィールド型の違いは dry-run + デバッグログで特定した**

---

### ⑤ force assignee sync による 1 件検証

問題：

* Owner フィールド修正後、51 件が update 対象になった
* いきなり全件は怖い

対応：

* `FORCE_ASSIGNEE_SYNC=true` + `FORCE_SYNC_ITEM_URL` で 1 件だけ先行確認
* 1 件成功を確認してから全件実行

👉 **段階確認の仕組みを先に作っておいたことが安全性につながった**

---

## 6. 工夫したポイント

### ① 「完全一致」をゴールにした

中途半端にせず：

```
create: 0
update: 0
skip: 全件
```

まで持っていった

👉 これにより「正しい同期状態」を定義できた

---

### ② ログの可視化

```
[Plan] create / update / skip
```

を出すことで：

* 実行前に挙動が理解できる
* デバッグが圧倒的に楽

---

### ③ 小さく検証 → 本番

流れ：

1. 1件手動作成
2. dry-run
3. create実行
4. dry-run
5. update実行
6. dry-run

👉 **段階的に確実に進めた**

---

## 7. 得られた学び

### ① 同期は「ID」がすべて

* タイトルではダメ
* URLでも不安定
* metadata埋め込みが最強

---

### ② 「差分だけやる」が本質

毎回全部更新ではなく：

* create
* update
* skip

の3分類が重要

---

### ③ 完璧な初回より、後から整える設計

* createで無理しない
* updateで整える

👉 シンプルで壊れにくい

---

## 8. 今後の拡張

### 優先度高

* GitHub Actions で自動化

### 次

* ~~assignee 同期~~ → 完了（2026-04-15）
* priority 同期

---

## 9. 一言まとめ

GitHubを上流、Backlogを運用基盤として、
**差分同期で両者をつなぐ仕組みを構築した。**

---

## 10. 補足（個人的な気づき）

* エラーは全部「順番」で解決できた
* 一気にやろうとすると詰まる

---

## 11. Due Date 調査記録（2026-04-15）

### 背景

Due Date が Backlog に反映されていないように見えたため、取得経路を end-to-end で確認した。

### 調査方法

`DEBUG_DUE_DATE_SYNC=true` / `DRY_RUN=true` で実行し、issue #5 を対象に以下を確認。

### 結果

| 確認項目 | 結果 |
|---------|------|
| `fieldValues` 取得件数（GraphQL） | 10 件 |
| `getField("Due Date")` 生ノード | `{ date: "2026-04-14", field: { name: "Due date" } }` |
| `normalizedItem.dueDate` | `"2026-04-14"` |
| `payload.dueDate` | `"2026-04-14"` |
| `backlogIssue.dueDate`（API） | `"2026-04-14T00:00:00Z"` |
| `normalizeDueDate` 比較 | Backlog `"2026-04-14"` vs GitHub `"2026-04-14"` → **一致** |
| `buildBacklogUpdateParams` 結果 | `null`（差分なし → skip） |

### 結論

Due Date の取得・正規化・差分検出ロジックは **正常に動作している**。  
「反映されていない」ように見えた原因は、**Backlog 側にすでに同じ期限が入っていたため update がスキップされた**ためであり、  
動作不良ではなく正常な skip 挙動。

### 対処済みの事項

| 項目 | 変更内容 |
|------|---------|
| `fieldValues(first: 20)` の上限不足（予防的修正） | `first: 100` に拡大（フィールドが多い場合の切り捨て防止） |
| `DEBUG_DUE_DATE_SYNC` / `DEBUG_DUE_DATE_ITEM_URL` | 1 件ごとの取得経路トレース機能を追加 |
| `docs/mapping.md` | Due Date 実装済み・Start date 未実装を明記 |
| `README.md` | 初期スコープに Due Date 追記・Start date を対象外に明記 |

---

## 12. Start date 同期実装（2026-04-15）

### 変更内容

Due Date の実装パターンをそのまま踏襲し、最小変更で対応した。

| 変更箇所 | 内容 |
|---------|------|
| `normalizeGitHubProjectItem()` | `getField('Start date')` 追加、return に `startDate` 追加 |
| `mapGitHubItemToBacklogIssue()` | `payload.startDate = normalizedItem.startDate` |
| `buildBacklogUpdateParams()` | `normalizeDueDate()` を流用した日付比較を追加 |
| `createBacklogIssue()` | `payload.startDate` があれば POST に追加 |
| `updateBacklogIssue()` | `updateParams.startDate` があれば PATCH に追加 |
| self-test | startDate の差分あり / なし の 2 ケースを追加（9 → 11 passed） |
| `DEBUG_DUE_DATE_SYNC` | Start date の取得・比較結果も同時にログ出力するよう拡張 |

### 注意事項

- GitHub プロジェクトに `"Start date"` フィールドがない場合は `startDate: null` になる
- `null` を PATCH すると Backlog の開始日をクリアする（空文字送信）
- フィールド名は `getField` の大小文字無視照合で吸収されるため、`"Start Date"` も対応済み

### 本番同期結果（2026-04-15）

**Step 1: 1 件確認（LIMIT=1）**

SUISHIN_DIV-48「フェーズ1実績指標を集計する」で 1 件先行確認。
Backlog の開始日に `2026-04-08` が反映されたことを確認。description 崩れなし。

**Step 2: 全件同期（LIMIT なし）**

```
create : 0
update : 46
skip   : 6
Draft  : 0
```

46 件すべてに `startDate` が反映された。skip 6 件は GitHub 側も Backlog 側も開始日が未設定または一致のため正常 skip。

**最終状態**

GitHub Project の Start date・Due Date・担当者・ステータス・タイトル・説明の全フィールドが Backlog に同期済み。  
`create: 0 / update: 0 / skip: 全件` の完全一致状態を再確認済み。

---

## 残タスク / 今後の拡張

### 優先度：高（運用に入るために必要）
- [ ] GitHub 側ページネーション対応（100件以上対応）
- [ ] GitHub Actions での定期実行（Secrets 設定含む）
- [ ] エラーハンドリング（1件失敗時の継続 or 停止制御）
- [x] assigneeMap 未定義ユーザーの扱い：完了 → [unmapped-assignee-policy.md](unmapped-assignee-policy.md)
  - warn only 実装済み（ASSIGNEE_UNMAPPED センチネル）
  - 大野 / 潮田 / 石丸 を assigneeMap に追加済み
  - Owner フィールド（text 型）からの読み取りに対応
  - force assignee sync で 1 件確認後、50 件 update 完了（2026-04-15）

### 優先度：中（運用安定・改善）
- [ ] ログの構造化（JSON出力 or 保存）
- [ ] 差分検知のユニットテスト追加
- [ ] dry-run 結果の保存（監査・比較用）

### 優先度：低（拡張）
- [x] **Start date 同期**（GitHub 開始日 → Backlog `startDate`）：実装・全件本番同期完了（2026-04-15）
- [ ] コメント同期（GitHub → Backlog）
- [ ] 双方向同期（Backlog → GitHub）
- [ ] UI（同期結果の可視化）

### 技術的な気づき・今後の設計メモ
- Backlog create API は statusId を受け付けないため、初回は未対応→次回 update が必要
- sync metadata を description に埋め込む設計はシンプルで有効
- 差分検知で Last synced を除外する設計が重要
* dry-runが精神的にもめちゃくちゃ効いた