# フィールドマッピング仕様

GitHub Project の各項目を Backlog のどのフィールドに対応させるかを定義します。

## 基本フィールド対応表

| GitHub Projects フィールド | Backlog フィールド | 備考 |
|---------------------------|-------------------|------|
| Item Title | 件名（summary） | そのまま転写 |
| Item Body（Issue 本文） | 詳細（description） | sync metadata を末尾に付与する |
| Status | 状態（status） | 後述のステータスマッピングを参照 |
| Assignees | 担当者（assignee） | 後述の担当者マッピングを参照 |
| **Due Date**（日付フィールド） | **期限日（`dueDate`）** | **実装済み**（GitHub のフィールド名は `Due Date` / `Due date` など大小混在でも `getField` で照合） |
| **Start date**（開始日） | **開始日（`startDate`）** | **実装済み**（GitHub のフィールド名 `Start date` を使用。`getField` で大小文字無視照合） |
| Parent issue | 親課題（`parentIssueId`） | **実装済み**。GitHub の親Issueに対応する Backlog 課題IDを設定する |
| GitHub Issue URL | description 内の sync metadata | Backlog から元 Issue を追跡可能にする |

## ステータス対応表（たたき台）

以下はデフォルト案です。プロジェクト固有の名称に合わせて `config/mapping.json` で上書きしてください。

| GitHub Status | Backlog ステータス | Backlog status ID |
|--------------|-------------------|-------------------|
| Todo / Backlog | 未対応 | 1 |
| In Progress | 処理中 | 2 |
| In Review | 処理中 | 2 |
| Done | 完了 | 4 |
| Closed / Cancelled | 完了 | 4 |

> Backlog のステータス ID はプロジェクトによって異なる場合があります。
> 実際の ID は Backlog API `GET /api/v2/projects/:projectKey/statuses` で確認してください。

## 担当者マッピングの考え方

GitHub のユーザー名と Backlog のユーザー ID は別システムのため、直接の自動マッピングはできません。
`config/mapping.json` の `assigneeMap` に手動でマッピングテーブルを定義します。

```json
{
  "assigneeMap": {
    "github-username-1": 123456,
    "github-username-2": 234567
  }
}
```

- GitHub 側に担当者がいない場合: Backlog の担当者は未設定のままにする
- GitHub 側のユーザーが `assigneeMap` に存在しない場合: 担当者は未設定とし、ログに警告を出す

### Backlog → GitHub 担当者同期の注意

Backlog → GitHub 同期では、`assigneeMap` を逆引きして Backlog userId から GitHub login を求めます。  
ただし現行運用では、`config/mapping.json` の `assigneeMap` に GitHub login ではなく Project Owner 表示名（例: `石丸`, `大野`, `潮田`）が入っている場合があります。

- GitHub Issue assignee に送れるのは実 GitHub login のみです。
- `石丸` など GitHub login として無効な値は、担当者同期だけ警告付きでスキップします。
- Status 同期は継続します。
- 担当者も Backlog → GitHub で同期したい場合は、`assigneeMap` / `reverseAssigneeMap` を実 GitHub login で整備してください。

## sync metadata 仕様

Backlog 課題の詳細（description）末尾に以下のブロックを付与します。
これにより、Backlog 課題から GitHub の元アイテムを追跡できます。

```
---
<!-- github-backlog-sync -->
GitHub Issue: https://github.com/<org>/<repo>/issues/<number>
GitHub Project Item ID: <projectItemId>
Last synced: 2026-04-14T12:00:00Z
<!-- /github-backlog-sync -->
```

### metadata の役割

| フィールド | 用途 |
|-----------|------|
| GitHub Issue URL | 元 Issue への直接リンク |
| GitHub Project Item ID | 同期済みチェック・差分更新の基準キー |
| Last synced | 最終同期日時（デバッグ・監査用） |

> 将来的には Backlog 課題の `externalKey` や カスタムフィールドを活用する方法も検討します。

## Due Date 同期の仕様詳細

### フィールド名の照合

`getField()` は大小文字を無視して照合するため、GitHub プロジェクト側のフィールド名が  
`"Due Date"` でも `"Due date"` でも正しく取得されます。

```js
const getField = (fieldName) =>
  fieldNodes.find(
    (n) => n?.field?.name?.toLowerCase() === fieldName.toLowerCase()
  );
```

### 日付の正規化比較

Backlog API は `dueDate` を `"2026-04-30T00:00:00Z"` 形式で返します。  
GitHub は `"2026-04-30"` のみ返します。  
`normalizeDueDate()` で先頭 10 文字（`YYYY-MM-DD`）に揃えてから比較するため、フォーマット差異では差分とみなされません。

### skip（差分なし）の挙動

GitHub と Backlog の期限日がすでに一致している場合、`buildBacklogUpdateParams()` は `null` を返し、  
その課題の update はスキップされます。これは **正常動作** です（不要な update の防止）。

> **調査メモ（2026-04-15）**  
> `DEBUG_DUE_DATE_SYNC=true` で issue #5 を検証。`fieldValues` 10 件中に `Due date: "2026-04-14"` が含まれており、  
> `normalizedItem.dueDate` / `payload.dueDate` ともに `"2026-04-14"` が格納された。  
> Backlog 側も `"2026-04-14T00:00:00Z"` → 正規化後 `"2026-04-14"` で一致。  
> `buildBacklogUpdateParams` 結果は `null`（skip）。Due Date の取得・比較ロジックは正常に動作していることを確認。

## Start date 同期の仕様詳細

### フィールド名の照合

`getField('Start date')` で取得。`getField` は大小文字無視のため `"Start Date"` / `"Start date"` 等の表記ゆれを吸収します。

### 日付の正規化比較

Due Date と同じく `normalizeDueDate()` を使用。Backlog API が `"T00:00:00Z"` 付きで返しても先頭 10 文字で比較します。

### GitHub 側にフィールドがない場合

GitHub プロジェクトに `"Start date"` フィールドがない、または値が未設定の場合、`startDate` は `null` になります。  
Backlog 側に値がある場合は差分として検出され、空文字を PATCH して Backlog の開始日をクリアします。

> フィールド名が環境によって異なる場合（例: `"Start Date"` vs `"Start date"`）は `getField` が吸収しますが、  
> まったく別名（例: `"開始日"`）の場合は `mapping.json` に `githubStartDateFieldName` キーを追加する拡張を将来検討。

## 親Issueの日付集計ルール

親Issueの期間は、親Issue自身に入力された日付ではなく、直接の子Issueの日付から自動集計します。

- 親Issueの `startDate` は、子Issueの `startDate` のうち最も早い日付にする。
- 親Issueの `dueDate` は、子Issueの `dueDate` のうち最も遅い日付にする。
- 子Issue側に該当する日付が 1 件もない場合、その親Issueの該当日付は未設定として同期する。
- 子Issueを持たないIssueの日付は、GitHub Project の値をそのまま同期する。
- この集計は Backlog payload 作成前に行うため、Backlog には集計後の親Issue期間が反映される。

## 親子関係同期の仕様

GitHub Issue の parent issue を取得し、対応する Backlog 課題の `id` を子課題の `parentIssueId` として同期します。

- 親Issueと子Issueの対応は、Backlog description 末尾の sync metadata にある `GitHub Issue` URL で照合します。
- GitHub 側に親Issueがない場合、Backlog 側に既存の親課題があれば `parentIssueId` を空にしてクリアします。
- GitHub 側に親Issueがあっても、その親Issueに対応する Backlog 課題が見つからない場合は警告を出してスキップします。
- 通常の create/update の後に親子関係を同期するため、同じ同期回で作成された親課題も参照できます。

## 識別子（A. 識別子の統一）

### 識別子とは

`[I-01]` や `[親I-55]` のような形式のプレフィックスで、GitHub と Backlog の両方で同じタスクを一目で識別できるようにするものです。

### 識別子の付与ルール

| 項目 | 内容 |
|------|------|
| 形式 | 角括弧内に `I-数字` を含む形式（例: `[I-01]`, `[親I-55]`） |
| 付与場所 | GitHub Issue の title の先頭 |
| Backlog への反映 | スクリプトが GitHub title の識別子をそのまま Backlog summary の先頭に使う |
| 二重付与の防止 | title に識別子が既にある場合は付与しない |

### 責務の分担

| 責務 | 担当 |
|------|------|
| GitHub Issue の title に `[I-xx]` または `[親I-xx]` を付ける | **GitHub 側の運用**（このリポジトリの外） |
| title から識別子を抽出して Backlog summary に使う | **このリポジトリのスクリプト** |
| 識別子なし title の警告ログ | **このリポジトリのスクリプト** |

### GitHub 側の運用ルール

新しい GitHub Issue を作成する際は、title の先頭に `[I-xx]` 形式の識別子を付けてください。親Issueの場合は `[親I-xx]` を使えます。

```
[I-01] フェーズ1実績指標を集計する
[I-02] 局FBメモの傾向をまとめる
[I-03] フェーズ1KPTを整理する
[親I-55] 入力フォーム・HP導線修正を完了する
```

- `I-` は固定プレフィックス（プロジェクトで統一）
- 親Issueは `親I-` を使い、通常の作業Issueと区別してよい
- 番号はゼロ埋め2桁推奨（例: `01`, `02`）
- 既存 Issue に後から識別子を付ける場合も同じ形式に揃える

### 識別子がない場合の挙動

スクリプトは `[Identifier] 識別子なし:` ログを出力し、title をそのまま Backlog summary に使います。  
同期は継続します（エラーにはなりません）。

---

## 内部パス → 表示名マッピング（B. Backlog 向け表示変換）

### 目的

Backlog 利用者は GitHub にアクセスできないため、`docs/phase2-tasklist.md` のような内部パスを  
そのまま Backlog の description に表示しても意味が分かりません。  
`config/mapping.json` の `sourcePathMap` で人間向けの表示名に変換します。

### 設定方法

`config/mapping.json` に `sourcePathMap` を追加します。

```json
{
  "sourcePathMap": {
    "docs/phase2-tasklist.md":      "フェーズ2タスク一覧",
    "docs/phase2-retrospective.md": "フェーズ2ふりかえり",
    "docs/phase1-kpt.md":           "フェーズ1KPT"
  }
}
```

### 変換が適用される箇所

`sourcePathMap` に登録済みのパスは、Backlog description の **2 箇所** で変換されます。

| 箇所 | 変換内容 |
|------|---------|
| 冒頭の「同期元情報」ブロック `元資料` フィールド | `docs/xxx.md` → 表示名 |
| GitHub Issue body 本文中に出現するパス | `docs/xxx.md` → 表示名（本文置換） |

### 対応する GitHub Issue body のパターン

| 形式 | 変換前 | 変換後 |
|------|--------|--------|
| Markdown リンク | `[任意テキスト](docs/phase2-tasklist.md)` | `[フェーズ2タスク一覧](docs/phase2-tasklist.md)` |
| プレーンテキスト | `docs/phase2-tasklist.md` | `フェーズ2タスク一覧` |

> Markdown リンクの場合はリンク先 URL を保持し、表示テキストのみ書き換えます。  
> これにより Backlog の内部管理用に元パスを残しつつ、表示は人間向けになります。  
> **注意:** Backlog 利用者は GitHub にアクセスできないため、Markdown リンクの URL（`docs/xxx.md`）を  
> クリックしても開けません。リンクは内部管理・将来の参照用として保持しているものであり、  
> Backlog 上で実際に参照できるのは表示テキスト（表示名）のみです。

### 安全設計（未登録パスはそのまま）

**`sourcePathMap` に登録済みのパスのみ**を置換します。  
未登録のパスはそのまま残るため、意図しない置換・情報欠損は発生しません。  
新しいドキュメントを追加した際は `mapping.json` の `sourcePathMap` にも追記してください。

---

## Backlog description の同期元情報ブロック（A-2 / B-2）

Backlog 利用者向けに、description の**冒頭**に同期元情報ブロックを挿入します。

```
## 同期元情報

* 識別子: I-03
* 元チケット: フェーズ1KPTを整理する
* 元資料: フェーズ2タスク一覧
* 元項目: No.15 フェーズ1KPTを整理する

---

（GitHub Issue の body）

---
<!-- github-backlog-sync -->
GitHub Issue: https://github.com/...
GitHub Project Item ID: PVTI_...
Last synced: 2026-04-14T12:00:00.000Z
<!-- /github-backlog-sync -->
```

### 各フィールドの取得方法

| フィールド | 取得元 | 補足 |
|-----------|--------|------|
| 識別子 | GitHub Issue title の `[I-xx]` | なければ行省略 |
| 元チケット | GitHub Issue title から識別子を除いたもの | 常に出力 |
| 元資料 | body の docs パスを `sourcePathMap` で変換 | パスが検出されない場合は行省略 |
| 元項目 | body の `No.N タイトル` パターン | 検出されない場合は行省略 |

### 元項目のカスタムパターン

デフォルト（`No.N タイトル`）以外のパターンを使う場合は `mapping.json` に  
`sourceItemPattern` として正規表現文字列を設定できます。

---

## 今後の検討項目

- [x] **Start date 同期**（GitHub 開始日 → Backlog `startDate`）：実装済み（2026-04-15）
- [x] **識別子の統一**（`[I-xx]` 形式の summary / description 冒頭ブロック）：実装済み（2026-04-15）
- [x] **内部パス → 表示名変換**（`sourcePathMap` 設定ベース）：実装済み（2026-04-15）
- [ ] Backlog の「カテゴリー」「マイルストーン」と GitHub の Labels / Milestone の対応
- [ ] Backlog の「優先度」と GitHub の Priority カスタムフィールドの対応
- [ ] 差分更新の基準: sync metadata の `Last synced` vs GitHub webhook イベントの `updated_at`
