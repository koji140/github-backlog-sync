# フィールドマッピング仕様

GitHub Project の各項目を Backlog のどのフィールドに対応させるかを定義します。

## 基本フィールド対応表

| GitHub Projects フィールド | Backlog フィールド | 備考 |
|---------------------------|-------------------|------|
| Item Title | 件名（summary） | そのまま転写 |
| Item Body（Issue 本文） | 詳細（description） | sync metadata を末尾に付与する |
| Status | 状態（status） | 後述のステータスマッピングを参照 |
| Assignees | 担当者（assignee） | 後述の担当者マッピングを参照 |
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

## 今後の検討項目

- [ ] Backlog の「カテゴリー」「マイルストーン」と GitHub の Labels / Milestone の対応
- [ ] Backlog の「優先度」と GitHub の Priority カスタムフィールドの対応
- [ ] 差分更新の基準: sync metadata の `Last synced` vs GitHub webhook イベントの `updated_at`
