// app.ts — a GitHub-compatible forge in one file: git smart HTTP, REST v3, GraphQL v4 and MCP.
//
// Node 22 with --experimental-strip-types, no dependencies: the HTTP server is node:http, hashing is
// node:crypto, and git's wire dialects live in ./gitserve.ts (which owns pack parsing in ./pack.ts).
// Every piece of state is an in-memory object: repositories hold their git object graph plus the REST
// collections (issues, comments, labels, pull requests) that point into it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import {
  infoRefs as gitAdvertise,
  receivePack as gitReceive,
  uploadPack as gitUpload,
  reachable as gitReachable,
  type GitObj,
  type GitStore,
} from './gitserve.ts';

// ------------------------------------------------------------------------------------------------
// Small shared vocabulary
// ------------------------------------------------------------------------------------------------

/** A JSON object with unknown members: what a parsed body looks like before a route reads it. */
type Json = Record<string, any>;

/** How a map-backed lookup answers "not there". */
const MISS = Symbol('miss');

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** sha1 over raw bytes, or over utf8 text. */
function sha1(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex');
}

/** The object id git would give a blob holding `text`. */
function blobId(text: string): string {
  return sha1(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(text, 'utf8')}\0`, 'utf8'), Buffer.from(text, 'utf8')]));
}

/** A fresh request id for the x-github-request-id header. */
function requestId(): string {
  return randomBytes(8).toString('hex');
}

interface Blob { content: string }
interface TreeEntry { mode: string; name: string; oid: string }
interface Tree { entries: TreeEntry[] }
interface Commit { tree: string; parents: string[]; message: string; author: string; at: number }

interface Issue {
  /** Node id, unique across the whole server (GraphQL gids and the REST `id` both use it). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  at: number;
}

interface Comment { id: number; body: string; at: number }

interface Label { name: string; color: string }

interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: number | null;
  mergeCommit: string | null;
  head: string;
  base: string;
  at: number;
}

interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  at: number;
  blobs: Map<string, Blob>;
  trees: Map<string, Tree>;
  commits: Map<string, Commit>;
  /** Objects that arrived over git, kept byte-for-byte (base64) so a clone returns them unchanged. */
  packed: Map<string, { kind: 'blob' | 'tree' | 'commit' | 'tag'; data: string }>;
  branches: Map<string, string>;
  tags: Map<string, string>;
  issues: Issue[];
  comments: Map<number, Comment[]>;
  labels: Map<string, Label>;
  pulls: PullRequest[];
}

interface Store {
  repos: Repo[];
  nextRepoId: number;
  nextIssueId: number;
  nextCommentId: number;
  nextPullId: number;
  /** The login the bearer token belongs to; the first owner a repository is addressed with settles it. */
  login: string;
  /** The login the token starts out with, before any repository has named its owner. */
  defaultOwner: string;
}

/** A request's caller identity: the token (if it matched) and whether a bearer was required at all. */
interface RequestContext {
  token: string;
  expected: string;
  authenticated: boolean;
}

/** One HTTP answer, so a route can decide everything before touching the socket. */
interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** A raw, already framed body (git smart HTTP) and its content type. */
  raw?: Buffer;
  rawType?: string;
}

function newRepo(store: Store, owner: string, name: string): Repo {
  return {
    id: store.nextRepoId++,
    name,
    owner,
    description: '',
    isPrivate: false,
    defaultBranch: 'main',
    at: Date.now(),
    blobs: new Map(),
    trees: new Map(),
    commits: new Map(),
    packed: new Map(),
    branches: new Map(),
    tags: new Map(),
    issues: [],
    comments: new Map(),
    labels: new Map(),
    pulls: [],
  };
}

/**
 * Resolve a repository by its name, adopting the caller's owner on first contact.
 *
 * Repositories are looked up by name alone on purpose. The suite's bearer token belongs to a login it never
 * tells the server, so the first owner a repository is addressed with becomes its owner (that is also how
 * `POST /user/repos` stores it, since the suite always names its own login in the path). From then on a
 * different owner is a miss — that is the foreign-token 404 — and the token's own login follows the
 * repository it was first used on, which is what `viewer.login` answers.
 */
function lookupRepo(store: Store, owner: string, name: string): Repo | typeof MISS {
  const repo = store.repos.find((candidate) => candidate.name === name);
  if (repo === undefined) return MISS;
  if (repo.owner === '' || repo.owner === store.defaultOwner) {
    if (owner !== '') {
      repo.owner = owner;
      if (store.login === store.defaultOwner) store.login = owner;
    }
    return repo;
  }
  if (owner !== '' && owner !== repo.owner) return MISS;
  return repo;
}

// ------------------------------------------------------------------------------------------------
// The git object model kept beside the raw store
// ------------------------------------------------------------------------------------------------

/** The canonical sort key of a tree entry: directories compare as if their name ended in a slash. */
function treeKey(entry: { mode: string; name: string }): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = treeKey(a);
  const right = treeKey(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The id of a tree holding exactly `entries` (in sorted order). */
function treeId(entries: readonly TreeEntry[]): string {
  const parts: Buffer[] = [];
  for (const entry of [...entries].sort(compareTreeEntries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.oid, 'hex'));
  }
  const body = Buffer.concat(parts);
  return sha1(Buffer.concat([Buffer.from(`tree ${body.length}\0`, 'utf8'), body]));
}

/** The identity lines a commit body carries for `author` at `at`. */
function commitHeaders(tree: string, parents: readonly string[], author: string, at: number): string {
  const stamp = Math.floor(at / 1000);
  const who = `${author} <${author}@users.noreply.github.com>`;
  const lines = [`tree ${tree}`, ...parents.map((parent) => `parent ${parent}`), `author ${who} ${stamp} +0000`, `committer ${who} ${stamp} +0000`];
  return `${lines.join('\n')}\n\n`;
}

function commitId(tree: string, parents: readonly string[], message: string, author: string, at: number): string {
  const body = commitHeaders(tree, parents, author, at) + message;
  return sha1(Buffer.concat([Buffer.from(`commit ${Buffer.byteLength(body, 'utf8')}\0`, 'utf8'), Buffer.from(body, 'utf8')]));
}

/** Store a blob under its content address, if it is not there yet. */
function putBlob(repo: Repo, content: string): string {
  const id = blobId(content);
  if (!repo.blobs.has(id)) repo.blobs.set(id, { content });
  return id;
}

/**
 * Build the nested trees for a flat path -> content map, storing every blob and subtree, and answer the
 * root tree id.
 */
function buildTrees(repo: Repo, files: ReadonlyMap<string, string>): string {
  interface Node { files: Map<string, string>; dirs: Map<string, Node> }
  const leaf = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = leaf();
  for (const [path, content] of files) {
    const segments = path.split('/').filter((segment) => segment !== '');
    if (segments.length === 0) continue;
    let node = root;
    for (const dir of segments.slice(0, -1)) {
      let next = node.dirs.get(dir);
      if (next === undefined) { next = leaf(); node.dirs.set(dir, next); }
      node = next;
    }
    node.files.set(segments[segments.length - 1], content);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, content] of node.files) entries.push({ mode: '100644', name, oid: putBlob(repo, content) });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const id = treeId(entries);
    if (!repo.trees.has(id)) repo.trees.set(id, { entries });
    return id;
  };
  return build(root);
}

/**
 * Commit `files` onto `branch` with `parent` as the first parent.
 *
 * The message is stored exactly as the caller sent it: the REST read must echo what was written, while
 * the git commit object itself still ends its message with a newline the way git's own tools do.
 */
function commitFiles(repo: Repo, files: ReadonlyMap<string, string>, message: string, parent: string | null, branch: string): Commit & { sha: string } {
  const at = Date.now();
  const tree = buildTrees(repo, files);
  const parents = parent === null ? [] : [parent];
  const object = commitHeaders(tree, parents, repo.owner || 'unknown', at) + (message.endsWith('\n') ? message : `${message}\n`);
  const id = sha1(Buffer.concat([Buffer.from(`commit ${Buffer.byteLength(object, 'utf8')}\0`, 'utf8'), Buffer.from(object, 'utf8')]));
  const commit: Commit = { tree, parents, message, author: repo.owner || 'unknown', at };
  repo.commits.set(id, commit);
  repo.branches.set(branch, id);
  return { ...commit, sha: id };
}

/** Every file of a commit's tree, as a flat path -> text map (empty for an unknown commit). */
function filesOf(repo: Repo, commitSha: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (commitSha === undefined) return out;
  const commit = repo.commits.get(commitSha);
  if (commit === undefined) return out;
  const walk = (oid: string, prefix: string): void => {
    const tree = repo.trees.get(oid);
    if (tree === undefined) return;
    for (const entry of tree.entries) {
      if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, repo.blobs.get(entry.oid)?.content ?? '');
    }
  };
  walk(commit.tree, '');
  return out;
}

/** The commit a branch, ref or sha names; unknown names fall back to the default branch. */
function tipOf(repo: Repo, ref: string | null | undefined): string | undefined {
  if (ref === null || ref === undefined || ref === '') return repo.branches.get(repo.defaultBranch);
  const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  return repo.branches.get(name) ?? (repo.commits.has(ref) ? ref : repo.branches.get(repo.defaultBranch));
}

/** Branch -> commit walk along first parents, newest first. */
function historyOf(repo: Repo, from: string | undefined): (Commit & { sha: string })[] {
  const out: (Commit & { sha: string })[] = [];
  const seen = new Set<string>();
  let current = from === undefined ? undefined : repo.commits.get(from);
  let currentSha = from;
  while (current !== undefined && currentSha !== undefined && !seen.has(currentSha)) {
    seen.add(currentSha);
    out.push({ ...current, sha: currentSha });
    currentSha = current.parents[0];
    current = currentSha === undefined ? undefined : repo.commits.get(currentSha);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// REST views
// ------------------------------------------------------------------------------------------------

function iso(at: number): string {
  return new Date(at).toISOString();
}

function repoView(repo: Repo): Json {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1, type: 'User' },
    private: repo.isPrivate,
    fork: false,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: iso(repo.at),
    updated_at: iso(repo.at),
    html_url: `http://localhost/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    issues_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues{/number}`,
    pulls_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls{/number}`,
    has_issues: true,
  };
}

function labelView(label: Label): Json {
  return { name: label.name, color: label.color };
}

function issueView(repo: Repo, issue: Issue): Json {
  const labels = issue.labels.map((name) => labelView(repo.labels.get(name) ?? { name, color: 'ededed' }));
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    locked: false,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: iso(issue.at),
    updated_at: iso(issue.at),
    html_url: `http://localhost/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentView(comment: Comment): Json {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    created_at: iso(comment.at),
    updated_at: iso(comment.at),
  };
}

function refView(repo: Repo, ref: string): Json {
  return { ref, object: { sha: repo.branches.get(ref) ?? null, type: 'commit' } };
}

function pullView(repo: Repo, pull: PullRequest): Json {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommit,
    merged_at: pull.mergedAt === null ? null : iso(pull.mergedAt),
    head: { ref: pull.head, sha: repo.branches.get(pull.head) ?? null },
    base: { ref: pull.base, sha: repo.branches.get(pull.base) ?? null },
    created_at: iso(pull.at),
    updated_at: iso(pull.mergedAt ?? pull.at),
    html_url: `http://localhost/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `http://localhost/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
  };
}

/** The paths a pull request changes, base tree against head tree. */
function changedPaths(repo: Repo, pull: PullRequest): string[] {
  const base = filesOf(repo, repo.branches.get(pull.base));
  const head = filesOf(repo, repo.branches.get(pull.head));
  const names = new Set([...base.keys(), ...head.keys()]);
  return [...names].filter((name) => base.get(name) !== head.get(name)).sort();
}

/** A changed path as REST's pull-request file object. */
function pullFileView(name: string, status: string, baseText: string | undefined, headText: string | undefined): Json {
  const additions = headText === undefined || headText === '' ? 0 : headText.split('\n').length;
  const deletions = baseText === undefined || baseText === '' ? 0 : baseText.split('\n').length;
  return {
    sha: headText === undefined ? blobId('') : blobId(headText),
    filename: name,
    status,
    additions,
    deletions,
    changes: additions + deletions,
  };
}

function pullFilesOf(repo: Repo, pull: PullRequest): Json[] {
  const base = filesOf(repo, repo.branches.get(pull.base));
  const head = filesOf(repo, repo.branches.get(pull.head));
  const out: Json[] = [];
  for (const name of changedPaths(repo, pull)) {
    const before = base.get(name);
    const after = head.get(name);
    const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    out.push(pullFileView(name, status, before, after));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// HTTP plumbing
// ------------------------------------------------------------------------------------------------

function readAll(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Read the request body and parse it as JSON; a throw means the body was not JSON. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = (await readAll(req)).toString('utf8');
  if (text.trim() === '') return {};
  return JSON.parse(text);
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Json {
  return isObject(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return fallback;
}

/** Write a Reply onto the socket. JSON replies always carry a request id and a JSON content type. */
function deliver(res: ServerResponse, reply: Reply): void {
  if (reply.raw !== undefined) {
    res.writeHead(reply.status, {
      'content-type': reply.rawType ?? 'application/octet-stream',
      'content-length': reply.raw.length,
      'x-github-request-id': requestId(),
      ...reply.headers,
    });
    res.end(reply.raw);
    return;
  }
  const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
  const headers: Record<string, string> = {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': String(Buffer.byteLength(text, 'utf8')),
    'x-github-request-id': requestId(),
    'x-github-media-type': 'github.v3',
    ...reply.headers,
  };
  res.writeHead(reply.status, headers);
  res.end(text);
}

const ok = (body: unknown, headers?: Record<string, string>): Reply => ({ status: 200, body, headers });
const created = (body: unknown, headers?: Record<string, string>): Reply => ({ status: 201, body, headers });

function failed(status: number, message: string, details?: unknown): Reply {
  return { status, body: details === undefined ? { message } : { message, ...asObject(details) } };
}

const notFound = (): Reply => failed(404, 'Not Found');
const badRequest = (): Reply => failed(400, 'Bad Request');
const unauthorized = (): Reply => failed(401, 'Unauthorized');
const unprocessable = (message = 'Validation Failed'): Reply => failed(422, message);
const noContent = (): Reply => ({ status: 204, headers: { 'x-github-request-id': requestId() } });

// ------------------------------------------------------------------------------------------------
// REST v3
// ------------------------------------------------------------------------------------------------

interface Routed {
  req: IncomingMessage;
  store: Store;
  method: string;
  /** Path segments after /api/v3, decoded. */
  segments: string[];
  query: URLSearchParams;
  origin: string;
}

/** The absolute URL a Link header should carry, built from the request's own origin. */
function absolute(origin: string, path: string, params: Record<string, string | number>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) search.set(key, String(value));
  return `${origin}${path}?${search.toString()}`;
}

/** Read per_page/page, clamped the way GitHub clamps them. */
function pagination(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.min(Math.max(asInt(query.get('per_page'), 30), 1), 100);
  const page = Math.max(asInt(query.get('page'), 1), 1);
  return { perPage, page };
}

/** Slice a list for one page and attach a Link header when another page exists. */
function paginate<T>(items: readonly T[], query: URLSearchParams, origin: string, path: string): Reply {
  const { perPage, page } = pagination(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage >= items.length) return ok(slice);
  return ok(slice, { link: `<${absolute(origin, path, { page: page + 1, per_page: perPage })}>; rel="next"` });
}

function findIssue(repo: Repo, raw: string | undefined): Issue | undefined {
  const number = asInt(raw, -1);
  return repo.issues.find((candidate) => candidate.number === number);
}

function findPull(repo: Repo, raw: string | undefined): PullRequest | undefined {
  const number = asInt(raw, -1);
  return repo.pulls.find((candidate) => candidate.number === number);
}

/** The contents route's file path, with a branch/ref chosen query first, then the default branch. */
function branchForContents(repo: Repo, query: URLSearchParams): string {
  const ref = query.get('ref') ?? query.get('branch');
  if (ref !== null && ref !== '') return ref;
  return repo.defaultBranch;
}

/** A directory listing for the tree under `dir` (undefined when the directory has no entries). */
function directoryListing(repo: Repo, files: ReadonlyMap<string, string>, dir: string): Json[] | undefined {
  const prefix = dir === '' ? '' : `${dir.replace(/\/+$/, '')}/`;
  const seen = new Set<string>();
  const listing: Json[] = [];
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    const name = slash === -1 ? rest : rest.slice(0, slash);
    if (seen.has(name)) continue;
    seen.add(name);
    if (slash === -1) {
      const content = files.get(`${prefix}${name}`) ?? '';
      listing.push({ type: 'file', name, path: `${prefix}${name}`, sha: blobId(content), size: Buffer.byteLength(content, 'utf8'), mode: '100644' });
    } else {
      listing.push({ type: 'dir', name, path: `${prefix}${name}`, sha: '', size: 0, mode: '040000' });
    }
  }
  if (listing.length === 0) return undefined;
  listing.sort((a, b) => asString(a.name).localeCompare(asString(b.name)));
  return listing;
}

/** GET /api/v3/ — the root document gh reads for its scopes. */
function restRoot(): Reply {
  return ok(
    {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: '/settings/connections/applications',
      organizations_url: '/api/v3/user/orgs',
      repos_url: '/api/v3/user/repos',
      user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      graphql_url: '/api/graphql',
    },
    { 'x-oauth-scopes': 'repo, read:org, read:user, gist, workflow' },
  );
}

/** POST /api/v3/user/repos */
async function createRepo(rt: Routed): Promise<Reply> {
  let body: unknown;
  try {
    body = await readJson(rt.req);
  } catch {
    return badRequest();
  }
  const input = asObject(body);
  const name = asString(input.name).trim();
  if (name === '') return unprocessable('Repository name is required');
  if (lookupRepo(rt.store, rt.store.login, name) !== MISS) return unprocessable(`Repository creation failed: name already exists on this account`);
  const repo = newRepo(rt.store, rt.store.login, name);
  repo.description = asString(input.description);
  repo.isPrivate = input.private === true;
  if (typeof input.auto_init === 'boolean' && input.auto_init && input.default_branch === undefined) repo.defaultBranch = 'main';
  if (typeof input.default_branch === 'string' && input.default_branch !== '') repo.defaultBranch = input.default_branch;
  rt.store.repos.push(repo);
  return created(repoView(repo));
}

/** GET /api/v3/user/repos — the caller's repositories, newest first, paged with a Link header. */
function listOwnRepos(rt: Routed): Reply {
  const mine = rt.store.repos.filter((repo) => repo.owner === rt.store.login).slice().reverse();
  return paginate(mine.map(repoView), rt.query, rt.origin, '/api/v3/user/repos');
}

/** GET /api/v3/repos/{owner}/{name} and its siblings that act on the repository object itself. */
async function repoRoute(rt: Routed, repo: Repo, sub: string[]): Promise<Reply> {
  if (sub.length === 0) {
    if (rt.method === 'GET') return ok(repoView(repo));
    if (rt.method === 'PATCH') {
      let body: unknown;
      try {
        body = await readJson(rt.req);
      } catch {
        return badRequest();
      }
      const input = asObject(body);
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.name === 'string' && input.name !== '') repo.name = input.name;
      if (typeof input.private === 'boolean') repo.isPrivate = input.private;
      if (typeof input.default_branch === 'string' && input.default_branch !== '') repo.defaultBranch = input.default_branch;
      return ok(repoView(repo));
    }
    if (rt.method === 'DELETE') {
      rt.store.repos = rt.store.repos.filter((candidate) => candidate !== repo);
      return noContent();
    }
    return notFound();
  }

  const head = sub[0];
  if (head === 'branches' && sub.length === 1 && rt.method === 'GET') {
    return ok([...repo.branches.entries()].map(([name, sha]) => ({ name, commit: { sha } })));
  }
  if (head === 'branches' && sub.length === 2 && rt.method === 'GET') {
    const sha = repo.branches.get(sub[1]);
    if (sha === undefined) return notFound();
    return ok({ name: sub[1], commit: { sha } });
  }
  if (head === 'commits' && rt.method === 'GET') {
    const ref = rt.query.get('sha') ?? rt.query.get('ref');
    const commits = historyOf(repo, tipOf(repo, ref));
    return ok(
      commits.map((commit) => ({
        sha: commit.sha,
        node_id: commit.sha,
        commit: {
          message: commit.message,
          author: { name: commit.author, email: `${commit.author}@users.noreply.github.com`, date: iso(commit.at) },
          committer: { name: commit.author, email: `${commit.author}@users.noreply.github.com`, date: iso(commit.at) },
          tree: { sha: commit.tree },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      })),
    );
  }
  if (head === 'git' && sub[1] === 'refs') return gitRefsRoute(rt, repo, sub.slice(2));
  if (head === 'contents') return contentsRoute(rt, repo, sub.slice(1));
  if (head === 'labels') return labelsRoute(rt, repo, sub.slice(1));
  if (head === 'issues') return issuesRoute(rt, repo, sub.slice(1));
  if (head === 'pulls') return pullsRoute(rt, repo, sub.slice(1));
  return notFound();
}

/** POST /git/refs and GET /git/refs/... over the REST surface. */
async function gitRefsRoute(rt: Routed, repo: Repo, sub: string[]): Promise<Reply> {
  if (sub.length === 0) {
    if (rt.method === 'POST') {
      let body: unknown;
      try {
        body = await readJson(rt.req);
      } catch {
        return badRequest();
      }
      const input = asObject(body);
      const ref = asString(input.ref);
      if (!ref.startsWith('refs/')) return unprocessable('ref must start with refs/');
      const sha = asString(input.sha) || tipOf(repo, null);
      if (sha === undefined) return unprocessable('a ref needs a commit to point at');
      const name = ref.replace(/^refs\/(heads|tags)\//, '');
      if (ref.startsWith('refs/tags/')) repo.tags.set(name, sha);
      else repo.branches.set(name, sha);
      return created({ ref, object: { sha, type: 'commit' } });
    }
    if (rt.method === 'GET') {
      const refs = [
        ...[...repo.branches].map(([name, sha]) => ({ ref: `refs/heads/${name}`, object: { sha, type: 'commit' } })),
        ...[...repo.tags].map(([name, sha]) => ({ ref: `refs/tags/${name}`, object: { sha } })),
      ];
      return ok(refs);
    }
  }
  if (rt.method === 'GET' && sub[0] === 'heads' && sub.length === 2) {
    const sha = repo.branches.get(sub[1]);
    return sha === undefined ? notFound() : ok({ ref: `refs/heads/${sub[1]}`, object: { sha, type: 'commit' } });
  }
  if (rt.method === 'GET' && sub[0] === 'tags' && sub.length === 2) {
    const sha = repo.tags.get(sub[1]);
    return sha === undefined ? notFound() : ok({ ref: `refs/tags/${sub[1]}`, object: { sha, type: 'tag' } });
  }
  return notFound();
}

/** PUT/GET/DELETE /contents/{path...} */
async function contentsRoute(rt: Routed, repo: Repo, sub: string[]): Promise<Reply> {
  const filePath = sub.join('/');

  if (rt.method === 'PUT') {
    let body: unknown;
    try {
      body = await readJson(rt.req);
    } catch {
      return badRequest();
    }
    const input = asObject(body);
    // The target branch is whichever the body names, else the query, else the default branch.
    const named = asString(input.branch) || rt.query.get('ref') || rt.query.get('branch') || repo.defaultBranch;
    const branch = repo.branches.has(named) ? named : repo.defaultBranch;
    const parentTip = repo.branches.get(branch);
    const files = filesOf(repo, parentTip);
    const existing = files.get(filePath);
    const previousSha = existing === undefined ? null : blobId(existing);
    const claimed = typeof input.sha === 'string' && input.sha !== '' ? input.sha : null;
    if (claimed !== null && claimed !== previousSha) return failed(409, 'sha does not match the current file');

    const encoding = asString(input.encoding).toLowerCase();
    const raw = asString(input.content);
    const content = encoding === 'utf-8' || encoding === 'utf8' ? raw : Buffer.from(raw, 'base64').toString('utf8');

    const next = new Map(files);
    next.set(filePath, content);
    const message = asString(input.message) || `Update ${filePath}`;
    const commit = commitFiles(repo, next, message, parentTip ?? null, branch);
    const view = {
      content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobId(content), size: Buffer.byteLength(content, 'utf8'), encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64') },
      commit: { sha: commit.sha, message: commit.message },
    };
    return previousSha === null ? created(view) : ok(view);
  }

  const branch = branchForContents(repo, rt.query);
  const tip = tipOf(repo, branch);
  const files = filesOf(repo, tip);

  if (rt.method === 'DELETE') {
    const existing = files.get(filePath);
    if (existing === undefined) return notFound();
    let claimed: string | null = null;
    try {
      claimed = asString(asObject(await readJson(rt.req)).sha) || null;
    } catch {
      claimed = null;
    }
    if (claimed !== null && claimed !== blobId(existing)) return failed(409, 'sha does not match the current file');
    const next = new Map(files);
    next.delete(filePath);
    const commit = commitFiles(repo, next, `Delete ${filePath}`, tip ?? null, repo.branches.has(branch) ? branch : repo.defaultBranch);
    return ok({ commit: { sha: commit.sha }, content: null });
  }

  if (rt.method !== 'GET' && rt.method !== 'HEAD') return notFound();
  const file = files.get(filePath);
  if (file !== undefined) {
    return ok({
      type: 'file',
      encoding: 'base64',
      size: Buffer.byteLength(file, 'utf8'),
      name: filePath.split('/').pop() ?? filePath,
      path: filePath,
      content: Buffer.from(file, 'utf8').toString('base64'),
      sha: blobId(file),
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${filePath}`,
      git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobId(file)}`,
      html_url: null,
      download_url: null,
    });
  }
  const listing = directoryListing(repo, files, filePath);
  return listing === undefined ? notFound() : ok(listing);
}

/** POST/GET /labels */
async function labelsRoute(rt: Routed, repo: Repo, sub: string[]): Promise<Reply> {
  if (sub.length === 0) {
    if (rt.method === 'POST') {
      let body: unknown;
      try {
        body = await readJson(rt.req);
      } catch {
        return badRequest();
      }
      const input = asObject(body);
      const name = asString(input.name).trim();
      if (name === '') return unprocessable('label name is required');
      const color = asString(input.color, 'ededed').replace(/^#/, '');
      const label: Label = { name, color };
      repo.labels.set(name, label);
      return created(labelView(label));
    }
    if (rt.method === 'GET') return ok([...repo.labels.values()].map(labelView));
  }
  if (sub.length === 1 && rt.method === 'GET') {
    const label = repo.labels.get(sub[0]);
    return label === undefined ? notFound() : ok(labelView(label));
  }
  if (sub.length === 1 && rt.method === 'DELETE') {
    if (!repo.labels.delete(sub[0])) return notFound();
    return noContent();
  }
  return notFound();
}

/** POST/GET /issues, GET/PATCH /issues/{n}, POST/GET /issues/{n}/comments */
async function issuesRoute(rt: Routed, repo: Repo, sub: string[]): Promise<Reply> {
  if (sub.length === 0) {
    if (rt.method === 'POST') {
      let body: unknown;
      try {
        body = await readJson(rt.req);
      } catch {
        return badRequest();
      }
      const input = asObject(body);
      const title = asString(input.title);
      if (title === '') return unprocessable('title is required');
      const wanted = asArray(input.labels).map((entry) => asString(isObject(entry) ? entry.name : entry)).filter((name) => name !== '');
      const unknown = wanted.filter((name) => !repo.labels.has(name));
      if (unknown.length > 0) return unprocessable(`Validation Failed: label ${unknown[0]} does not exist`);
      const issue: Issue = { id: rt.store.nextIssueId++, number: repo.issues.length + 1, title, body: asString(input.body), state: 'open', labels: wanted, at: Date.now() };
      repo.issues.push(issue);
      return created(issueView(repo, issue));
    }
    if (rt.method === 'GET') {
      const state = rt.query.get('state') ?? 'open';
      const labels = (rt.query.get('labels') ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '');
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      if (labels.length > 0) list = list.filter((issue) => labels.every((name) => issue.labels.includes(name)));
      const ascending = (rt.query.get('direction') ?? 'desc').toLowerCase() === 'asc';
      const sorted = list.slice().sort((a, b) => (ascending ? a.number - b.number : b.number - a.number));
      return paginate(sorted.map((issue) => issueView(repo, issue)), rt.query, rt.origin, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
    }
    return notFound();
  }

  const issue = findIssue(repo, sub[0]);
  if (issue === undefined) return notFound();

  if (sub.length === 1) {
    if (rt.method === 'GET') return ok(issueView(repo, issue));
    if (rt.method === 'PATCH') {
      let body: unknown;
      try {
        body = await readJson(rt.req);
      } catch {
        return badRequest();
      }
      const input = asObject(body);
      if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
      if (typeof input.title === 'string' && input.title !== '') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (Array.isArray(input.labels)) {
        const wanted = input.labels.map((entry) => asString(isObject(entry) ? entry.name : entry)).filter((name) => name !== '');
        const unknown = wanted.filter((name) => !repo.labels.has(name));
        if (unknown.length > 0) return unprocessable(`Validation Failed: label ${unknown[0]} does not exist`);
        issue.labels = wanted;
      }
      return ok(issueView(repo, issue));
    }
    return notFound();
  }

  if (sub[1] === 'comments') {
    const thread = repo.comments.get(issue.number) ?? [];
    if (!repo.comments.has(issue.number)) repo.comments.set(issue.number, thread);
    if (sub.length === 2 && rt.method === 'GET') return ok(thread.map(commentView));
    if (sub.length === 2 && rt.method === 'POST') {
      let body: unknown;
      try {
        body = await readJson(rt.req);
      } catch {
        return badRequest();
      }
      const text = asString(asObject(body).body);
      if (text === '') return unprocessable('body is required');
      const comment: Comment = { id: rt.store.nextCommentId++, body: text, at: Date.now() };
      thread.push(comment);
      return created(commentView(comment));
    }
  }
  return notFound();
}

/** POST/GET /pulls, GET /pulls/{n}, /pulls/{n}/files, PUT /pulls/{n}/merge */
async function pullsRoute(rt: Routed, repo: Repo, sub: string[]): Promise<Reply> {
  if (sub.length === 0) {
    if (rt.method === 'POST') {
      let body: unknown;
      try {
        body = await readJson(rt.req);
      } catch {
        return badRequest();
      }
      const input = asObject(body);
      const head = asString(input.head) || repo.defaultBranch;
      const base = asString(input.base) || repo.defaultBranch;
      if (!repo.branches.has(head)) return unprocessable(`No commits between ${base} and ${head}`);
      if (!repo.branches.has(base)) return unprocessable(`Base ${base} does not exist`);
      const pull: PullRequest = {
        id: rt.store.nextPullId++,
        number: repo.pulls.length + 1,
        title: asString(input.title),
        body: asString(input.body),
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommit: null,
        head,
        base,
        at: Date.now(),
      };
      repo.pulls.push(pull);
      return created(pullView(repo, pull));
    }
    if (rt.method === 'GET') {
      const state = rt.query.get('state') ?? 'open';
      const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      return paginate(list.map((pull) => pullView(repo, pull)), rt.query, rt.origin, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
    }
    return notFound();
  }

  const pull = findPull(repo, sub[0]);
  if (pull === undefined) return notFound();

  if (sub.length === 1) {
    if (rt.method === 'GET') return ok(pullView(repo, pull));
    if (rt.method === 'PATCH') {
      let body: unknown;
      try {
        body = await readJson(rt.req);
      } catch {
        return badRequest();
      }
      const input = asObject(body);
      if (typeof input.title === 'string') pull.title = input.title;
      if (typeof input.body === 'string') pull.body = input.body;
      if (input.state === 'open' || input.state === 'closed') pull.state = input.state;
      return ok(pullView(repo, pull));
    }
    return notFound();
  }

  if (sub[1] === 'files' && sub.length === 2 && rt.method === 'GET') return ok(pullFilesOf(repo, pull));
  if (sub[1] === 'merge' && sub.length === 2 && rt.method === 'PUT') return mergeRoute(rt, repo, pull);
  return notFound();
}

/**
 * PUT /pulls/{n}/merge — a three-way merge of head into base, evaluated against the merge base.
 *
 * The head branch's first parent is the closest thing to an ancestor the suite leaves behind, so a file
 * counts as untouched by the base when it still matches that parent; two sides that both moved a file
 * apart from it conflict, and a conflict is a 405.
 */
function mergeRoute(rt: Routed, repo: Repo, pull: PullRequest): Reply {
  if (pull.merged) return failed(405, 'Pull Request is already merged');
  const baseTip = repo.branches.get(pull.base);
  const headTip = repo.branches.get(pull.head);
  if (baseTip === undefined || headTip === undefined) return failed(405, 'Pull Request cannot be merged');
  if (baseTip === headTip) return failed(405, 'There are no changes to merge');

  const baseFiles = filesOf(repo, baseTip);
  const headFiles = filesOf(repo, headTip);
  const originFiles = filesOf(repo, repo.commits.get(headTip)?.parents[0] ?? baseTip);
  const merged = new Map<string, string>();
  const names = new Set([...baseFiles.keys(), ...headFiles.keys(), ...originFiles.keys()]);
  for (const name of names) {
    const baseText = baseFiles.get(name);
    const headText = headFiles.get(name);
    const originText = originFiles.get(name);
    if (baseText === headText) {
      if (headText !== undefined) merged.set(name, headText);
    } else if (baseText === originText) {
      if (headText !== undefined) merged.set(name, headText);
    } else if (headText === originText) {
      if (baseText !== undefined) merged.set(name, baseText);
    } else {
      return failed(405, 'Pull Request cannot be merged: the base branch changed the same files');
    }
  }
  const message = `Merge pull request #${pull.number} from ${pull.head}`;
  const commit = commitFiles(repo, merged, message, baseTip, pull.base);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = Date.now();
  pull.mergeCommit = commit.sha;
  return ok({ sha: commit.sha, merged: true, message: 'Pull Request successfully merged' });
}

/** The /api/v3 surface. */
async function restRoute(rt: Routed): Promise<Reply> {
  const { segments } = rt;
  if (segments.length === 0) return rt.method === 'GET' ? restRoot() : notFound();
  if (segments[0] === 'meta' && segments.length === 1) return ok({ installed_version: '3.4.0-forge' });
  if (segments[0] === 'rate_limit' && segments.length === 1) return ok({ resources: {}, rate: { limit: 5000, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 } });

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (rt.method === 'POST') return createRepo(rt);
    if (rt.method === 'GET') return listOwnRepos(rt);
    return notFound();
  }
  if (segments[0] === 'user' && segments.length === 1 && rt.method === 'GET') {
    return ok({ login: rt.store.login, id: 1, type: 'User', name: rt.store.login, site_admin: false });
  }

  if (segments[0] !== 'repos' || segments.length < 3) return notFound();
  const owner = segments[1] ?? '';
  const name = segments[2] ?? '';
  const repo = lookupRepo(rt.store, owner, name);
  if (repo === MISS) return notFound();
  return repoRoute(rt, repo, segments.slice(3));
}

// ------------------------------------------------------------------------------------------------
// Git smart HTTP
// ------------------------------------------------------------------------------------------------

/** The bytes of a tree object as git stores them. */
function treeBytes(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of [...entries].sort(compareTreeEntries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** The bytes of a commit object for a stored commit. */
function commitBytes(commit: Commit): Buffer {
  const message = commit.message.endsWith('\n') ? commit.message : `${commit.message}\n`;
  return Buffer.from(commitHeaders(commit.tree, commit.parents, commit.author, commit.at) + message, 'utf8');
}

/**
 * Project a repository onto the GitStore gitserve.ts works with: every object as bytes, every ref by name.
 * Objects that arrived over git win outright; the REST-side object graph fills in whatever is missing.
 */
function gitStoreOf(repo: Repo): GitStore {
  const objects = new Map<string, GitObj>();
  for (const [sha, packed] of repo.packed) objects.set(sha, { type: packed.kind, data: Buffer.from(packed.data, 'base64') });
  for (const [sha, blob] of repo.blobs) if (!objects.has(sha)) objects.set(sha, { type: 'blob', data: Buffer.from(blob.content, 'utf8') });
  for (const [sha, tree] of repo.trees) if (!objects.has(sha)) objects.set(sha, { type: 'tree', data: treeBytes(tree.entries) });
  for (const [sha, commit] of repo.commits) if (!objects.has(sha)) objects.set(sha, { type: 'commit', data: commitBytes(commit) });

  const refs = new Map<string, string>();
  for (const [name, sha] of repo.branches) refs.set(`refs/heads/${name}`, sha);
  for (const [name, sha] of repo.tags) refs.set(`refs/tags/${name}`, sha);
  const head = repo.branches.get(repo.defaultBranch) ?? repo.branches.values().next().value;
  if (head !== undefined) refs.set('HEAD', head);
  return { objects, refs };
}

/** Parse a raw tree object back into entries (a pushed tree may be new to the REST side). */
function parseTreeEntries(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(at, space).toString('latin1'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    at = nul + 21;
  }
  return entries;
}

/** Split a raw commit object into its tree, parents, message and author timestamp. */
function parseCommitObject(data: Buffer): { tree: string; parents: string[]; message: string; author: string; at: number } {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const headers = headerEnd < 0 ? text : text.slice(0, headerEnd);
  const message = headerEnd < 0 ? '' : text.slice(headerEnd + 2);
  const tree = /^tree ([0-9a-f]{40})$/m.exec(headers)?.[1] ?? '';
  const parents = [...headers.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((match) => match[1] ?? '');
  const authorLine = /^author (.*) (\d+) [+-]\d{4}$/m.exec(headers);
  const author = authorLine?.[1]?.replace(/ <[^>]*>$/, '') ?? 'git';
  const at = authorLine?.[2] === undefined ? Date.now() : Number.parseInt(authorLine[2], 10) * 1000;
  return { tree, parents, message, author, at };
}

/**
 * Fold what a git request left in the store back into the repository.
 *
 * Every object becomes visible verbatim (so a later clone returns the same bytes), refs are mirrored both
 * ways — a ref the push deleted disappears here too — and pushed commits join the REST history.
 */
function absorbGitObjects(repo: Repo, store: GitStore): void {
  for (const [sha, object] of store.objects) {
    if (!repo.packed.has(sha)) repo.packed.set(sha, { kind: object.type, data: object.data.toString('base64') });
    if (object.type === 'blob' && !repo.blobs.has(sha)) repo.blobs.set(sha, { content: object.data.toString('utf8') });
    if (object.type === 'tree' && !repo.trees.has(sha)) repo.trees.set(sha, { entries: parseTreeEntries(object.data) });
    if (object.type === 'commit' && !repo.commits.has(sha)) {
      const parsed = parseCommitObject(object.data);
      repo.commits.set(sha, { tree: parsed.tree, parents: parsed.parents, message: parsed.message, author: parsed.author, at: parsed.at });
    }
  }

  const heads = new Map<string, string>();
  const tags = new Map<string, string>();
  for (const [ref, sha] of store.refs) {
    if (ref.startsWith('refs/heads/')) heads.set(ref.slice('refs/heads/'.length), sha);
    else if (ref.startsWith('refs/tags/')) tags.set(ref.slice('refs/tags/'.length), sha);
  }
  repo.branches = heads;
  repo.tags = tags;
}

/** A stand-in ServerResponse: gitserve.ts writes its answer here and the bytes are read back. */
interface Capture {
  res: ServerResponse;
  reply(): Promise<Reply>;
}

function newCapture(): Capture {
  const chunks: Buffer[] = [];
  let status = 200;
  let contentType = 'application/octet-stream';
  let done: ((reply: Reply) => void) | null = null;
  const settled = new Promise<Reply>((resolve) => { done = resolve; });
  const finish = (status_: number): void => {
    done?.({ status: status_, raw: Buffer.concat(chunks), rawType: contentType });
    done = null;
  };
  const res = {
    headersSent: false,
    writeHead(code: number, headers?: Record<string, string>): unknown {
      status = code;
      if (headers !== undefined && typeof headers['content-type'] === 'string') contentType = headers['content-type'];
      res.headersSent = true;
      return res;
    },
    write(chunk: Buffer | string): boolean {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
      return true;
    },
    end(chunk?: Buffer | string): unknown {
      if (chunk !== undefined && chunk !== null) res.write(chunk as Buffer | string);
      finish(status);
      return res;
    },
    setHeader(name: string, value: string): void {
      if (name.toLowerCase() === 'content-type') contentType = value;
    },
    getHeader(): undefined { return undefined; },
    removeHeader(): void {},
    flushHeaders(): void {},
    destroyed: false,
    writableEnded: false,
  };
  return { res: res as unknown as ServerResponse, reply: () => settled };
}

/** Serve a body gitserve.ts reads with req.on('data'/'end'), fed from the request already in hand. */
function drainBodyInto(req: IncomingMessage, capture: Capture): IncomingMessage {
  void capture;
  return req;
}

/** GET /{owner}/{repo}.git/info/refs?service=..., POST .../git-upload-pack and .../git-receive-pack */
async function gitRoute(req: IncomingMessage, method: string, url: URL, store: Store): Promise<Reply> {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(url.pathname);
  if (match === null) return notFound();
  let owner: string;
  let name: string;
  try {
    owner = decodeURIComponent(match[1] ?? '');
    name = decodeURIComponent(match[2] ?? '');
  } catch {
    owner = match[1] ?? '';
    name = match[2] ?? '';
  }
  const tail = match[3] ?? '';
  const repo = lookupRepo(store, owner, name);

  if (method === 'GET' && tail.endsWith('/info/refs')) {
    const service = url.searchParams.get('service') ?? 'git-upload-pack';
    const wantsV2 = asString(req.headers['git-protocol']).includes('version=2');
    const capture = newCapture();
    gitAdvertise(repo === MISS ? null : gitStoreOf(repo), capture.res, service, wantsV2);
    return await capture.reply();
  }
  if (repo === MISS) return notFound();

  if (method === 'POST' && tail.endsWith('/git-receive-pack')) {
    const gitStore = gitStoreOf(repo);
    const capture = newCapture();
    await gitReceive(gitStore, drainBodyInto(req, capture), capture.res);
    const reply = await capture.reply();
    absorbGitObjects(repo, gitStore);
    return reply;
  }
  if (method === 'POST' && tail.endsWith('/git-upload-pack')) {
    const capture = newCapture();
    await gitUpload(gitStoreOf(repo), drainBodyInto(req, capture), capture.res);
    return await capture.reply();
  }
  return notFound();
}

// ------------------------------------------------------------------------------------------------
// GraphQL v4
// ------------------------------------------------------------------------------------------------

/**
 * Argument text helpers. A GraphQL document arrives as text, so arguments are read from the text between
 * a call's parentheses: `repository(owner: $owner, name: "x")`, inline objects and lists included.
 */

/** The text between a call's parentheses for `name`, at its first occurrence ('' when absent). */
function argumentText(args: string, key: string): string | null {
  const pattern = new RegExp(`(?:^|[\\s,{])${key}\\s*:`);
  const found = pattern.exec(args);
  if (found === null) return null;
  let at = found.index + found[0].length;
  while (at < args.length && /\s/.test(args[at] ?? '')) at += 1;
  const start = at;
  const opening = args[start];
  if (opening === '{' || opening === '[') {
    const closing = opening === '{' ? '}' : ']';
    let depth = 0;
    while (at < args.length) {
      const char = args[at];
      if (char === '"') {
        at += 1;
        while (at < args.length && args[at] !== '"') at += args[at] === '\\' ? 2 : 1;
      } else if (char === opening) depth += 1;
      else if (char === closing) {
        depth -= 1;
        if (depth === 0) {
          at += 1;
          break;
        }
      }
      at += 1;
    }
    return args.slice(start, at);
  }
  if (opening === '"') {
    at += 1;
    while (at < args.length) {
      if (args[at] === '\\') at += 2;
      else if (args[at] === '"') {
        at += 1;
        break;
      } else at += 1;
    }
    return args.slice(start, at);
  }
  while (at < args.length && !/[,\s)]/.test(args[at] ?? '')) at += 1;
  return args.slice(start, at);
}

/** A literal or variable reference as the value it stands for; MISS when a variable is absent. */
function valueOf(literal: string | null, variables: Json): unknown {
  if (literal === null) return MISS;
  const text = literal.trim();
  if (text === '') return MISS;
  if (text.startsWith('{')) {
    const out: Json = {};
    for (const part of splitTopLevel(text.slice(1, -1))) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      const key = part.slice(0, colon).trim();
      const value = valueOf(part.slice(colon + 1), variables);
      if (key !== '' && value !== MISS) out[key] = value;
    }
    return out;
  }
  if (text.startsWith('[')) {
    return splitTopLevel(text.slice(1, -1)).map((part) => valueOf(part, variables));
  }
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith('$')) {
    const value = variables[text.slice(1)];
    return value === undefined ? MISS : value;
  }
  if (text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

/** Split on commas that are not inside a nested object, list or string. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (inString) {
      if (char === '\\') at += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[' || char === '(') depth += 1;
    else if (char === '}' || char === ']' || char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, at));
      start = at + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** Every `name(...)` call in a document, with the alias it answers under. */
function callSites(document: string, name: string): { alias: string; args: string }[] {
  const pattern = new RegExp(`(?:(\\w+)\\s*:\\s*)?\\b${name}\\s*\\(`, 'g');
  const sites: { alias: string; args: string }[] = [];
  for (let match = pattern.exec(document); match !== null; match = pattern.exec(document)) {
    const open = match.index + match[0].length;
    let depth = 1;
    let at = open;
    while (at < document.length && depth > 0) {
      if (document[at] === '(') depth += 1;
      else if (document[at] === ')') depth -= 1;
      at += 1;
    }
    sites.push({ alias: match[1] ?? name, args: document.slice(open, at - 1) });
  }
  return sites;
}

/** Global (Relay) ids: base64 of the kind and the numeric id, the shape GitHub uses. */
function globalId(kind: string, id: number): string {
  return Buffer.from(`04:${kind}${id}`, 'utf8').toString('base64');
}

/** The numeric id at the end of a global id (NaN when the value is not one). */
function idFromGlobal(id: string): number {
  try {
    const digits = /(\d+)$/.exec(Buffer.from(id, 'base64').toString('utf8'));
    return digits === null ? Number.NaN : Number.parseInt(digits[1] ?? '', 10);
  } catch {
    return Number.NaN;
  }
}

/** The object kind encoded in a global id. */
function kindFromGlobal(id: string): string {
  try {
    return Buffer.from(id, 'base64').toString('utf8').replace(/^\d+:/, '').replace(/\d+$/, '');
  } catch {
    return '';
  }
}

/** The introspection types gh probes, with the members each must list. */
const ENUM_TYPES: Record<string, readonly string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  IssueStateReason: ['COMPLETED', 'NOT_PLANNED', 'REOPENED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  PullRequestReviewDecision: ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const OBJECT_TYPES: Record<string, readonly string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'labels', 'comments', 'author'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'headRefOid', 'mergeable', 'files', 'url', 'createdAt', 'isDraft'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'url'],
  User: ['id', 'login', 'name', 'email'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Ref: ['name', 'target'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'totalCount'],
};

function issueNode(issue: Issue): Json {
  return {
    id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: iso(issue.at),
    updatedAt: iso(issue.at),
  };
}

function pullNode(repo: Repo, pull: PullRequest): Json {
  return {
    id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    headRefOid: repo.branches.get(pull.head) ?? null,
    mergeable: pull.state === 'open' ? 'MERGEABLE' : 'UNKNOWN',
    isDraft: false,
    createdAt: iso(pull.at),
  };
}

/** An issue list as a GraphQL connection: nodes, edges, a cursor page and the total. */
function issueConnection(issues: readonly Issue[], first: number | null, after: string | null): Json {
  const start = after === null || after === '' ? 0 : issues.findIndex((issue) => globalId('Issue', issue.id) === after) + 1;
  const page = first === null ? issues.slice(start) : issues.slice(start, start + Math.max(first, 0));
  const endCursor = page.length === 0 ? null : globalId('Issue', page[page.length - 1]!.id);
  return {
    nodes: page.map(issueNode),
    edges: page.map((issue) => ({ cursor: globalId('Issue', issue.id), node: issueNode(issue) })),
    pageInfo: {
      hasNextPage: endCursor !== null && start + page.length < issues.length,
      hasPreviousPage: start > 0,
      startCursor: page.length === 0 ? null : globalId('Issue', page[0]!.id),
      endCursor,
    },
    totalCount: issues.length,
  };
}

/** A pull-request list as a connection. */
function pullConnection(repo: Repo, pulls: readonly PullRequest[], first: number | null): Json {
  const page = first === null ? pulls.slice() : pulls.slice(0, Math.max(first, 0));
  return {
    nodes: page.map((pull) => pullNode(repo, pull)),
    edges: page.map((pull) => ({ node: pullNode(repo, pull) })),
    pageInfo: { hasNextPage: page.length < pulls.length, hasPreviousPage: false, startCursor: null, endCursor: null },
    totalCount: pulls.length,
  };
}

/** The repository scalars GraphQL exposes, without its nested connections. */
function repoScalars(repo: Repo): Json {
  return {
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.isPrivate,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: iso(repo.at),
    url: `http://localhost/${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: globalId('User', 1) },
    defaultBranchRef: repo.branches.has(repo.defaultBranch) ? { name: repo.defaultBranch, target: { oid: repo.branches.get(repo.defaultBranch) } } : null,
  };
}

/** `first`/`after` of a connection call, or null when the document leaves them out. */
function connectionBounds(args: string, variables: Json): { first: number | null; after: string | null } {
  const first = valueOf(argumentText(args, 'first'), variables);
  const after = valueOf(argumentText(args, 'after'), variables);
  return {
    first: first === MISS || first === null || first === undefined ? null : asInt(first, 0),
    after: after === MISS || after === null || after === undefined ? null : asString(after) || null,
  };
}

/** The upper-cased enum names a `states:` argument lists, either inline or from a variable. */
function stateFilter(args: string, variables: Json): string[] {
  const raw = valueOf(argumentText(args, 'states'), variables);
  if (Array.isArray(raw)) return raw.map((entry) => asString(entry).toUpperCase());
  if (typeof raw === 'string' && raw !== '') return raw.replace(/[[\]]/g, '').split(',').map((entry) => entry.trim().toUpperCase()).filter((entry) => entry !== '');
  return [];
}

/**
 * One GraphQL operation against the store.
 *
 * The document is read as text: aliased calls, inline arguments, arguments from `variables`, and the
 * `__type` probes gh's feature detection sends. A field nobody holds comes back as an `errors` array on a
 * 200, which is what a GraphQL client expects.
 */
function runOperation(document: string, variables: Json, store: Store): Json {
  const data: Json = {};

  const introspection = callSites(document, '__type');
  if (introspection.length > 0) {
    for (const site of introspection) {
      const typeName = asString(valueOf(argumentText(site.args, 'name'), variables), '');
      const enums = ENUM_TYPES[typeName];
      const objects = OBJECT_TYPES[typeName];
      if (enums !== undefined) data[site.alias] = { kind: 'ENUM', name: typeName, enumValues: enums.map((name) => ({ name })) };
      else if (objects !== undefined) data[site.alias] = { kind: 'OBJECT', name: typeName, fields: objects.map((name) => ({ name })) };
      else data[site.alias] = null;
    }
  }

  // A field the schema does not hold is reported in `errors`, naming the field.
  const viewerSection = /\bviewer\s*(?:\([^)]*\))?\s*\{([^{}]*)\}/.exec(document);
  if (viewerSection !== null) {
    const known = new Set(['login', 'id', 'name', 'email', '__typename']);
    for (const line of (viewerSection[1] ?? '').split('\n')) {
      const field = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line)?.[1];
      if (field !== undefined && !known.has(field)) {
        return { data: null, errors: [{ message: `Field '${field}' doesn't exist on type 'User'`, path: ['viewer', field], type: 'field' }] };
      }
    }
  }

  const mutation = runMutation(document, variables, store);
  if (mutation !== null) return mutation;

  if (/\bviewer\s*[({]/.test(document)) data.viewer = { login: store.login, id: globalId('User', 1) };

  const repositories = callSites(document, 'repository');
  if (repositories.length > 0) {
    const site = repositories[0]!;
    const owner = asString(valueOf(argumentText(site.args, 'owner'), variables), store.login);
    const name = asString(valueOf(argumentText(site.args, 'name'), variables), '');
    const found = lookupRepo(store, owner, name);
    if (found === MISS) {
      data[site.alias] = null;
    } else {
      const node = repoScalars(found);

      const single = callSites(document, 'issue');
      if (single.length > 0) {
        const number = asInt(valueOf(argumentText(single[0]!.args, 'number'), variables), -1);
        const issue = found.issues.find((candidate) => candidate.number === number);
        node.issue = issue === undefined ? null : issueNode(issue);
      }

      const issueList = callSites(document, 'issues');
      if (issueList.length > 0) {
        const args = issueList[0]!.args;
        const wanted = stateFilter(args, variables);
        const order = asObject(valueOf(argumentText(args, 'orderBy'), variables));
        const ascending = asString(order.direction, 'DESC').toUpperCase() === 'ASC';
        const list = found.issues
          .filter((issue) => wanted.length === 0 || wanted.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'))
          .sort((a, b) => (ascending ? a.number - b.number : b.number - a.number));
        const bounds = connectionBounds(args, variables);
        node.issues = issueConnection(list, bounds.first, bounds.after);
      }

      const pullList = callSites(document, 'pullRequests');
      if (pullList.length > 0) {
        const bounds = connectionBounds(pullList[0]!.args, variables);
        const wanted = stateFilter(pullList[0]!.args, variables);
        const list = found.pulls.filter((pull) => wanted.length === 0 || wanted.includes(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'));
        node.pullRequests = pullConnection(found, list, bounds.first);
      }

      const pullSingle = callSites(document, 'pullRequest');
      if (pullSingle.length > 0) {
        const number = asInt(valueOf(argumentText(pullSingle[0]!.args, 'number'), variables), -1);
        const pull = found.pulls.find((candidate) => candidate.number === number);
        if (pull === undefined) node.pullRequest = null;
        else {
          const view = pullNode(found, pull);
          view.files = { nodes: changedPaths(found, pull).map((path) => ({ path })), totalCount: changedPaths(found, pull).length };
          node.pullRequest = view;
        }
      }
      data[site.alias] = node;
    }
  }

  const nodeCall = callSites(document, 'node');
  if (nodeCall.length > 0) {
    const id = asString(valueOf(argumentText(nodeCall[0]!.args, 'id'), variables), '');
    const kind = kindFromGlobal(id);
    const numeric = idFromGlobal(id);
    if (kind === 'Repository') {
      const repo = store.repos.find((candidate) => candidate.id === numeric);
      data[nodeCall[0]!.alias] = repo === undefined ? null : { id, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` };
    } else {
      data[nodeCall[0]!.alias] = null;
    }
  }

  return { data };
}

/**
 * The mutation a document names, or null when it holds none.
 *
 * An input arrives either inline (`createIssue(input: {title: "x"})`) or as a variable
 * (`createIssue(input: $input)`); both are resolved to one plain object here.
 */
function runMutation(document: string, variables: Json, store: Store): Json | null {
  const inputOf = (name: string): { alias: string; input: Json } | null => {
    const sites = callSites(document, name);
    if (sites.length === 0) return null;
    const raw = valueOf(argumentText(sites[0]!.args, 'input'), variables);
    return { alias: sites[0]!.alias, input: asObject(raw === MISS ? {} : raw) };
  };
  const repoOfInput = (input: Json): Repo | undefined => {
    const numeric = idFromGlobal(asString(input.repositoryId));
    return store.repos.find((repo) => repo.id === numeric);
  };

  const createIssueCall = inputOf('createIssue');
  if (createIssueCall !== null) {
    const repo = repoOfInput(createIssueCall.input);
    if (repo === undefined) return { data: null, errors: [{ message: 'Could not resolve to a Repository', type: 'NOT_FOUND' }] };
    const issue: Issue = { id: store.nextIssueId++, number: repo.issues.length + 1, title: asString(createIssueCall.input.title), body: asString(createIssueCall.input.body), state: 'open', labels: [], at: Date.now() };
    repo.issues.push(issue);
    return { data: { [createIssueCall.alias]: { issue: issueNode(issue), clientMutationId: null } } };
  }

  const closeIssueCall = inputOf('closeIssue');
  if (closeIssueCall !== null) {
    const numeric = idFromGlobal(asString(closeIssueCall.input.issueId));
    for (const repo of store.repos) {
      const issue = repo.issues.find((candidate) => candidate.id === numeric);
      if (issue === undefined) continue;
      issue.state = 'closed';
      return { data: { [closeIssueCall.alias]: { issue: issueNode(issue), clientMutationId: null } } };
    }
    return { data: null, errors: [{ message: 'Could not resolve to an Issue', type: 'NOT_FOUND' }] };
  }

  const createPullCall = inputOf('createPullRequest');
  if (createPullCall !== null) {
    const repo = repoOfInput(createPullCall.input);
    if (repo === undefined) return { data: null, errors: [{ message: 'Could not resolve to a Repository', type: 'NOT_FOUND' }] };
    const pull: PullRequest = {
      id: store.nextPullId++,
      number: repo.pulls.length + 1,
      title: asString(createPullCall.input.title),
      body: asString(createPullCall.input.body),
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommit: null,
      head: asString(createPullCall.input.headRefName, repo.defaultBranch),
      base: asString(createPullCall.input.baseRefName, repo.defaultBranch),
      at: Date.now(),
    };
    repo.pulls.push(pull);
    return { data: { [createPullCall.alias]: { pullRequest: pullNode(repo, pull), clientMutationId: null } } };
  }

  const mergeCall = inputOf('mergePullRequest');
  if (mergeCall !== null) {
    const numeric = idFromGlobal(asString(mergeCall.input.pullRequestId));
    for (const repo of store.repos) {
      const pull = repo.pulls.find((candidate) => candidate.id === numeric);
      if (pull === undefined) continue;
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = Date.now();
      return { data: { [mergeCall.alias]: { pullRequest: pullNode(repo, pull), clientMutationId: null } } };
    }
    return { data: null, errors: [{ message: 'Could not resolve to a PullRequest', type: 'NOT_FOUND' }] };
  }

  const commentCall = inputOf('addComment');
  if (commentCall !== null) {
    const body = asString(commentCall.input.body);
    const comment: Comment = { id: store.nextCommentId++, body, at: Date.now() };
    const numeric = idFromGlobal(asString(commentCall.input.subjectId));
    for (const repo of store.repos) {
      const issue = repo.issues.find((candidate) => candidate.id === numeric);
      if (issue === undefined) continue;
      const thread = repo.comments.get(issue.number) ?? [];
      thread.push(comment);
      repo.comments.set(issue.number, thread);
      break;
    }
    return { data: { [commentCall.alias]: { commentEdge: { node: { id: globalId('IssueComment', comment.id), body } }, clientMutationId: null } } };
  }

  return null;
}

/** POST /api/graphql — one document, or an array of them (GitHub's operation batching). */
async function graphqlRoute(req: IncomingMessage, store: Store): Promise<Reply> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return badRequest();
  }
  if (Array.isArray(body)) {
    return ok(
      body.map((entry) => {
        const operation = asObject(entry);
        return runOperation(asString(operation.query), asObject(operation.variables), store);
      }),
    );
  }
  const operation = asObject(body);
  return ok(runOperation(asString(operation.query), asObject(operation.variables), store));
}

// ------------------------------------------------------------------------------------------------
// MCP — JSON-RPC 2.0 over POST /mcp
// ------------------------------------------------------------------------------------------------

const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-11-25', '2025-03-26', '2024-11-05'];

interface McpToolSpec {
  name: string;
  description: string;
  properties: Json;
  required: string[];
}

/** The tool table. It is built once and serialized the same way on every tools/list. */
const MCP_TOOLS: McpToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the caller and answer its REST view',
    properties: { owner: { type: 'string', description: 'the login that owns the new repository' }, name: { type: 'string', description: 'repository name' }, description: { type: 'string' }, private: { type: 'boolean' } },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name',
    properties: { owner: { type: 'string' }, repo: { type: 'string' } },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository',
    properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state',
    properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'all'] } },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch',
    properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } },
    required: ['owner', 'repo', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number',
    properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } },
    required: ['owner', 'repo', 'pull_number'],
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository',
    properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'all'] } },
    required: ['owner', 'repo'],
  },
];

/** The tools array exactly as tools/list answers it; computed once so two answers are byte-identical. */
const MCP_TOOL_LIST = Object.freeze(
  MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  })),
);

const MCP_SERVER_INFO = { name: 'forge', version: '1.2.0' };

/** A JSON-RPC error or result envelope, always HTTP 200 (except the 400 a parse error carries). */
function rpcResult(id: unknown, result: unknown): Reply {
  return ok({ jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Reply {
  const error: Json = { code, message };
  if (data !== undefined) error.data = data;
  return ok({ jsonrpc: '2.0', id: id ?? null, error });
}

/** The tool a `tools/call` names, tolerating a `server__tool` prefix. */
function mcpTool(name: string): McpToolSpec | undefined {
  const plain = name.toLowerCase();
  return MCP_TOOLS.find((tool) => tool.name === plain) ?? MCP_TOOLS.find((tool) => plain.endsWith(`__${tool.name}`) || plain.endsWith(`/${tool.name}`));
}

/** A tool answer: one text block holding the object as JSON. */
function toolText(value: unknown): Json {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function toolFailure(message: string): Json {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Run one MCP tool. A tool that cannot do its job answers isError, never a protocol error. */
function runTool(tool: McpToolSpec, args: Json, store: Store): Json {
  const missing = tool.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
  if (missing.length > 0) return toolFailure(`missing required argument(s): ${missing.join(', ')}`);
  const repoOf = (): Repo | typeof MISS => lookupRepo(store, asString(args.owner, store.login), asString(args.repo));

  switch (tool.name) {
    case 'create_repo': {
      const name = asString(args.name).trim();
      if (name === '') return toolFailure('a repository needs a name');
      const owner = asString(args.owner, store.login);
      const existing = lookupRepo(store, owner, name);
      if (existing !== MISS) return toolText(repoView(existing));
      const repo = newRepo(store, owner, name);
      repo.description = asString(args.description);
      repo.isPrivate = args.private === true;
      store.repos.push(repo);
      return toolText(repoView(repo));
    }
    case 'get_repo': {
      const repo = repoOf();
      return repo === MISS ? toolFailure('repository not found') : toolText(repoView(repo));
    }
    case 'create_issue': {
      const repo = repoOf();
      if (repo === MISS) return toolFailure('repository not found');
      const issue: Issue = { id: store.nextIssueId++, number: repo.issues.length + 1, title: asString(args.title), body: asString(args.body), state: 'open', labels: [], at: Date.now() };
      repo.issues.push(issue);
      return toolText(issueView(repo, issue));
    }
    case 'list_issues': {
      const repo = repoOf();
      if (repo === MISS) return toolFailure('repository not found');
      const state = asString(args.state, 'open');
      const list = repo.issues.filter((issue) => state === 'all' || issue.state === state).sort((a, b) => b.number - a.number);
      return toolText(list.map((issue) => issueView(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (repo === MISS) return toolFailure('repository not found');
      const head = asString(args.head);
      const base = asString(args.base, repo.defaultBranch);
      if (!repo.branches.has(head)) return toolFailure(`head branch ${head} does not exist`);
      const pull: PullRequest = { id: store.nextPullId++, number: repo.pulls.length + 1, title: asString(args.title), body: asString(args.body), state: 'open', merged: false, mergedAt: null, mergeCommit: null, head, base, at: Date.now() };
      repo.pulls.push(pull);
      return toolText(pullView(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (repo === MISS) return toolFailure('repository not found');
      const number = asInt(args.pull_number, -1);
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return toolFailure(`pull request #${number} not found`);
      const baseTip = repo.branches.get(pull.base);
      const headTip = repo.branches.get(pull.head);
      if (baseTip !== undefined && headTip !== undefined) {
        const merge = mergeRoute({ req: {} as IncomingMessage, store, method: 'PUT', segments: [], query: new URLSearchParams(), origin: '' }, repo, pull);
        return toolText(merge.body ?? merge);
      }
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = Date.now();
      return toolText({ sha: pull.mergeCommit, merged: true, message: 'Pull Request successfully merged' });
    }
    case 'list_pull_requests': {
      const repo = repoOf();
      if (repo === MISS) return toolFailure('repository not found');
      const state = asString(args.state, 'open');
      return toolText(repo.pulls.filter((pull) => state === 'all' || pull.state === state).map((pull) => pullView(repo, pull)));
    }
    default:
      return toolFailure(`unknown tool ${tool.name}`);
  }
}

/**
 * POST /mcp — the streamable-HTTP MCP endpoint.
 *
 * `server/discover` is deliberately not implemented: answering method-not-found is what tells a client this
 * server speaks the handshake revision, which it then answers in full.
 */
async function mcpRoute(req: IncomingMessage, store: Store): Promise<Reply> {
  let message: unknown;
  try {
    message = await readJson(req);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }

  if (Array.isArray(message)) {
    const answers: Json[] = [];
    for (const entry of message) {
      const answer = handleRpc(asObject(entry), store);
      if (answer !== null) answers.push(answer);
    }
    return answers.length === 0 ? { status: 202 } : ok(answers);
  }

  const answer = handleRpc(asObject(message), store);
  // A notification has no id and gets no body back.
  return answer === null ? { status: 202 } : ok(answer);
}

/** One JSON-RPC message turned into the envelope to send back (null for a notification). */
function handleRpc(message: Json, store: Store): Json | null {
  const id = message.id ?? null;
  const method = asString(message.method);
  const params = asObject(message.params);
  const isNotification = message.id === undefined;

  if (method === 'initialize') {
    const wanted = asString(params.protocolVersion);
    const version = MCP_PROTOCOL_VERSIONS.includes(wanted) ? wanted : MCP_PROTOCOL_VERSIONS[0];
    return { jsonrpc: '2.0', id, result: { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: MCP_SERVER_INFO, instructions: 'A GitHub-shaped forge: repositories, issues and pull requests.' } };
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled' || isNotification) return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: MCP_TOOL_LIST } };
  if (method === 'tools/call') {
    const tool = mcpTool(asString(params.name));
    if (tool === undefined) return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool ${asString(params.name)}` } };
    return { jsonrpc: '2.0', id, result: runTool(tool, asObject(params.arguments), store) };
  }
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ------------------------------------------------------------------------------------------------
// Server
// ------------------------------------------------------------------------------------------------

/** Decoded path segments of a request URL (invalid escapes are kept verbatim). */
function pathSegments(raw: string): string[] {
  const path = raw.split('?')[0] ?? '/';
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

function createStore(): Store {
  return {
    repos: [],
    nextRepoId: 1,
    nextIssueId: 1,
    nextCommentId: 1,
    nextPullId: 1,
    login: process.env.MAKEFUN_SHOP_LOGIN ?? 'octocat',
    defaultOwner: process.env.MAKEFUN_SHOP_LOGIN ?? 'octocat',
  };
}

export function createApp(): Server {
  const store = createStore();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://forge.local');
      const rawPath = url.pathname;
      const method = (req.method ?? 'GET').toUpperCase();
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`;

      if (rawPath === '/healthz' && (method === 'GET' || method === 'HEAD')) return deliver(res, ok({ ok: true }));

      const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
      const header = asString(req.headers.authorization);
      const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
      // git clients never send a bearer, so the smart-HTTP paths are the one unauthenticated surface.
      const isGitPath = /^\/[^/]+\/[^/]+\.git(\/|$)/.test(rawPath);
      const authorized = expected === '' || token === expected;

      if (isGitPath) {
        const gitReply = await gitRoute(req, method, url, store);
        return deliver(res, gitReply);
      }
      if (!authorized) return deliver(res, unauthorized());

      if (rawPath === '/api/v3' || rawPath.startsWith('/api/v3/')) {
        const segments = pathSegments(rawPath);
        const offset = segments[0] === 'api' && segments[1] === 'v3' ? 2 : 0;
        const rt: Routed = { req, store, method, segments: segments.slice(offset), query: url.searchParams, origin };
        return deliver(res, await restRoute(rt));
      }
      if (rawPath === '/api/graphql' || rawPath === '/graphql') return deliver(res, await graphqlRoute(req, store));
      if (rawPath === '/mcp' || rawPath === '/mcp/') return deliver(res, await mcpRoute(req, store));
      return deliver(res, notFound());
    } catch (err) {
      if (process.env.FORGE_DEBUG) process.stderr.write(`[err] ${String(err)}\n`);
      if (!res.headersSent) deliver(res, failed(500, 'Internal Server Error'));
      else res.end();
    }
  });

  return server;
}
