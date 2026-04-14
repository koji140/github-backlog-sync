/**
 * sync-github-project-to-backlog.js
 *
 * GitHub Projects → Backlog 片方向同期スクリプト（スケルトン）
 *
 * 現在の状態: 骨組みのみ。各 TODO 箇所に実装を追加していく。
 *
 * 実行方法:
 *   node scripts/sync-github-project-to-backlog.js
 *   または npm start
 */

// ---------------------------------------------------------------------------
// 環境変数の読み込み
// ---------------------------------------------------------------------------

// TODO: dotenv を使う場合は以下を有効化
// import 'dotenv/config';

const config = {
  // GitHub 設定
  gh: {
    token: process.env.GH_TOKEN,
    org: process.env.GH_ORG,
    projectNumber: Number(process.env.GH_PROJECT_NUMBER),
  },
  // Backlog 設定
  backlog: {
    apiKey: process.env.BACKLOG_API_KEY,
    space: process.env.BACKLOG_SPACE,       // 例: "yourspace"
    projectKey: process.env.BACKLOG_PROJECT_KEY, // 例: "PROJ"
  },
};

// ---------------------------------------------------------------------------
// バリデーション
// ---------------------------------------------------------------------------

function validateConfig(cfg) {
  const required = [
    ['GH_TOKEN', cfg.gh.token],
    ['GH_ORG', cfg.gh.org],
    ['GH_PROJECT_NUMBER', cfg.gh.projectNumber],
    ['BACKLOG_API_KEY', cfg.backlog.apiKey],
    ['BACKLOG_SPACE', cfg.backlog.space],
    ['BACKLOG_PROJECT_KEY', cfg.backlog.projectKey],
  ];

  const missing = required.filter(([, val]) => !val).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`必要な環境変数が設定されていません: ${missing.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// GitHub Projects API（GraphQL v2）
// ---------------------------------------------------------------------------

/**
 * GitHub Project のアイテム一覧を取得する
 *
 * @returns {Promise<Array>} Project アイテムの配列
 *
 * TODO: GitHub GraphQL API を呼び出す実装を追加する
 *   - エンドポイント: https://api.github.com/graphql
 *   - 認証ヘッダー: Authorization: Bearer <GH_TOKEN>
 *   - クエリ例:
 *       query {
 *         organization(login: "<org>") {
 *           projectV2(number: <projectNumber>) {
 *             items(first: 100) {
 *               nodes {
 *                 id
 *                 fieldValues(first: 20) { nodes { ... } }
 *                 content { ... on Issue { title body url number } }
 *               }
 *             }
 *           }
 *         }
 *       }
 *   - ページネーション（after カーソル）の対応も必要
 */
async function fetchGitHubProjectItems() {
  // TODO: 実装
  console.log('[GitHub] Project アイテムの取得をスキップ（未実装）');
  return [];
}

// ---------------------------------------------------------------------------
// Backlog API（REST）
// ---------------------------------------------------------------------------

/**
 * Backlog の課題一覧を取得する（既存課題の重複チェック用）
 *
 * @returns {Promise<Array>} Backlog 課題の配列
 *
 * TODO: Backlog API を呼び出す実装を追加する
 *   - エンドポイント: https://<space>.backlog.com/api/v2/issues
 *   - 認証: クエリパラメータ ?apiKey=<BACKLOG_API_KEY>
 *   - projectId でフィルタリングし、description 内の sync metadata を確認して
 *     GitHub Project Item ID が一致する課題を特定する
 */
async function fetchBacklogIssues() {
  // TODO: 実装
  console.log('[Backlog] 課題一覧の取得をスキップ（未実装）');
  return [];
}

/**
 * Backlog に課題を新規作成する
 *
 * @param {object} issue - 作成する課題のデータ
 * @returns {Promise<object>} 作成された Backlog 課題
 *
 * TODO: Backlog API を呼び出す実装を追加する
 *   - エンドポイント: POST https://<space>.backlog.com/api/v2/issues
 *   - 必須パラメータ: projectId, summary, issueTypeId, priorityId
 *   - docs/mapping.md の sync metadata を description 末尾に付与すること
 */
async function createBacklogIssue(issue) {
  // TODO: 実装
  // issue は mapGitHubItemToBacklogIssue の返り値 { summary, description, statusId, ... }
  console.log(`[Backlog] 課題作成をスキップ（未実装）: ${issue.summary}`);
}

/**
 * Backlog の既存課題を更新する
 *
 * @param {number} issueId - 更新対象の Backlog 課題 ID
 * @param {object} updates - 更新内容
 * @returns {Promise<object>} 更新された Backlog 課題
 *
 * TODO: Backlog API を呼び出す実装を追加する
 *   - エンドポイント: PATCH https://<space>.backlog.com/api/v2/issues/:issueIdOrKey
 *   - ステータスマッピング・担当者マッピングを適用すること
 */
async function updateBacklogIssue(issueId, updates) {
  // TODO: 実装
  console.log(`[Backlog] 課題更新をスキップ（未実装）: issueId=${issueId}`);
}

// ---------------------------------------------------------------------------
// マッピング処理
// ---------------------------------------------------------------------------

/**
 * GitHub Project アイテムを Backlog 課題フォーマットに変換する
 *
 * @param {object} item - GitHub Project アイテム
 * @param {object} mapping - config/mapping.json の内容
 * @returns {object} Backlog 課題作成用のペイロード
 *
 * TODO: 実装
 *   - statusMap を使ってステータスを変換する
 *   - assigneeMap を使って担当者を変換する
 *   - sync metadata を description に付与する
 */
function mapGitHubItemToBacklogIssue(item, mapping) {
  // TODO: 実装
  // GitHub GraphQL API のレスポンス構造に注意:
  //   item.content.title  → Issue のタイトル
  //   item.content.body   → Issue の本文
  //   item.content.url    → Issue の URL（sync metadata に使用）
  //   item.id             → Project Item ID（sync metadata のキーに使用）
  //   fieldValues         → Status などカスタムフィールドの値
  return {
    summary: null,       // TODO: item.content.title
    description: '',     // TODO: item.content.body + sync metadata（docs/mapping.md 参照）
    statusId: null,      // TODO: mapping.statusMap[<StatusフィールドのValue名>]
    assigneeId: null,    // TODO: mapping.assigneeMap[<GitHubユーザー名>]
    issueTypeId: mapping.issueTypeId ?? null,
    priorityId: mapping.priorityId ?? 3, // デフォルト: 普通（Backlog priorityId=3）
  };
}

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== GitHub → Backlog 同期開始 ===');

  // 設定バリデーション
  validateConfig(config);
  console.log('[Config] 環境変数の読み込み完了');

  // TODO: config/mapping.json を読み込む
  // import { readFile } from 'fs/promises';
  // const mapping = JSON.parse(await readFile('./config/mapping.json', 'utf-8'));
  const mapping = {}; // TODO: 実装後に削除

  // Step 1: GitHub Project のアイテムを取得
  const githubItems = await fetchGitHubProjectItems();
  console.log(`[GitHub] 取得件数: ${githubItems.length}`);

  // Step 2: Backlog の既存課題を取得（重複防止）
  const backlogIssues = await fetchBacklogIssues();
  console.log(`[Backlog] 既存課題数: ${backlogIssues.length}`);

  // Step 3: 各アイテムを Backlog に同期
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of githubItems) {
    const payload = mapGitHubItemToBacklogIssue(item, mapping);

    // TODO: sync metadata を使って既存課題との照合を行う
    const existingIssue = null; // TODO: backlogIssues から検索

    if (existingIssue) {
      // TODO: 差分がある場合のみ更新する
      await updateBacklogIssue(existingIssue.id, payload);
      updated++;
    } else {
      await createBacklogIssue(payload);
      created++;
    }
  }

  console.log('=== 同期完了 ===');
  console.log(`  作成: ${created} 件`);
  console.log(`  更新: ${updated} 件`);
  console.log(`  スキップ: ${skipped} 件`);
}

// ---------------------------------------------------------------------------
// エントリーポイント
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('[ERROR]', err.message);
  process.exit(1);
});
