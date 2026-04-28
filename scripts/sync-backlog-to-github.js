/**
 * sync-backlog-to-github.js
 *
 * Backlog → GitHub Projects ステータス同期スクリプト（last-modified wins）
 *
 * 対象: Backlog 課題のうち sync metadata（<!-- github-backlog-sync -->）を持つもの
 * 条件: backlogIssue.updated > lastSynced → Backlog が最後に変更された
 *       → GitHub Projects の Status を Backlog に合わせて更新する
 *
 * reverseStatusMap は mapping.json の statusMap を自動で逆引きして生成する（先着優先）。
 * 例: { "Todo": 1, "Backlog": 1, "In Progress": 2 } → { 1: "Todo", 2: "In Progress" }
 *
 * 実行方法:
 *   node scripts/sync-backlog-to-github.js
 *   DRY_RUN=true node scripts/sync-backlog-to-github.js
 *   または npm run sync-to-github / npm run sync-to-github:dry
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

try {
  const dotenv = await import('dotenv');
  dotenv.config();
} catch {
  // dotenv 未インストール時は環境変数を直接参照する
}

// ---------------------------------------------------------------------------
// 環境変数の読み込み
// ---------------------------------------------------------------------------

const config = {
  gh: {
    token:         process.env.GH_TOKEN,
    owner:         process.env.GH_ORG,
    ownerType:     process.env.GH_OWNER_TYPE || 'org',
    projectNumber: Number(process.env.GH_PROJECT_NUMBER),
  },
  backlog: {
    apiKey:     process.env.BACKLOG_API_KEY,
    space:      process.env.BACKLOG_SPACE,
    projectKey: process.env.BACKLOG_PROJECT_KEY,
  },
  dryRun: process.env.DRY_RUN === 'true',
};

// ---------------------------------------------------------------------------
// バリデーション
// ---------------------------------------------------------------------------

function validateConfig(cfg) {
  if (!['org', 'user'].includes(cfg.gh.ownerType)) {
    throw new Error(
      `GH_OWNER_TYPE の値が不正です: "${cfg.gh.ownerType}"\n` +
      `有効な値: "org" または "user"`
    );
  }
  const required = [
    ['GH_TOKEN',            cfg.gh.token],
    ['GH_ORG',              cfg.gh.owner],
    ['GH_PROJECT_NUMBER',   cfg.gh.projectNumber],
    ['BACKLOG_API_KEY',     cfg.backlog.apiKey],
    ['BACKLOG_SPACE',       cfg.backlog.space],
    ['BACKLOG_PROJECT_KEY', cfg.backlog.projectKey],
  ];
  const missing = required.filter(([, val]) => !val).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`環境変数が設定されていません: ${missing.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// mapping.json 読み込み
// ---------------------------------------------------------------------------

async function loadMapping() {
  const mappingPath = resolve(__dirname, '..', 'config', 'mapping.json');
  let raw;
  try {
    raw = await readFile(mappingPath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`config/mapping.json が見つかりません。参照パス: ${mappingPath}`);
    }
    throw new Error(`config/mapping.json の読み込みに失敗しました: ${err.message}`);
  }

  const parsed = JSON.parse(raw);

  if (!parsed.statusMap) {
    throw new Error('config/mapping.json に statusMap が存在しません。');
  }
  if (typeof parsed.projectId !== 'number' || parsed.projectId <= 0) {
    throw new Error(
      `config/mapping.json の projectId が未設定または無効です（現在: ${parsed.projectId}）。`
    );
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// reverseStatusMap: statusMap から自動生成 + mapping.reverseStatusMap で上書き
//
// statusMap は N:1（複数 GitHub Status → 同一 Backlog ID）なので逆引き時は先着を採用する。
// 例: { "Todo": 1, "Backlog": 1, "In Progress": 2, "In Review": 2, "Done": 4 }
//     → { 1: "Todo", 2: "In Progress", 4: "Done" }
//
// mapping.json に reverseStatusMap を書くと、自動生成結果を上書きできる。
// 主に statusMap に現れない Backlog statusId（例: 3=処理済み）の追加に使う。
// ---------------------------------------------------------------------------

// Backlog 側で変更とみなす最小時間差（ミリ秒）。
// 同期処理自体が Backlog の updated を lastSynced の数秒後に設定するため、
// この閾値未満の差は「同期による更新」として無視する。
const BACKLOG_CHANGE_THRESHOLD_MS = 5 * 60 * 1000; // 5分

function buildReverseStatusMap(statusMap, reverseStatusMapOverride = {}) {
  const reverse = {};
  for (const [githubName, backlogId] of Object.entries(statusMap)) {
    if (!(backlogId in reverse)) {
      reverse[backlogId] = githubName;
    }
  }
  // mapping.json の reverseStatusMap で上書き（キーは数値・文字列どちらでも可）
  for (const [backlogId, githubName] of Object.entries(reverseStatusMapOverride)) {
    reverse[Number(backlogId)] = githubName;
  }
  return reverse;
}

// assigneeMap（GitHub login → Backlog userId）を自動逆引きして
// reverseAssigneeMap（Backlog userId 文字列 → GitHub login）を生成する。
// mapping.json の reverseAssigneeMap で上書き可能。
function buildReverseAssigneeMap(assigneeMap, reverseAssigneeMapOverride = {}) {
  const reverse = {};
  for (const [githubLogin, backlogId] of Object.entries(assigneeMap ?? {})) {
    const key = String(backlogId);
    if (!(key in reverse)) {
      reverse[key] = githubLogin;
    }
  }
  for (const [backlogId, githubLogin] of Object.entries(reverseAssigneeMapOverride)) {
    reverse[String(backlogId)] = githubLogin;
  }
  return reverse;
}

// ---------------------------------------------------------------------------
// sync metadata 解析（sync-github-project-to-backlog.js と同一ロジック）
// ---------------------------------------------------------------------------

function extractSyncMetadata(description) {
  if (!description) return null;
  const blockMatch = description.match(
    /<!-- github-backlog-sync -->([\s\S]*?)<!-- \/github-backlog-sync -->/
  );
  if (!blockMatch) return null;
  const block = blockMatch[1];
  const githubUrl           = block.match(/^GitHub Issue:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const githubProjectItemId = block.match(/^GitHub Project Item ID:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const lastSynced          = block.match(/^Last synced:\s*(.+)$/m)?.[1]?.trim() ?? null;
  if (!githubProjectItemId && !githubUrl) return null;
  return { githubProjectItemId, githubUrl, lastSynced };
}

// ---------------------------------------------------------------------------
// GitHub GraphQL: プロジェクト情報取得（projectId / Status fieldId / オプション一覧）
// ---------------------------------------------------------------------------

/**
 * GitHub Projects の node ID・Status フィールド ID・オプション名→ID マップを返す
 *
 * @returns {Promise<{
 *   projectId: string,
 *   statusFieldId: string,
 *   optionsByName: { [name: string]: string }
 * }>}
 */
async function fetchGitHubProjectInfo() {
  const { token, owner, ownerType, projectNumber } = config.gh;
  const ownerEntity = ownerType === 'user' ? 'user' : 'organization';

  const query = `
    query GetProjectInfo($owner: String!, $projectNumber: Int!) {
      ${ownerEntity}(login: $owner) {
        projectV2(number: $projectNumber) {
          id
          title
          fields(first: 30) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options {
                  id
                  name
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
    body: JSON.stringify({ query, variables: { owner, projectNumber } }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub GraphQL API エラー: HTTP ${response.status}\n${body}`);
  }

  const json = await response.json();
  if (json.errors) {
    throw new Error(`GitHub GraphQL エラー:\n${JSON.stringify(json.errors, null, 2)}`);
  }

  const ownerData = ownerType === 'user' ? json.data?.user : json.data?.organization;
  const project   = ownerData?.projectV2;
  if (!project) {
    throw new Error(
      `プロジェクトが見つかりません: ownerType=${ownerType}, owner=${owner}, projectNumber=${projectNumber}`
    );
  }

  console.log(`[GitHub] プロジェクト: "${project.title}" (id=${project.id})`);

  const statusField = project.fields.nodes.find(
    (f) => f?.name?.toLowerCase() === 'status' && Array.isArray(f.options)
  );
  if (!statusField) {
    throw new Error(
      `GitHub Project に "Status" フィールドが見つかりません。` +
      `フィールド名（大文字小文字）を確認してください。`
    );
  }

  const optionsByName = Object.fromEntries(
    statusField.options.map((opt) => [opt.name, opt.id])
  );

  console.log(`[GitHub] Status fieldId: ${statusField.id}`);
  console.log(`[GitHub] Status オプション: ${JSON.stringify(optionsByName)}`);

  return {
    projectId:     project.id,
    statusFieldId: statusField.id,
    optionsByName,
  };
}

// ---------------------------------------------------------------------------
// GitHub GraphQL mutation: Status フィールドを更新
// ---------------------------------------------------------------------------

/**
 * GitHub Projects の単一選択フィールド（Status）を更新する
 *
 * @param {string} projectId   - GitHub Projects の node ID
 * @param {string} itemId      - GitHub Project Item の node ID（sync metadata から取得）
 * @param {string} fieldId     - Status フィールドの node ID
 * @param {string} optionId    - 設定するオプションの node ID
 */
async function updateGitHubProjectItemStatus(projectId, itemId, fieldId, optionId) {
  const { token } = config.gh;

  const mutation = `
    mutation UpdateProjectV2ItemStatus(
      $projectId: ID!
      $itemId: ID!
      $fieldId: ID!
      $optionId: String!
    ) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item {
          id
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
      query: mutation,
      variables: { projectId, itemId, fieldId, optionId },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub GraphQL mutation エラー: HTTP ${response.status}\n${body}`);
  }

  const json = await response.json();
  if (json.errors) {
    throw new Error(`GitHub GraphQL mutation エラー:\n${JSON.stringify(json.errors, null, 2)}`);
  }
}

// ---------------------------------------------------------------------------
// GitHub Issues REST API: 担当者更新
// ---------------------------------------------------------------------------

function parseGitHubIssueUrl(url) {
  if (!url) return null;
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

async function updateGitHubIssueAssignees(owner, repo, issueNumber, login) {
  const { token } = config.gh;

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
        'User-Agent': 'github-backlog-sync/0.1.0',
      },
      body: JSON.stringify({ assignees: [login] }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub Issues API エラー: HTTP ${response.status}\n${body}`);
  }
}

// ---------------------------------------------------------------------------
// Backlog API: 課題一覧取得
// ---------------------------------------------------------------------------

async function fetchBacklogIssues(projectId) {
  const { apiKey, space } = config.backlog;
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
        `Backlog API エラー: HTTP ${response.status} (GET /api/v2/issues, offset=${offset})\n${body}`
      );
    }

    const issues = await response.json();
    allIssues.push(...issues);
    if (issues.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    console.log(`[Backlog]   取得済み: ${allIssues.length} 件（続きを取得中...）`);
  }

  return allIssues;
}

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Backlog → GitHub ステータス同期開始 ===');
  console.log(`[Config] DRY_RUN: ${config.dryRun}`);

  validateConfig(config);

  const mapping            = await loadMapping();
  const reverseStatusMap   = buildReverseStatusMap(mapping.statusMap, mapping.reverseStatusMap ?? {});
  const reverseAssigneeMap = buildReverseAssigneeMap(mapping.assigneeMap, mapping.reverseAssigneeMap ?? {});

  console.log('[Config] reverseStatusMap（statusMap から自動生成 + 上書き適用）:');
  for (const [backlogId, githubName] of Object.entries(reverseStatusMap)) {
    console.log(`  Backlog statusId ${backlogId} → GitHub "${githubName}"`);
  }

  console.log('[Config] reverseAssigneeMap（assigneeMap から自動生成 + 上書き適用）:');
  for (const [backlogId, githubLogin] of Object.entries(reverseAssigneeMap)) {
    console.log(`  Backlog userId ${backlogId} → GitHub "${githubLogin}"`);
  }

  // GitHub プロジェクト情報（projectId / fieldId / optionsByName）
  const { projectId: ghProjectId, statusFieldId, optionsByName } = await fetchGitHubProjectInfo();

  // Backlog 課題を全件取得
  const backlogIssues = await fetchBacklogIssues(mapping.projectId);
  console.log(`[Backlog] 総取得件数: ${backlogIssues.length}`);

  // sync metadata を持つ課題のみ対象
  const syncedIssues = backlogIssues.filter(
    (issue) => extractSyncMetadata(issue.description) !== null
  );
  console.log(`[Backlog] sync metadata あり: ${syncedIssues.length} 件（照合対象）`);

  // ----------------------------------------------------------
  // 各課題を分類: update / skip / マッピングなし
  // ----------------------------------------------------------
  const toUpdate = [];
  const toSkip   = [];
  const noMap    = [];

  for (const issue of syncedIssues) {
    const meta = extractSyncMetadata(issue.description);
    const { githubProjectItemId, githubUrl, lastSynced } = meta;

    // lastSynced が記録されていない課題は判定不能 → スキップ
    if (!lastSynced) {
      toSkip.push({ issue, reason: 'lastSynced なし' });
      continue;
    }

    // last-modified wins: Backlog の updated が lastSynced より BACKLOG_CHANGE_THRESHOLD_MS 以上
    // 新しい場合のみ Backlog 側の変更とみなす。
    // 閾値未満の差（数秒〜数十秒）は同期処理自体が Backlog updated を進めたノイズとして無視する。
    const backlogUpdated = issue.updated ? new Date(issue.updated) : null;
    const lastSyncedDate = new Date(lastSynced);
    const diffMs = backlogUpdated ? backlogUpdated - lastSyncedDate : -Infinity;

    if (diffMs <= BACKLOG_CHANGE_THRESHOLD_MS) {
      toSkip.push({ issue, reason: `GitHub が最後の変更（diff ${Math.round(diffMs / 1000)}秒 < 閾値 ${BACKLOG_CHANGE_THRESHOLD_MS / 60000}分）` });
      continue;
    }

    // Backlog ステータスを GitHub Status 名に逆引き
    const backlogStatusId    = issue.status?.id;
    const targetGitHubStatus = reverseStatusMap[backlogStatusId];
    if (!targetGitHubStatus) {
      noMap.push({ issue, backlogStatusId });
      console.warn(
        `[Map] reverseStatusMap に Backlog statusId=${backlogStatusId} のマッピングなし: ` +
        `${issue.issueKey} "${issue.summary}" → スキップ`
      );
      continue;
    }

    // GitHub Status オプション ID を取得
    const optionId = optionsByName[targetGitHubStatus];
    if (!optionId) {
      noMap.push({ issue, backlogStatusId, targetGitHubStatus });
      console.warn(
        `[Map] GitHub Status オプションなし: "${targetGitHubStatus}" (${issue.issueKey}) → スキップ`
      );
      continue;
    }

    // Backlog 担当者を GitHub login に逆引き
    // null: Backlog 未設定 → GitHub 担当者はクリアしない（スキップ）
    // ASSIGNEE_UNMAPPED 相当: マッピングなし → warn のみ・スキップ
    const backlogAssigneeId = issue.assignee?.id ?? null;
    let targetGitHubLogin = null;
    let assigneeUnmapped  = false;
    if (backlogAssigneeId !== null) {
      targetGitHubLogin = reverseAssigneeMap[String(backlogAssigneeId)] ?? null;
      if (targetGitHubLogin === null) {
        assigneeUnmapped = true;
      }
    }

    toUpdate.push({
      issue,
      githubProjectItemId,
      githubUrl,
      targetGitHubStatus,
      optionId,
      targetGitHubLogin,
      assigneeUnmapped,
      backlogUpdated: backlogUpdated.toISOString(),
      lastSynced,
    });
  }

  console.log('');
  console.log('[Plan] 同期予定:');
  console.log(`  update 対象 : ${toUpdate.length} 件`);
  console.log(`  skip        : ${toSkip.length} 件（GitHub が最後の変更 or lastSynced なし）`);
  console.log(`  マップなし  : ${noMap.length} 件`);

  if (toUpdate.length > 0) {
    const previewCount = Math.min(toUpdate.length, 10);
    console.log(`\n[Plan] update 予定（先頭 ${previewCount} 件）:`);
    toUpdate.slice(0, previewCount).forEach(({ issue, targetGitHubStatus, targetGitHubLogin, assigneeUnmapped, backlogUpdated, lastSynced }, i) => {
      const assigneeInfo = targetGitHubLogin
        ? ` / 担当: "${targetGitHubLogin}"`
        : assigneeUnmapped
          ? ' / 担当: マッピングなし（スキップ）'
          : ' / 担当: Backlog未設定（スキップ）';
      console.log(
        `  ${i + 1}. ${issue.issueKey} "${issue.summary}"` +
        ` → GitHub Status: "${targetGitHubStatus}"${assigneeInfo}` +
        ` (Backlog更新: ${backlogUpdated} > lastSynced: ${lastSynced})`
      );
    });
    if (toUpdate.length > previewCount) {
      console.log(`  ... 他 ${toUpdate.length - previewCount} 件`);
    }
  }

  if (config.dryRun) {
    console.log('\n[DRY-RUN] GitHub への書き込みはスキップします。');
    console.log('=== 同期完了（DRY-RUN） ===');
    return;
  }

  console.log('\n[Sync] GitHub への書き込みを開始します:');

  let updated = 0;
  for (const { issue, githubProjectItemId, githubUrl, targetGitHubStatus, optionId, targetGitHubLogin, assigneeUnmapped } of toUpdate) {
    await updateGitHubProjectItemStatus(ghProjectId, githubProjectItemId, statusFieldId, optionId);

    if (targetGitHubLogin !== null) {
      const parsed = parseGitHubIssueUrl(githubUrl);
      if (parsed) {
        await updateGitHubIssueAssignees(parsed.owner, parsed.repo, parsed.number, targetGitHubLogin);
      } else {
        console.warn(`[Assignee] GitHub Issue URL が解析できません（Draft の可能性）: ${issue.issueKey} → 担当者同期をスキップ`);
      }
    } else if (assigneeUnmapped) {
      console.warn(`[Assignee] reverseAssigneeMap に Backlog userId=${issue.assignee?.id} のマッピングなし: ${issue.issueKey} → 担当者同期をスキップ`);
    }

    const assigneeLog = targetGitHubLogin ? ` / 担当: "${targetGitHubLogin}"` : '';
    console.log(
      `  [UPDATE] ${issue.issueKey} "${issue.summary}" → GitHub Status: "${targetGitHubStatus}"${assigneeLog}`
    );
    updated++;
  }

  console.log('');
  console.log('=== 同期完了 ===');
  console.log(`  GitHub update : ${updated} 件`);
  console.log(`  skip          : ${toSkip.length} 件`);
  console.log(`  マップなし    : ${noMap.length} 件`);
}

main().catch((err) => {
  console.error('[ERROR]', err.message);
  process.exit(1);
});
