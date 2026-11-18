// The MCP endpoint: JSON-RPC 2.0 at /mcp, modern 2026-07-28 era.
//
// No handshake and no session: every request declares its revision in
// `_meta` and the server answers `server/discover` with its identity,
// capabilities and supported revisions in one result. `initialize` is kept
// as the fallback for older clients. The six tools are github-mcp-server's
// names, and every tool result carries both a text block (the JSON payload)
// and `structuredContent` (the payload itself), so either reader finds it.
//
// A tool that cannot run — missing arguments, an unknown repository, a
// merge that conflicts — answers a tool result with `isError: true`, never
// a JSON-RPC error: the call itself succeeded, the tool is reporting the
// failure. Only transport-level problems (an unknown method, an unknown
// tool name, a body that is not JSON) are JSON-RPC errors, and a body that
// is not JSON is HTTP 400 with -32700, the way the 2026-07-28 transport
// requires.

import { store, StoreError, VIEWER } from './store.ts';
import type { Issue, PullRequest, Repository } from './store.ts';
import type { HandlerContext, HandlerResult } from './git-http.ts';

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_REVISION = '2026-07-28';

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

interface JsonRpcError {
  code: number;
  message: string;
}

interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: unknown;
  isError: boolean;
}

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, { readonly type: string; readonly description: string }>>;
    readonly required: readonly string[];
  };
}

/** The six tools, frozen: tools/list must be byte-identical across calls. */
const TOOLS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
        owner: Object.freeze({ type: 'string', description: 'The owner login; the authenticated user when omitted.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'open, closed or all (default open).' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from one branch into another.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

// ---------------------------------------------------------------------------------------------------------
// payloads: the REST-shaped objects the tools return
// ---------------------------------------------------------------------------------------------------------

function repoPayload(repo: Repository): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: repo.id,
    name: repo.name,
    full_name: `${repo.ownerLogin}/${repo.name}`,
    owner: { login: repo.ownerLogin, id: VIEWER.databaseId },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: repo.hasIssuesEnabled,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issuePayload(issue: Issue): Record<string, unknown> {
  return {
    id: issue.databaseId,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'OPEN' ? 'open' : 'closed',
    labels: issue.labels,
    comments: issue.comments.length,
    user: { login: issue.authorLogin },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullPayload(repo: Repository, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.databaseId,
    node_id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state === 'OPEN' ? 'open' : 'closed',
    merged: pr.merged,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRefName, repo: { full_name: `${repo.ownerLogin}/${repo.name}` } },
    base: { ref: pr.baseRefName, repo: { full_name: `${repo.ownerLogin}/${repo.name}` } },
    user: { login: pr.authorLogin },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
  };
}

function okResult(payload: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `error: ${message}` }], isError: true };
}

// ---------------------------------------------------------------------------------------------------------
// argument readers
// ---------------------------------------------------------------------------------------------------------

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function optionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function numberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function missing(required: readonly string[], args: Record<string, unknown>): string | null {
  for (const name of required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// the tools
// ---------------------------------------------------------------------------------------------------------

/** Run one tool by name. Unknown tools throw a JSON-RPC error; tool failures are isError results. */
function callTool(name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const absent = missing(['name'], args);
      if (absent !== null) return errorResult(`missing required argument: ${absent}`);
      const repo = store.createRepo(VIEWER.login, stringArg(args, 'name')!, {
        description: optionalStringArg(args, 'description'),
        private: typeof args.private === 'boolean' ? args.private : undefined,
      });
      return okResult(repoPayload(repo));
    }
    case 'get_repo': {
      const absent = missing(['owner', 'repo'], args);
      if (absent !== null) return errorResult(`missing required argument: ${absent}`);
      const repo = store.requireRepo(stringArg(args, 'owner')!, stringArg(args, 'repo')!);
      return okResult(repoPayload(repo));
    }
    case 'create_issue': {
      const absent = missing(['owner', 'repo', 'title'], args);
      if (absent !== null) return errorResult(`missing required argument: ${absent}`);
      const repo = store.requireRepo(stringArg(args, 'owner')!, stringArg(args, 'repo')!);
      const issue = store.createIssue(repo, {
        title: stringArg(args, 'title')!,
        body: optionalStringArg(args, 'body'),
      });
      return okResult(issuePayload(issue));
    }
    case 'list_issues': {
      const absent = missing(['owner', 'repo'], args);
      if (absent !== null) return errorResult(`missing required argument: ${absent}`);
      const repo = store.requireRepo(stringArg(args, 'owner')!, stringArg(args, 'repo')!);
      const state = optionalStringArg(args, 'state');
      const states =
        state === 'closed' ? ['CLOSED' as const]
        : state === 'all' ? undefined
        : ['OPEN' as const];
      const result = store.listIssues(repo, { states });
      return okResult(result.issues.map(issuePayload));
    }
    case 'create_pull_request': {
      const absent = missing(['owner', 'repo', 'title', 'head', 'base'], args);
      if (absent !== null) return errorResult(`missing required argument: ${absent}`);
      const repo = store.requireRepo(stringArg(args, 'owner')!, stringArg(args, 'repo')!);
      const pr = store.createPullRequest(repo, {
        title: stringArg(args, 'title')!,
        body: optionalStringArg(args, 'body'),
        headRefName: stringArg(args, 'head')!,
        baseRefName: stringArg(args, 'base')!,
      });
      return okResult(pullPayload(repo, pr));
    }
    case 'merge_pull_request': {
      const absent = missing(['owner', 'repo', 'pull_number'], args);
      if (absent !== null) return errorResult(`missing required argument: ${absent}`);
      const repo = store.requireRepo(stringArg(args, 'owner')!, stringArg(args, 'repo')!);
      const number = numberArg(args, 'pull_number');
      if (number === undefined) return errorResult('pull_number must be an integer');
      const result = store.mergePullRequest(repo, number, 'merge');
      if (!result.merged) return errorResult(result.message);
      const pr = store.requirePullRequest(repo, number);
      return okResult({ ...pullPayload(repo, pr), sha: result.sha });
    }
    default:
      throw new McpRpcError(JSON_RPC_INVALID_PARAMS, `unknown tool ${JSON.stringify(name)}`);
  }
}

/** A JSON-RPC-level failure (not a tool failure): the response carries `error`, not `result`. */
class McpRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------------------
// the JSON-RPC dispatcher
// ---------------------------------------------------------------------------------------------------------

function jsonBody(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function rpcResult(id: unknown, result: unknown): HandlerResult {
  return {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: jsonBody({ jsonrpc: '2.0', id, result }),
  };
}

function rpcError(status: number, id: unknown, error: JsonRpcError): HandlerResult {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: jsonBody({ jsonrpc: '2.0', id, error }),
  };
}

function serverInfo(): { name: string; version: string } {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function capabilities(): Record<string, unknown> {
  return { tools: {} };
}

/** Dispatch one parsed JSON-RPC request. `id` is undefined for notifications. */
function dispatch(
  request: Record<string, unknown>,
  id: unknown,
): HandlerResult {
  const method = request.method;
  if (typeof method !== 'string' || method === '') {
    return rpcError(200, id ?? null, { code: JSON_RPC_INVALID_REQUEST, message: 'a method name is required' });
  }
  const params = request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
    ? (request.params as Record<string, unknown>)
    : {};

  // Notifications carry no id and get no answer.
  const isNotification = id === undefined;
  if (method.startsWith('notifications/')) {
    return { status: 202, headers: {}, body: '' };
  }
  if (isNotification) {
    return { status: 202, headers: {}, body: '' };
  }

  try {
    switch (method) {
      case 'server/discover':
        return rpcResult(id, {
          supportedVersions: [PROTOCOL_REVISION],
          serverInfo: serverInfo(),
          capabilities: capabilities(),
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
        });
      case 'initialize': {
        const offered = params.protocolVersion;
        const negotiated =
          typeof offered === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-11-25';
        return rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: capabilities(),
          serverInfo: serverInfo(),
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });
      case 'tools/call': {
        const toolName = params.name;
        if (typeof toolName !== 'string' || toolName === '') {
          return rpcError(200, id, { code: JSON_RPC_INVALID_PARAMS, message: 'tools/call needs a tool name' });
        }
        const args =
          params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
            ? (params.arguments as Record<string, unknown>)
            : {};
        try {
          return rpcResult(id, callTool(toolName, args));
        } catch (err) {
          if (err instanceof McpRpcError) return rpcError(200, id, { code: err.code, message: err.message });
          if (err instanceof StoreError) return rpcResult(id, errorResult(err.message));
          throw err;
        }
      }
      default:
        return rpcError(200, id, { code: JSON_RPC_METHOD_NOT_FOUND, message: `method not found: ${method}` });
    }
  } catch (err) {
    if (err instanceof McpRpcError) return rpcError(200, id, { code: err.code, message: err.message });
    throw err;
  }
}

/**
 * Answer one POST to /mcp. A body that is not JSON is HTTP 400 with
 * JSON-RPC -32700; anything else is a JSON-RPC response (or a 202 for a
 * notification). Auth is app.ts's job, before this runs.
 */
export function handleMcp(ctx: HandlerContext): HandlerResult {
  const text = ctx.body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return rpcError(400, null, { code: JSON_RPC_PARSE_ERROR, message: 'Parse error' });
  }
  if (Array.isArray(parsed)) {
    return rpcError(200, null, { code: JSON_RPC_INVALID_REQUEST, message: 'batch requests are not supported' });
  }
  if (parsed === null || typeof parsed !== 'object') {
    return rpcError(200, null, { code: JSON_RPC_INVALID_REQUEST, message: 'the request must be a JSON-RPC object' });
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id;
  if (id !== undefined && typeof id !== 'string' && typeof id !== 'number') {
    return rpcError(200, null, { code: JSON_RPC_INVALID_REQUEST, message: 'the request id must be a string or a number' });
  }
  return dispatch(request, id);
}
