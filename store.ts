/**
 * store.ts — the forge's in-memory store: repositories, the git object graph,
 * refs, issues, pull requests, comments and labels. One process, no database,
 * no disk; every function is synchronous, so the timed workloads (200 pushes,
 * 50 concurrent clones, 2000 issue reads, 200 issue writes) never wait on I/O.
 *
 * Determinism is mandatory: ids and numbers come from sequential counters,
 * and every timestamp comes from the fixed trial clock (`trialNow()`), never
 * from the wall clock and never from randomness. Two runs on the same
 * instance produce byte-identical state.
 *
 * Field names match what the REST, GraphQL and MCP surfaces read:
 * repository id/databaseId/name/owner/defaultBranchRef/viewerPermission/
 * hasIssuesEnabled; issue number/title/body/state/comments; pull request
 * number/title/body/state/headRefName/baseRefName/mergeable/merged/files.
 */

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  isAncestor as gitIsAncestor,
  isObjectId,
  mergeBase as gitMergeBase,
  parseCommit,
  parseTag,
  parseTree,
  peelTag as gitPeelTag,
  walkCommits,
} from './git.ts';
import type { GitObject, GitObjectType, TreeEntry } from './git.ts';

/** The fixed authenticated user; derived from a fixed seed, never from a request. */
export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  databaseId: 1000,
  type: 'User',
  name: 'Ada Iversen',
});

/** The identity server-generated commits (merges, content writes) carry. */
export const SERVER_IDENTITY = 'Ada Iversen <adaiversen@make.fun>';

// ---------------------------------------------------------------------------------------------
// the trial clock
// ---------------------------------------------------------------------------------------------

/** Unix seconds for "now": `MAKEFUN_TRIAL_NOW` when set, else the fixed default. */
function readTrialNow(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) {
      // A millisecond value (past the year 2100 in seconds) is divided down.
      return value > 4102444800 ? Math.floor(value / 1000) : Math.floor(value);
    }
  }
  return 1700000000;
}

const TRIAL_NOW = readTrialNow();

/** The trial clock, in Unix seconds. Fixed for the whole run. */
export function trialNow(): number {
  return TRIAL_NOW;
}

/** The trial clock as an ISO-8601 timestamp. The clock is fixed, so the string is computed once. */
const TRIAL_NOW_ISO = new Date(TRIAL_NOW * 1000).toISOString();
export function trialNowIso(): string {
  return TRIAL_NOW_ISO;
}

// ---------------------------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------------------------

/** A store failure the HTTP layer maps to a status: `status` is the HTTP code. */
export class StoreError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code = 'store', status = 400) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.status = status;
  }
}

function notFound(what: string): StoreError {
  return new StoreError(`${what} not found`, 'not-found', 404);
}

function alreadyExists(what: string): StoreError {
  return new StoreError(`${what} already exists`, 'already-exists', 422);
}

function validation(message: string): StoreError {
  return new StoreError(message, 'validation', 422);
}

// ---------------------------------------------------------------------------------------------
// the data model
// ---------------------------------------------------------------------------------------------

export type IssueState = 'OPEN' | 'CLOSED';
export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';

export interface IssueComment {
  readonly id: string;
  readonly databaseId: number;
  body: string;
  readonly authorLogin: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Issue {
  readonly id: string;
  readonly databaseId: number;
  readonly number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  readonly comments: IssueComment[];
  readonly authorLogin: string;
  readonly createdAt: string;
  updatedAt: string;
  /** Creation sequence (per repo): the tie-break when timestamps are equal. */
  readonly seq: number;
  updatedSeq: number;
}

export interface PullRequest {
  readonly id: string;
  readonly databaseId: number;
  readonly number: number;
  title: string;
  body: string;
  state: PullRequestState;
  /** Branch short names, e.g. `feature` and `main` (not full ref names). */
  readonly headRefName: string;
  readonly baseRefName: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  readonly comments: IssueComment[];
  readonly authorLogin: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly seq: number;
  updatedSeq: number;
}

export interface Label {
  readonly id: string;
  readonly name: string;
  color: string;
  description: string;
}

export interface Repository {
  readonly id: string;
  readonly databaseId: number;
  name: string;
  readonly ownerLogin: string;
  description: string;
  private: boolean;
  /** Short name of the default branch, usually `main`. */
  defaultBranch: string;
  readonly viewerPermission: string;
  readonly hasIssuesEnabled: boolean;
  readonly createdAt: string;
  updatedAt: string;
  /** Full ref name → commit oid, e.g. `refs/heads/main`. */
  readonly refs: Map<string, string>;
  /** Object id → object. */
  readonly objects: Map<string, GitObject>;
  readonly issues: Map<number, Issue>;
  readonly pullRequests: Map<number, PullRequest>;
  readonly labels: Map<string, Label>;
  nextIssueNumber: number;
  nextPullRequestNumber: number;
  nextIssueDatabaseId: number;
  nextPullRequestDatabaseId: number;
}

export interface RefUpdateResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface PageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export interface IssueListResult {
  readonly issues: Issue[];
  readonly pageInfo: PageInfo;
  readonly totalCount: number;
}

export interface PullRequestListResult {
  readonly pullRequests: PullRequest[];
  readonly pageInfo: PageInfo;
  readonly totalCount: number;
}

export interface PullRequestFile {
  readonly path: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

export interface MergeResult {
  readonly merged: boolean;
  readonly sha: string | null;
  readonly message: string;
  readonly conflicts?: string[];
}

export interface FetchSelection {
  /** The objects to send, sorted by id for byte-identical packs. */
  readonly objects: GitObject[];
  /** Commits at the depth boundary: their parents were cut off. */
  readonly shallow: string[];
  /** Client shallow commits this fetch deepened past. */
  readonly unshallow: string[];
}

export interface NodeRef {
  readonly kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment' | 'Label';
  readonly owner: string;
  readonly repo: string;
  readonly number?: number;
  readonly name?: string;
}

export interface OrderBy {
  readonly field: 'CREATED_AT' | 'UPDATED_AT';
  readonly direction: 'ASC' | 'DESC';
}

const DEFAULT_ORDER: OrderBy = { field: 'CREATED_AT', direction: 'DESC' };

function encodeCursor(kind: string, number: number): string {
  return Buffer.from(`${kind}:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, kind: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const prefix = `${kind}:`;
    if (!text.startsWith(prefix)) return null;
    const number = Number(text.slice(prefix.length));
    return Number.isInteger(number) && number > 0 ? number : null;
  } catch {
    return null;
  }
}

function pageOf<T extends { readonly number: number }>(
  sorted: T[],
  kind: string,
  first: number | undefined,
  after: string | undefined,
): { items: T[]; pageInfo: PageInfo } {
  let start = 0;
  if (after !== undefined) {
    const afterNumber = decodeCursor(after, kind);
    if (afterNumber !== null) {
      const index = sorted.findIndex((item) => item.number === afterNumber);
      if (index >= 0) start = index + 1;
    }
  }
  const limit = first === undefined ? sorted.length - start : Math.max(0, first);
  const items = sorted.slice(start, start + limit);
  const hasNextPage = start + items.length < sorted.length;
  return {
    items,
    pageInfo: {
      hasNextPage,
      endCursor: items.length ? encodeCursor(kind, items[items.length - 1].number) : null,
    },
  };
}

function compareOrdered(
  a: { readonly seq: number; updatedSeq: number },
  b: { readonly seq: number; updatedSeq: number },
  orderBy: OrderBy,
): number {
  const keyA = orderBy.field === 'UPDATED_AT' ? a.updatedSeq : a.seq;
  const keyB = orderBy.field === 'UPDATED_AT' ? b.updatedSeq : b.seq;
  return orderBy.direction === 'ASC' ? keyA - keyB : keyB - keyA;
}

// ---------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------

export class ForgeStore {
  /** owner login → (repo name → repository). */
  private readonly repos = new Map<string, Map<string, Repository>>();
  /** Global id → what it names (for GraphQL `node(id:)`). */
  private readonly nodes = new Map<string, NodeRef>();

  private nextRepoDatabaseId = 1;
  private nextIssueId = 1;
  private nextPullRequestId = 1;
  private nextCommentId = 1;
  private nextLabelId = 1;
  /** Monotonic mutation counter, for UPDATED_AT ordering under a fixed clock. */
  private mutationSeq = 0;

  private tick(): number {
    this.mutationSeq += 1;
    return this.mutationSeq;
  }

  // -- repositories -------------------------------------------------------------

  createRepo(
    owner: string,
    name: string,
    options: { description?: string; private?: boolean; defaultBranch?: string } = {},
  ): Repository {
    if (!owner) throw validation('owner is required');
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw validation(`invalid repository name ${JSON.stringify(name)}`);
    let byOwner = this.repos.get(owner);
    if (!byOwner) {
      byOwner = new Map();
      this.repos.set(owner, byOwner);
    }
    if (byOwner.has(name)) throw alreadyExists(`repository ${owner}/${name}`);
    const databaseId = this.nextRepoDatabaseId++;
    const now = trialNowIso();
    const repo: Repository = {
      id: `R_${databaseId}`,
      databaseId,
      name,
      ownerLogin: owner,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      pullRequests: new Map(),
      labels: new Map(),
      nextIssueNumber: 1,
      nextPullRequestNumber: 1,
      nextIssueDatabaseId: 1,
      nextPullRequestDatabaseId: 1,
    };
    byOwner.set(name, repo);
    this.nodes.set(repo.id, { kind: 'Repository', owner, repo: name });
    return repo;
  }

  getRepo(owner: string, name: string): Repository | undefined {
    return this.repos.get(owner)?.get(name);
  }

  requireRepo(owner: string, name: string): Repository {
    const repo = this.getRepo(owner, name);
    if (!repo) throw notFound(`repository ${owner}/${name}`);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const byOwner = this.repos.get(owner);
    const repo = byOwner?.get(name);
    if (!repo) return false;
    byOwner!.delete(name);
    if (byOwner!.size === 0) this.repos.delete(owner);
    this.nodes.delete(repo.id);
    for (const issue of repo.issues.values()) {
      this.nodes.delete(issue.id);
      for (const comment of issue.comments) this.nodes.delete(comment.id);
    }
    for (const pr of repo.pullRequests.values()) {
      this.nodes.delete(pr.id);
      for (const comment of pr.comments) this.nodes.delete(comment.id);
    }
    for (const label of repo.labels.values()) this.nodes.delete(label.id);
    return true;
  }

  /** Every repository of one owner, in creation order. */
  listRepos(owner: string): Repository[] {
    return [...(this.repos.get(owner)?.values() ?? [])];
  }

  /** Resolve a global id (GraphQL `node(id:)`); undefined when unknown. */
  getNode(id: string): NodeRef | undefined {
    return this.nodes.get(id);
  }

  /** The full ref name of a repository's default branch. */
  defaultBranchRefName(repo: Repository): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  // -- objects ------------------------------------------------------------------

  /** Store an object (idempotent) and return its id. */
  putObject(repo: Repository, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repository, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  hasObject(repo: Repository, oid: string): boolean {
    return repo.objects.has(oid);
  }

  /** A lookup bound to one repository, for the git.ts walk helpers. */
  lookup(repo: Repository): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** Store every object from a parsed pack; returns the ids stored. */
  putPackObjects(repo: Repository, objects: Iterable<GitObject>): string[] {
    const stored: string[] = [];
    for (const object of objects) {
      const oid = hashObject(object.type, object.data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: object.data });
      stored.push(oid);
    }
    return stored;
  }

  // -- refs ---------------------------------------------------------------------

  /** The exact value of a ref, or undefined when the ref does not exist. */
  getRef(repo: Repository, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Resolve a ref, following HEAD to the default branch. */
  resolveRef(repo: Repository, ref: string): string | undefined {
    if (ref === 'HEAD') return repo.refs.get(this.defaultBranchRefName(repo));
    return repo.refs.get(ref);
  }

  /** Every ref, sorted by name. */
  listRefs(repo: Repository): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()]
      .map(([name, oid]) => ({ name, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * Update a ref with fast-forward enforcement. `oldOid` is the value the
   * caller believes the ref holds (`ZERO_OID` for a create); `newOid` is the
   * new tip (`ZERO_OID` for a delete). Returns `{ok, reason}` — a refused
   * update changes nothing. The refusal reason for a non-fast-forward update
   * is exactly `non-fast-forward`.
   */
  updateRef(repo: Repository, ref: string, newOid: string, oldOid: string): RefUpdateResult {
    if (!ref.startsWith('refs/')) return { ok: false, reason: 'invalid ref' };
    if (!isObjectId(newOid) || !isObjectId(oldOid)) return { ok: false, reason: 'invalid object id' };
    const current = repo.refs.get(ref);
    if (oldOid !== ZERO_OID && oldOid !== current) return { ok: false, reason: 'stale old value' };
    if (newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) return { ok: false, reason: 'no such ref' };
      repo.refs.delete(ref);
      return { ok: true };
    }
    if (!this.hasObject(repo, newOid)) return { ok: false, reason: 'missing object' };
    if (current === undefined) {
      // Create: oldOid must have been zero (checked above).
      repo.refs.set(ref, newOid);
      return { ok: true };
    }
    if (newOid === current) return { ok: true };
    if (!gitIsAncestor(current, newOid, this.lookup(repo))) {
      return { ok: false, reason: 'non-fast-forward' };
    }
    repo.refs.set(ref, newOid);
    return { ok: true };
  }

  // -- trees and files ----------------------------------------------------------

  /**
   * Flatten a tree to `path → {oid, mode}`, recursing into directories.
   * Gitlinks are kept as entries (their target is not in this repo).
   */
  flattenTree(repo: Repository, treeOid: string): Map<string, { oid: string; mode: string }> {
    const files = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else files.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return files;
  }

  /** Build nested tree objects from a flat `path → {oid, mode}` map; returns the root tree id. */
  buildTreeFromFiles(repo: Repository, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, value] of files) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index];
        let child = node.dirs.get(name);
        if (!child) {
          child = make();
          node.dirs.set(name, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1], value);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Read one file out of a commit's tree; undefined when the path is absent. */
  getFileAtCommit(
    repo: Repository,
    commitOid: string,
    path: string,
  ): { oid: string; mode: string; data: Buffer } | undefined {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return undefined;
    const treeOid = parseCommit(commit.data).tree;
    const files = this.flattenTree(repo, treeOid);
    const found = files.get(path);
    if (!found) return undefined;
    const blob = repo.objects.get(found.oid);
    if (!blob || blob.type !== 'blob') return undefined;
    return { oid: found.oid, mode: found.mode, data: blob.data };
  }

  /** Create a commit object (no ref is moved). */
  createCommit(
    repo: Repository,
    fields: {
      tree: string;
      parents?: readonly string[];
      message: string;
      author?: string;
      committer?: string;
    },
  ): string {
    return this.putObject(
      repo,
      'commit',
      buildCommit({
        tree: fields.tree,
        parents: fields.parents ?? [],
        message: fields.message,
        author: fields.author ?? SERVER_IDENTITY,
        committer: fields.committer ?? SERVER_IDENTITY,
        timestamp: trialNow(),
      }),
    );
  }

  // -- fetch selection (git smart-HTTP) -----------------------------------------

  /**
   * The objects a fetch must send for `wants`, minus what the client already
   * holds (`haves`). `depth` limits the walk to that many commit generations
   * from each want; `shallow` is the client's current shallow boundary, which
   * the walk deepens past instead of pruning at. Returns the objects (sorted
   * by id), the new shallow boundary, and the commits this fetch unshallows.
   *
   * Two subtleties matter here. First, the wanted closure is built from the
   * *walked* commits' trees only — a plain reachable-closure would follow
   * parents past the depth limit and leak history into a shallow fetch.
   * Second, the held closure does not traverse past a shallow have's parents:
   * a shallow client holds the boundary commit and its tree, not its history.
   */
  fetchObjects(
    repo: Repository,
    options: {
      wants: readonly string[];
      haves?: readonly string[];
      depth?: number;
      shallow?: readonly string[];
    },
  ): FetchSelection {
    const lookup = this.lookup(repo);
    const wants = [...new Set(options.wants)].filter((oid) => oid !== ZERO_OID);
    for (const want of wants) {
      if (!repo.objects.has(want)) throw notFound(`object ${want}`);
    }
    const haves = new Set(options.haves ?? []);
    const clientShallow = new Set(options.shallow ?? []);
    // Haves prune the walk — except the client's shallow boundary, which the
    // walk must deepen past (the client holds those commits, not their parents).
    const prune = new Set([...haves].filter((oid) => !clientShallow.has(oid)));
    const { commits } = walkCommits(wants, lookup, { maxDepth: options.depth, prune });
    const included = new Set(commits);

    // Wanted: the walked commits and their tree closures, plus wanted tags
    // (and a tag target's tree closure when the target is a tree or blob;
    // a commit target is already in `included` via the walk).
    const wanted = new Set<string>();
    for (const oid of included) {
      wanted.add(oid);
      this.addTreeClosure(repo, parseCommit(repo.objects.get(oid)!.data).tree, wanted);
    }
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (!object) continue;
      if (object.type === 'tag') {
        wanted.add(want);
        const target = parseTag(object.data).object;
        const targetObject = repo.objects.get(target);
        if (targetObject?.type === 'tree') this.addTreeClosure(repo, target, wanted);
        else if (targetObject?.type === 'blob') wanted.add(target);
      } else if (object.type === 'tree') {
        this.addTreeClosure(repo, want, wanted);
      } else if (object.type === 'blob') {
        wanted.add(want);
      }
    }

    // Held: the closure of the haves, not traversing past a shallow have.
    const held = new Set<string>();
    const heldQueue = [...haves];
    while (heldQueue.length) {
      const oid = heldQueue.pop()!;
      if (held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      held.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        this.addTreeClosure(repo, commit.tree, held);
        if (!clientShallow.has(oid)) {
          for (const parent of commit.parents) heldQueue.push(parent);
        }
      } else if (object.type === 'tag') {
        heldQueue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        this.addTreeClosure(repo, oid, held);
      }
    }

    const objects: GitObject[] = [];
    for (const oid of [...wanted].sort()) {
      if (held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object) objects.push(object);
    }

    // The shallow boundary: included commits whose parents exist but were not
    // walked (cut off by depth or by a have). Roots are never shallow.
    const shallow: string[] = [];
    if (options.depth !== undefined) {
      for (const oid of commits) {
        const parents = parseCommit(repo.objects.get(oid)!.data).parents;
        if (parents.length === 0) continue;
        if (parents.some((parent) => repo.objects.has(parent) && !included.has(parent))) shallow.push(oid);
      }
      shallow.sort();
    }

    // Unshallow: a client-shallow commit is deepened when it is in the walk
    // (or already held) and every parent it has in the store is now included
    // or held too.
    const unshallow: string[] = [];
    for (const oid of clientShallow) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      if (!included.has(oid) && !haves.has(oid)) continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0) continue;
      const deepened = parents.every(
        (parent) => included.has(parent) || held.has(parent) || !repo.objects.has(parent),
      );
      if (deepened) unshallow.push(oid);
    }
    unshallow.sort();

    return { objects, shallow, unshallow };
  }

  /** Add a tree and everything under it (trees, blobs) to `out`. Gitlinks are added as entries. */
  private addTreeClosure(repo: Repository, treeOid: string, out: Set<string>): void {
    const queue = [treeOid];
    while (queue.length) {
      const oid = queue.pop()!;
      if (out.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') continue;
      out.add(oid);
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000') queue.push(entry.oid);
        else out.add(entry.oid);
      }
    }
  }

  /** Follow annotated tags to the object they ultimately point at. */
  peelTag(repo: Repository, oid: string): string {
    return gitPeelTag(oid, this.lookup(repo));
  }

  // -- merge helpers ------------------------------------------------------------

  mergeBase(repo: Repository, aOid: string, bOid: string): string | null {
    return gitMergeBase(aOid, bOid, this.lookup(repo));
  }

  isAncestor(repo: Repository, ancestorOid: string, oid: string): boolean {
    return gitIsAncestor(ancestorOid, oid, this.lookup(repo));
  }

  /**
   * A three-way merge of `oursOid` and `theirsOid` against their common
   * ancestor `baseOid` (commit ids; a tree id may be passed directly and is
   * used as-is). Returns the merged tree id, or a conflict flag with the
   * conflicting paths when both sides changed the same path differently.
   */
  threeWayMerge(
    repo: Repository,
    baseOid: string,
    oursOid: string,
    theirsOid: string,
  ): { tree: string | null; conflict: boolean; conflicts: string[] } {
    const treeOf = (oid: string): string => {
      const object = repo.objects.get(oid);
      if (!object) return '';
      if (object.type === 'tree') return oid;
      if (object.type === 'commit') return parseCommit(object.data).tree;
      return '';
    };
    const base = baseOid ? this.flattenTree(repo, treeOf(baseOid)) : new Map();
    const ours = this.flattenTree(repo, treeOf(oursOid));
    const theirs = this.flattenTree(repo, treeOf(theirsOid));
    const merged = new Map<string, { oid: string; mode: string }>();
    const conflicts: string[] = [];
    const same = (
      a: { oid: string; mode: string } | undefined,
      b: { oid: string; mode: string } | undefined,
    ): boolean => {
      if (a === undefined || b === undefined) return a === b;
      return a.oid === b.oid && a.mode === b.mode;
    };
    const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      if (same(o, t)) {
        if (o !== undefined) merged.set(path, o);
      } else if (same(o, b)) {
        if (t !== undefined) merged.set(path, t);
      } else if (same(t, b)) {
        if (o !== undefined) merged.set(path, o);
      } else {
        conflicts.push(path);
      }
    }
    // A path one side keeps as a file while the other side turns into a
    // directory (or vice versa) is a conflict too.
    for (const path of conflicts) merged.delete(path);
    const filePaths = [...merged.keys()];
    for (const path of filePaths) {
      const segments = path.split('/');
      for (let index = 1; index < segments.length; index += 1) {
        const ancestor = segments.slice(0, index).join('/');
        if (merged.has(ancestor)) {
          conflicts.push(path);
          merged.delete(path);
          break;
        }
      }
    }
    if (conflicts.length) return { tree: null, conflict: true, conflicts: [...new Set(conflicts)].sort() };
    return { tree: this.buildTreeFromFiles(repo, merged), conflict: false, conflicts: [] };
  }

  // -- issues -------------------------------------------------------------------

  createIssue(
    repo: Repository,
    input: { title: string; body?: string; labels?: string[] },
  ): Issue {
    if (!input.title) throw validation('issue title is required');
    const labels = input.labels ?? [];
    for (const name of labels) {
      if (!repo.labels.has(name)) throw validation(`unknown label ${JSON.stringify(name)}`);
    }
    const number = repo.nextIssueNumber++;
    const databaseId = repo.nextIssueDatabaseId++;
    const now = trialNowIso();
    const seq = this.tick();
    const issue: Issue = {
      id: `I_${this.nextIssueId++}`,
      databaseId,
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'OPEN',
      labels: [...labels],
      comments: [],
      authorLogin: VIEWER.login,
      createdAt: now,
      updatedAt: now,
      seq,
      updatedSeq: seq,
    };
    repo.issues.set(number, issue);
    this.nodes.set(issue.id, { kind: 'Issue', owner: repo.ownerLogin, repo: repo.name, number });
    return issue;
  }

  getIssue(repo: Repository, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  requireIssue(repo: Repository, number: number): Issue {
    const issue = repo.issues.get(number);
    if (!issue) throw notFound(`issue #${number}`);
    return issue;
  }

  listIssues(
    repo: Repository,
    options: {
      states?: readonly IssueState[];
      orderBy?: OrderBy;
      first?: number;
      after?: string;
    } = {},
  ): IssueListResult {
    const orderBy = options.orderBy ?? DEFAULT_ORDER;
    const filtered = [...repo.issues.values()]
      .filter((issue) => !options.states || options.states.includes(issue.state))
      .sort((a, b) => compareOrdered(a, b, orderBy));
    const { items, pageInfo } = pageOf(filtered, 'issue', options.first, options.after);
    return { issues: items, pageInfo, totalCount: filtered.length };
  }

  updateIssue(
    repo: Repository,
    number: number,
    input: { title?: string; body?: string; state?: IssueState },
  ): Issue {
    const issue = this.requireIssue(repo, number);
    if (input.title !== undefined) issue.title = input.title;
    if (input.body !== undefined) issue.body = input.body;
    if (input.state !== undefined) issue.state = input.state;
    issue.updatedAt = trialNowIso();
    issue.updatedSeq = this.tick();
    return issue;
  }

  closeIssue(repo: Repository, number: number): Issue {
    return this.updateIssue(repo, number, { state: 'CLOSED' });
  }

  addIssueComment(repo: Repository, number: number, body: string): IssueComment {
    const issue = this.requireIssue(repo, number);
    if (!body) throw validation('comment body is required');
    const now = trialNowIso();
    const comment: IssueComment = {
      id: `C_${this.nextCommentId++}`,
      databaseId: this.nextCommentId - 1,
      body,
      authorLogin: VIEWER.login,
      createdAt: now,
      updatedAt: now,
    };
    issue.comments.push(comment);
    issue.updatedAt = now;
    issue.updatedSeq = this.tick();
    this.nodes.set(comment.id, { kind: 'IssueComment', owner: repo.ownerLogin, repo: repo.name, number });
    return comment;
  }

  listIssueComments(repo: Repository, number: number): IssueComment[] {
    return [...this.requireIssue(repo, number).comments];
  }

  // -- pull requests ------------------------------------------------------------

  createPullRequest(
    repo: Repository,
    input: { title: string; body?: string; headRefName: string; baseRefName: string },
  ): PullRequest {
    if (!input.title) throw validation('pull request title is required');
    if (!input.headRefName || !input.baseRefName) throw validation('head and base branches are required');
    const headRef = `refs/heads/${input.headRefName}`;
    const baseRef = `refs/heads/${input.baseRefName}`;
    if (!repo.refs.has(headRef)) throw validation(`head branch ${input.headRefName} does not exist`);
    if (!repo.refs.has(baseRef)) throw validation(`base branch ${input.baseRefName} does not exist`);
    const number = repo.nextPullRequestNumber++;
    const databaseId = repo.nextPullRequestDatabaseId++;
    const now = trialNowIso();
    const seq = this.tick();
    const pr: PullRequest = {
      id: `P_${this.nextPullRequestId++}`,
      databaseId,
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'OPEN',
      headRefName: input.headRefName,
      baseRefName: input.baseRefName,
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      comments: [],
      authorLogin: VIEWER.login,
      createdAt: now,
      updatedAt: now,
      seq,
      updatedSeq: seq,
    };
    repo.pullRequests.set(number, pr);
    this.nodes.set(pr.id, { kind: 'PullRequest', owner: repo.ownerLogin, repo: repo.name, number });
    return pr;
  }

  getPullRequest(repo: Repository, number: number): PullRequest | undefined {
    return repo.pullRequests.get(number);
  }

  requirePullRequest(repo: Repository, number: number): PullRequest {
    const pr = repo.pullRequests.get(number);
    if (!pr) throw notFound(`pull request #${number}`);
    return pr;
  }

  listPullRequests(
    repo: Repository,
    options: {
      states?: readonly PullRequestState[];
      orderBy?: OrderBy;
      first?: number;
      after?: string;
    } = {},
  ): PullRequestListResult {
    const orderBy = options.orderBy ?? DEFAULT_ORDER;
    const filtered = [...repo.pullRequests.values()]
      .filter((pr) => !options.states || options.states.includes(pr.state))
      .sort((a, b) => compareOrdered(a, b, orderBy));
    const { items, pageInfo } = pageOf(filtered, 'pr', options.first, options.after);
    return { pullRequests: items, pageInfo, totalCount: filtered.length };
  }

  /** The current tip of a pull request's head branch, if the branch exists. */
  getPrHeadSha(repo: Repository, pr: PullRequest): string | undefined {
    return repo.refs.get(`refs/heads/${pr.headRefName}`);
  }

  /** The current tip of a pull request's base branch, if the branch exists. */
  getPrBaseSha(repo: Repository, pr: PullRequest): string | undefined {
    return repo.refs.get(`refs/heads/${pr.baseRefName}`);
  }

  /** True when the pull request merges cleanly right now (no conflicts). */
  isPrMergeable(repo: Repository, pr: PullRequest): boolean {
    if (pr.state !== 'OPEN') return false;
    const headTip = this.getPrHeadSha(repo, pr);
    const baseTip = this.getPrBaseSha(repo, pr);
    if (!headTip || !baseTip) return false;
    if (headTip === baseTip) return false;
    if (gitIsAncestor(headTip, baseTip, this.lookup(repo))) return true;
    const base = gitMergeBase(baseTip, headTip, this.lookup(repo));
    if (base === null) return true; // Unrelated histories merge as a fresh tree.
    return !this.threeWayMerge(repo, base, baseTip, headTip).conflict;
  }

  /**
   * The paths a pull request changes, diffed between the merge-base tree and
   * the head tree (or the empty tree when the histories are unrelated).
   */
  getPrFiles(repo: Repository, number: number): PullRequestFile[] {
    const pr = this.requirePullRequest(repo, number);
    const headTip = this.getPrHeadSha(repo, pr);
    const baseTip = this.getPrBaseSha(repo, pr);
    if (!headTip || !baseTip) return [];
    const base = gitMergeBase(baseTip, headTip, this.lookup(repo));
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
    const before = baseTree === null ? new Map() : this.flattenTree(repo, baseTree);
    const after = this.flattenTree(repo, headTree);
    const files: PullRequestFile[] = [];
    const paths = new Set([...before.keys(), ...after.keys()]);
    for (const path of [...paths].sort()) {
      const oldEntry = before.get(path);
      const newEntry = after.get(path);
      if (oldEntry === undefined && newEntry !== undefined) {
        files.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
      } else if (oldEntry !== undefined && newEntry === undefined) {
        files.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
      } else if (
        oldEntry !== undefined &&
        newEntry !== undefined &&
        (oldEntry.oid !== newEntry.oid || oldEntry.mode !== newEntry.mode)
      ) {
        files.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
      }
    }
    return files;
  }

  addPrComment(repo: Repository, number: number, body: string): IssueComment {
    const pr = this.requirePullRequest(repo, number);
    if (!body) throw validation('comment body is required');
    const now = trialNowIso();
    const comment: IssueComment = {
      id: `C_${this.nextCommentId++}`,
      databaseId: this.nextCommentId - 1,
      body,
      authorLogin: VIEWER.login,
      createdAt: now,
      updatedAt: now,
    };
    pr.comments.push(comment);
    pr.updatedAt = now;
    pr.updatedSeq = this.tick();
    this.nodes.set(comment.id, { kind: 'IssueComment', owner: repo.ownerLogin, repo: repo.name, number });
    return comment;
  }

  /**
   * Merge a pull request into its base ref. `merge` writes a merge commit
   * (two parents); `squash` writes one commit with the merged tree on top of
   * the base. Returns `{merged, sha, message}`; a conflict or an already
   * merged request returns `merged: false` and changes nothing.
   */
  mergePullRequest(
    repo: Repository,
    number: number,
    method: 'merge' | 'squash' = 'merge',
  ): MergeResult {
    if (method !== 'merge' && method !== 'squash') throw validation(`unsupported merge method ${method}`);
    const pr = this.requirePullRequest(repo, number);
    if (pr.state !== 'OPEN') return { merged: false, sha: null, message: 'Pull request is already merged or closed' };
    const headTip = this.getPrHeadSha(repo, pr);
    const baseTip = this.getPrBaseSha(repo, pr);
    if (!headTip || !baseTip) return { merged: false, sha: null, message: 'Head or base branch is missing' };
    if (headTip === baseTip) return { merged: false, sha: null, message: 'Nothing to merge' };
    const lookup = this.lookup(repo);
    if (gitIsAncestor(headTip, baseTip, lookup)) {
      pr.state = 'MERGED';
      pr.merged = true;
      pr.mergeCommitSha = baseTip;
      pr.mergedAt = trialNowIso();
      pr.updatedAt = trialNowIso();
      pr.updatedSeq = this.tick();
      return { merged: true, sha: baseTip, message: 'Pull request already merged' };
    }
    const baseRef = `refs/heads/${pr.baseRefName}`;
    const fastForward = gitIsAncestor(baseTip, headTip, lookup);
    let mergedTree: string;
    let parents: string[];
    let message: string;
    if (fastForward) {
      mergedTree = parseCommit(repo.objects.get(headTip)!.data).tree;
      if (method === 'merge') {
        const moved = this.updateRef(repo, baseRef, headTip, baseTip);
        if (!moved.ok) return { merged: false, sha: null, message: moved.reason ?? 'ref update refused' };
        this.markMerged(repo, pr, headTip);
        return { merged: true, sha: headTip, message: 'Pull request successfully merged' };
      }
      parents = [baseTip];
      message = `${pr.title} (#${pr.number})`;
    } else {
      const base = gitMergeBase(baseTip, headTip, lookup);
      const merged = this.threeWayMerge(repo, base ?? '', baseTip, headTip);
      if (merged.conflict || merged.tree === null) {
        return { merged: false, sha: null, message: 'Merge conflict', conflicts: merged.conflicts };
      }
      mergedTree = merged.tree;
      if (method === 'merge') {
        parents = [baseTip, headTip];
        message = `Merge pull request #${pr.number} from ${repo.ownerLogin}/${pr.headRefName}`;
      } else {
        parents = [baseTip];
        message = `${pr.title} (#${pr.number})`;
      }
    }
    const commitOid = this.createCommit(repo, { tree: mergedTree, parents, message });
    const moved = this.updateRef(repo, baseRef, commitOid, baseTip);
    if (!moved.ok) return { merged: false, sha: null, message: moved.reason ?? 'ref update refused' };
    this.markMerged(repo, pr, commitOid);
    return { merged: true, sha: commitOid, message: 'Pull request successfully merged' };
  }

  private markMerged(repo: Repository, pr: PullRequest, sha: string): void {
    void repo;
    pr.state = 'MERGED';
    pr.merged = true;
    pr.mergeCommitSha = sha;
    pr.mergedAt = trialNowIso();
    pr.updatedAt = trialNowIso();
    pr.updatedSeq = this.tick();
  }

  /** Close a pull request without merging (REST PATCH state=closed). */
  closePullRequest(repo: Repository, number: number): PullRequest {
    const pr = this.requirePullRequest(repo, number);
    if (pr.state === 'OPEN') {
      pr.state = 'CLOSED';
      pr.updatedAt = trialNowIso();
      pr.updatedSeq = this.tick();
    }
    return pr;
  }

  // -- labels -------------------------------------------------------------------

  createLabel(
    repo: Repository,
    input: { name: string; color: string; description?: string },
  ): Label {
    if (!input.name) throw validation('label name is required');
    if (repo.labels.has(input.name)) throw alreadyExists(`label ${input.name}`);
    const label: Label = {
      id: `L_${this.nextLabelId++}`,
      name: input.name,
      color: input.color ?? 'ededed',
      description: input.description ?? '',
    };
    repo.labels.set(input.name, label);
    this.nodes.set(label.id, { kind: 'Label', owner: repo.ownerLogin, repo: repo.name, name: input.name });
    return label;
  }

  getLabel(repo: Repository, name: string): Label | undefined {
    return repo.labels.get(name);
  }

  listLabels(repo: Repository): Label[] {
    return [...repo.labels.values()];
  }
}

/** The one store every surface shares. */
export const store = new ForgeStore();
