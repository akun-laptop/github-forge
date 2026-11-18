/**
 * rest.ts — the forge's GitHub REST v3 API: repositories, branches, commits,
 * contents, labels, issues, comments, pulls and merges. Node stdlib only;
 * every handler is synchronous.
 *
 * Routes (all under `/api/v3`, dispatched by `routeRest` on the decoded path
 * segments after the prefix):
 *
 *   GET    /                                     200 JSON + X-OAuth-Scopes
 *   GET    /meta                                 200 {"installed_version"}
 *   GET    /user/repos?per_page=&page=           200 list + Link rel="next"
 *   POST   /user/repos                           201 (422 "already exists")
 *   GET    /repos/{o}/{r}                        200 / 404 {"message"}
 *   PATCH  /repos/{o}/{r}                        200 (description/private)
 *   DELETE /repos/{o}/{r}                        204
 *   POST   /repos/{o}/{r}/git/refs               201 {ref, object:{sha}}
 *   GET    /repos/{o}/{r}/branches               200 [{name, commit:{sha}}]
 *   GET    /repos/{o}/{r}/commits[?sha=<ref>]    200 [{sha, commit:{message}}]
 *   GET    /repos/{o}/{r}/contents/{path}[?ref=] 200 file | directory array
 *   PUT    /repos/{o}/{r}/contents/{path}        201 create / 200 update / 409 stale sha
 *   DELETE /repos/{o}/{r}/contents/{path}        200 {commit:{sha}}
 *   POST   /repos/{o}/{r}/labels                 201 {name, color}
 *   GET    /repos/{o}/{r}/issues                 200 list (state/sort/direction/page)
 *   POST   /repos/{o}/{r}/issues                 201 / 422 unknown label
 *   GET    /repos/{o}/{r}/issues/{n}             200 one issue
 *   PATCH  /repos/{o}/{r}/issues/{n}             200 ({state:"closed"} closes)
 *   GET|POST /repos/{o}/{r}/issues/{n}/comments  200 list / 201 {id, body}
 *   GET    /repos/{o}/{r}/pulls                  200 list (state=all|open|closed)
 *   POST   /repos/{o}/{r}/pulls                  201 {number, state:"open", head, base}
 *   GET    /repos/{o}/{r}/pulls/{n}              200 / 404
 *   GET    /repos/{o}/{r}/pulls/{n}/files        200 [{filename, status, additions, ...}]
 *   PUT    /repos/{o}/{r}/pulls/{n}/merge        200 {sha, merged:true} / 404 / 405 conflict
 *   GET|POST /repos/{o}/{r}/pulls/{n}/comments   200 list / 201 (GitHub parity)
 *
 * Auth is app.ts's job: every /api/v3 request without a Bearer token is 401
 * there, so these handlers never see an unauthenticated call. Ownership falls
 * out of the store: a repo under another login simply does not exist for this
 * token, so it is a 404, never a 403. Repos are always created under the
 * viewer (the login the token names).
 *
 * Perf: GET /issues/{n} (the read workload: 2,000 sequential reads of one
 * issue) serves a cached serialized Buffer keyed by
 * (repo, issue number, updatedSeq) — a mutation ticks updatedSeq, so the
 * cache is always fresh. POST /issues (the write workload) is a direct store
 * call plus one JSON.stringify of a minimal object.
 */

import { commitMessageForApi, parseCommit, parseTree, ZERO_OID } from './git.ts';
import { invalidateRepoCache, nextRequestId } from './git-http.ts';
import type { HandlerContext, HandlerResult } from './git-http.ts';
import { store, StoreError, trialNowIso, VIEWER } from './store.ts';
import type { Issue, IssueComment, PullRequest, Repository } from './store.ts';
import { walkCommits } from './git.ts';

// ---------------------------------------------------------------------------------------------
// reply helpers
// ---------------------------------------------------------------------------------------------

function jsonOk(status: number, body: unknown, extraHeaders?: Record<string, string>): HandlerResult {
  return {
    status,
    headers: { 'content-type': 'application/json', 'x-github-request-id': nextRequestId(), ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function jsonBufferOk(status: number, body: Buffer, extraHeaders?: Record<string, string>): HandlerResult {
  return {
    status,
    headers: { 'content-type': 'application/json', 'x-github-request-id': nextRequestId(), ...extraHeaders },
    body,
  };
}

function jsonError(status: number, message: string): HandlerResult {
  return {
    status,
    headers: { 'content-type': 'application/json', 'x-github-request-id': nextRequestId() },
    body: JSON.stringify({ message }),
  };
}

const notFound = (what: string): HandlerResult => jsonError(404, `${what} not found`);

function bodyObject(ctx: HandlerContext): Record<string, unknown> {
  const json = ctx.json;
  if (json === undefined || json === null) return {};
  if (typeof json !== 'object' || Array.isArray(json)) throw new StoreError('request body must be a JSON object', 'validation', 400);
  return json as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function parseNumber(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  const value = Number(segment);
  return Number.isSafeInteger(value) ? value : null;
}

function queryInt(ctx: HandlerContext, name: string, fallback: number): number {
  const raw = ctx.query.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Slice a page out of a list and build the Link header (absolute URLs). */
function paginate<T>(
  items: readonly T[],
  ctx: HandlerContext,
  path: string,
): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.min(queryInt(ctx, 'per_page', 30), 100);
  const page = queryInt(ctx, 'page', 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`<${ctx.origin}${path}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  }
  links.push(`<${ctx.origin}${path}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  headers.link = links.join(', ');
  return { page: slice, headers };
}

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER.login ? VIEWER.id : 0, type: 'User' };
}

function repoJson(repo: Repository): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: repo.id,
    name: repo.name,
    full_name: `${repo.ownerLogin}/${repo.name}`,
    owner: userJson(repo.ownerLogin),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: repo.hasIssuesEnabled,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function labelJson(repo: Repository, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? '',
  };
}

function issueToJson(repo: Repository, issue: Issue): Record<string, unknown> {
  return {
    id: issue.databaseId,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'OPEN' ? 'open' : 'closed',
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(issue.authorLogin),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

/** Cached serialized issue JSON, keyed by (repo, number, updatedSeq). */
const issueJsonCache = new Map<string, Buffer>();
const ISSUE_JSON_CACHE_MAX = 4096;

function issueJsonBuffer(repo: Repository, issue: Issue): Buffer {
  const key = `${repo.id}:${issue.number}:${issue.updatedSeq}`;
  const hit = issueJsonCache.get(key);
  if (hit !== undefined) return hit;
  const buffer = Buffer.from(JSON.stringify(issueToJson(repo, issue)), 'utf8');
  if (issueJsonCache.size >= ISSUE_JSON_CACHE_MAX) {
    const oldest = issueJsonCache.keys().next().value;
    if (oldest !== undefined) issueJsonCache.delete(oldest);
  }
  issueJsonCache.set(key, buffer);
  return buffer;
}

function commentJson(comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.databaseId,
    node_id: comment.id,
    body: comment.body,
    user: userJson(comment.authorLogin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function pullToJson(repo: Repository, pr: PullRequest): Record<string, unknown> {
  const headSha = store.getPrHeadSha(repo, pr) ?? ZERO_OID;
  const baseSha = store.getPrBaseSha(repo, pr) ?? ZERO_OID;
  return {
    id: pr.databaseId,
    node_id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state === 'OPEN' ? 'open' : 'closed',
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: store.isPrMergeable(repo, pr),
    head: { ref: pr.headRefName, sha: headSha, repo: { name: repo.name, full_name: `${repo.ownerLogin}/${repo.name}` } },
    base: { ref: pr.baseRefName, sha: baseSha, repo: { name: repo.name, full_name: `${repo.ownerLogin}/${repo.name}` } },
    user: userJson(pr.authorLogin),
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
  };
}

/** `Name <email> ts tz` as GitHub's author object. */
function identityJson(raw: string): Record<string, unknown> {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(raw.trim());
  if (match === null) return { name: raw, email: '', date: trialNowIso() };
  const date = new Date(Number(match[3]) * 1000).toISOString();
  return { name: match[1], email: match[2], date };
}

function commitJson(repo: Repository, sha: string): Record<string, unknown> | null {
  const object = store.getObject(repo, sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha,
    node_id: sha,
    commit: {
      message: commitMessageForApi(commit.message),
      author: identityJson(commit.author),
      committer: identityJson(commit.committer),
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------------------------
// ref resolution
// ---------------------------------------------------------------------------------------------

/**
 * Resolve a `ref` query/body value to a commit oid: a branch short name, a
 * full ref name, or a 40-hex commit id. Undefined when it names nothing.
 */
function resolveRefToCommit(repo: Repository, ref: string | null | undefined): string | undefined {
  if (ref === null || ref === undefined || ref === '') ref = repo.defaultBranch;
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const object = store.getObject(repo, ref.toLowerCase());
    return object?.type === 'commit' ? ref.toLowerCase() : undefined;
  }
  const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  const oid = store.getRef(repo, full);
  if (oid === undefined) return undefined;
  const peeled = store.peelTag(repo, oid);
  const object = store.getObject(repo, peeled);
  return object?.type === 'commit' ? peeled : undefined;
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

/**
 * Walk a commit's tree down `segments`: returns the final entry
 * ({kind:'file'|'dir', oid, mode}) or undefined when the path is absent.
 */
function resolveTreePath(
  repo: Repository,
  treeOid: string,
  segments: readonly string[],
): { kind: 'file' | 'dir'; oid: string; mode: string } | undefined {
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = store.getObject(repo, current);
    if (object === undefined || object.type !== 'tree') return undefined;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return undefined;
    if (index === segments.length - 1) {
      return { kind: entry.mode === '40000' ? 'dir' : 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return undefined;
    current = entry.oid;
  }
  return { kind: 'dir', oid: treeOid, mode: '40000' };
}

function contentsGet(repo: Repository, segments: readonly string[], ctx: HandlerContext): HandlerResult {
  const tip = resolveRefToCommit(repo, ctx.query.get('ref'));
  if (tip === undefined) return notFound('ref');
  const commitObject = store.getObject(repo, tip);
  if (commitObject === undefined) return notFound('commit');
  const treeOid = parseCommit(commitObject.data).tree;
  const found = resolveTreePath(repo, treeOid, segments);
  if (found === undefined) return notFound(`path ${segments.join('/')}`);
  const path = segments.join('/');
  if (found.kind === 'dir') {
    const object = store.getObject(repo, found.oid);
    if (object === undefined) return notFound('directory');
    const entries = parseTree(object.data).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (store.getObject(repo, entry.oid)?.data.length ?? 0),
    }));
    return jsonOk(200, entries);
  }
  const blob = store.getObject(repo, found.oid);
  if (blob === undefined || blob.type !== 'blob') return notFound('file');
  return jsonOk(200, {
    type: 'file',
    encoding: 'base64',
    content: blob.data.toString('base64'),
    sha: found.oid,
    size: blob.data.length,
    name: segments[segments.length - 1],
    path,
  });
}

function contentsPut(repo: Repository, segments: readonly string[], ctx: HandlerContext): HandlerResult {
  const body = bodyObject(ctx);
  const message = stringField(body, 'message');
  const content = stringField(body, 'content');
  if (message === undefined) throw new StoreError('message is required', 'validation', 422);
  if (content === undefined) throw new StoreError('content is required', 'validation', 422);
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = store.getRef(repo, refName);
  if (tip === undefined && branch !== repo.defaultBranch) {
    throw new StoreError(`branch ${branch} does not exist`, 'validation', 422);
  }
  const path = segments.join('/');
  const files = new Map<string, { oid: string; mode: string }>();
  if (tip !== undefined) {
    const commitObject = store.getObject(repo, tip);
    if (commitObject !== undefined) {
      for (const [entryPath, entry] of store.flattenTree(repo, parseCommit(commitObject.data).tree)) {
        files.set(entryPath, entry);
      }
    }
  }
  const existing = files.get(path);
  const sha = stringField(body, 'sha');
  if (sha !== undefined) {
    if (existing === undefined || existing.oid.toLowerCase() !== sha.toLowerCase()) {
      return jsonError(409, `sha ${sha} does not match the current content of ${path}`);
    }
  }
  const bytes = Buffer.from(content, 'base64');
  const blobOid = store.putObject(repo, 'blob', bytes);
  files.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
  const treeOid = store.buildTreeFromFiles(repo, files);
  const commitOid = store.createCommit(repo, {
    tree: treeOid,
    parents: tip !== undefined ? [tip] : [],
    message,
  });
  const moved = store.updateRef(repo, refName, commitOid, tip ?? ZERO_OID);
  if (!moved.ok) return jsonError(409, moved.reason ?? 'ref update refused');
  const status = existing === undefined ? 201 : 200;
  return jsonOk(status, {
    content: { name: segments[segments.length - 1], path, sha: blobOid, size: bytes.length, encoding: 'base64' },
    commit: { sha: commitOid, message },
  });
}

function contentsDelete(repo: Repository, segments: readonly string[], ctx: HandlerContext): HandlerResult {
  const body = bodyObject(ctx);
  const message = stringField(body, 'message') ?? `Delete ${segments.join('/')}`;
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = store.getRef(repo, refName);
  if (tip === undefined) return notFound('branch');
  const commitObject = store.getObject(repo, tip);
  if (commitObject === undefined) return notFound('commit');
  const path = segments.join('/');
  const files = store.flattenTree(repo, parseCommit(commitObject.data).tree);
  const existing = files.get(path);
  if (existing === undefined) return notFound(`path ${path}`);
  const sha = stringField(body, 'sha');
  if (sha !== undefined && existing.oid.toLowerCase() !== sha.toLowerCase()) {
    return jsonError(409, `sha ${sha} does not match the current content of ${path}`);
  }
  files.delete(path);
  const treeOid = store.buildTreeFromFiles(repo, files);
  const commitOid = store.createCommit(repo, { tree: treeOid, parents: [tip], message });
  const moved = store.updateRef(repo, refName, commitOid, tip);
  if (!moved.ok) return jsonError(409, moved.reason ?? 'ref update refused');
  return jsonOk(200, { commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------------------------------------
// pull request files
// ---------------------------------------------------------------------------------------------

/** Lines of a blob, without a trailing empty element. */
function blobLines(repo: Repository, oid: string | null): string[] {
  if (oid === null) return [];
  const object = store.getObject(repo, oid);
  if (object === undefined || object.type !== 'blob') return [];
  const lines = object.data.toString('utf8').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Added/removed line counts as a multiset difference (order-free, cheap). */
function lineDiff(before: readonly string[], after: readonly string[]): { additions: number; deletions: number } {
  const counts = new Map<string, number>();
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of after) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of counts.values()) deletions += remaining;
  return { additions, deletions };
}

function pullFilesJson(repo: Repository, number: number): Record<string, unknown>[] {
  return store.getPrFiles(repo, number).map((file) => {
    const { additions, deletions } = lineDiff(blobLines(repo, file.oldOid), blobLines(repo, file.newOid));
    return {
      filename: file.path,
      status: file.status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: file.newOid ?? file.oldOid,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

/**
 * Route one REST call. `segments` are the decoded path segments after
 * `/api/v3/` (so `GET /api/v3/repos/o/r/issues/3` arrives as
 * `['repos','o','r','issues','3']`). A contents path keeps its slashes as
 * separate segments and is re-joined inside the contents handlers.
 */
export function routeRest(method: string, segments: readonly string[], ctx: HandlerContext): HandlerResult {
  try {
    // GET /api/v3/ — the API root.
    if (segments.length === 0) {
      if (method !== 'GET') return jsonError(405, `method ${method} not allowed on /api/v3/`);
      return jsonOk(200, { current_user_url: `${ctx.origin}/api/v3/user` }, { 'x-oauth-scopes': 'repo' });
    }

    // GET /api/v3/meta
    if (segments.length === 1 && segments[0] === 'meta') {
      if (method !== 'GET') return jsonError(405, `method ${method} not allowed on /api/v3/meta`);
      return jsonOk(200, { installed_version: '1.0.0' });
    }

    // /api/v3/user/repos — list (GET) and create (POST).
    if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
      if (method === 'GET') {
        const { page, headers } = paginate(store.listRepos(VIEWER.login), ctx, '/api/v3/user/repos');
        return jsonOk(200, page.map(repoJson), headers);
      }
      if (method === 'POST') {
        const body = bodyObject(ctx);
        const name = stringField(body, 'name');
        if (name === undefined) throw new StoreError('name is required', 'validation', 422);
        invalidateRepoCache(VIEWER.login, name);
        const repo = store.createRepo(VIEWER.login, name, {
          description: stringField(body, 'description'),
          private: typeof body.private === 'boolean' ? body.private : undefined,
          defaultBranch: stringField(body, 'default_branch'),
        });
        return jsonOk(201, repoJson(repo));
      }
      return jsonError(405, `method ${method} not allowed on /api/v3/user/repos`);
    }

    // Everything below is /api/v3/repos/{owner}/{name}/...
    if (segments.length < 3 || segments[0] !== 'repos') return notFound('route');
    const owner = segments[1];
    const name = segments[2];
    const rest = segments.slice(3);

    // /repos/{o}/{r} — read, patch, delete.
    if (rest.length === 0) {
      if (method === 'GET') {
        const repo = store.getRepo(owner, name);
        return repo === undefined ? notFound(`repository ${owner}/${name}`) : jsonOk(200, repoJson(repo));
      }
      if (method === 'PATCH') {
        const repo = store.requireRepo(owner, name);
        const body = bodyObject(ctx);
        const description = stringField(body, 'description');
        if (description !== undefined) repo.description = description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        const defaultBranch = stringField(body, 'default_branch');
        if (defaultBranch !== undefined) repo.defaultBranch = defaultBranch;
        repo.updatedAt = trialNowIso();
        return jsonOk(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        if (!store.deleteRepo(owner, name)) return notFound(`repository ${owner}/${name}`);
        invalidateRepoCache(owner, name);
        return { status: 204, headers: { 'x-github-request-id': nextRequestId() }, body: '' };
      }
      return jsonError(405, `method ${method} not allowed on /api/v3/repos/${owner}/${name}`);
    }

    const repo = store.requireRepo(owner, name);
    const head = rest[0];

    // POST /repos/{o}/{r}/git/refs — create a branch (or any ref).
    if (head === 'git' && rest.length === 2 && rest[1] === 'refs') {
      if (method !== 'POST') return jsonError(405, `method ${method} not allowed on /git/refs`);
      const body = bodyObject(ctx);
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (ref === undefined || !ref.startsWith('refs/')) throw new StoreError('ref is required', 'validation', 422);
      if (sha === undefined || !/^[0-9a-f]{40}$/i.test(sha)) throw new StoreError('sha is required', 'validation', 422);
      if (store.getRef(repo, ref) !== undefined) {
        return jsonError(422, `Reference already exists: ${ref}`);
      }
      const result = store.updateRef(repo, ref, sha.toLowerCase(), ZERO_OID);
      if (!result.ok) return jsonError(422, result.reason ?? 'ref update refused');
      return jsonOk(201, { ref, object: { sha: sha.toLowerCase(), type: 'commit' } });
    }

    // GET /repos/{o}/{r}/branches
    if (head === 'branches' && rest.length === 1) {
      if (method !== 'GET') return jsonError(405, `method ${method} not allowed on /branches`);
      const branches = store
        .listRefs(repo)
        .filter((ref) => ref.name.startsWith('refs/heads/'))
        .map((ref) => ({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid } }));
      return jsonOk(200, branches);
    }

    // GET /repos/{o}/{r}/commits[?sha=<ref>]
    if (head === 'commits' && rest.length === 1) {
      if (method !== 'GET') return jsonError(405, `method ${method} not allowed on /commits`);
      const tip = resolveRefToCommit(repo, ctx.query.get('sha'));
      if (tip === undefined) return notFound('ref');
      const { commits } = walkCommits([tip], store.lookup(repo));
      const list: Record<string, unknown>[] = [];
      for (const sha of commits) {
        const entry = commitJson(repo, sha);
        if (entry !== null) list.push(entry);
      }
      return jsonOk(200, list);
    }

    // /repos/{o}/{r}/contents/{path...}
    if (head === 'contents') {
      const pathSegments = rest.slice(1);
      if (method === 'GET') return contentsGet(repo, pathSegments, ctx);
      if (method === 'PUT') return contentsPut(repo, pathSegments, ctx);
      if (method === 'DELETE') return contentsDelete(repo, pathSegments, ctx);
      return jsonError(405, `method ${method} not allowed on /contents`);
    }

    // /repos/{o}/{r}/labels
    if (head === 'labels' && rest.length === 1) {
      if (method === 'GET') {
        return jsonOk(200, store.listLabels(repo).map((label) => ({ name: label.name, color: label.color, description: label.description })));
      }
      if (method === 'POST') {
        const body = bodyObject(ctx);
        const labelName = stringField(body, 'name');
        if (labelName === undefined) throw new StoreError('name is required', 'validation', 422);
        const label = store.createLabel(repo, {
          name: labelName,
          color: stringField(body, 'color') ?? 'ededed',
          description: stringField(body, 'description'),
        });
        return jsonOk(201, { name: label.name, color: label.color, description: label.description });
      }
      return jsonError(405, `method ${method} not allowed on /labels`);
    }

    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (head === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = (ctx.query.get('state') ?? 'open').toLowerCase();
          const states = state === 'all' ? undefined : state === 'closed' ? (['CLOSED'] as const) : (['OPEN'] as const);
          const sort = (ctx.query.get('sort') ?? 'created').toLowerCase();
          const direction = (ctx.query.get('direction') ?? 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
          const { issues } = store.listIssues(repo, {
            states,
            orderBy: { field: sort === 'updated' ? 'UPDATED_AT' : 'CREATED_AT', direction },
          });
          const { page, headers } = paginate(issues, ctx, `/api/v3/repos/${owner}/${name}/issues`);
          return jsonOk(200, page.map((issue) => issueToJson(repo, issue)), headers);
        }
        if (method === 'POST') {
          const body = bodyObject(ctx);
          const title = stringField(body, 'title');
          if (title === undefined) throw new StoreError('title is required', 'validation', 422);
          const labels = Array.isArray(body.labels)
            ? body.labels.filter((label): label is string => typeof label === 'string')
            : undefined;
          const issue = store.createIssue(repo, { title, body: stringField(body, 'body'), labels });
          return jsonOk(201, issueToJson(repo, issue));
        }
        return jsonError(405, `method ${method} not allowed on /issues`);
      }
      const number = parseNumber(rest[1]);
      if (number === null) return notFound('issue');
      if (rest.length === 2) {
        if (method === 'GET') {
          const issue = store.getIssue(repo, number);
          return issue === undefined
            ? notFound(`issue #${number}`)
            : jsonBufferOk(200, issueJsonBuffer(repo, issue));
        }
        if (method === 'PATCH') {
          const body = bodyObject(ctx);
          const state = stringField(body, 'state');
          const issue = store.updateIssue(repo, number, {
            title: stringField(body, 'title'),
            body: stringField(body, 'body'),
            state: state === 'closed' ? 'CLOSED' : state === 'open' ? 'OPEN' : undefined,
          });
          return jsonOk(200, issueToJson(repo, issue));
        }
        return jsonError(405, `method ${method} not allowed on /issues/${number}`);
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          return jsonOk(200, store.listIssueComments(repo, number).map(commentJson));
        }
        if (method === 'POST') {
          const body = bodyObject(ctx);
          const text = stringField(body, 'body');
          if (text === undefined) throw new StoreError('body is required', 'validation', 422);
          return jsonOk(201, commentJson(store.addIssueComment(repo, number, text)));
        }
        return jsonError(405, `method ${method} not allowed on /issues/${number}/comments`);
      }
      return notFound('route');
    }

    // /repos/{o}/{r}/pulls[/{n}[/files|merge|comments]]
    if (head === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = (ctx.query.get('state') ?? 'open').toLowerCase();
          const states =
            state === 'all'
              ? undefined
              : state === 'closed'
                ? (['CLOSED', 'MERGED'] as const)
                : (['OPEN'] as const);
          const { pullRequests } = store.listPullRequests(repo, { states });
          const { page, headers } = paginate(pullRequests, ctx, `/api/v3/repos/${owner}/${name}/pulls`);
          return jsonOk(200, page.map((pr) => pullToJson(repo, pr)), headers);
        }
        if (method === 'POST') {
          const body = bodyObject(ctx);
          const title = stringField(body, 'title');
          const headRef = stringField(body, 'head');
          const baseRef = stringField(body, 'base');
          if (title === undefined) throw new StoreError('title is required', 'validation', 422);
          if (headRef === undefined || baseRef === undefined) {
            throw new StoreError('head and base are required', 'validation', 422);
          }
          const pr = store.createPullRequest(repo, {
            title,
            body: stringField(body, 'body'),
            headRefName: headRef,
            baseRefName: baseRef,
          });
          return jsonOk(201, pullToJson(repo, pr));
        }
        return jsonError(405, `method ${method} not allowed on /pulls`);
      }
      const number = parseNumber(rest[1]);
      if (number === null) return notFound('pull request');
      if (rest.length === 2) {
        if (method !== 'GET') return jsonError(405, `method ${method} not allowed on /pulls/${number}`);
        const pr = store.getPullRequest(repo, number);
        return pr === undefined ? notFound(`pull request #${number}`) : jsonOk(200, pullToJson(repo, pr));
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') return jsonError(405, `method ${method} not allowed on /pulls/${number}/files`);
        store.requirePullRequest(repo, number);
        return jsonOk(200, pullFilesJson(repo, number));
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') return jsonError(405, `method ${method} not allowed on /pulls/${number}/merge`);
        const body = bodyObject(ctx);
        const methodName = stringField(body, 'merge_method');
        const result = store.mergePullRequest(repo, number, methodName === 'squash' ? 'squash' : 'merge');
        if (!result.merged) return jsonError(405, result.message);
        return jsonOk(200, { sha: result.sha, merged: true, message: result.message });
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const pr = store.requirePullRequest(repo, number);
        if (method === 'GET') return jsonOk(200, pr.comments.map(commentJson));
        if (method === 'POST') {
          const body = bodyObject(ctx);
          const text = stringField(body, 'body');
          if (text === undefined) throw new StoreError('body is required', 'validation', 422);
          return jsonOk(201, commentJson(store.addPrComment(repo, number, text)));
        }
        return jsonError(405, `method ${method} not allowed on /pulls/${number}/comments`);
      }
      return notFound('route');
    }

    return notFound('route');
  } catch (err) {
    if (err instanceof StoreError) return jsonError(err.status, err.message);
    throw err;
  }
}
