/**
 * git-http.ts — the forge's git smart-HTTP surface: protocol v2 upload-pack
 * (ls-refs + fetch), v0 upload-pack (advertisement + fetch) and v0
 * receive-pack (push). Node stdlib only; every handler is synchronous, so the
 * timed push/clone workloads never wait on I/O.
 *
 * The wire contract, as the kit's git-client.ts parses it:
 * - info/refs answers the `# service=…` preamble (pkt-line-framed) plus a
 *   flush, then the advertisement. v2 (when the request carries
 *   `Git-Protocol: version=2`) is `version 2` + capability lines; v0 is ref
 *   lines with the capabilities after a NUL on the FIRST ref line. An unborn
 *   repo advertises `<ZERO_OID> capabilities^{}` carrying the capabilities.
 * - v2 fetch answers three sections in order — `acknowledgments` (always
 *   `NAK`), `shallow-info`, `packfile` — each a name line, its content lines,
 *   and a delim; the packfile section carries the pack as sideband band-1
 *   packets and the response ends with a flush. An empty fetch still sends a
 *   packfile section with a valid 0-object pack (32 bytes).
 * - v0 fetch answers `NAK`, then `shallow`/`unshallow` lines, then the
 *   sideband pack, then a flush.
 * - receive-pack takes commands (pkt-lines, the first carrying capabilities
 *   after a NUL) + a flush + a raw pack, and answers report-status pkt-lined
 *   inside sideband band 1 when `side-band-64k` was requested (`unpack ok`,
 *   then `ok <ref>` / `ng <ref> <reason>` per ref). A refused update still
 *   unpacks (and keeps) its objects.
 *
 * Perf: the v2 advertisement is one module-level constant Buffer. Fetch
 * responses are cached keyed by (repo, protocol, wants, haves, depth,
 * shallow) — objects are immutable and a fetch walks only from its wants, so
 * the cached bytes stay correct under later pushes; only a repo
 * delete/recreate under the same name invalidates (see
 * `invalidateRepoCache`, called from rest.ts). That makes the 50 concurrent
 * shallow clones of the clone workload pay one pack build.
 *
 * This module also owns the handler types rest.ts and app.ts share:
 * `HandlerContext` (what app.ts hands a handler) and `HandlerResult` (what a
 * handler returns). app.ts owns routing, auth and the request-id header; the
 * helpers here add a request id anyway so a reply never lacks one.
 */

import { parsePack, writePack, ZERO_OID } from './git.ts';
import type { GitObject } from './git.ts';
import { store, StoreError } from './store.ts';
import type { Repository } from './store.ts';

// ---------------------------------------------------------------------------------------------
// handler types (shared with rest.ts and app.ts)
// ---------------------------------------------------------------------------------------------

/**
 * What app.ts hands a handler. `origin` is the request's origin
 * (`http://` + Host header) — rest.ts needs it for absolute pagination
 * links. `query` is the decoded query string. `body` is the raw request
 * body (possibly empty). `json` is the parsed JSON body for REST requests
 * (app.ts answers 400 itself when the body is malformed JSON, so a handler
 * never sees one). `headers` are the request headers, lowercased names.
 */
export interface HandlerContext {
  readonly origin: string;
  readonly query: URLSearchParams;
  readonly body: Buffer;
  readonly json?: unknown;
  readonly headers: Record<string, string | undefined>;
}

/** What a handler returns: status, headers and a body (Buffer or string). */
export interface HandlerResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer | string;
}

/** Sequential request ids; app.ts may override with its own. */
let requestSeq = 0;
export function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

function jsonError(status: number, message: string): HandlerResult {
  return {
    status,
    headers: { 'content-type': 'application/json', 'x-github-request-id': nextRequestId() },
    body: JSON.stringify({ message }),
  };
}

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

const EMPTY = Buffer.alloc(0);
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');
const HEX4 = /^[0-9a-f]{4}$/;

/** One pkt-line: a 4-hex-digit length (itself included) plus the payload. */
function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), data]);
}

/** Several pkt-lines (and flush/delim markers) as one Buffer. */
function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

type Pkt = { readonly kind: 'data'; readonly payload: Buffer } | { readonly kind: 'flush' | 'delim' };

/** A malformed pkt-line stream (the caller maps it to HTTP 400). */
export class PacketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PacketError';
  }
}

/**
 * Decode pkt-lines from `buf`. Stops after the first flush when
 * `stopAtFlush` is set (receive-pack: the bytes after it are the raw pack)
 * and reports how many bytes were consumed.
 */
function decodePackets(
  buf: Buffer,
  options: { stopAtFlush?: boolean } = {},
): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new PacketError('truncated pkt-line length');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (options.stopAtFlush) break;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (!HEX4.test(head)) throw new PacketError(`bad pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length < 4 || length > 65520 || offset + length > buf.length) {
      throw new PacketError(`pkt-line length ${length} is out of range`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** The data lines of a packet list, as text without the trailing newline. */
function dataLines(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// sideband
// ---------------------------------------------------------------------------------------------

/**
 * A Buffer as sideband packets of one band: each pkt-line holds one band
 * byte plus at most 65515 bytes of data (65520 max pkt-line, minus the
 * 4-byte length and the band byte).
 */
function sideband(band: 1 | 2, data: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < data.length || chunks.length === 0; offset += 65515) {
    const slice = data.subarray(offset, offset + 65515);
    const payload = Buffer.allocUnsafe(1 + slice.length);
    payload[0] = band;
    slice.copy(payload, 1);
    chunks.push(pktLine(payload));
    if (data.length === 0) break;
  }
  return chunks;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

/** v2 capabilities: fetch with shallow, ls-refs with unborn, sha1 objects. */
const V2_ADVERTISEMENT: Buffer = pktLines([
  '# service=git-upload-pack\n',
  'flush',
  'version 2\n',
  'ls-refs=unborn\n',
  'fetch=shallow\n',
  'object-format=sha1\n',
  'flush',
]);

const V0_UPLOAD_CAPABILITIES = 'side-band-64k shallow thin-pack ofs-delta';
const V0_RECEIVE_CAPABILITIES = 'report-status side-band-64k delete-refs';

/**
 * A v0 ref advertisement: the service preamble, then ref lines (HEAD first,
 * carrying the capabilities after a NUL on the first line), with a
 * `<peeled> <ref>^{}` line after each annotated tag. An unborn repo
 * advertises one `<ZERO_OID> capabilities^{}` line carrying the capabilities.
 */
function v0Advertisement(repo: Repository, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const defaultRef = store.defaultBranchRefName(repo);
  const symref = `symref=HEAD:${defaultRef}`;
  const capabilities =
    service === 'git-upload-pack' ? `${V0_UPLOAD_CAPABILITIES} ${symref}` : `${V0_RECEIVE_CAPABILITIES} ${symref}`;
  const refs = store.listRefs(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`), FLUSH);
    return Buffer.concat(parts);
  }
  const headTip = store.getRef(repo, defaultRef);
  const lines: string[] = [];
  let first = true;
  const caps = (): string => {
    if (!first) return '';
    first = false;
    return `\0${capabilities}`;
  };
  if (headTip !== undefined) lines.push(`${headTip} HEAD${caps()}\n`);
  for (const ref of refs) {
    lines.push(`${ref.oid} ${ref.name}${caps()}\n`);
    const peeled = store.peelTag(repo, ref.oid);
    if (peeled !== ref.oid) lines.push(`${peeled} ${ref.name}^{}\n`);
  }
  parts.push(pktLines([...lines, 'flush']));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------------------------

function lsRefsResponse(repo: Repository, args: readonly string[]): Buffer {
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const defaultRef = store.defaultBranchRefName(repo);
  const headTip = store.getRef(repo, defaultRef);
  const lines: string[] = [];
  if (headTip !== undefined) {
    if (keep('HEAD')) lines.push(`${headTip} HEAD${wantSymrefs ? ` symref-target:${defaultRef}` : ''}\n`);
  } else if (wantUnborn && keep('HEAD')) {
    lines.push(`unborn HEAD symref-target:${defaultRef}\n`);
  }
  for (const ref of store.listRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wantPeel) {
      const peeled = store.peelTag(repo, ref.oid);
      if (peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return pktLines([...lines, 'flush']);
}

// ---------------------------------------------------------------------------------------------
// fetch (v2 and v0 share the selection; only the framing differs)
// ---------------------------------------------------------------------------------------------

/** Cached fetch responses, keyed by repo + protocol + the fetch parameters. */
const fetchCache = new Map<string, Buffer>();
const FETCH_CACHE_MAX = 128;

/** Drop every cached fetch for one repo (call on create/delete under a reused name). */
export function invalidateRepoCache(owner: string, name: string): void {
  const prefix = `${owner}/${name}|`;
  for (const key of [...fetchCache.keys()]) {
    if (key.startsWith(prefix)) fetchCache.delete(key);
  }
}

interface FetchParams {
  readonly wants: readonly string[];
  readonly haves: readonly string[];
  readonly shallow: readonly string[];
  readonly depth: number | undefined;
  /** A request carrying filter/deepen-since/deepen-not bypasses the cache. */
  readonly cacheable: boolean;
}

function fetchCacheKey(
  owner: string,
  name: string,
  protocol: 2 | 0,
  params: FetchParams,
): string {
  const wants = [...params.wants].sort().join(',');
  const haves = [...params.haves].sort().join(',');
  const shallow = [...params.shallow].sort().join(',');
  return `${owner}/${name}|v${protocol}|${wants}|${haves}|${params.depth ?? ''}|${shallow}`;
}

/**
 * The objects a fetch sends, as a v2 response: `acknowledgments` (always
 * NAK — the client accepts it and the checks never require an ACK),
 * `shallow-info`, `packfile` (sideband band 1), flush.
 */
function v2FetchBody(selection: { objects: GitObject[]; shallow: string[]; unshallow: string[] }): Buffer {
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [
    pktLine('acknowledgments\n'),
    pktLine('NAK\n'),
    DELIM,
    pktLine('shallow-info\n'),
  ];
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(DELIM, pktLine('packfile\n'), ...sideband(1, pack), FLUSH);
  return Buffer.concat(parts);
}

/** The same selection as a v0 response: NAK, shallow lines, sideband pack, flush. */
function v0FetchBody(selection: { objects: GitObject[]; shallow: string[]; unshallow: string[] }): Buffer {
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sideband(1, pack), FLUSH);
  return Buffer.concat(parts);
}

function serveFetch(
  repo: Repository,
  owner: string,
  name: string,
  protocol: 2 | 0,
  params: FetchParams,
): Buffer {
  const key = params.cacheable ? fetchCacheKey(owner, name, protocol, params) : null;
  if (key !== null) {
    const hit = fetchCache.get(key);
    if (hit !== undefined) return hit;
  }
  const selection = store.fetchObjects(repo, {
    wants: params.wants,
    haves: params.haves,
    depth: params.depth,
    shallow: params.shallow,
  });
  const body = protocol === 2 ? v2FetchBody(selection) : v0FetchBody(selection);
  if (key !== null) {
    if (fetchCache.size >= FETCH_CACHE_MAX) {
      const oldest = fetchCache.keys().next().value;
      if (oldest !== undefined) fetchCache.delete(oldest);
    }
    fetchCache.set(key, body);
  }
  return body;
}

// ---------------------------------------------------------------------------------------------
// v2 request parsing
// ---------------------------------------------------------------------------------------------

function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const { packets } = decodePackets(body);
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (command === '' && line.startsWith('command=')) command = line.slice('command='.length);
      // agent= and object-format= lines before the delim are ignored.
    } else {
      args.push(line);
    }
  }
  return { command, args };
}

function parseFetchArgs(args: readonly string[]): FetchParams {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let cacheable = true;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).split(' ')[0]);
    else if (arg.startsWith('have ')) haves.push(arg.slice(5));
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8));
    else if (arg.startsWith('deepen ')) {
      const value = Number(arg.slice(7));
      if (Number.isInteger(value) && value > 0) depth = value;
    } else if (arg.startsWith('deepen-since ') || arg.startsWith('deepen-not ') || arg.startsWith('filter ')) {
      cacheable = false; // Unsupported selectors: answer a plain fetch, uncached.
    }
    // done, thin-pack, no-progress, ofs-delta: no effect on the answer.
  }
  return { wants, haves, shallow, depth, cacheable };
}

// ---------------------------------------------------------------------------------------------
// v0 fetch request parsing
// ---------------------------------------------------------------------------------------------

function parseV0Fetch(body: Buffer): FetchParams {
  const { packets } = decodePackets(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let cacheable = true;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8));
      else if (line.startsWith('deepen ')) {
        const value = Number(line.slice(7));
        if (Number.isInteger(value) && value > 0) depth = value;
      } else if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) cacheable = false;
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5));
    }
    // done: no effect.
  }
  return { wants, haves, shallow, depth, cacheable };
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function parseReceivePack(body: Buffer): {
  commands: PushCommand[];
  capabilities: Set<string>;
  pack: Buffer;
} {
  const { packets, consumed } = decodePackets(body, { stopAtFlush: true });
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      for (const capability of line.slice(nul + 1).split(' ')) {
        if (capability) capabilities.add(capability);
      }
      line = line.slice(0, nul);
    }
    const [oldOid, newOid, ref] = line.split(' ');
    if (oldOid === undefined || newOid === undefined || ref === undefined) {
      throw new PacketError(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
    }
    if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid)) {
      throw new PacketError('push command has a bad object id');
    }
    if (!ref.startsWith('refs/')) throw new PacketError(`push command has a bad ref ${JSON.stringify(ref)}`);
    commands.push({ oldOid, newOid, ref });
  }
  return { commands, capabilities, pack: body.subarray(consumed) };
}

function handleReceivePackBody(repo: Repository, body: Buffer): Buffer {
  const { commands, capabilities, pack } = parseReceivePack(body);
  const sidebandOn = capabilities.has('side-band-64k');
  const reportStatus = capabilities.has('report-status') || capabilities.has('report-status-v2');
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const parsed = parsePack(pack, { resolveBase: store.lookup(repo) });
      if (!parsed.checksumOk) {
        unpackOk = false;
        unpackDetail = 'pack checksum mismatch';
      } else {
        store.putPackObjects(repo, parsed.objects.values());
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail.replace(/\n/g, ' ').slice(0, 120)}\n`];
  if (unpackOk) {
    for (const command of commands) {
      const result = store.updateRef(repo, command.ref, command.newOid, command.oldOid);
      lines.push(result.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${result.reason ?? 'refused'}\n`);
    }
  }
  // Without report-status the client reads no report; answer the pkt-lined
  // stream anyway (real git does) — the client only parses it when asked.
  void reportStatus;
  const reportStream = pktLines([...lines, 'flush']);
  if (sidebandOn) {
    return Buffer.concat([...sideband(1, reportStream), FLUSH]);
  }
  return reportStream;
}

// ---------------------------------------------------------------------------------------------
// handlers (app.ts routes to these)
// ---------------------------------------------------------------------------------------------

/** GET /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack */
export function handleInfoRefs(owner: string, repoName: string, ctx: HandlerContext): HandlerResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return jsonError(404, `repository ${owner}/${repoName} not found`);
  const service = ctx.query.get('service');
  if (service === 'git-upload-pack') {
    const v2 = ctx.headers['git-protocol'] === 'version=2';
    return {
      status: 200,
      headers: {
        'content-type': 'application/x-git-upload-pack-advertisement',
        'x-github-request-id': nextRequestId(),
      },
      body: v2 ? V2_ADVERTISEMENT : v0Advertisement(repo, 'git-upload-pack'),
    };
  }
  if (service === 'git-receive-pack') {
    return {
      status: 200,
      headers: {
        'content-type': 'application/x-git-receive-pack-advertisement',
        'x-github-request-id': nextRequestId(),
      },
      body: v0Advertisement(repo, 'git-receive-pack'),
    };
  }
  return jsonError(400, `unknown service ${JSON.stringify(service)}`);
}

/** POST /{owner}/{repo}.git/git-upload-pack — v2 ls-refs/fetch or a v0 fetch. */
export function handleUploadPack(owner: string, repoName: string, ctx: HandlerContext): HandlerResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return jsonError(404, `repository ${owner}/${repoName} not found`);
  try {
    let body: Buffer;
    if (ctx.headers['git-protocol'] === 'version=2') {
      const { command, args } = parseV2Request(ctx.body);
      if (command === 'ls-refs') body = lsRefsResponse(repo, args);
      else if (command === 'fetch') body = serveFetch(repo, owner, repoName, 2, parseFetchArgs(args));
      else throw new PacketError(`unsupported v2 command ${JSON.stringify(command)}`);
    } else {
      body = serveFetch(repo, owner, repoName, 0, parseV0Fetch(ctx.body));
    }
    return {
      status: 200,
      headers: {
        'content-type': 'application/x-git-upload-pack-result',
        'x-github-request-id': nextRequestId(),
      },
      body,
    };
  } catch (err) {
    if (err instanceof StoreError) return jsonError(err.status, err.message);
    if (err instanceof PacketError) return jsonError(400, err.message);
    throw err;
  }
}

/** POST /{owner}/{repo}.git/git-receive-pack — a v0 push. */
export function handleReceivePack(owner: string, repoName: string, ctx: HandlerContext): HandlerResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return jsonError(404, `repository ${owner}/${repoName} not found`);
  try {
    return {
      status: 200,
      headers: {
        'content-type': 'application/x-git-receive-pack-result',
        'x-github-request-id': nextRequestId(),
      },
      body: handleReceivePackBody(repo, ctx.body),
    };
  } catch (err) {
    if (err instanceof StoreError) return jsonError(err.status, err.message);
    if (err instanceof PacketError) return jsonError(400, err.message);
    throw err;
  }
}
