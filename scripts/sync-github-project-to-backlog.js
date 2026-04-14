/**
 * sync-github-project-to-backlog.js
 *
 * GitHub Projects → Backlog 片方向同期スクリプト
 *
 * 実装状況:
 *   [済] fetchGitHubProjectItems()    ... GitHub GraphQL API 呼び出し（1 ページ分）
 *   [済] normalizeGitHubProjectItem() ... GraphQL 生レスポンスを中間形式へ整形
 *   [済] buildSyncMetadataBlock()     ... Backlog description 末尾に付与する metadata ブロック生成
 *   [済] appendSyncMetadata()         ... description に metadata ブロックを付与
 *   [済] extractSyncMetadata()        ... Backlog description から sync metadata を解析
 *   [済] mapGitHubItemToBacklogIssue() ... normalize 済みアイテムを Backlog ペイロードへ変換
 *   [済] fetchBacklogIssues()         ... Backlog 課題一覧取得（offset ページネーション対応）
 *   [済] findExistingBacklogIssue()   ... sync metadata による照合（projectItemId → URL の優先順）
 *   [済] DRY_RUN モード              ... Backlog 書き込みなしで create/update/skip + 照合結果を確認
 *   [済] normalizeDescriptionForComparison() ... description を比較用に正規化（Last synced 除去）
 *   [済] runDescriptionNormalizationTests()  ... 正規化関数の動作確認（SELF_TEST=true で実行）
 *   [済] normalizeDueDate()           ... dueDate の比較用に日付文字列を正規化
 *   [済] buildBacklogUpdateParams()   ... 差分チェック（Last synced を除く比較で変更フィールドのみ抽出）
 *   [済] createBacklogIssue()         ... Backlog 課題新規作成（POST /api/v2/issues）
 *   [済] updateBacklogIssue()         ... Backlog 課題更新（PATCH /api/v2/issues/:id）
 *   [TODO] GitHub 側ページネーション  ... 100 件超のプロジェクトへの対応
 *
 * 実行方法:
 *   node scripts/sync-github-project-to-backlog.js
 *   DRY_RUN=true node scripts/sync-github-project-to-backlog.js
 *   または npm start / npm run dry-run
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// ESM での __dirname 相当（スクリプトの場所基準でパスを解決するために使用）
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// dotenv が存在する場合のみロード（存在しなければスキップ）
try {
  const dotenv = await import('dotenv');
  dotenv.config();
} catch {
  // dotenv 未インストール時は環境変数を直接参照する
}

// ---------------------------------------------------------------------------
// センチネル定数
// ---------------------------------------------------------------------------

/**
 * assigneeMap に GitHub ユーザーが存在しなかったことを示すセンチネル値。
 *
 * null との区別が必要な理由:
 *   - null   = GitHub 側に担当者がいない（意図的な未設定）→ Backlog 担当者もクリアしてよい
 *   - ASSIGNEE_UNMAPPED = GitHub 側に担当者はいるが assigneeMap に未定義
 *                         → warn only ポリシーにより Backlog 既存担当者を変えない
 *
 * warn only ポリシー詳細: docs/unmapped-assignee-policy.md
 */
const ASSIGNEE_UNMAPPED = Symbol('ASSIGNEE_UNMAPPED');

// ---------------------------------------------------------------------------
// 環境変数の読み込み
// ---------------------------------------------------------------------------

const config = {
  // GitHub 設定
  gh: {
    token:         process.env.GH_TOKEN,
    // GH_ORG は「owner login」を指す（org 名でも個人アカウント名でも可）
    owner:         process.env.GH_ORG,
    // GH_OWNER_TYPE: 'org'（デフォルト）または 'user'
    // organization project → 'org'（省略可）
    // user project（https://github.com/users/<login>/projects/<n>）→ 'user'
    ownerType:     process.env.GH_OWNER_TYPE || 'org',
    projectNumber: Number(process.env.GH_PROJECT_NUMBER),
  },
  // Backlog 設定（fetchBacklogIssues / create / update 実装後に必須になる）
  backlog: {
    apiKey:     process.env.BACKLOG_API_KEY,
    space:      process.env.BACKLOG_SPACE,        // 例: "yourspace"
    projectKey: process.env.BACKLOG_PROJECT_KEY,  // 例: "PROJ"
  },
  // dry-run: true なら Backlog への書き込み API を呼ばない
  dryRun: process.env.DRY_RUN === 'true',
  // limit: 正の整数なら Draft 除外後の先頭 N 件のみ処理する（未指定・空は全件）
  limit: process.env.LIMIT || '',
};

// ---------------------------------------------------------------------------
// バリデーション
// ---------------------------------------------------------------------------

function validateConfig(cfg) {
  // GitHub 側は取得に必要なため必須
  const requiredGh = [
    ['GH_TOKEN',          cfg.gh.token],
    ['GH_ORG',            cfg.gh.owner],
    ['GH_PROJECT_NUMBER', cfg.gh.projectNumber],
  ];

  // GH_OWNER_TYPE の値チェック
  if (!['org', 'user'].includes(cfg.gh.ownerType)) {
    throw new Error(
      `GH_OWNER_TYPE の値が不正です: "${cfg.gh.ownerType}"\n` +
      `有効な値: "org"（organization project）または "user"（user project）`
    );
  }
  const missingGh = requiredGh.filter(([, val]) => !val).map(([key]) => key);
  if (missingGh.length > 0) {
    throw new Error(`GitHub 環境変数が設定されていません: ${missingGh.join(', ')}`);
  }

  // LIMIT は空文字・未指定なら全件（有効時は正の整数のみ許容）
  if (cfg.limit !== '') {
    const parsed = Number(cfg.limit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `LIMIT の値が不正です: "${cfg.limit}"\n` +
        `正の整数を指定するか、全件処理する場合は LIMIT を未指定・空にしてください。`
      );
    }
  }

  // Backlog 側は同期実装まで任意（未設定の場合は警告のみ）
  const requiredBacklog = [
    ['BACKLOG_API_KEY',    cfg.backlog.apiKey],
    ['BACKLOG_SPACE',      cfg.backlog.space],
    ['BACKLOG_PROJECT_KEY', cfg.backlog.projectKey],
  ];
  const missingBacklog = requiredBacklog.filter(([, val]) => !val).map(([key]) => key);
  if (missingBacklog.length > 0) {
    console.warn(
      `[Config] Backlog 環境変数が未設定のため Backlog 同期はスキップされます: ${missingBacklog.join(', ')}`
    );
  }
}

// ---------------------------------------------------------------------------
// mapping.json 読み込み
// ---------------------------------------------------------------------------

/**
 * config/mapping.json を読み込んで返す
 *
 * スクリプトの場所（scripts/）から 1 つ上の config/ を参照するため、
 * import.meta.url ベースのパスで解決する。これにより、どのディレクトリから
 * node コマンドを実行しても同じファイルを参照できる。
 *
 * @returns {Promise<object>} mapping.json の内容
 * @throws {Error} ファイルが存在しない場合、または JSON として不正な場合
 */
async function loadMapping() {
  const mappingPath = resolve(__dirname, '..', 'config', 'mapping.json');
  let raw;
  try {
    raw = await readFile(mappingPath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `config/mapping.json が見つかりません。\n` +
        `以下のコマンドで mapping.example.json をコピーして作成してください:\n` +
        `  cp config/mapping.example.json config/mapping.json\n` +
        `その後、mapping.json の各 ID を実際の値に書き換えてください（docs/mapping.md 参照）。\n` +
        `参照パス: ${mappingPath}`
      );
    }
    throw new Error(`config/mapping.json の読み込みに失敗しました: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `config/mapping.json の JSON パースに失敗しました。\n` +
      `ファイルの内容を確認してください（コメント記法など JSON 非準拠の記法がないか）。\n` +
      `パースエラー: ${err.message}`
    );
  }

  // 必須フィールドの存在チェック（値の妥当性はここでは問わない）
  const required = ['statusMap', 'assigneeMap', 'issueTypeId', 'priorityId', 'projectId'];
  const missing = required.filter((k) => !(k in parsed));
  if (missing.length > 0) {
    throw new Error(
      `config/mapping.json に必須フィールドが不足しています: ${missing.join(', ')}\n` +
      `config/mapping.example.json を参考に不足フィールドを追加してください。`
    );
  }

  // projectId は Backlog API 取得・課題作成の必須パラメータのため、正の整数であることを確認する。
  // mapping.example.json のプレースホルダー値（0）のまま使うと API でエラーになるため、ここで検出する。
  if (typeof parsed.projectId !== 'number' || parsed.projectId <= 0) {
    throw new Error(
      `config/mapping.json の projectId が未設定または無効です（現在: ${parsed.projectId}）。\n` +
      `Backlog API で正しい値を確認してください:\n` +
      `  GET https://<space>.backlog.com/api/v2/projects/<projectKey>  （要 apiKey）\n` +
      `レスポンス JSON の "id" フィールド（正の整数）を mapping.json の projectId に設定してください。`
    );
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// GitHub Projects API（GraphQL v2）
// ---------------------------------------------------------------------------

/**
 * GitHub ProjectV2 のアイテム一覧を 1 ページ分取得する
 *
 * @returns {Promise<{ nodes: Array, pageInfo: { hasNextPage: boolean, endCursor: string|null } }>}
 *
 * TODO: ページネーション対応（pageInfo.hasNextPage が true の場合に endCursor を使って再帰呼び出し）
 */
async function fetchGitHubProjectItems() {
  const { token, owner, ownerType, projectNumber } = config.gh;

  // ページネーション変数（現時点は 1 ページ目のみ）
  const cursor = null; // TODO: ページネーション本実装時に引数化する

  // ownerType に応じて organization / user を切り替える
  // - 'org'  → organization project（デフォルト）
  // - 'user' → user project（https://github.com/users/<login>/projects/<n>）
  const ownerEntity = ownerType === 'user' ? 'user' : 'organization';

  const query = `
    query FetchProjectItems($owner: String!, $projectNumber: Int!, $cursor: String) {
      ${ownerEntity}(login: $owner) {
        projectV2(number: $projectNumber) {
          title
          items(first: 100, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              type
              fieldValues(first: 20) {
                nodes {
                  ... on ProjectV2ItemFieldTextValue {
                    text
                    field {
                      ... on ProjectV2FieldCommon { name }
                    }
                  }
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field {
                      ... on ProjectV2FieldCommon { name }
                    }
                  }
                  ... on ProjectV2ItemFieldDateValue {
                    date
                    field {
                      ... on ProjectV2FieldCommon { name }
                    }
                  }
                }
              }
              content {
                ... on Issue {
                  title
                  body
                  url
                  number
                  assignees(first: 10) {
                    nodes { login }
                  }
                  labels(first: 10) {
                    nodes { name }
                  }
                }
                ... on PullRequest {
                  title
                  body
                  url
                  number
                  assignees(first: 10) {
                    nodes { login }
                  }
                  labels(first: 10) {
                    nodes { name }
                  }
                }
                ... on DraftIssue {
                  title
                  body
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'github-backlog-sync/0.1.0',
    },
    body: JSON.stringify({
      query,
      variables: { owner, projectNumber, cursor },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub GraphQL API エラー: HTTP ${response.status}\nレスポンス本文:\n${body}`
    );
  }

  const json = await response.json();

  if (json.errors) {
    throw new Error(
      `GitHub GraphQL エラー:\n${JSON.stringify(json.errors, null, 2)}`
    );
  }

  // ownerType に応じて organization / user どちらのデータを取り出すかを決める
  const ownerData = ownerType === 'user' ? json.data?.user : json.data?.organization;
  const itemsConnection = ownerData?.projectV2?.items;
  if (!itemsConnection) {
    throw new Error(
      `プロジェクトが見つかりません: ownerType=${ownerType}, owner=${owner}, projectNumber=${projectNumber}\n` +
      `GH_OWNER_TYPE が正しいか確認してください（organization project → 'org', user project → 'user'）\n` +
      `レスポンス:\n${JSON.stringify(json.data, null, 2)}`
    );
  }

  const projectTitle = ownerData.projectV2.title;
  console.log(`[GitHub] プロジェクト: "${projectTitle}"`);

  // TODO: ページネーション対応
  // pageInfo.hasNextPage が true の場合は endCursor を使って次のページを取得する必要がある
  if (itemsConnection.pageInfo.hasNextPage) {
    console.warn(
      `[GitHub] 注意: アイテムが 100 件を超えています。現在は 1 ページ目のみ取得しています。` +
      ` endCursor="${itemsConnection.pageInfo.endCursor}"`
    );
  }

  return {
    nodes:    itemsConnection.nodes,
    pageInfo: itemsConnection.pageInfo,
  };
}

// ---------------------------------------------------------------------------
// 中間形式への整形
// ---------------------------------------------------------------------------

/**
 * GitHub GraphQL の生アイテムを扱いやすい中間形式に整形する
 *
 * @param {object} rawItem - fetchGitHubProjectItems() が返す nodes 配列の 1 要素
 * @returns {{
 *   projectItemId: string,
 *   contentType: string,
 *   isDraft: boolean,
 *   title: string|null,
 *   body: string|null,
 *   url: string|null,
 *   number: number|null,
 *   assigneeLogins: string[],
 *   labelNames: string[],
 *   statusName: string|null,
 *   dueDate: string|null,
 * }}
 */
function normalizeGitHubProjectItem(rawItem) {
  const isDraft = rawItem.type === 'DRAFT_ISSUE';
  const content = rawItem.content ?? {};

  // fieldValues から名前付きフィールドを抽出するヘルパー
  const fieldNodes = rawItem.fieldValues?.nodes ?? [];
  const getField = (fieldName) =>
    fieldNodes.find(
      (n) => n?.field?.name?.toLowerCase() === fieldName.toLowerCase()
    );

  const statusField  = getField('Status');
  const dueDateField = getField('Due Date');

  return {
    projectItemId:  rawItem.id,
    contentType:    rawItem.type,   // ISSUE | PULL_REQUEST | DRAFT_ISSUE
    isDraft,
    title:          content.title ?? null,
    body:           content.body  ?? null,
    url:            content.url   ?? null,    // Draft にはない
    number:         content.number ?? null,   // Draft にはない
    assigneeLogins: (content.assignees?.nodes ?? []).map((n) => n.login),
    labelNames:     (content.labels?.nodes   ?? []).map((n) => n.name),
    statusName:     statusField?.name  ?? null,
    dueDate:        dueDateField?.date ?? null,
  };
}

// ---------------------------------------------------------------------------
// sync metadata 処理
// ---------------------------------------------------------------------------

/**
 * Backlog description 末尾に付与する sync metadata ブロックを生成する
 *
 * 生成例:
 *   ---
 *   <!-- github-backlog-sync -->
 *   GitHub Issue: https://github.com/org/repo/issues/42
 *   GitHub Project Item ID: PVTI_lADOA...
 *   Last synced: 2026-04-14T12:00:00.000Z
 *   <!-- /github-backlog-sync -->
 *
 * @param {object} normalizedItem - normalizeGitHubProjectItem() の返り値
 * @param {object} syncMetadataCfg - mapping.json の syncMetadata 設定（任意）
 * @returns {string} metadata ブロック文字列
 */
function buildSyncMetadataBlock(normalizedItem, syncMetadataCfg = {}) {
  const markerOpen  = syncMetadataCfg.markerOpen  ?? '<!-- github-backlog-sync -->';
  const markerClose = syncMetadataCfg.markerClose ?? '<!-- /github-backlog-sync -->';
  const now         = new Date().toISOString();

  const lines = [
    '---',
    markerOpen,
    `GitHub Issue: ${normalizedItem.url ?? '(Draft - URL なし)'}`,
    `GitHub Project Item ID: ${normalizedItem.projectItemId}`,
    `Last synced: ${now}`,
    markerClose,
  ];
  return lines.join('\n');
}

/**
 * description 末尾に sync metadata ブロックを付与する
 *
 * 既存の metadata ブロック（再同期時）は上書きせず常に末尾に追記する。
 * （重複防止は将来の差分更新実装で対処する予定）
 *
 * @param {string|null} description - GitHub item の body
 * @param {string} metadataBlock    - buildSyncMetadataBlock() の返り値
 * @returns {string}
 */
function appendSyncMetadata(description, metadataBlock) {
  const base = (description ?? '').trimEnd();
  return base ? `${base}\n\n${metadataBlock}` : metadataBlock;
}

/**
 * Backlog 課題の description から sync metadata を解析する
 *
 * 対象ブロック形式（buildSyncMetadataBlock の出力と対応）:
 *   <!-- github-backlog-sync -->
 *   GitHub Issue: https://...
 *   GitHub Project Item ID: PVTI_...
 *   Last synced: 2026-04-14T12:00:00.000Z
 *   <!-- /github-backlog-sync -->
 *
 * フィールドの追加や順序変更には対応している。
 * マーカーが存在しない場合、または projectItemId と url の両方が取得できない場合は null を返す。
 *
 * @param {string|null|undefined} description - Backlog 課題の description
 * @returns {{ githubProjectItemId: string|null, githubUrl: string|null, lastSynced: string|null } | null}
 */
function extractSyncMetadata(description) {
  if (!description) return null;

  // マーカー間のブロックを抽出（[\s\S]*? で改行を含む最小マッチ）
  const blockMatch = description.match(
    /<!-- github-backlog-sync -->([\s\S]*?)<!-- \/github-backlog-sync -->/
  );
  if (!blockMatch) return null;

  const block = blockMatch[1];

  // 各フィールドを行単位で抽出（行末の空白をトリム）
  const githubUrl            = block.match(/^GitHub Issue:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const githubProjectItemId  = block.match(/^GitHub Project Item ID:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const lastSynced           = block.match(/^Last synced:\s*(.+)$/m)?.[1]?.trim() ?? null;

  // 照合に使えるキーが一つもない場合は metadata なしとみなす
  if (!githubProjectItemId && !githubUrl) return null;

  return { githubProjectItemId, githubUrl, lastSynced };
}

// ---------------------------------------------------------------------------
// description 差分判定用正規化
// ---------------------------------------------------------------------------

/**
 * description を差分比較専用に正規化する
 *
 * sync metadata ブロック内の `Last synced:` 行だけを除去し、
 * 末尾の余分な空白・改行を trim して返す。
 * それ以外の本文・metadata（GitHub Issue URL / Project Item ID）は保持する。
 *
 * これにより「Last synced タイムスタンプの更新だけ」では差分ありと判定されなくなる。
 * ── Backlog に送る実際の description 本文には使わない（比較専用）。
 *
 * @param {string|null|undefined} description
 * @returns {string} 比較用に正規化された文字列（入力が null/undefined なら ''）
 */
function normalizeDescriptionForComparison(description) {
  if (!description) return '';

  // sync metadata ブロック（マーカー間）の Last synced 行だけを除去する。
  // ブロック外の本文には手を加えない。
  const result = description.replace(
    /<!-- github-backlog-sync -->([\s\S]*?)<!-- \/github-backlog-sync -->/,
    (_match, inner) => {
      // 行末の \r\n / \n を含めて削除する
      const withoutLastSynced = inner.replace(/^Last synced:\s*.+\r?\n?/m, '');
      return `<!-- github-backlog-sync -->${withoutLastSynced}<!-- /github-backlog-sync -->`;
    }
  );

  // 末尾の空白・改行を取り除いてノイズを吸収する
  return result.trimEnd();
}

/**
 * normalizeDescriptionForComparison の動作を確認する自己テスト
 *
 * SELF_TEST=true の場合に main() の前に実行される。
 * テストに失敗した場合は process.exit(1) で終了する。
 */
function runDescriptionNormalizationTests() {
  console.log('=== normalizeDescriptionForComparison 自己確認テスト ===\n');

  let passed = 0;
  let failed = 0;

  /** @param {string} label @param {boolean} ok */
  function check(label, ok) {
    if (ok) {
      console.log(`  PASS: ${label}`);
      passed++;
    } else {
      console.error(`  FAIL: ${label}`);
      failed++;
    }
  }

  // テスト用 description を生成するヘルパー
  const makeDesc = (body, url, itemId, lastSynced) => {
    const meta = [
      '---',
      '<!-- github-backlog-sync -->',
      `GitHub Issue: ${url}`,
      `GitHub Project Item ID: ${itemId}`,
      `Last synced: ${lastSynced}`,
      '<!-- /github-backlog-sync -->',
    ].join('\n');
    return body ? `${body}\n\n${meta}` : meta;
  };

  const URL  = 'https://github.com/org/repo/issues/1';
  const ID   = 'PVTI_aaa';
  const OLD  = '2026-04-01T00:00:00.000Z';
  const NEW  = '2026-04-14T12:34:56.789Z';

  // Case 1: Last synced のみ異なる → 正規化後は同じ → update しない
  const c1a = makeDesc('本文', URL, ID, OLD);
  const c1b = makeDesc('本文', URL, ID, NEW);
  check(
    'Last synced のみ異なる → 正規化後は同じ',
    normalizeDescriptionForComparison(c1a) === normalizeDescriptionForComparison(c1b)
  );

  // Case 2: 本文が変わった → 正規化後も異なる → update する
  const c2a = makeDesc('旧本文', URL, ID, OLD);
  const c2b = makeDesc('新本文', URL, ID, NEW);
  check(
    '本文が変わった → 正規化後も異なる',
    normalizeDescriptionForComparison(c2a) !== normalizeDescriptionForComparison(c2b)
  );

  // Case 3: GitHub URL / Project Item ID が変わった → 正規化後も異なる
  const c3a = makeDesc('本文', 'https://github.com/org/repo/issues/1', 'PVTI_aaa', OLD);
  const c3b = makeDesc('本文', 'https://github.com/org/repo/issues/2', 'PVTI_bbb', NEW);
  check(
    'GitHub URL / Item ID が変わった → 正規化後も異なる',
    normalizeDescriptionForComparison(c3a) !== normalizeDescriptionForComparison(c3b)
  );

  // Case 4: sync metadata なし → 本文のみで比較
  const c4 = '本文のみ（sync metadata なし）';
  check(
    'sync metadata なし → 同じ本文なら正規化後も同じ',
    normalizeDescriptionForComparison(c4) === normalizeDescriptionForComparison(c4)
  );

  // Case 5: null / undefined → '' として扱う
  check('null → 空文字',      normalizeDescriptionForComparison(null)      === '');
  check('undefined → 空文字', normalizeDescriptionForComparison(undefined) === '');
  check('空文字 → 空文字',    normalizeDescriptionForComparison('')        === '');

  // Case 6: buildBacklogUpdateParams との統合 ─ Last synced のみ変化では null を返すこと
  const backlogIssue = { summary: 'タイトル', description: c1a, assignee: null, dueDate: null, status: { id: 1 } };
  const payload      = { summary: 'タイトル', description: c1b, assigneeId: null, dueDate: null, statusId: 1,
                         statusName: 'Todo', githubProjectItemId: ID, githubUrl: URL };
  const diffResult   = buildBacklogUpdateParams(backlogIssue, payload);
  check(
    'buildBacklogUpdateParams: Last synced のみ変化 → null（skip）',
    diffResult === null
  );

  // Case 7: summary 変化時は description も params に含まれること（Last synced リフレッシュ）
  const backlogIssue2 = { ...backlogIssue, summary: '旧タイトル' };
  const payload2      = { ...payload, summary: '新タイトル' };
  const diffResult2   = buildBacklogUpdateParams(backlogIssue2, payload2);
  check(
    'buildBacklogUpdateParams: summary 変化時は description も params に含まれる',
    diffResult2 !== null && 'summary' in diffResult2 && 'description' in diffResult2
  );

  console.log(`\n結果: ${passed} passed / ${failed} failed\n`);
  if (failed > 0) {
    console.error('自己確認テストに失敗しました。実装を確認してください。');
    process.exit(1);
  }
  console.log('すべてのテストが通過しました。');
}

// ---------------------------------------------------------------------------
// マッピング処理
// ---------------------------------------------------------------------------

/**
 * normalize 済みの GitHub アイテムを Backlog 課題フォーマットに変換する
 *
 * Draft は呼び出し前に除外されている前提（isDraft チェックはしない）。
 *
 * @param {object} normalizedItem - normalizeGitHubProjectItem() の返り値
 * @param {object} mapping        - loadMapping() の返り値
 * @returns {{
 *   summary: string,
 *   description: string,
 *   assigneeId: number|null|typeof ASSIGNEE_UNMAPPED,
 *   issueTypeId: number|null,
 *   priorityId: number,
 *   dueDate: string|null,
 *   statusId: number|null,
 *   statusName: string|null,
 *   githubProjectItemId: string,
 *   githubUrl: string|null,
 * }}
 *
 * assigneeId の値の意味:
 *   number           = マッピング済み Backlog ユーザー ID
 *   null             = GitHub 側に担当者なし（意図的な未設定）
 *   ASSIGNEE_UNMAPPED = GitHub 側に担当者はいるが assigneeMap に未定義
 *                       → buildBacklogUpdateParams() で diff 対象外になる（warn only）
 */
function mapGitHubItemToBacklogIssue(normalizedItem, mapping) {
  // --- summary ---
  const summary = normalizedItem.title ?? '(タイトルなし)';

  // --- assigneeId ---
  // GitHub 側に複数担当者がいる場合は先頭 1 名のみを対象にする
  let assigneeId = null;
  if (normalizedItem.assigneeLogins.length > 0) {
    const primaryLogin = normalizedItem.assigneeLogins[0];
    const mapped = mapping.assigneeMap?.[primaryLogin];
    if (mapped != null) {
      assigneeId = mapped;
    } else {
      // warn only ポリシー: Backlog 既存担当者をクリアしないようセンチネルを返す
      assigneeId = ASSIGNEE_UNMAPPED;
      console.warn(
        `[Map] 担当者マッピングなし: GitHub ユーザー "${primaryLogin}" は assigneeMap に存在しません。` +
        ` Backlog 既存担当者は変更しません（warn only）。`
      );
    }
    if (normalizedItem.assigneeLogins.length > 1) {
      console.warn(
        `[Map] 複数担当者: "${normalizedItem.title}" には ${normalizedItem.assigneeLogins.length} 名の担当者がいますが、` +
        ` Backlog には先頭 1 名 (${primaryLogin}) のみをマッピングします。`
      );
    }
  }

  // --- statusId ---
  let statusId = null;
  if (normalizedItem.statusName) {
    statusId = mapping.statusMap?.[normalizedItem.statusName] ?? null;
    if (statusId === null) {
      console.warn(
        `[Map] ステータスマッピングなし: GitHub Status "${normalizedItem.statusName}" は statusMap に存在しません。` +
        ` Backlog ステータスは未設定になります。`
      );
    }
  }

  // --- description + sync metadata ---
  const metadataBlock = buildSyncMetadataBlock(
    normalizedItem,
    mapping.syncMetadata
  );
  const description = appendSyncMetadata(normalizedItem.body, metadataBlock);

  return {
    summary,
    description,
    assigneeId,
    issueTypeId:         mapping.issueTypeId ?? null,
    priorityId:          mapping.priorityId  ?? 3,
    dueDate:             normalizedItem.dueDate,
    statusId,
    // GitHub 側の情報（照合・ログ用）
    statusName:          normalizedItem.statusName,
    githubProjectItemId: normalizedItem.projectItemId,
    githubUrl:           normalizedItem.url,
  };
}

// ---------------------------------------------------------------------------
// 既存 Backlog 課題との照合
// ---------------------------------------------------------------------------

/**
 * backlogIssues の中から mappedItem に対応する既存課題を探す
 *
 * 各 Backlog 課題の description を extractSyncMetadata() で解析し、
 * githubProjectItemId → githubUrl の優先順で照合する。
 * sync metadata を持たない課題は照合対象外。
 * 複数の候補が見つかった場合は警告ログを出して最初の 1 件を返す。
 *
 * @param {Array}  backlogIssues - fetchBacklogIssues() の返り値
 * @param {object} mappedItem    - mapGitHubItemToBacklogIssue() の返り値
 * @returns {{ issue: object|null, hadDuplicate: boolean }}
 *   issue: 一致した Backlog 課題オブジェクト（なければ null）
 *   hadDuplicate: 複数候補が見つかった場合 true
 */
function findExistingBacklogIssue(backlogIssues, mappedItem) {
  if (backlogIssues.length === 0) return { issue: null, hadDuplicate: false };

  const candidates = [];

  for (const issue of backlogIssues) {
    const meta = extractSyncMetadata(issue.description);
    if (!meta) continue; // sync metadata なし → 照合対象外

    // 優先順位 1: GitHub Project Item ID（最も信頼性が高い）
    const matchesById =
      meta.githubProjectItemId !== null &&
      meta.githubProjectItemId === mappedItem.githubProjectItemId;

    // 優先順位 2: GitHub URL（Item ID が変わった場合のフォールバック）
    const matchesByUrl =
      !matchesById &&
      meta.githubUrl !== null &&
      meta.githubUrl === mappedItem.githubUrl;

    if (matchesById || matchesByUrl) {
      candidates.push({
        issue,
        matchedBy: matchesById ? 'projectItemId' : 'url',
      });
    }
  }

  if (candidates.length === 0) {
    return { issue: null, hadDuplicate: false };
  }

  if (candidates.length > 1) {
    const ids = candidates.map((c) => `${c.issue.issueKey}(id=${c.issue.id})`).join(', ');
    console.warn(
      `[Match] 重複候補あり: "${mappedItem.summary}" に対して ${candidates.length} 件の Backlog 課題が一致しました。` +
      ` 先頭の ${candidates[0].issue.issueKey} を使用します。` +
      ` 候補: ${ids}`
    );
    return { issue: candidates[0].issue, hadDuplicate: true };
  }

  return { issue: candidates[0].issue, hadDuplicate: false };
}

// ---------------------------------------------------------------------------
// Backlog API（REST）
// ---------------------------------------------------------------------------

/**
 * dueDate 文字列を "YYYY-MM-DD" 形式に正規化する
 *
 * GitHub から来る値: "2026-04-30"（日付のみ）
 * Backlog API レスポンスの値: "2026-04-30T00:00:00Z" などタイムスタンプ付きの場合がある
 * → 先頭 10 文字（日付部分）で統一して比較する
 *
 * @param {string|null|undefined} dateStr
 * @returns {string|null} "YYYY-MM-DD" または null
 */
function normalizeDueDate(dateStr) {
  if (!dateStr) return null;
  return String(dateStr).slice(0, 10);
}

/**
 * 既存の Backlog 課題と新しい payload を比較し、変更があるフィールドだけを返す
 *
 * 比較対象:
 *   summary     : 文字列完全一致
 *   description : normalizeDescriptionForComparison() 後で比較（Last synced 行を除外）
 *   assigneeId  : backlogIssue.assignee?.id vs payload.assigneeId
 *   dueDate     : 日付部分 (YYYY-MM-DD) のみ比較
 *   statusId    : backlogIssue.status?.id vs payload.statusId
 *
 * description の比較で Last synced 行を除外することで、タイムスタンプの変化だけでは
 * 差分ありと判定されなくなる。
 *
 * 他のフィールドに差分があって update する場合は、description も params に含めて
 * Last synced をリフレッシュする（Backlog 側で最終同期日時が更新される）。
 *
 * @param {object} backlogIssue - fetchBacklogIssues() の返り値の 1 要素（Backlog API レスポンス）
 * @param {object} payload      - mapGitHubItemToBacklogIssue() の返り値
 * @returns {object|null} 変更フィールドを含むオブジェクト、変更なしなら null
 */
function buildBacklogUpdateParams(backlogIssue, payload) {
  const params = {};

  // summary
  if ((backlogIssue.summary ?? '') !== (payload.summary ?? '')) {
    params.summary = payload.summary;
  }

  // description: Last synced を除いた正規化後の値で比較する
  // → タイムスタンプのみの変化では diff なしとなりスキップされる
  const currentDescNorm = normalizeDescriptionForComparison(backlogIssue.description);
  const newDescNorm     = normalizeDescriptionForComparison(payload.description);
  if (currentDescNorm !== newDescNorm) {
    params.description = payload.description ?? '';
  }

  // assigneeId
  // ASSIGNEE_UNMAPPED の場合は warn only ポリシーにより diff 対象外（Backlog 既存担当者を維持）
  if (payload.assigneeId !== ASSIGNEE_UNMAPPED) {
    const currentAssigneeId = backlogIssue.assignee?.id ?? null;
    if (currentAssigneeId !== payload.assigneeId) {
      // payload.assigneeId が null の場合は空文字を送って担当者をクリアする
      params.assigneeId = payload.assigneeId;
    }
  }

  // dueDate（日付部分のみ比較）
  const currentDueDate = normalizeDueDate(backlogIssue.dueDate);
  const newDueDate     = normalizeDueDate(payload.dueDate);
  if (currentDueDate !== newDueDate) {
    params.dueDate = payload.dueDate; // null の場合は空文字に変換して送る（後述）
  }

  // statusId（payload が null の場合は変更しない）
  const currentStatusId = backlogIssue.status?.id ?? null;
  if (payload.statusId !== null && currentStatusId !== payload.statusId) {
    params.statusId = payload.statusId;
  }

  // description 以外のフィールドに差分があって Backlog を更新するなら、
  // description も送って Last synced をリフレッシュする（同期日時の鮮度を保つ）
  if (Object.keys(params).length > 0 && !('description' in params)) {
    params.description = payload.description ?? '';
  }

  return Object.keys(params).length > 0 ? params : null;
}

/**
 * Backlog の課題一覧を全件取得する（既存課題の重複チェック用）
 *
 * offset ページネーションで count=100 ずつ取得し、返却件数が PAGE_SIZE 未満になったら終了する。
 * DRY_RUN=true 時も実際に API を呼び出す（照合に必要なため）。
 *
 * @param {object} mapping - loadMapping() の返り値（mapping.projectId を使用）
 * @returns {Promise<Array>} Backlog 課題オブジェクトの配列（id / issueKey / summary / description を含む）
 */
async function fetchBacklogIssues(mapping) {
  const { apiKey, space } = config.backlog;

  // Backlog 環境変数は課題取得に必須（DRY_RUN 時も取得を実行するため）
  const missingBacklog = [
    !apiKey && 'BACKLOG_API_KEY',
    !space  && 'BACKLOG_SPACE',
  ].filter(Boolean);
  if (missingBacklog.length > 0) {
    throw new Error(
      `Backlog 課題取得に必要な環境変数が設定されていません: ${missingBacklog.join(', ')}\n` +
      `.env ファイルを確認してください。`
    );
  }

  const { projectId } = mapping; // loadMapping() で正の整数であることを検証済み

  const PAGE_SIZE = 100;
  const allIssues = [];
  let offset = 0;

  console.log(`[Backlog] 課題一覧を取得中... (projectId=${projectId})`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = new URL(`https://${space}.backlog.com/api/v2/issues`);
    url.searchParams.set('apiKey', apiKey);
    url.searchParams.append('projectId[]', String(projectId));
    url.searchParams.set('count', String(PAGE_SIZE));
    url.searchParams.set('offset', String(offset));

    const response = await fetch(url.toString());

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Backlog API エラー: HTTP ${response.status}` +
        ` (GET /api/v2/issues, projectId=${projectId}, offset=${offset})\n` +
        `レスポンス本文:\n${body}`
      );
    }

    const issues = await response.json();
    allIssues.push(...issues);

    if (issues.length < PAGE_SIZE) break; // このページが最終ページ
    offset += PAGE_SIZE;
    console.log(`[Backlog]   取得済み: ${allIssues.length} 件（続きを取得中...）`);
  }

  return allIssues;
}

/**
 * Backlog に課題を新規作成する
 *
 * DRY_RUN=true の場合は API を呼ばずに予定内容をログ出力して返す。
 *
 * @param {object}  payload  - mapGitHubItemToBacklogIssue() の返り値
 * @param {object}  mapping  - loadMapping() の返り値（projectId 取得用）
 * @param {boolean} dryRun
 * @returns {Promise<object|null>} 作成された Backlog 課題オブジェクト、または DRY_RUN 時は null
 */
async function createBacklogIssue(payload, mapping, dryRun) {
  if (dryRun) {
    const assigneeLog = payload.assigneeId === ASSIGNEE_UNMAPPED
      ? '未マッピング（送信しない・warn only）'
      : (payload.assigneeId ?? '未設定');
    console.log(`  [DRY-RUN] CREATE: "${payload.summary}"`);
    console.log(`    status: ${payload.statusName ?? '未設定'}（create 時は送信しない。次回 update で同期）`);
    console.log(`    assigneeId: ${assigneeLog}`);
    console.log(`    dueDate: ${payload.dueDate ?? '未設定'}`);
    console.log(`    githubUrl: ${payload.githubUrl ?? '(なし)'}`);
    return null;
  }

  const { apiKey, space } = config.backlog;

  // --- リクエストボディの組み立て（application/x-www-form-urlencoded）---
  const params = new URLSearchParams();
  params.set('projectId',   String(mapping.projectId));
  params.set('summary',     payload.summary);
  params.set('issueTypeId', String(payload.issueTypeId));
  params.set('priorityId',  String(payload.priorityId));

  // 任意パラメータ（値がある場合のみ追加）
  // ※ statusId は create API では受け付けられないため送らない。
  //   作成直後は Backlog のデフォルト状態（未対応）になる。
  //   次回 update 時に statusId が差分として検出され、そこで初めて同期される。
  if (payload.description)         params.set('description', payload.description);
  // ASSIGNEE_UNMAPPED（未マッピング）は送らない。null（GitHub 側に担当者なし）も送らない。
  if (payload.assigneeId != null && payload.assigneeId !== ASSIGNEE_UNMAPPED) {
    params.set('assigneeId', String(payload.assigneeId));
  }
  if (payload.dueDate)             params.set('dueDate',     payload.dueDate);

  const url = new URL(`https://${space}.backlog.com/api/v2/issues`);
  url.searchParams.set('apiKey', apiKey);

  let response;
  try {
    response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch (networkErr) {
    throw new Error(
      `[Backlog] 課題作成リクエスト失敗（ネットワークエラー）: "${payload.summary}"\n` +
      `  GitHub: ${payload.githubUrl ?? payload.githubProjectItemId}\n` +
      `  エラー: ${networkErr.message}`
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `[Backlog] 課題作成 API エラー: HTTP ${response.status} "${payload.summary}"\n` +
      `  GitHub: ${payload.githubUrl ?? payload.githubProjectItemId}\n` +
      `  レスポンス本文:\n${body}`
    );
  }

  const created = await response.json();
  console.log(`  [CREATE] 作成完了: ${created.issueKey} (id=${created.id}) "${created.summary}"`);
  return created;
}

/**
 * Backlog の既存課題を差分フィールドのみ更新する
 *
 * buildBacklogUpdateParams() で差分なし（null）と判定された場合はこの関数を呼ばない前提。
 * DRY_RUN=true の場合は API を呼ばずに変更予定フィールドをログ出力して返す。
 *
 * @param {object}  backlogIssue  - fetchBacklogIssues() の返り値の 1 要素（照合で見つかった既存課題）
 * @param {object}  payload       - mapGitHubItemToBacklogIssue() の返り値（エラーログ用コンテキスト含む）
 * @param {object}  updateParams  - buildBacklogUpdateParams() の返り値（差分フィールドのみ）
 * @param {boolean} dryRun
 * @returns {Promise<object|null>} 更新された Backlog 課題オブジェクト、または DRY_RUN 時は null
 */
async function updateBacklogIssue(backlogIssue, payload, updateParams, dryRun) {
  if (dryRun) {
    const changedFields = Object.keys(updateParams).join(', ');
    console.log(
      `  [DRY-RUN] UPDATE: ${backlogIssue.issueKey}(id=${backlogIssue.id})` +
      ` "${payload.summary}" [変更フィールド: ${changedFields}]`
    );
    return null;
  }

  const { apiKey, space } = config.backlog;

  // --- リクエストボディの組み立て（変更フィールドのみ）---
  const params = new URLSearchParams();

  if ('summary'     in updateParams) params.set('summary',     updateParams.summary);
  if ('description' in updateParams) params.set('description', updateParams.description ?? '');
  if ('assigneeId'  in updateParams) {
    // null の場合は空文字で Backlog 側の担当者をクリアする
    params.set('assigneeId', updateParams.assigneeId != null ? String(updateParams.assigneeId) : '');
  }
  if ('dueDate'  in updateParams) params.set('dueDate',  updateParams.dueDate ?? '');
  if ('statusId' in updateParams) params.set('statusId', String(updateParams.statusId));

  const url = new URL(`https://${space}.backlog.com/api/v2/issues/${backlogIssue.id}`);
  url.searchParams.set('apiKey', apiKey);

  let response;
  try {
    response = await fetch(url.toString(), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch (networkErr) {
    throw new Error(
      `[Backlog] 課題更新リクエスト失敗（ネットワークエラー）: ${backlogIssue.issueKey} "${payload.summary}"\n` +
      `  GitHub: ${payload.githubUrl ?? payload.githubProjectItemId}\n` +
      `  エラー: ${networkErr.message}`
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `[Backlog] 課題更新 API エラー: HTTP ${response.status} ${backlogIssue.issueKey} "${payload.summary}"\n` +
      `  GitHub: ${payload.githubUrl ?? payload.githubProjectItemId}\n` +
      `  レスポンス本文:\n${body}`
    );
  }

  const updated = await response.json();
  console.log(`  [UPDATE] 更新完了: ${updated.issueKey} (id=${updated.id}) "${updated.summary}"`);
  return updated;
}

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== GitHub → Backlog 同期開始 ===');
  console.log(`[Config] DRY_RUN: ${config.dryRun}`);

  // 設定バリデーション（GitHub 必須 / Backlog は fetchBacklogIssues 内で検証）
  validateConfig(config);
  console.log('[Config] 環境変数の読み込み完了');

  // mapping.json の読み込み（projectId の値チェックも内部で実施）
  const mapping = await loadMapping();
  console.log('[Config] mapping.json 読み込み完了');

  // ----------------------------------------------------------
  // Step 1: GitHub Project のアイテムを取得
  // ----------------------------------------------------------
  const { nodes: rawItems } = await fetchGitHubProjectItems();

  const total      = rawItems.length;
  const draftItems = rawItems.filter((item) => item.type === 'DRAFT_ISSUE');
  const issueItems = rawItems.filter((item) => item.type === 'ISSUE');
  const prItems    = rawItems.filter((item) => item.type === 'PULL_REQUEST');

  console.log(`[GitHub] 総取得件数: ${total}`);
  console.log(`[GitHub]   Issue        : ${issueItems.length} 件`);
  console.log(`[GitHub]   PullRequest  : ${prItems.length} 件`);
  console.log(`[GitHub]   Draft（スキップ）: ${draftItems.length} 件`);

  // ----------------------------------------------------------
  // Step 2: Draft をスキップして中間形式へ normalize
  // ----------------------------------------------------------
  const nonDraftItems   = rawItems.filter((item) => item.type !== 'DRAFT_ISSUE');
  const normalizedItems = nonDraftItems.map(normalizeGitHubProjectItem);

  console.log(`[Normalize] normalize 完了: ${normalizedItems.length} 件`);

  // ----------------------------------------------------------
  // Step 2.5: LIMIT による件数制限（Draft 除外後の先頭 N 件のみ処理）
  // ----------------------------------------------------------
  const limitValue = config.limit === '' ? null : Number(config.limit);

  if (limitValue !== null) {
    console.log(`[Limit] LIMIT=${limitValue} が設定されています`);
    console.log(`[Limit] 対象件数: ${normalizedItems.length} 件 → 先頭 ${Math.min(limitValue, normalizedItems.length)} 件のみ処理します`);
    if (normalizedItems.length <= limitValue) {
      console.log(`[Limit] 対象件数が LIMIT 以下のため、全件処理します`);
    }
  }

  const targetItems = limitValue !== null ? normalizedItems.slice(0, limitValue) : normalizedItems;

  // ----------------------------------------------------------
  // Step 3: normalize 済みアイテムを Backlog ペイロードへ変換
  // ----------------------------------------------------------
  const mappedItems = targetItems.map((item) =>
    mapGitHubItemToBacklogIssue(item, mapping)
  );

  // ----------------------------------------------------------
  // Step 4: Backlog の既存課題を全件取得
  // DRY_RUN=true 時も実行（照合に必要なため）
  // ----------------------------------------------------------
  const backlogIssues = await fetchBacklogIssues(mapping);

  // sync metadata の有無を集計
  const backlogWithMeta    = backlogIssues.filter(
    (issue) => extractSyncMetadata(issue.description) !== null
  );
  const backlogWithoutMeta = backlogIssues.length - backlogWithMeta.length;

  console.log(`[Backlog] 総取得件数: ${backlogIssues.length}`);
  console.log(`[Backlog]   sync metadata あり: ${backlogWithMeta.length} 件（照合対象）`);
  console.log(`[Backlog]   sync metadata なし: ${backlogWithoutMeta} 件（照合対象外）`);

  // ----------------------------------------------------------
  // Step 5: create / update（差分あり）/ skip（差分なし・Draft）の分類
  // ----------------------------------------------------------
  const toCreate     = [];                // { payload }
  const toUpdate     = [];                // { backlogIssue, payload, updateParams }
  const toSkipNoDiff = [];                // { backlogIssue, payload }（照合一致・差分なし）
  let   duplicateWarnings = 0;

  for (const mappedItem of mappedItems) {
    const { issue: existing, hadDuplicate } = findExistingBacklogIssue(backlogIssues, mappedItem);
    if (hadDuplicate) duplicateWarnings++;

    if (existing) {
      const updateParams = buildBacklogUpdateParams(existing, mappedItem);
      if (updateParams === null) {
        toSkipNoDiff.push({ backlogIssue: existing, payload: mappedItem });
      } else {
        toUpdate.push({ backlogIssue: existing, payload: mappedItem, updateParams });
      }
    } else {
      toCreate.push(mappedItem);
    }
  }

  const skipDraftCount  = draftItems.length;
  const skipNoDiffCount = toSkipNoDiff.length;

  console.log('');
  console.log('[Plan] 同期予定:');
  console.log(`  create 対象        : ${toCreate.length} 件`);
  console.log(`  update 対象        : ${toUpdate.length} 件`);
  console.log(`  skip（差分なし）   : ${skipNoDiffCount} 件`);
  console.log(`  skip（Draft）      : ${skipDraftCount} 件`);
  if (duplicateWarnings > 0) {
    console.log(`  重複候補あり       : ${duplicateWarnings} 件（詳細は上記 [Match] 警告を確認）`);
  }

  // create 対象のサマリーを表示（多い場合は先頭 10 件のみ）
  if (toCreate.length > 0) {
    const previewCount = Math.min(toCreate.length, 10);
    console.log(`\n[Plan] create 予定（先頭 ${previewCount} 件）:`);
    toCreate.slice(0, previewCount).forEach((item, i) => {
      console.log(`  ${i + 1}. "${item.summary}" [status: ${item.statusName ?? '未設定'}]`);
    });
    if (toCreate.length > previewCount) {
      console.log(`  ... 他 ${toCreate.length - previewCount} 件`);
    }
  }

  if (toUpdate.length > 0) {
    const previewCount = Math.min(toUpdate.length, 10);
    console.log(`\n[Plan] update 予定（先頭 ${previewCount} 件）:`);
    toUpdate.slice(0, previewCount).forEach(({ backlogIssue, payload, updateParams }, i) => {
      const fields = Object.keys(updateParams).join(', ');
      console.log(`  ${i + 1}. ${backlogIssue.issueKey}(id=${backlogIssue.id}) "${payload.summary}" [変更: ${fields}]`);
    });
    if (toUpdate.length > previewCount) {
      console.log(`  ... 他 ${toUpdate.length - previewCount} 件`);
    }
  }

  // ----------------------------------------------------------
  // Step 6: Backlog に同期
  // DRY_RUN=true ならログのみ（API 呼び出しなし）。false なら実際に create / update を実行。
  // 1 件でも失敗した時点でスローして中断する（どの課題で失敗したかはエラーメッセージに含まれる）。
  // ----------------------------------------------------------
  if (config.dryRun) {
    console.log('\n[DRY-RUN] Backlog への書き込みはスキップします。以下は実行予定の操作:');
  } else {
    console.log('\n[Sync] Backlog への書き込みを開始します:');
  }

  let created = 0;
  let updated = 0;
  const createdKeys = [];
  const updatedKeys = [];

  for (const payload of toCreate) {
    const result = await createBacklogIssue(payload, mapping, config.dryRun);
    if (result) createdKeys.push(result.issueKey);
    created++;
  }

  for (const { backlogIssue, payload, updateParams } of toUpdate) {
    const result = await updateBacklogIssue(backlogIssue, payload, updateParams, config.dryRun);
    if (result) updatedKeys.push(result.issueKey);
    updated++;
  }

  // ----------------------------------------------------------
  // 最終サマリー
  // ----------------------------------------------------------
  console.log('');
  console.log('=== 同期完了 ===');
  console.log(`  GitHub 取得         : ${total} 件`);
  if (limitValue !== null) {
    console.log(`  LIMIT 適用          : 先頭 ${targetItems.length} 件のみ処理（全 ${normalizedItems.length} 件中）`);
  }
  console.log(`  Backlog 照合対象    : ${backlogWithMeta.length} 件 / ${backlogIssues.length} 件`);
  console.log(`  Backlog create      : ${created} 件${config.dryRun ? '（DRY-RUN）' : ''}`);
  if (!config.dryRun && createdKeys.length > 0) {
    const preview = createdKeys.slice(0, 5).join(', ');
    const more    = createdKeys.length > 5 ? ` ... 他 ${createdKeys.length - 5} 件` : '';
    console.log(`    作成 issueKey     : ${preview}${more}`);
  }
  console.log(`  Backlog update      : ${updated} 件${config.dryRun ? '（DRY-RUN）' : ''}`);
  if (!config.dryRun && updatedKeys.length > 0) {
    const preview = updatedKeys.slice(0, 5).join(', ');
    const more    = updatedKeys.length > 5 ? ` ... 他 ${updatedKeys.length - 5} 件` : '';
    console.log(`    更新 issueKey     : ${preview}${more}`);
  }
  console.log(`  差分なしスキップ    : ${skipNoDiffCount} 件`);
  console.log(`  Draft スキップ      : ${skipDraftCount} 件`);
  if (duplicateWarnings > 0) {
    console.log(`  重複候補あり        : ${duplicateWarnings} 件（要確認）`);
  }
}

// ---------------------------------------------------------------------------
// エントリーポイント
// ---------------------------------------------------------------------------

// SELF_TEST=true のとき: 正規化関数の動作確認のみ実行して終了
// （API 呼び出し・mapping.json 読み込みは不要）
if (process.env.SELF_TEST === 'true') {
  runDescriptionNormalizationTests();
  process.exit(0);
}

main().catch((err) => {
  console.error('[ERROR]', err.message);
  process.exit(1);
});
