// The server: one node:http process routing all four surfaces.
//
//   git smart HTTP   /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack
//   REST v3          /api/v3/*
//   GraphQL v4       /api/graphql (and /graphql as an alias)
//   MCP              /mcp
//
// Auth is a Bearer token, required on the REST and GraphQL surfaces and on
// MCP (401 without one); git paths are unauthenticated, the way a git
// remote is. Every reply carries X-GitHub-Request-Id. Routing overhead is
// kept minimal — no logging in the hot path, no work before the handler
// runs, bodies read once — because the timed workloads share this router.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StoreError, trialNowIso, VIEWER } from './store.ts';
import {
  handleInfoRefs,
  handleReceivePack,
  handleUploadPack,
  nextRequestId,
  type HandlerContext,
  type HandlerResult,
} from './git-http.ts';
import { routeRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The bearer token a request presents, or undefined when it presents none. */
function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  if (!header.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? undefined : token;
}

/** The path segments of a request URL, percent-decoded; null when undecodable. Parsed by hand — no URL object, this runs on every request. */
function segmentsOf(url: string): string[] | null {
  const q = url.indexOf('?');
  const pathname = q === -1 ? url : url.slice(0, q);
  const raw = pathname.split('/');
  const segments: string[] = [];
  for (const part of raw) {
    if (part === '') continue;
    try {
      segments.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  return segments;
}

/** Shared empty query params: no handler mutates ctx.query, so one instance serves every query-less URL. */
const EMPTY_PARAMS = new URLSearchParams();
/** Shared empty headers: only the git handlers read ctx.headers, and they get the real ones. */
const EMPTY_HEADERS: Record<string, string | undefined> = {};

function queryOf(url: string): URLSearchParams {
  const q = url.indexOf('?');
  if (q === -1) return EMPTY_PARAMS;
  try {
    return new URLSearchParams(url.slice(q + 1));
  } catch {
    return EMPTY_PARAMS;
  }
}

/** The request headers as a flat lowercase record (first value wins). */
function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    out[name] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

function jsonResult(status: number, body: unknown, extra: Readonly<Record<string, string>> = {}): HandlerResult {
  return {
    status,
    headers: { 'content-type': JSON_TYPE, ...extra },
    body: `${JSON.stringify(body)}\n`,
  };
}

/** Answer with a HandlerResult, adding the request id when the handler left it out. Mutates the result's headers in place — every result is built fresh per request. */
function send(res: ServerResponse, result: HandlerResult): void {
  const headers = result.headers;
  if (headers['x-github-request-id'] === undefined) headers['x-github-request-id'] = nextRequestId();
  const body = result.body;
  headers['content-length'] = String(typeof body === 'string' ? Buffer.byteLength(body) : body.length);
  res.writeHead(result.status, headers);
  res.end(body);
}

/** Read the whole request body (POST/PUT/PATCH carry one; GET/HEAD do not). A single chunk is returned as-is — no copy. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; null when the body is empty, a 400 result when it is not JSON. */
function parseJsonBody(
  body: Buffer,
): { json: unknown } | { error: HandlerResult } {
  if (body.length === 0) return { json: undefined };
  try {
    return { json: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return { error: jsonResult(400, { message: 'request body is not valid JSON' }) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One GraphQL operation from a parsed body entry (single or batched). */
function runGraphQLOperation(entry: unknown): Record<string, unknown> {
  if (!isRecord(entry) || typeof entry.query !== 'string') {
    return { data: null, errors: [{ message: 'query is required' }] };
  }
  const variables = isRecord(entry.variables) ? entry.variables : undefined;
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
  return executeGraphQL(entry.query, variables, operationName);
}

/** POST /api/graphql (and GET with ?query=): one operation, or a JSON array of them. */
function handleGraphQL(method: string, url: string, ctx: HandlerContext): HandlerResult {
  if (method === 'GET') {
    const query = queryOf(url);
    const document = query.get('query');
    if (document === null) return jsonResult(400, { message: 'query is required' });
    let variables: Record<string, unknown> | undefined;
    const rawVariables = query.get('variables');
    if (rawVariables !== null) {
      try {
        const parsed = JSON.parse(rawVariables) as unknown;
        if (isRecord(parsed)) variables = parsed;
      } catch {
        return jsonResult(400, { message: 'variables is not valid JSON' });
      }
    }
    const operationName = query.get('operationName') ?? undefined;
    return jsonResult(200, executeGraphQL(document, variables, operationName));
  }
  if (method !== 'POST') return jsonResult(405, { message: `method ${method} not allowed on /api/graphql` });
  const parsed = parseJsonBody(ctx.body);
  if ('error' in parsed) return parsed.error;
  const body = parsed.json;
  if (Array.isArray(body)) {
    return jsonResult(200, body.map((entry) => runGraphQLOperation(entry)));
  }
  if (!isRecord(body)) return jsonResult(400, { message: 'the GraphQL body must be an object or an array' });
  return jsonResult(200, runGraphQLOperation(body));
}

/** GET /api/v3/user — the token owner's profile. */
function handleUser(ctx: HandlerContext): HandlerResult {
  return jsonResult(200, {
    login: VIEWER.login,
    id: VIEWER.databaseId,
    node_id: `U_${VIEWER.databaseId}`,
    type: 'User',
    name: VIEWER.name,
    avatar_url: '',
    html_url: '',
    url: `${ctx.origin}/api/v3/user`,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
  });
}

/** Route one request to its surface. The body is already read. */
function route(req: IncomingMessage, body: Buffer): HandlerResult {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';
  const segments = segmentsOf(url);
  if (segments === null) return jsonResult(400, { message: 'the request path is not valid' });
  const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : 'entry';
  const ctx: HandlerContext = {
    origin: `http://${host}`,
    query: queryOf(url),
    body,
    headers: EMPTY_HEADERS,
  };

  // The env's boot check: 200 {"ok":true}, no auth.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    return jsonResult(200, { ok: true });
  }

  // MCP: POST /mcp, authenticated.
  if (segments.length === 1 && segments[0] === 'mcp') {
    if (method !== 'POST') return jsonResult(405, { message: `method ${method} not allowed on /mcp` });
    if (bearerToken(req) === undefined) return jsonResult(401, { message: 'authentication is required' });
    return handleMcp(ctx);
  }

  // GraphQL: POST /api/graphql (or the /graphql alias), authenticated.
  const isGraphQL =
    (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') ||
    (segments.length === 1 && segments[0] === 'graphql');
  if (isGraphQL) {
    if (bearerToken(req) === undefined) return jsonResult(401, { message: 'authentication is required' });
    return handleGraphQL(method, url, ctx);
  }

  // REST v3: /api/v3/*, authenticated. The /user profile is answered here;
  // everything else goes to the REST router with the segments after /api/v3/.
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    if (bearerToken(req) === undefined) return jsonResult(401, { message: 'authentication is required' });
    const rest = segments.slice(2);
    if (rest.length === 1 && rest[0] === 'user') {
      if (method !== 'GET') return jsonResult(405, { message: `method ${method} not allowed on /api/v3/user` });
      return handleUser(ctx);
    }
    const parsed = parseJsonBody(body);
    if ('error' in parsed) return parsed.error;
    return routeRest(method, rest, { ...ctx, json: parsed.json });
  }

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs, git-upload-pack, git-receive-pack}.
  // The .git suffix is stripped before the handlers run; a bare repo name works too.
  if (segments.length >= 3) {
    const owner = segments[0]!;
    const repoSegment = segments[1]!;
    const repoName = repoSegment.endsWith('.git') ? repoSegment.slice(0, -'.git'.length) : repoSegment;
    if (repoName !== '' && owner !== 'api') {
      const gitCtx: HandlerContext = { ...ctx, headers: headersOf(req) };
      if (segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs' && method === 'GET') {
        return handleInfoRefs(owner, repoName, gitCtx);
      }
      if (segments.length === 3 && segments[2] === 'git-upload-pack' && method === 'POST') {
        return handleUploadPack(owner, repoName, gitCtx);
      }
      if (segments.length === 3 && segments[2] === 'git-receive-pack' && method === 'POST') {
        return handleReceivePack(owner, repoName, gitCtx);
      }
    }
  }

  return jsonResult(404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
    const answer = (body: Buffer): void => {
      try {
        send(res, route(req, body));
      } catch (err) {
        if (err instanceof StoreError) {
          send(res, jsonResult(err.status, { message: err.message }));
          return;
        }
        send(res, jsonResult(500, { message: err instanceof Error ? err.message : 'internal server error' }));
      }
    };
    if (!needsBody) {
      answer(Buffer.alloc(0));
      return;
    }
    readBody(req).then(answer, () => {
      send(res, jsonResult(400, { message: 'could not read the request body' }));
    });
  });
}
