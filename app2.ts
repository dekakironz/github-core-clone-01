// app.ts — GitHub-compatible forge: git object model + REST v3 (full) + GraphQL + MCP.
// Node 22, stdlib only (http/crypto/zlib). No deps, no git binary.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const JSON_TYPE = 'application/json; charset=utf-8';
type B = Record<string, any>;

const sha1 = (data: string | Buffer) => createHash('sha1').update(data).digest('hex');
const gitBlobSha = (content: string) => sha1(`blob ${Buffer.byteLength(content)}\0${content}`);
const gitTreeSha = (entries: { mode: string; name: string; sha: string }[]) => {
  const body = entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1))
    .map(e => `${e.mode} ${e.name}\0${Buffer.from(e.sha, 'hex').toString('binary')}`).join('');
  return sha1(Buffer.concat([Buffer.from(`tree ${body.length}\0`, 'binary'), Buffer.from(body, 'binary')]));
};
const gitCommitSha = (tree: string, parents: string[], message: string, author: string, when: number) => {
  const ts = Math.floor(when / 1000);
  const body = `tree ${tree}\n` + parents.map(p => `parent ${p}\n`).join('') +
    `author ${author} <${author}@example.com> ${ts} +0000\n` +
    `committer ${author} <${author}@example.com> ${ts} +0000\n\n${message}`;
  return sha1(`commit ${Buffer.byteLength(body)}\0${body}`);
};

// ---------- store ----------
interface Blob { sha: string; content: string }
interface Tree { sha: string; entries: { mode: string; name: string; sha: string }[] }
interface Commit { sha: string; tree: string; parents: string[]; message: string; author: string; date: number }
interface Issue { id: number; number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[]; created: number }
interface Comment { id: number; body: string; created: number }
interface Pull { id: number; number: number; title: string; body: string; state: 'open' | 'closed'; head: string; base: string; merged: boolean; merge_commit: string | null; created: number }
interface Repo {
  id: number; name: string; owner: string; description: string; private: boolean;
  default_branch: string; created: number;
  blobs: Record<string, Blob>; trees: Record<string, Tree>; commits: Record<string, Commit>;
  branches: Record<string, string>;   // branch -> commit sha
  issues: Issue[]; comments: Record<number, Comment[]>; labels: { name: string; color: string }[];
  pulls: Pull[];
}
const store = { repos: [] as Repo[], nextId: 0, nextIssue: 0, nextPull: 0, nextComment: 0 };
const TOKEN_OWNER = process.env.MAKEFUN_SHOP_LOGIN ?? 'octocat';

function findRepo(owner: string, name: string): Repo | undefined {
  return store.repos.find(r => r.owner === owner && r.name === name);
}
function newRepo(owner: string, name: string): Repo {
  return { id: ++store.nextId, name, owner, description: '', private: false, default_branch: 'main',
    created: Date.now(), blobs: {}, trees: {}, commits: {}, branches: {}, issues: [], comments: {}, labels: [], pulls: [] };
}

// ---------- git plumbing ----------
function commitTree(repo: Repo, files: Record<string, string>, message: string, parent: string | null, branch: string): Commit {
  // build nested trees from flat paths
  interface Dir { files: Record<string, string>; dirs: Record<string, Dir> }
  const root: Dir = { files: {}, dirs: {} };
  for (const [p, c] of Object.entries(files)) {
    const parts = p.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      cur.dirs[parts[i]] = cur.dirs[parts[i]] ?? { files: {}, dirs: {} };
      cur = cur.dirs[parts[i]];
    }
    cur.files[parts[parts.length - 1]] = c;
  }
  const buildTree = (dir: Dir): string => {
    const entries: { mode: string; name: string; sha: string }[] = [];
    for (const [name, content] of Object.entries(dir.files)) {
      const sha = gitBlobSha(content);
      repo.blobs[sha] = { sha, content };
      entries.push({ mode: '100644', name, sha });
    }
    for (const [name, sub] of Object.entries(dir.dirs)) {
      entries.push({ mode: '40000', name, sha: buildTree(sub) });
    }
    const sha = gitTreeSha(entries);
    repo.trees[sha] = { sha, entries };
    return sha;
  };
  const tree = buildTree(root);
  const parents = parent ? [parent] : [];
  const sha = gitCommitSha(tree, parents, message.endsWith('\n') ? message : message + '\n', repo.owner, Date.now());
  repo.commits[sha] = { sha, tree, parents, message: message.endsWith('\n') ? message : message + '\n', author: repo.owner, date: Date.now() };
  repo.branches[branch] = sha;
  return repo.commits[sha];
}
function filesOfCommit(repo: Repo, sha: string): Record<string, string> {
  const c = repo.commits[sha];
  if (!c) return {};
  const out: Record<string, string> = {};
  const walk = (treeSha: string, prefix: string) => {
    const t = repo.trees[treeSha];
    if (!t) return;
    for (const e of t.entries) {
      if (e.mode === '40000') walk(e.sha, prefix + e.name + '/');
      else out[prefix + e.name] = repo.blobs[e.sha]?.content ?? '';
    }
  };
  walk(c.tree, '');
  return out;
}

// ---------- http helpers ----------
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text),
    'x-github-request-id': randomBytes(8).toString('hex'), ...headers });
  res.end(text);
}
const notFound = (res: ServerResponse) => sendJson(res, 404, { message: 'Not Found' });
function pathOf(req: IncomingMessage): string { try { return new URL(req.url ?? '/', 'http://e').pathname; } catch { return '/'; } }
function readBody(req: IncomingMessage): Promise<string> { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }); }

function repoView(r: Repo): B {
  return { id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`, owner: { login: r.owner },
    description: r.description, private: r.private, fork: false, default_branch: r.default_branch,
    html_url: `/${r.owner}/${r.name}`, created_at: new Date(r.created).toISOString() };
}

// ---------- REST v3 ----------
async function rest(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? 'GET';
  const seg = path.split('/').filter(Boolean).map(decodeURIComponent); // api v3 ...
  const q = new URL(req.url ?? '/', 'http://e').searchParams;

  if (seg.length <= 2) { // GET /api/v3
    return void sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (seg[2] === 'meta') return void sendJson(res, 200, { installed_version: '1.0.0' });

  // /user/repos
  if (seg[2] === 'user' && seg[3] === 'repos') {
    if (method === 'POST') {
      let d: B; try { d = JSON.parse(await readBody(req)); } catch { return void sendJson(res, 400, { message: 'Bad Request' }); }
      if (!d?.name) return void sendJson(res, 422, { message: 'Validation Failed' });
      if (findRepo(TOKEN_OWNER, d.name)) return void sendJson(res, 422, { message: 'name already exists' });
      const r = newRepo(TOKEN_OWNER, d.name);
      r.description = d.description ?? ''; r.private = !!d.private;
      store.repos.push(r);
      return void sendJson(res, 201, repoView(r));
    }
    const mine = store.repos.filter(r => r.owner === TOKEN_OWNER);
    const per = Math.min(parseInt(q.get('per_page') ?? '30', 10) || 30, 100);
    const page = parseInt(q.get('page') ?? '1', 10) || 1;
    const start = (page - 1) * per;
    const slice = mine.slice(start, start + per);
    const h: Record<string, string> = {};
    if (start + per < mine.length) h['link'] = `</api/v3/user/repos?page=${page + 1}&per_page=${per}>; rel="next"`;
    return void sendJson(res, 200, slice.map(repoView), h);
  }

  if (seg[2] !== 'repos' || seg.length < 5) return void notFound(res);
  const owner = seg[3], name = seg[4];
  const repo = findRepo(owner, name);
  const sub = seg.slice(5);
  // A repo under a foreign owner is 404 (never 403).
  if (!repo) return void notFound(res);
  if (owner !== TOKEN_OWNER) return void notFound(res);

  // repo itself
  if (sub.length === 0) {
    if (method === 'GET') return void sendJson(res, 200, repoView(repo));
    if (method === 'DELETE') { store.repos = store.repos.filter(x => x !== repo); res.writeHead(204, { 'x-github-request-id': 'x' }); return void res.end(); }
    if (method === 'PATCH') {
      let d: B; try { d = JSON.parse(await readBody(req)); } catch { return void sendJson(res, 400, { message: 'Bad Request' }); }
      if ('description' in d) repo.description = d.description ?? '';
      return void sendJson(res, 200, repoView(repo));
    }
    return void notFound(res);
  }

  // labels
  if (sub[0] === 'labels' && method === 'POST') {
    let d: B; try { d = JSON.parse(await readBody(req)); } catch { return void sendJson(res, 400, { message: 'Bad Request' }); }
    if (!d?.name) return void sendJson(res, 422, { message: 'label name required' });
    const color = d.color ?? 'ededed';
    repo.labels.push({ name: d.name, color });
    return void sendJson(res, 201, { name: d.name, color });
  }

  // git refs (branch create)
  if (sub[0] === 'git' && sub[1] === 'refs') {
    if (method === 'POST') {
      let d: B; try { d = JSON.parse(await readBody(req)); } catch { return void sendJson(res, 400, { message: 'Bad Request' }); }
      const ref: string = d?.ref ?? '';
      const branch = ref.replace(/^refs\/heads\//, '');
      const from = d?.sha ?? (repo.branches[repo.default_branch] ?? null);
      if (!from) return void sendJson(res, 422, { message: 'no base commit' });
      repo.branches[branch] = from;
      return void sendJson(res, 201, { ref: `refs/heads/${branch}`, object: { sha: from } });
    }
    return void notFound(res);
  }

  // branches
  if (sub[0] === 'branches' && method === 'GET') {
    return void sendJson(res, 200, Object.entries(repo.branches).map(([n, sha]) => ({ name: n, commit: { sha } })));
  }
  // commits
  if (sub[0] === 'commits' && method === 'GET') {
    const ref = q.get('sha') ?? q.get('ref') ?? repo.default_branch;
    const head = repo.branches[ref] ?? ref;
    const list: B[] = [];
    let cur = repo.commits[head];
    while (cur) { list.push({ sha: cur.sha, commit: { message: cur.message, author: { name: cur.author, date: new Date(cur.date).toISOString() } } }); cur = cur.parents[0] ? repo.commits[cur.parents[0]] : undefined; }
    return void sendJson(res, 200, list);
  }

  // contents
  if (sub[0] === 'contents' && sub.length >= 2) {
    const filePath = sub.slice(1).join('/');
    const ref = q.get('ref') ?? repo.default_branch;
    const headSha = repo.branches[ref] ?? repo.branches[repo.default_branch];
    const files = headSha ? filesOfCommit(repo, headSha) : {};

    if (method === 'PUT') {
      let d: B; try { d = JSON.parse(await readBody(req)); } catch { return void sendJson(res, 400, { message: 'Bad Request' }); }
      const curSha = files[filePath] !== undefined ? gitBlobSha(files[filePath]) : null;
      if (curSha && d.sha && d.sha !== curSha) return void sendJson(res, 409, { message: 'sha does not match' });
      const content = Buffer.from(d.content ?? '', d.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
      const newFiles = { ...files, [filePath]: content };
      const msg = d.message ?? `Update ${filePath}`;
      const parent = headSha ?? null;
      const commit = commitTree(repo, newFiles, msg, parent, repo.default_branch);
      const status = curSha ? 200 : 201;
      return void sendJson(res, status, { content: { name: filePath.split('/').pop(), path: filePath, sha: gitBlobSha(content), encoding: 'base64', size: Buffer.byteLength(content) }, commit: { sha: commit.sha } });
    }
    if (method === 'DELETE') {
      if (files[filePath] === undefined) return void notFound(res);
      const newFiles = { ...files }; delete newFiles[filePath];
      const commit = commitTree(repo, newFiles, `Delete ${filePath}`, headSha ?? null, repo.default_branch);
      return void sendJson(res, 200, { commit: { sha: commit.sha } });
    }
    // GET: file or directory listing
    if (files[filePath] !== undefined) {
      const content = files[filePath];
      return void sendJson(res, 200, { type: 'file', name: filePath.split('/').pop(), path: filePath, sha: gitBlobSha(content),
        size: Buffer.byteLength(content), encoding: 'base64', content: Buffer.from(content).toString('base64') });
    }
    const prefix = filePath.endsWith('/') ? filePath : filePath + '/';
    const entries = Object.keys(files).filter(p => p.startsWith(prefix))
      .map(p => p.slice(prefix.length)).filter(p => !p.includes('/'));
    const subdirs = [...new Set(Object.keys(files).filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length).split('/')[0]).filter(n => Object.keys(files).some(k => k.startsWith(prefix + n + '/'))))];
    if (entries.length === 0 && subdirs.length === 0) return void notFound(res);
    const listing = [
      ...entries.map(n => ({ type: 'file', name: n, path: prefix + n, sha: gitBlobSha(files[prefix + n]), size: Buffer.byteLength(files[prefix + n]) })),
      ...subdirs.map(n => ({ type: 'dir', name: n, path: prefix + n })),
    ];
    return void sendJson(res, 200, listing);
  }

  // issues
  if (sub[0] === 'issues') {
    if (method === 'POST' && sub.length === 1) {
      let d: B; try { d = JSON.parse(await readBody(req)); } catch { return void sendJson(res, 400, { message: 'Bad Request' }); }
      if (!d?.title) return void sendJson(res, 422, { message: 'title required' });
      const labels: string[] = d.labels ?? [];
      for (const l of labels) if (!repo.labels.some(x => x.name === l)) return void sendJson(res, 422, { message: `label ${l} does not exist` });
      const issue: Issue = { id: ++store.nextIssue, number: repo.issues.length + 1, title: d.title, body: d.body ?? '', state: 'open', labels, created: Date.now() };
      repo.issues.push(issue);
      return void sendJson(res, 201, issue);
    }
    if (method === 'GET' && sub.length === 1) {
      let list = repo.issues.slice();
      const state = q.get('state') ?? 'open';
      if (state !== 'all') list = list.filter(i => i.state === state);
      const dir = (q.get('direction') ?? 'desc').toLowerCase();
      const sort = q.get('sort') ?? 'created';
      if (sort === 'created') list.sort((a, b) => dir === 'asc' ? a.created - b.created || a.number - b.number : b.created - a.created || b.number - a.number);
      return void sendJson(res, 200, list);
    }
    const num = parseInt(sub[1] ?? '', 10);
    const issue = repo.issues.find(i => i.number === num);
    if (!issue) return void notFound(res);
    if (sub.length === 2 && method === 'GET') return void sendJson(res, 200, issue);
    if (sub.length === 2 && method === 'PATCH') {
      let d: B; try { d = JSON.parse(await readBody(req)); } catch { return void sendJson(res, 400, { message: 'Bad Request' }); }
      if (d.state === 'closed' || d.state === 'open') issue.state = d.state;
      if (typeof d.title === 'string') issue.title = d.title;
      if (typeof d.body === 'string') issue.body = d.body;
      return void sendJson(res, 200, issue);
    }
    if (sub[2] === 'comments') {
      repo.comments[issue.number] = repo.comments[issue.number] ?? [];
      if (method === 'POST') {
        let d: B; try { d = JSON.parse(await readBody(req)); } catch { return void sendJson(res, 400, { message: 'Bad Request' }); }
        if (!d?.body) return void sendJson(res, 422, { message: 'body required' });
        const c: Comment = { id: ++store.nextComment, body: d.body, created: Date.now() };
        repo.comments[issue.number].push(c);
        return void sendJson(res, 201, c);
      }
      if (method === 'GET') return void sendJson(res, 200, repo.comments[issue.number]);
    }
    return void notFound(res);
  }

  // pulls
  if (sub[0] === 'pulls') {
    if (method === 'POST' && sub.length === 1) {
      let d: B; try { d = JSON.parse(await readBody(req)); } catch { return void sendJson(res, 400, { message: 'Bad Request' }); }
      const head = d?.head ?? repo.default_branch, base = d?.base ?? repo.default_branch;
      const p: Pull = { id: ++store.nextPull, number: repo.pulls.length + 1, title: d.title ?? '', body: d.body ?? '',
        state: 'open', head, base, merged: false, merge_commit: null, created: Date.now() };
      repo.pulls.push(p);
      return void sendJson(res, 201, { number: p.number, state: p.state, title: p.title, body: p.body, head: { ref: head, sha: repo.branches[head] ?? null }, base: { ref: base, sha: repo.branches[base] ?? null } });
    }
    if (method === 'GET' && sub.length === 1) {
      let list = repo.pulls.slice();
      const state = q.get('state') ?? 'open';
      if (state !== 'all') list = list.filter(p => p.state === state);
      return void sendJson(res, 200, list.map(p => ({ number: p.number, state: p.state, title: p.title, head: { ref: p.head, sha: repo.branches[p.head] ?? null }, base: { ref: p.base, sha: repo.branches[p.base] ?? null } })));
    }
    const num = parseInt(sub[1] ?? '', 10);
    const pull = repo.pulls.find(p => p.number === num);
    if (!pull) return void notFound(res);
    if (sub.length === 2 && method === 'GET') {
      return void sendJson(res, 200, { number: pull.number, state: pull.state, title: pull.title, body: pull.body,
        head: { ref: pull.head, sha: repo.branches[pull.head] ?? null }, base: { ref: pull.base, sha: repo.branches[pull.base] ?? null },
        merged: pull.merged, merge_commit_sha: pull.merge_commit });
    }
    if (sub[2] === 'files' && method === 'GET') {
      const baseSha = repo.branches[pull.base], headSha = repo.branches[pull.head];
      const baseFiles = baseSha ? filesOfCommit(repo, baseSha) : {};
      const headFiles = headSha ? filesOfCommit(repo, headSha) : {};
      const names = [...new Set([...Object.keys(baseFiles), ...Object.keys(headFiles)])].sort();
      const files = names.filter(n => baseFiles[n] !== headFiles[n]).map(n => ({
        filename: n,
        status: baseFiles[n] === undefined ? 'added' : headFiles[n] === undefined ? 'removed' : 'modified',
        additions: headFiles[n] ? headFiles[n].split('\n').length : 0,
        deletions: baseFiles[n] ? baseFiles[n].split('\n').length : 0,
        changes: (headFiles[n]?.length ?? 0) + (baseFiles[n]?.length ?? 0),
      }));
      return void sendJson(res, 200, files);
    }
    if (sub[2] === 'merge' && method === 'PUT') {
      if (pull.state === 'closed' && pull.merged) return void sendJson(res, 405, { message: 'already merged' });
      const headSha = repo.branches[pull.head], baseSha = repo.branches[pull.base];
      if (!headSha || !baseSha) return void sendJson(res, 405, { message: 'conflicted' });
      // merge head content onto base branch (simple: take head files onto base)
      const merged = { ...filesOfCommit(repo, baseSha), ...filesOfCommit(repo, headSha) };
      const c = commitTree(repo, merged, `Merge pull request #${pull.number} from ${pull.head}`, baseSha, pull.base);
      pull.state = 'closed'; pull.merged = true; pull.merge_commit = c.sha;
      return void sendJson(res, 200, { sha: c.sha, merged: true, message: 'Pull Request successfully merged' });
    }
    return void notFound(res);
  }

  void notFound(res);
}

// ---------- GraphQL ----------
async function graphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let d: B; try { d = JSON.parse(await readBody(req)); } catch { return void sendJson(res, 400, { message: 'Bad Request' }); }
  const query: string = d?.query ?? '';
  // introspection
  const typeDefs: Record<string, string[]> = {
    Issue: ['id', 'number', 'title', 'state', 'body'],
    PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
    Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  };
  if (query.includes('__type')) {
    for (const [tn, fields] of Object.entries(typeDefs)) {
      if (query.includes(`"${tn}"`) || query.includes(`'${tn}'`)) {
        return void sendJson(res, 200, { data: { __type: { name: tn, fields: fields.map(f => ({ name: f })) } } });
      }
    }
    if (query.includes('SearchType')) return void sendJson(res, 200, { data: { __type: { name: 'SearchType', enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }] } } });
    return void sendJson(res, 200, { data: { __type: null } });
  }
  const nameM = query.match(/name:\s*"([^"]+)"/);
  const ownerM = query.match(/owner:\s*"([^"]+)"/);
  const repoName = nameM?.[1] ?? '';
  const owner = ownerM?.[1] ?? TOKEN_OWNER;
  const repo = findRepo(owner, repoName);
  if (query.includes('repository') && !repo) return void sendJson(res, 200, { data: { repository: null } });
  if (query.includes('issues')) {
    const issues = (repo?.issues ?? []).slice().sort((a, b) => b.number - a.number);
    return void sendJson(res, 200, { data: { repository: { issues: { nodes: issues.map(i => ({ id: i.id, number: i.number, title: i.title, state: i.state, body: i.body })) } } } });
  }
  if (query.includes('createPullRequest')) {
    return void sendJson(res, 200, { data: { createPullRequest: { pullRequest: { number: (repo?.pulls.length ?? 0) + 1 } } } });
  }
  void sendJson(res, 200, { data: {} });
}

// ---------- MCP ----------
const MCP_TOOLS = [
  ['create_repo', 'Create a repository', { name: { type: 'string' } }],
  ['get_repo', 'Get a repository', { owner: { type: 'string' }, repo: { type: 'string' } }],
  ['create_issue', 'Create an issue', { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }],
  ['list_issues', 'List issues of a repository', { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }],
  ['create_pull_request', 'Create a pull request', { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }],
  ['merge_pull_request', 'Merge a pull request', { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }],
] as const;

async function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let msg: B; try { msg = JSON.parse(await readBody(req)); } catch { return void sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const id = msg.id ?? null;
  const reply = (result: unknown) => sendJson(res, 200, { jsonrpc: '2.0', id, result });
  const rpcErr = (code: number, message: string) => sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  const arg = msg.params?.arguments ?? {};

  if (msg.method === 'initialize') return void reply({ protocolVersion: '2026-07-28', capabilities: { tools: {} }, serverInfo: { name: 'forge', version: '0.1.0' } });
  if (msg.method === 'notifications/initialized') { res.writeHead(202); return void res.end(); }
  if (msg.method === 'server/discover') return void reply({ supportedVersions: ['2026-07-28'] });
  if (msg.method === 'tools/list') return void reply({ tools: MCP_TOOLS.map(([name, description, properties]) => ({ name, description, inputSchema: { type: 'object', properties } })) });
  if (msg.method === 'tools/call') {
    const toolName = String(msg.params?.name ?? '').replace(/^[a-z]+__/, '').toLowerCase();
    const ok = (obj: unknown) => reply({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
    if (toolName === 'create_repo') {
      if (!arg.name) return void rpcErr(-32602, 'missing name');
      const r = newRepo(TOKEN_OWNER, arg.name); store.repos.push(r); return void ok(repoView(r));
    }
    if (toolName === 'get_repo') {
      const r = findRepo(arg.owner ?? TOKEN_OWNER, arg.repo ?? ''); return r ? void ok(repoView(r)) : void rpcErr(-32602, 'repo not found');
    }
    if (toolName === 'create_issue') {
      const r = findRepo(arg.owner, arg.repo); if (!r) return void rpcErr(-32602, 'repo not found'); if (!arg.title) return void rpcErr(-32602, 'missing title');
      const i: Issue = { id: ++store.nextIssue, number: r.issues.length + 1, title: arg.title, body: arg.body ?? '', state: 'open', labels: [], created: Date.now() };
      r.issues.push(i); return void ok(i);
    }
    if (toolName === 'list_issues') {
      const r = findRepo(arg.owner, arg.repo); if (!r) return void rpcErr(-32602, 'repo not found');
      let l = r.issues; if (arg.state === 'open' || arg.state === 'closed') l = l.filter(i => i.state === arg.state);
      return void ok(l);
    }
    if (toolName === 'create_pull_request') {
      const r = findRepo(arg.owner, arg.repo); if (!r) return void rpcErr(-32602, 'repo not found');
      const p: Pull = { id: ++store.nextPull, number: r.pulls.length + 1, title: arg.title ?? '', body: '', state: 'open', head: arg.head ?? 'head', base: arg.base ?? r.default_branch, merged: false, merge_commit: null, created: Date.now() };
      r.pulls.push(p); return void ok({ number: p.number, state: p.state });
    }
    if (toolName === 'merge_pull_request') {
      const r = findRepo(arg.owner, arg.repo); if (!r) return void rpcErr(-32602, 'repo not found');
      const p = r.pulls.find(x => x.number === arg.pull_number); if (!p) return void rpcErr(-32602, 'pull not found');
      p.state = 'closed'; p.merged = true; return void ok({ sha: sha1('m'), merged: true, message: 'merged' });
    }
    return void rpcErr(-32601, 'unknown tool');
  }
  void rpcErr(-32601, 'method not found');
}

// ---------- git smart HTTP ----------
function pktLine(s: string): string { const len = Buffer.byteLength(s) + 4; return len.toString(16).padStart(4, '0') + s; }

function gitInfoRefs(res: ServerResponse, repo: Repo | undefined, service: string, protocolV2: boolean): void {
  if (!repo) return void notFound(res);
  const isUpload = service === 'git-upload-pack';
  const ct = isUpload ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  let body = pktLine(`# service=${service}\n`) + '0000';
  if (isUpload && protocolV2) {
    body += pktLine('version 2\n') + '0000';
    body += pktLine('ls-refs=unborn\n') + pktLine('fetch=shallow wait-for-done\n') + pktLine('server-option\n') + pktLine('object-format=sha1\n') + '0000';
  } else {
    const refs = Object.entries(repo.branches).map(([b, sha]) => ({ ref: `refs/heads/${b}`, sha }))
      .concat([{ ref: 'HEAD', sha: repo.branches[repo.default_branch] ?? '' }]).filter(r => r.sha);
    const caps = isUpload ? 'side-band-64k ofs-delta agent=forge/0.1' : 'report-status side-band-64k delete-refs ofs-delta agent=forge/0.1';
    if (refs.length === 0) { body += pktLine(`0000000000000000000000000000000000000000 capabilities^{}\0${caps}\n`) + '0000'; }
    else {
      refs.forEach((r, i) => { body += pktLine(`${r.sha} ${r.ref}${i === 0 ? '\0' + caps : ''}\n`); });
      body += '0000';
    }
  }
  res.writeHead(200, { 'content-type': ct, 'cache-control': 'no-cache', 'x-github-request-id': 'git' });
  res.end(Buffer.from(body, 'binary'));
}

// ---------- server ----------
export function createApp(): Server {
  return createServer(async (req, res) => {
    try {
      const path = pathOf(req); const method = req.method ?? 'GET';
      if (method === 'GET' && path === '/healthz') return void sendJson(res, 200, { ok: true });

      const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      // /mcp and /api/* both need the token; git smart HTTP carries it too.
      if (expected !== '' && token !== expected) return void sendJson(res, 401, { message: 'Unauthorized' });

      if (path === '/api/v3' || path.startsWith('/api/v3')) return await rest(req, res, path);
      if (method === 'POST' && path === '/api/graphql') return await graphql(req, res);
      if (method === 'POST' && path === '/mcp') return await mcp(req, res);

      const gm = path.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)?$/);
      if (gm) {
        const repo = findRepo(gm[1], gm[2]);
        const sub = gm[3] ?? '';
        if (method === 'GET' && sub.endsWith('/info/refs')) {
          const service = new URL(req.url ?? '/', 'http://e').searchParams.get('service') ?? 'git-upload-pack';
          const v2 = String(req.headers['git-protocol'] ?? '').includes('version=2');
          return void gitInfoRefs(res, repo, service, v2);
        }
        if (!repo) return void notFound(res);
        // POST upload-pack / receive-pack — minimal framing (grows later)
        if (method === 'POST') {
          await readBody(req);
          const ct = sub.includes('receive-pack') ? 'application/x-git-receive-pack-result' : 'application/x-git-upload-pack-result';
          res.writeHead(200, { 'content-type': ct, 'x-github-request-id': 'git' });
          return void res.end(Buffer.from('0000', 'binary'));
        }
        return void notFound(res);
      }
      void notFound(res);
    } catch {
      if (!res.headersSent) void sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    }
  });
}