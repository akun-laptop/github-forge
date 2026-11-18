// The GraphQL v4 surface: a small parser and executor over the shared store.
//
// No GraphQL library is vendored — the documents the suite sends are the
// shapes gh and github-mcp-server actually send, and this module covers
// exactly that surface: queries and mutations, variables, aliases, named
// and inline fragments, nested selection sets, enum literals and input
// objects as arguments, `__type` introspection, and operation batching
// (the batching itself is app.ts's: one JSON array in, one array out).
//
// A field the schema does not hold is a GraphQL-level error, never an HTTP
// error: the response is still 200 and carries an `errors` entry naming the
// field, the way GitHub answers it. A mutation that cannot run (an unknown
// id, a validation failure) is the same: the field resolves to null and the
// error is recorded. Nothing here reads a clock or the network.

import { store, StoreError, VIEWER } from './store.ts';
import type { Issue, OrderBy, PullRequest, Repository } from './store.ts';

// ---------------------------------------------------------------------------------------------------------
// the lexer
// ---------------------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|']);

class GraphQLSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLSyntaxError';
  }
}

function isNameStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isNameChar(ch: string): boolean {
  return isNameStart(ch) || (ch >= '0' && ch <= '9');
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** Tokenize a document. Commas and comments are insignificant and dropped. */
function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // Block strings (""") are read to their close; plain strings honor the usual escapes.
      if (source[i + 1] === '"' && source[i + 2] === '"') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GraphQLSyntaxError('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let out = '';
      i += 1;
      let closed = false;
      while (i < n) {
        const c = source[i]!;
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (c === '\n' || c === '\r') throw new GraphQLSyntaxError('unterminated string');
        if (c === '\\') {
          const esc = source[i + 1];
          if (esc === undefined) throw new GraphQLSyntaxError('unterminated string');
          switch (esc) {
            case '"': out += '"'; i += 2; break;
            case '\\': out += '\\'; i += 2; break;
            case '/': out += '/'; i += 2; break;
            case 'b': out += '\b'; i += 2; break;
            case 'f': out += '\f'; i += 2; break;
            case 'n': out += '\n'; i += 2; break;
            case 'r': out += '\r'; i += 2; break;
            case 't': out += '\t'; i += 2; break;
            case 'u': {
              const hex = source.slice(i + 2, i + 6);
              if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GraphQLSyntaxError('bad unicode escape');
              out += String.fromCharCode(Number.parseInt(hex, 16));
              i += 6;
              break;
            }
            default: throw new GraphQLSyntaxError(`bad escape \\${esc}`);
          }
          continue;
        }
        out += c;
        i += 1;
      }
      if (!closed) throw new GraphQLSyntaxError('unterminated string');
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (ch === '-' || isDigit(ch)) {
      const start = i;
      if (ch === '-') i += 1;
      while (i < n && isDigit(source[i]!)) i += 1;
      let isFloat = false;
      if (source[i] === '.') {
        isFloat = true;
        i += 1;
        while (i < n && isDigit(source[i]!)) i += 1;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        isFloat = true;
        i += 1;
        if (source[i] === '+' || source[i] === '-') i += 1;
        while (i < n && isDigit(source[i]!)) i += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(start, i) });
      continue;
    }
    if (isNameStart(ch)) {
      const start = i;
      while (i < n && isNameChar(source[i]!)) i += 1;
      tokens.push({ kind: 'name', value: source.slice(start, i) });
      continue;
    }
    throw new GraphQLSyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------------------
// the parser: documents, operations, fragments, values
// ---------------------------------------------------------------------------------------------------------

type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly items: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: readonly { readonly name: string; readonly value: ValueNode }[] };

interface FieldNode {
  readonly kind: 'field';
  readonly name: string;
  readonly alias: string | undefined;
  readonly args: readonly { readonly name: string; readonly value: ValueNode }[];
  readonly selection: readonly Selection[];
}

interface SpreadNode {
  readonly kind: 'spread';
  readonly name: string;
}

interface InlineNode {
  readonly kind: 'inline';
  readonly typeCondition: string | undefined;
  readonly selection: readonly Selection[];
}

type Selection = FieldNode | SpreadNode | InlineNode;

interface VariableDefinition {
  readonly name: string;
  readonly defaultValue: ValueNode | undefined;
}

interface Operation {
  readonly kind: 'query' | 'mutation' | 'subscription';
  readonly name: string | undefined;
  readonly variables: readonly VariableDefinition[];
  readonly selection: readonly Selection[];
}

interface FragmentDefinition {
  readonly name: string;
  readonly typeCondition: string;
  readonly selection: readonly Selection[];
}

interface Document {
  readonly operations: readonly Operation[];
  readonly fragments: ReadonlyMap<string, FragmentDefinition>;
}

class Parser {
  private readonly tokens: readonly Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLSyntaxError(`expected "${value}", got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GraphQLSyntaxError(`expected ${what}, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private atName(value: string): boolean {
    const token = this.peek();
    return token.kind === 'name' && token.value === value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDefinition>();
    while (this.peek().kind !== 'eof') {
      if (this.atName('fragment')) {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' | 'subscription' = 'query';
    if (this.atName('query') || this.atName('mutation') || this.atName('subscription')) {
      kind = this.next().value as 'query' | 'mutation' | 'subscription';
    }
    let name: string | undefined;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables = this.atPunct('(') ? this.parseVariableDefinitions() : [];
    this.skipDirectives();
    const selection = this.parseSelectionSet();
    return { kind, name, variables, selection };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    this.expectPunct('(');
    const definitions: VariableDefinition[] = [];
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName('a variable name');
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.atPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      this.skipDirectives();
      definitions.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return definitions;
  }

  /** A type expression, read and discarded: the executor needs names, not types. */
  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    if (this.atPunct('!')) this.next();
  }

  private parseFragment(): FragmentDefinition {
    this.next(); // 'fragment'
    const name = this.expectName('a fragment name');
    if (!this.atName('on')) throw new GraphQLSyntaxError('expected "on" in a fragment definition');
    this.next();
    const typeCondition = this.expectName('a type condition');
    this.skipDirectives();
    const selection = this.parseSelectionSet();
    return { name, typeCondition, selection };
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new GraphQLSyntaxError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.atPunct('...')) {
      this.next();
      if (this.atName('on')) {
        this.next();
        const typeCondition = this.expectName('a type condition');
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: undefined, selection: this.parseSelectionSet() };
    }
    const first = this.expectName('a field name');
    let alias: string | undefined;
    let name = first;
    if (this.atPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName('a field name');
    }
    const args = this.atPunct('(') ? this.parseArguments() : [];
    this.skipDirectives();
    const selection = this.atPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selection };
  }

  private parseArguments(): { readonly name: string; readonly value: ValueNode }[] {
    this.expectPunct('(');
    const args: { name: string; value: ValueNode }[] = [];
    while (!this.atPunct(')')) {
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct('}')) {
        const name = this.expectName('an object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GraphQLSyntaxError(`unexpected value token ${JSON.stringify(token.value)}`);
  }

  /** Directives are parsed and ignored: the suite's documents do not use them. */
  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName('a directive name');
      if (this.atPunct('(')) this.parseArguments();
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// the schema: the field sets the executor resolves and introspection lists
// ---------------------------------------------------------------------------------------------------------

/** Every field each object type answers. Introspection lists these same sets. */
const FIELD_SETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
  ],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName',
    'mergeable', 'files',
  ],
  PullRequestConnection: ['nodes', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'totalCount'],
  PullRequestChangedFile: ['path'],
  Ref: ['name'],
  IssueComment: ['id', 'body'],
  IssueCommentEdge: ['node'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
});

const FIELD_SET_LOOKUP: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(FIELD_SETS).map(([type, fields]) => [type, new Set(fields)]),
);

/** The enum types introspection can name, and their values. */
const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
});

// ---------------------------------------------------------------------------------------------------------
// the executor
// ---------------------------------------------------------------------------------------------------------

/** A field-level failure: recorded in `errors`, the field resolves to null. */
class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

export interface GraphQLErrorEntry {
  message: string;
  path?: readonly (string | number)[];
}

export interface GraphQLExecution {
  data: Record<string, unknown> | null;
  errors?: GraphQLErrorEntry[];
}

/** A resolved object value: its GraphQL type plus the store record behind it. */
interface TypedObject {
  readonly __typename: string;
  readonly data: unknown;
}

type Resolved = null | string | number | boolean | TypedObject | Resolved[];

function typed(typename: string, data: unknown): TypedObject {
  return { __typename: typename, data };
}

function isTyped(value: unknown): value is TypedObject {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as TypedObject).__typename === 'string'
  );
}

interface ExecutorContext {
  readonly variables: Readonly<Record<string, unknown>>;
  readonly fragments: ReadonlyMap<string, FragmentDefinition>;
  readonly errors: GraphQLErrorEntry[];
}

/** A literal value node, with variables resolved. Missing variables read undefined. */
function valueOf(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? undefined : value;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(
  field: FieldNode,
  variables: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = valueOf(arg.value, variables);
  return args;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Resolve one field of one typed object. Unknown fields throw GraphQLError. */
function resolveField(
  parent: TypedObject,
  field: FieldNode,
  ctx: ExecutorContext,
): Resolved {
  if (field.name === '__typename') return parent.__typename;
  const known = FIELD_SET_LOOKUP.get(parent.__typename);
  if (known === undefined || !known.has(field.name)) {
    throw new GraphQLError(`Cannot query field "${field.name}" on type "${parent.__typename}".`);
  }
  const args = argsOf(field, ctx.variables);
  const data = parent.data;
  switch (parent.__typename) {
    case 'Query':
      return resolveQueryField(field.name, args);
    case 'Mutation':
      return resolveMutationField(field.name, args);
    case 'User': {
      const user = data as { login: string; id?: number; databaseId?: number; name?: string };
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return user.databaseId ?? user.id ?? null;
      return user.name ?? null;
    }
    case 'Repository':
      return resolveRepositoryField(data as Repository, field.name, args);
    case 'Issue': {
      const issue = data as Issue;
      if (field.name === 'id') return issue.id;
      if (field.name === 'databaseId') return issue.databaseId;
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state;
      return issue.body;
    }
    case 'IssueConnection': {
      const connection = data as {
        issues: Issue[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        totalCount: number;
      };
      if (field.name === 'nodes') return connection.issues.map((issue) => typed('Issue', issue));
      if (field.name === 'pageInfo') return typed('PageInfo', connection.pageInfo);
      return connection.totalCount;
    }
    case 'PageInfo': {
      const pageInfo = data as { hasNextPage: boolean; endCursor: string | null };
      return field.name === 'hasNextPage' ? pageInfo.hasNextPage : pageInfo.endCursor;
    }
    case 'PullRequest':
      return resolvePullRequestField(data as { repo: Repository; pr: PullRequest }, field.name, args);
    case 'PullRequestConnection': {
      const connection = data as { repo: Repository; pullRequests: PullRequest[]; totalCount: number };
      if (field.name === 'nodes') {
        return connection.pullRequests.map((pr) => typed('PullRequest', { repo: connection.repo, pr }));
      }
      return connection.totalCount;
    }
    case 'PullRequestFileConnection': {
      const connection = data as { files: { path: string }[] };
      if (field.name === 'nodes') {
        return connection.files.map((file) => typed('PullRequestChangedFile', file));
      }
      return connection.files.length;
    }
    case 'PullRequestChangedFile':
      return (data as { path: string }).path;
    case 'Ref':
      return (data as { name: string }).name;
    case 'IssueComment': {
      const comment = data as { id: string; body: string };
      return field.name === 'id' ? comment.id : comment.body;
    }
    case 'IssueCommentEdge': {
      const edge = data as { node: { id: string; body: string } };
      return typed('IssueComment', edge.node);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = data as { issue: Issue };
      return typed('Issue', payload.issue);
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = data as { repo: Repository; pr: PullRequest };
      return typed('PullRequest', payload);
    }
    case 'AddCommentPayload': {
      const payload = data as { comment: { id: string; body: string } };
      return typed('IssueCommentEdge', { node: payload.comment });
    }
    case '__Type': {
      const type = data as { name: string; kind: 'OBJECT' | 'ENUM'; fields: string[]; enumValues: string[] };
      if (field.name === 'name') return type.name;
      if (field.name === 'fields') {
        return type.fields.map((name) => typed('__Field', { name }));
      }
      return type.enumValues.map((name) => typed('__EnumValue', { name }));
    }
    case '__Field':
    case '__EnumValue':
      return (data as { name: string }).name;
    default:
      throw new GraphQLError(`Cannot query field "${field.name}" on type "${parent.__typename}".`);
  }
}

function resolveQueryField(name: string, args: Record<string, unknown>): Resolved {
  if (name === 'viewer') return typed('User', VIEWER);
  if (name === '__type') {
    const typeName = asString(args.name);
    if (typeName === undefined) return null;
    const fields = FIELD_SETS[typeName];
    const enumValues = ENUM_VALUES[typeName];
    if (fields === undefined && enumValues === undefined) return null;
    return typed('__Type', {
      name: typeName,
      kind: enumValues !== undefined ? 'ENUM' : 'OBJECT',
      fields: fields ?? [],
      enumValues: enumValues ?? [],
    });
  }
  if (name === 'repository') {
    const owner = asString(args.owner);
    const repoName = asString(args.name);
    if (owner === undefined || repoName === undefined) return null;
    const repo = store.getRepo(owner, repoName);
    return repo === undefined ? null : typed('Repository', repo);
  }
  // node(id:)
  const id = asString(args.id);
  if (id === undefined) return null;
  const node = store.getNode(id);
  if (node === undefined) return null;
  const repo = store.getRepo(node.owner, node.repo);
  if (repo === undefined) return null;
  if (node.kind === 'Repository') return typed('Repository', repo);
  if (node.kind === 'Issue' && node.number !== undefined) {
    const issue = store.getIssue(repo, node.number);
    return issue === undefined ? null : typed('Issue', issue);
  }
  if (node.kind === 'PullRequest' && node.number !== undefined) {
    const pr = store.getPullRequest(repo, node.number);
    return pr === undefined ? null : typed('PullRequest', { repo, pr });
  }
  return null;
}

function resolveRepositoryField(
  repo: Repository,
  name: string,
  args: Record<string, unknown>,
): Resolved {
  switch (name) {
    case 'id':
      return repo.id;
    case 'databaseId':
      return repo.databaseId;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.ownerLogin}/${repo.name}`;
    case 'owner':
      return typed('User', { login: repo.ownerLogin });
    case 'defaultBranchRef': {
      const tip = store.getRef(repo, store.defaultBranchRefName(repo));
      return tip === undefined ? null : typed('Ref', { name: repo.defaultBranch });
    }
    case 'viewerPermission':
      return repo.viewerPermission;
    case 'hasIssuesEnabled':
      return repo.hasIssuesEnabled;
    case 'description':
      return repo.description;
    case 'private':
      return repo.private;
    case 'issue': {
      const number = asNumber(args.number);
      if (number === undefined) return null;
      const issue = store.getIssue(repo, number);
      return issue === undefined ? null : typed('Issue', issue);
    }
    case 'issues': {
      const first = asNumber(args.first);
      const after = asString(args.after);
      const statesRaw = args.states;
      const states = Array.isArray(statesRaw)
        ? (statesRaw.filter((state): state is 'OPEN' | 'CLOSED' => state === 'OPEN' || state === 'CLOSED'))
        : undefined;
      const orderBy = parseOrderBy(args.orderBy);
      const result = store.listIssues(repo, {
        states,
        orderBy,
        first: first === undefined ? undefined : first,
        after: after === undefined ? undefined : after,
      });
      return typed('IssueConnection', result);
    }
    case 'pullRequests': {
      const first = asNumber(args.first);
      const result = store.listPullRequests(repo, { first: first === undefined ? undefined : first });
      return typed('PullRequestConnection', { repo, pullRequests: result.pullRequests, totalCount: result.totalCount });
    }
    case 'pullRequest': {
      const number = asNumber(args.number);
      if (number === undefined) return null;
      const pr = store.getPullRequest(repo, number);
      return pr === undefined ? null : typed('PullRequest', { repo, pr });
    }
    default:
      throw new GraphQLError(`Cannot query field "${name}" on type "Repository".`);
  }
}

/** `orderBy: {field: CREATED_AT, direction: DESC}` — or undefined for the store's default. */
function parseOrderBy(value: unknown): OrderBy | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const field = record.field === 'UPDATED_AT' ? 'UPDATED_AT' : 'CREATED_AT';
  const direction = record.direction === 'ASC' ? 'ASC' : 'DESC';
  return { field, direction };
}

function resolvePullRequestField(
  pair: { repo: Repository; pr: PullRequest },
  name: string,
  args: Record<string, unknown>,
): Resolved {
  const { repo, pr } = pair;
  switch (name) {
    case 'id':
      return pr.id;
    case 'databaseId':
      return pr.databaseId;
    case 'number':
      return pr.number;
    case 'title':
      return pr.title;
    case 'body':
      return pr.body;
    case 'state':
      return pr.state;
    case 'merged':
      return pr.merged;
    case 'headRefName':
      return pr.headRefName;
    case 'baseRefName':
      return pr.baseRefName;
    case 'mergeable':
      return store.isPrMergeable(repo, pr) ? 'MERGEABLE' : 'CONFLICTING';
    case 'files': {
      const first = asNumber(args.first);
      const files = store.getPrFiles(repo, pr.number);
      const sliced = first === undefined ? files : files.slice(0, Math.max(0, first));
      return typed('PullRequestFileConnection', { files: sliced });
    }
    default:
      throw new GraphQLError(`Cannot query field "${name}" on type "PullRequest".`);
  }
}

/** The repository a mutation input names, by its global id. */
function repoOfInput(input: Record<string, unknown>, key: string): Repository {
  const id = asString(input[key]);
  if (id === undefined) throw new GraphQLError(`input.${key} is required`);
  const node = store.getNode(id);
  if (node === undefined || node.kind !== 'Repository') throw new GraphQLError(`no repository with id ${JSON.stringify(id)}`);
  const repo = store.getRepo(node.owner, node.repo);
  if (repo === undefined) throw new GraphQLError(`no repository with id ${JSON.stringify(id)}`);
  return repo;
}

/** The issue or pull request a mutation input names, by its global id. */
function subjectOfInput(input: Record<string, unknown>, key: string): { repo: Repository; kind: 'Issue' | 'PullRequest'; number: number } {
  const id = asString(input[key]);
  if (id === undefined) throw new GraphQLError(`input.${key} is required`);
  const node = store.getNode(id);
  if (node === undefined || (node.kind !== 'Issue' && node.kind !== 'PullRequest') || node.number === undefined) {
    throw new GraphQLError(`no issue or pull request with id ${JSON.stringify(id)}`);
  }
  const repo = store.getRepo(node.owner, node.repo);
  if (repo === undefined) throw new GraphQLError(`no issue or pull request with id ${JSON.stringify(id)}`);
  return { repo, kind: node.kind, number: node.number };
}

function resolveMutationField(name: string, args: Record<string, unknown>): Resolved {
  const input = asRecord(args.input);
  if (input === undefined) throw new GraphQLError('input is required');
  try {
    switch (name) {
      case 'createIssue': {
        const repo = repoOfInput(input, 'repositoryId');
        const title = asString(input.title);
        if (title === undefined) throw new GraphQLError('input.title is required');
        const issue = store.createIssue(repo, { title, body: asString(input.body) });
        return typed('CreateIssuePayload', { issue });
      }
      case 'closeIssue': {
        const subject = subjectOfInput(input, 'issueId');
        if (subject.kind !== 'Issue') throw new GraphQLError('closeIssue needs an issue id');
        const issue = store.closeIssue(subject.repo, subject.number);
        return typed('CloseIssuePayload', { issue });
      }
      case 'createPullRequest': {
        const repo = repoOfInput(input, 'repositoryId');
        const title = asString(input.title);
        const headRefName = asString(input.headRefName);
        const baseRefName = asString(input.baseRefName);
        if (title === undefined) throw new GraphQLError('input.title is required');
        if (headRefName === undefined || baseRefName === undefined) {
          throw new GraphQLError('input.headRefName and input.baseRefName are required');
        }
        const pr = store.createPullRequest(repo, {
          title,
          body: asString(input.body),
          headRefName,
          baseRefName,
        });
        return typed('CreatePullRequestPayload', { repo, pr });
      }
      case 'mergePullRequest': {
        const subject = subjectOfInput(input, 'pullRequestId');
        if (subject.kind !== 'PullRequest') throw new GraphQLError('mergePullRequest needs a pull request id');
        const method = input.mergeMethod === 'SQUASH' ? 'squash' : 'merge';
        store.mergePullRequest(subject.repo, subject.number, method);
        const pr = store.requirePullRequest(subject.repo, subject.number);
        return typed('MergePullRequestPayload', { repo: subject.repo, pr });
      }
      case 'addComment': {
        const subject = subjectOfInput(input, 'subjectId');
        const body = asString(input.body);
        if (body === undefined) throw new GraphQLError('input.body is required');
        const comment =
          subject.kind === 'Issue'
            ? store.addIssueComment(subject.repo, subject.number, body)
            : store.addPrComment(subject.repo, subject.number, body);
        return typed('AddCommentPayload', { comment });
      }
      default:
        throw new GraphQLError(`Cannot query field "${name}" on type "Mutation".`);
    }
  } catch (err) {
    if (err instanceof GraphQLError) throw err;
    if (err instanceof StoreError) throw new GraphQLError(err.message);
    throw err;
  }
}

/** Complete a resolved value against its sub-selection (objects recurse, lists map, scalars pass through). */
function complete(
  value: Resolved,
  selection: readonly Selection[],
  ctx: ExecutorContext,
  path: readonly (string | number)[],
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => complete(item, selection, ctx, [...path, index]));
  }
  if (selection.length === 0) return null;
  return executeSelection(value, selection, ctx, path);
}

/** Execute one selection set against one typed object, merging fragments and aliases. */
function executeSelection(
  parent: TypedObject,
  selection: readonly Selection[],
  ctx: ExecutorContext,
  path: readonly (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'spread') {
      const fragment = ctx.fragments.get(node.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${node.name}".`, path });
        continue;
      }
      if (fragment.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelection(parent, fragment.selection, ctx, path));
      continue;
    }
    if (node.kind === 'inline') {
      if (node.typeCondition !== undefined && node.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelection(parent, node.selection, ctx, path));
      continue;
    }
    const key = node.alias ?? node.name;
    const fieldPath = [...path, key];
    let resolved: Resolved;
    try {
      resolved = resolveField(parent, node, ctx);
    } catch (err) {
      if (err instanceof GraphQLError || err instanceof StoreError) {
        ctx.errors.push({ message: err.message, path: fieldPath });
        continue;
      }
      throw err;
    }
    out[key] = complete(resolved, node.selection, ctx, fieldPath);
  }
  return out;
}

/**
 * Run one GraphQL operation. `variables` may be null (treated as {}); a
 * variable whose value is null reads as absent, the way gh sends `after: null`.
 */
export function executeGraphQL(
  query: string,
  variables: Record<string, unknown> | null | undefined,
  operationName?: string | null,
): GraphQLExecution {
  let document: Document;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return {
      data: null,
      errors: [{ message: err instanceof Error ? err.message : 'syntax error' }],
    };
  }
  if (document.operations.length === 0) {
    return { data: null, errors: [{ message: 'the document holds no operation' }] };
  }
  let operation: Operation | undefined;
  if (operationName !== undefined && operationName !== null && operationName !== '') {
    operation = document.operations.find((entry) => entry.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `unknown operation named ${JSON.stringify(operationName)}` }] };
    }
  } else if (document.operations.length === 1) {
    operation = document.operations[0];
  } else {
    return { data: null, errors: [{ message: 'the document holds several operations and no operationName was given' }] };
  }
  const supplied = variables ?? {};
  const merged: Record<string, unknown> = { ...supplied };
  for (const definition of operation.variables) {
    if (merged[definition.name] === undefined && definition.defaultValue !== undefined) {
      merged[definition.name] = valueOf(definition.defaultValue, supplied);
    }
  }
  const ctx: ExecutorContext = { variables: merged, fragments: document.fragments, errors: [] };
  const root = typed(operation.kind === 'mutation' ? 'Mutation' : 'Query', null);
  let data: Record<string, unknown>;
  try {
    data = executeSelection(root, operation.selection, ctx, []);
  } catch (err) {
    return {
      data: null,
      errors: [{ message: err instanceof Error ? err.message : 'internal error' }],
    };
  }
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}
