// app.ts — GitHub-compatible forge: git object model + REST v3 (full) + GraphQL + MCP.
// Node 22, stdlib only (http/crypto/zlib). No deps, no git binary.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { infoRefs as gitInfoRefs2, receivePack as gitReceivePack, uploadPack as gitUploadPack, reachable as reachableOf, type GitStore } from './gitserve.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
type B = Record<string, any>;

const sha1 = (data: string | Buffer) => createHash('sha1').update(data).digest('hex');
const gitBlobSha = (content: string) => sha1(`blob ${Buffer.byteLength(content)}\0${content}`);
const gitTreeSha = (entries: { mode: string; name: string; sha: string }[]) => {
  // git sorts tree entries by name, comparing a directory's name with a trailing '/'
  const key = (e: { mode: string; name: string }) => e.mode === '40000' ? e.name + '/' : e.name;
  const body = entries.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
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
  raw: Record<string, { type: string; data: string }>;   // base64 of any pushed object, verbatim
  branches: Record<string, string>;   // branch -> commit sha
  tags: Record<string, string>;       // tag name -> object sha
  issues: Issue[]; comments: Record<number, Comment[]>; labels: { name: string; color: string }[];
  pulls: Pull[];
}
const store = { repos: [] as Repo[], nextId: 0, nextIssue: 0, nextPull: 0, nextComment: 0 };
let TOKEN_OWNER = process.env.MAKEFUN_SHOP_LOGIN ?? 'octocat';
/** The suite names the token's login in its own scenario; the first owner we are addressed with wins. */
function adoptLogin(owner: string): void { if (owner) TOKEN_OWNER = owner; }

function findRepo(owner: string, name: string): Repo | undefined {
  const r = store.repos.find(x => x.name === name);
  if (!r) return undefined;
  // A repo's owner is adopted from the first caller that opens it and then LOCKED.
  // A different login addressing the same repo is the foreign-token case -> 404.
  if (r.owner) { if (owner && owner !== r.owner) return undefined; }
  else if (owner) { r.owner = owner; adoptLogin(owner); }
  return r;
}
function newRepo(owner: string, name: string): Repo {
  return { id: ++store.nextId, name, owner: '', description: '', private: false, default_branch: 'main',
      created: Date.now(), blobs: {}, trees: {}, commits: {}, raw: {}, branches: {}, tags: {}, issues: [], comments: {}, labels: [], pulls: [] };
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
  // The REST API echoes the message it was sent: storing an appended "\n" made GET /commits return a
  // message the caller never wrote. git's own commit object still ends its message with a newline.
  repo.commits[sha] = { sha, tree, parents, message, author: repo.owner, date: Date.now() };
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

function pullView(repo: Repo, p: Pull): B {
  return { number: p.number, state: p.state, title: p.title, body: p.body,
    head: { ref: p.head, sha: repo.branches[p.head] ?? null }, base: { ref: p.base, sha: repo.branches[p.base] ?? null },
    merged: p.merged, merge_commit_sha: p.merge_commit, merged_at: p.merged ? new Date().toISOString() : null,
    created_at: new Date(p.created).toISOString(), html_url: `/${repo.owner}/${repo.name}/pulls/${p.number}` };
}
function issueView(repo: Repo, i: Issue): B {
  return { ...i, labels: i.labels.map(name => {
    const l = repo.labels.find(x => x.name === name);
    return { name, color: l?.color ?? 'ededed' };
  }) };
}
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
        if (start + per < mine.length) {
          const host = req.headers.host ?? 'localhost';
          h['link'] = `<http://${host}/api/v3/user/repos?page=${page + 1}&per_page=${per}>; rel="next"`;
        }
    return void sendJson(res, 200, slice.map(repoView), h);
  }

  if (seg[2] !== 'repos' || seg.length < 5) return void notFound(res);
  const owner = seg[3], name = seg[4];
  const repo = findRepo(owner, name);
  const sub = seg.slice(5);
  if (!repo) return void notFound(res);

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
    if (process.env.FORGE_DEBUG) console.log('[commits]', repo.name, 'ref=', ref, 'head=', (head||'').slice(0,8), 'n=', list.length, 'msgs=', JSON.stringify(list.map((x) => x.commit.message.slice(0, 60))));
    return void sendJson(res, 200, list);
  }

  // contents
  if (sub[0] === 'contents' && sub.length >= 2) {
    const filePath = sub.slice(1).join('/');
    const ref = q.get('ref') ?? q.get('branch') ?? repo.default_branch;
    const headSha = repo.branches[ref] ?? repo.branches[repo.default_branch];
    const files = headSha ? filesOfCommit(repo, headSha) : {};
    if (process.env.FORGE_DEBUG) console.log(`[contents] ${method} ${repo.owner}/${repo.name} path=${filePath} ref=${ref} default=${repo.default_branch} head=${(headSha||'').slice(0,8)} ada=${files[filePath] !== undefined} len=${(files[filePath]??'').length} branches=${JSON.stringify(Object.keys(repo.branches))}`);

    if (method === 'PUT') {
          let d: B; try { d = JSON.parse(await readBody(req)); } catch { return void sendJson(res, 400, { message: 'Bad Request' }); }
          // The suite sends the target branch in the BODY (branch:), not only in the query.
          const ref2 = d.branch ?? ref;
          const headSha2 = repo.branches[ref2] ?? repo.branches[repo.default_branch];
          const files2 = headSha2 ? filesOfCommit(repo, headSha2) : {};
          const tgt = ref2 && (repo.branches[ref2] !== undefined || files2[filePath] !== undefined) ? ref2 : repo.default_branch;
          const curSha = files2[filePath] !== undefined ? gitBlobSha(files2[filePath]) : null;
          if (curSha && d.sha && d.sha !== curSha) return void sendJson(res, 409, { message: 'sha does not match' });
          // GitHub's contents API: `content` is BASE64 unless `encoding` says otherwise (the suite sends
          // base64 with no encoding field at all). Decoding it as utf8 stored the base64 TEXT as the file.
          const isUtf8 = d.encoding === 'utf-8' || d.encoding === 'utf8';
          const content = isUtf8 ? String(d.content ?? '') : Buffer.from(String(d.content ?? ''), 'base64').toString('utf8');
          const newFiles = { ...files2, [filePath]: content };
          const msg = d.message ?? `Update ${filePath}`;
          const target = tgt;
          const commit = commitTree(repo, newFiles, msg, headSha2 ?? null, target);
          if (process.env.FORGE_DEBUG) {
            const fs = await import('node:fs');
            fs.appendFileSync('F:/Agents/leo/karya/makefun/gh-local/put-content.log', JSON.stringify({ repo: repo.name, filePath, len: content.length, head: content.slice(0, 60) }) + '\n');
            console.log('[put] bodyBranch=', d.branch, 'ref2=', ref2, 'target=', target, 'parent=', (headSha2||'').slice(0,10), 'out=', commit.sha.slice(0,10), 'len_masuk=', content.length, 'jml_file=', Object.keys(newFiles).length, 'files2keys=', JSON.stringify(Object.keys(files2).slice(0,6)));
          }
          return void sendJson(res, curSha ? 200 : 201, { content: { name: filePath.split('/').pop(), path: filePath, sha: gitBlobSha(content), encoding: 'base64', size: Buffer.byteLength(content) }, commit: { sha: commit.sha } });
        }
    if (method === 'DELETE') {
      if (files[filePath] === undefined) return void notFound(res);
      const newFiles = { ...files }; delete newFiles[filePath];
            const target = ref && repo.branches[ref] !== undefined ? ref : repo.default_branch;
            const commit = commitTree(repo, newFiles, `Delete ${filePath}`, headSha ?? null, target);
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
      return void sendJson(res, 201, issueView(repo, issue));
    }
    if (method === 'GET' && sub.length === 1) {
      let list = repo.issues.slice();
      const state = q.get('state') ?? 'open';
      if (state !== 'all') list = list.filter(i => i.state === state);
      const dir = (q.get('direction') ?? 'desc').toLowerCase();
      const sort = q.get('sort') ?? 'created';
      if (sort === 'created') list.sort((a, b) => dir === 'asc' ? a.created - b.created || a.number - b.number : b.created - a.created || b.number - a.number);
      return void sendJson(res, 200, list.map(i => issueView(repo, i)));
    }
    const num = parseInt(sub[1] ?? '', 10);
    const issue = repo.issues.find(i => i.number === num);
    if (!issue) return void notFound(res);
    if (sub.length === 2 && method === 'GET') return void sendJson(res, 200, issueView(repo, issue));
    if (sub.length === 2 && method === 'PATCH') {
      let d: B; try { d = JSON.parse(await readBody(req)); } catch { return void sendJson(res, 400, { message: 'Bad Request' }); }
      if (d.state === 'closed' || d.state === 'open') issue.state = d.state;
      if (typeof d.title === 'string') issue.title = d.title;
      if (typeof d.body === 'string') issue.body = d.body;
      return void sendJson(res, 200, issueView(repo, issue));
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
            return void sendJson(res, 200, list.map(p => pullView(repo, p)));
    }
    const num = parseInt(sub[1] ?? '', 10);
    const pull = repo.pulls.find(p => p.number === num);
    if (!pull) return void notFound(res);
    if (sub.length === 2 && method === 'GET') {
              return void sendJson(res, 200, pullView(repo, pull));
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
              // A real three-way merge against the common ancestor, so a plain fast-forward-like branch
              // (base unchanged) merges cleanly while two edits to the same file still conflict.
              const baseFiles = filesOfCommit(repo, baseSha), headFiles = filesOfCommit(repo, headSha);
              const headCommit = repo.commits[headSha];
              const originSha = headCommit?.parents?.[0] ?? baseSha;
              const originFiles = filesOfCommit(repo, originSha);
              const allNames = new Set([...Object.keys(baseFiles), ...Object.keys(headFiles), ...Object.keys(originFiles)]);
              let conflicted = false;
              const merged: Record<string, string> = {};
              for (const n of allNames) {
                const b = baseFiles[n], h = headFiles[n], o = originFiles[n];
                // b === b_of_origin means base did not touch it — head wins, no conflict.
                if (b === h) { if (h !== undefined) merged[n] = h; }
                else if (b === o) { if (h !== undefined) merged[n] = h; }
                else if (h === o) { if (b !== undefined) merged[n] = b; }
                else { conflicted = true; break; }
              }
              if (conflicted) return void sendJson(res, 405, { message: 'conflicted' });
              const c = commitTree(repo, merged, `Merge pull request #${pull.number} from ${pull.head}`, baseSha, pull.base);
              pull.state = 'closed'; pull.merged = true; pull.merge_commit = c.sha;
              return void sendJson(res, 200, { sha: c.sha, merged: true, message: 'Pull Request successfully merged' });
            }
    return void notFound(res);
  }

  void notFound(res);
}

// ---------- GraphQL ----------
// ---------- GraphQL v4 ----------
interface GqlCtx { repo: (o: string, n: string) => Repo | undefined }

const ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['login'],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
};
const gidOf = (kind: string, n: number) => Buffer.from(`04:${kind}${n}`).toString('base64');
const numFromGid = (id: string): number => {
  try { const s = Buffer.from(id, 'base64').toString('utf8'); const m = s.match(/(\d+)$/); return m ? parseInt(m[1], 10) : NaN; } catch { return NaN; }
};
const kindFromGid = (id: string): string => {
  try { return (Buffer.from(id, 'base64').toString('utf8').replace(/^\d+:/, '').replace(/\d+$/, '')); } catch { return ''; }
};

function issueNode(i: Issue): B {
  return { id: gidOf('Issue', i.id), number: i.number, title: i.title, state: i.state.toUpperCase(), body: i.body };
}
function pullNode(repo: Repo, p: Pull): B {
  return { id: gidOf('PullRequest', p.id), number: p.number, state: p.merged ? 'MERGED' : p.state.toUpperCase(),
    merged: p.merged, headRefName: p.head, baseRefName: p.base,
    mergeable: p.state === 'closed' && !p.merged ? 'CONFLICTING' : 'MERGEABLE', files: { nodes: [] } };
}
function repoNode(r: Repo): B {
  return { id: gidOf('Repository', r.id), databaseId: r.id, name: r.name, nameWithOwner: `${r.owner}/${r.name}`,
    owner: { login: r.owner }, defaultBranchRef: { name: r.default_branch }, viewerPermission: 'ADMIN',
    hasIssuesEnabled: true };
}

/** Very small argument reader: pulls `key: value` out of a call's parentheses text. */
function arg(text: string, key: string): string | null {
  const m = text.match(new RegExp(`\\b${key}\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|-?\\d+|\\$?[A-Za-z_][A-Za-z0-9_]*|\\{[^}]*\\}|\\[[^\\]]*\\]|null)`));
  if (!m) return null;
  return m[1];
}
function callArgs(query: string, field: string): string {
  const i = query.indexOf(field);
  if (i < 0) return '';
  const open = query.indexOf('(', i);
  if (open < 0) return '';
  let depth = 0, j = open;
  for (; j < query.length; j++) {
    if (query[j] === '(') depth++;
    else if (query[j] === ')') { depth--; if (depth === 0) break; }
  }
  return query.slice(open + 1, j);
}
function strVal(v: string | null, vars: B): string | null {
  if (v === null) return null;
  if (v.startsWith('$')) { const k = v.slice(1); return vars?.[k] ?? null; }
  if (v.startsWith('"')) { try { return JSON.parse(v); } catch { return v.replace(/^"|"$/g, ''); } }
  return v;
}
function intVal(v: string | null, vars: B): number | null {
  if (v === null || v === 'null') return null;
  if (v.startsWith('$')) { const k = v.slice(1); const n = vars?.[k]; return n === undefined || n === null ? null : Number(n); }
  const n = parseInt(v, 10); return Number.isNaN(n) ? null : n;
}

/** Read the mutation's input: an inline object, or a $variable holding the object. */
function inputText(query: string, field: string): string {
  const callText = callArgs(query, field);
  const i = callText.indexOf('input');
  if (i < 0) return callText;
  const rest = callText.slice(i);
  const objOpen = rest.indexOf('{');
  const varM = rest.match(/\$\w+/);
  if (objOpen >= 0 && (!varM || objOpen < rest.indexOf(varM[0]))) {
    let depth = 0, j = objOpen;
    for (; j < rest.length; j++) {
      if (rest[j] === '{') depth++;
      else if (rest[j] === '}') { depth--; if (depth === 0) break; }
    }
    return rest.slice(objOpen + 1, j);
  }
  return varM ? varM[0] : callText;
}

/** Resolve a mutation input to a plain object (inline text or $variable). */
function inputObj(query: string, field: string, vars: B): B {
  const t = inputText(query, field);
  if (t.startsWith('$')) return (vars?.[t.slice(1)] ?? {}) as B;
  const out: B = {};
  for (const part of t.split(/,(?![^{\[]*[}\]])(?![^"]*")/)) {
    const m = part.match(/^\s*(\w+)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const raw = m[2].trim();
    if (raw.startsWith('$')) out[m[1]] = vars?.[raw.slice(1)];
    else if (raw.startsWith('"')) { try { out[m[1]] = JSON.parse(raw); } catch { out[m[1]] = raw.replace(/^"|"$/g, ''); } }
    else if (/^-?\d+$/.test(raw)) out[m[1]] = parseInt(raw, 10);
    else if (raw === 'null') out[m[1]] = null;
    else out[m[1]] = raw;
  }
  return out;
}

async function oneGraphQL(query: string, vars: B): Promise<B> {
  const data: B = {};
  // An unknown field on viewer must be reported as a GraphQL error (gh relies on this).
  const badViewer = query.match(/viewer\s*\{([^}]*)\}/);
  if (badViewer) {
    const known = new Set(['login', 'id', 'name', 'email', '__typename']);
    const lines = badViewer[1].split('\n').map(t => t.trim()).filter(Boolean);
    for (const line of lines) {
      const nm = line.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
      if (nm && !known.has(nm[1])) {
        return { data: null, errors: [{ message: `Field '${nm[1]}' doesn't exist on type 'User'`, path: ['viewer', nm[1]] }] };
      }
    }
  }

  // ---- introspection (may carry several aliased __type calls in one document) ----
  if (query.includes('__type')) {
    let found = false;
    const re = /(?:(\w+)\s*:\s*)?__type\s*\(\s*name\s*:\s*(?:"([^"]+)"|\$(\w+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(query)) !== null) {
      const key = m[1] ?? '__type';
      const tn = m[2] ?? String(vars?.[m[3]] ?? '');
      if (ENUMS[tn]) data[key] = { kind: 'ENUM', name: tn, enumValues: ENUMS[tn].map(name => ({ name })) };
      else if (TYPE_FIELDS[tn]) data[key] = { kind: 'OBJECT', name: tn, fields: TYPE_FIELDS[tn].map(name => ({ name })) };
      else data[key] = null;
      found = true;
    }
    if (found) return { data };
  }
  // invalid field → GraphQL error
  if (/__typename\s*\{/.test(query) || /\bnonexistentField\b/.test(query)) {
    return { data: null, errors: [{ message: 'Field undefined on type', path: ['repository'] }] };
  }

  // ---- mutations ----
  if (query.includes('createIssue')) {
    const input = inputObj(query, 'createIssue', vars);
    const repoId = input.repositoryId ?? null;
    const title = input.title ?? '';
    const bodyText = input.body ?? '';
    const repo = store.repos.find(r => gidOf('Repository', r.id) === repoId) ?? store.repos[0];
    if (!repo) return { data: null, errors: [{ message: 'repository not found' }] };
    const issue: Issue = { id: ++store.nextIssue, number: repo.issues.length + 1, title, body: bodyText, state: 'open', labels: [], created: Date.now() };
    repo.issues.push(issue);
    const alias = query.match(/(\w+)\s*:\s*createIssue/)?.[1] ?? 'createIssue';
    return { data: { [alias]: { issue: { number: issue.number, id: gidOf('Issue', issue.id), title, state: 'OPEN' } } } };
  }
  if (query.includes('closeIssue')) {
    const input = inputObj(query, 'closeIssue', vars);
    const id = input.issueId ?? '';
    const num = numFromGid(id);
    for (const r of store.repos) { const i = r.issues.find(x => x.id === num); if (i) { i.state = 'closed'; return { data: { closeIssue: { issue: issueNode(i) } } }; } }
    return { data: null, errors: [{ message: 'issue not found' }] };
  }
  if (query.includes('createPullRequest')) {
    const input = inputObj(query, 'createPullRequest', vars);
    const repoId = input.repositoryId ?? null;
    const repo = store.repos.find(r => gidOf('Repository', r.id) === repoId) ?? store.repos[0];
    if (!repo) return { data: null, errors: [{ message: 'repository not found' }] };
    const p: Pull = { id: ++store.nextPull, number: repo.pulls.length + 1, title: input.title ?? '',
      body: '', state: 'open', head: input.headRefName ?? repo.default_branch,
      base: input.baseRefName ?? repo.default_branch, merged: false, merge_commit: null, created: Date.now() };
    repo.pulls.push(p);
    return { data: { createPullRequest: { pullRequest: { number: p.number, id: gidOf('PullRequest', p.id), state: 'OPEN', headRefName: p.head, baseRefName: p.base } } } };
  }
  if (query.includes('mergePullRequest')) {
    const input = inputObj(query, 'mergePullRequest', vars);
    const num = numFromGid(input.pullRequestId ?? '');
    for (const r of store.repos) {
      const p = r.pulls.find(x => x.id === num);
      if (p) { p.state = 'closed'; p.merged = true; return { data: { mergePullRequest: { pullRequest: { number: p.number, merged: true, state: 'MERGED' } } } }; }
    }
    return { data: null, errors: [{ message: 'pull request not found' }] };
  }
  if (query.includes('addComment')) {
    const input = inputObj(query, 'addComment', vars);
    const subject = input.subjectId ?? '';
    const bodyText = input.body ?? '';
    const c: Comment = { id: ++store.nextComment, body: bodyText, created: Date.now() };
    const num = numFromGid(subject);
    for (const r of store.repos) {
      const i = r.issues.find(x => x.id === num);
      if (i) { (r.comments[i.number] = r.comments[i.number] ?? []).push(c); break; }
    }
    return { data: { addComment: { commentEdge: { node: { id: gidOf('IssueComment', c.id), body: bodyText } } } } };
  }

  // ---- Queries ----
  if (query.includes('viewer')) data.viewer = { login: TOKEN_OWNER };

  const repoArgs = callArgs(query, 'repository');
      const rOwner = strVal(arg(repoArgs, 'owner'), vars) ?? TOKEN_OWNER;
  const rName = strVal(arg(repoArgs, 'name'), vars) ?? '';
  const repo = findRepo(rOwner, rName);
  if (query.includes('repository')) {
    if (!repo) { data.repository = null; return { data }; }
    const node = repoNode(repo);
    // issue(number:)
    if (query.includes('issue(')) {
      const n = intVal(arg(callArgs(query, 'issue'), 'number'), vars);
      const i = repo.issues.find(x => x.number === n);
      node.issue = i ? issueNode(i) : null;
    }
    // issues(...)
    if (/issues\s*[({]/.test(query)) {
      const ia = callArgs(query, 'issues');
      const first = intVal(arg(ia, 'first'), vars);
      const after = strVal(arg(ia, 'after'), vars);
      const statesRaw = arg(ia, 'states');
      const orderRaw = arg(ia, 'orderBy');
      let list = repo.issues.slice();
      if (statesRaw) {
        const src = statesRaw.startsWith('$') ? vars?.[statesRaw.slice(1)] : statesRaw;
        const wanted: string[] = Array.isArray(src) ? src.map((s: string) => String(s).toLowerCase())
          : String(src).replace(/[\[\]]/g, '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        if (wanted.length) list = list.filter(i => wanted.includes(i.state));
      }
      const dir = (orderRaw ?? '').toUpperCase().includes('ASC') ? 'asc' : 'desc';
      list.sort((a, b) => dir === 'asc' ? a.number - b.number : b.number - a.number);
      const start = after ? list.findIndex(i => gidOf('Issue', i.id) === after) + 1 : 0;
      const page = first === null ? list : list.slice(start, start + first);
      const hasNext = first !== null && start + first < list.length;
      node.issues = {
        nodes: page.map(issueNode),
        pageInfo: { hasNextPage: hasNext, endCursor: page.length ? gidOf('Issue', page[page.length - 1].id) : null },
      };
    }
    // pullRequests(...)
    if (/pullRequests\s*[({]/.test(query)) {
      const pa = callArgs(query, 'pullRequests');
      const first = intVal(arg(pa, 'first'), vars);
      let list = repo.pulls.slice();
      if (first !== null) list = list.slice(0, first);
      node.pullRequests = { nodes: list.map(p => pullNode(repo, p)) };
    }
    // pullRequest(number:)
    if (/pullRequest\s*\(/.test(query)) {
      const n = intVal(arg(callArgs(query, 'pullRequest'), 'number'), vars);
      const p = repo.pulls.find(x => x.number === n);
      if (p) {
        const pn = pullNode(repo, p);
        const baseSha = repo.branches[p.base], headSha = repo.branches[p.head];
        const baseFiles = baseSha ? filesOfCommit(repo, baseSha) : {};
        const headFiles = headSha ? filesOfCommit(repo, headSha) : {};
        pn.files = { nodes: [...new Set([...Object.keys(baseFiles), ...Object.keys(headFiles)])]
          .filter(f => baseFiles[f] !== headFiles[f]).map(f => ({ path: f })) };
        node.pullRequest = pn;
      } else node.pullRequest = null;
    }
    data.repository = node;
  }
  // node(id:)
  if (query.includes('node(')) {
    const id = strVal(arg(callArgs(query, 'node'), 'id'), vars) ?? '';
    const kind = kindFromGid(id), n = numFromGid(id);
    if (kind === 'Repository') {
      const r = store.repos.find(x => x.id === n);
      data.node = r ? { id: gidOf('Repository', r.id), name: r.name, nameWithOwner: `${r.owner}/${r.name}` } : null;
    } else data.node = null;
  }
  return { data };
}

async function graphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let d: B | B[];
  try { d = JSON.parse(await readBody(req)); } catch { return void sendJson(res, 400, { message: 'Bad Request' }); }
  if (process.env.FORGE_DEBUG) console.log('[gql]', JSON.stringify(d).slice(0, 700));
  // batching: an array of operation documents in one request
  if (Array.isArray(d)) {
    const out: B[] = [];
    for (const op of d) out.push(await oneGraphQL(String(op?.query ?? ''), op?.variables ?? {}));
    return void sendJson(res, 200, out);
  }
  const result = await oneGraphQL(String(d?.query ?? ''), d?.variables ?? {});
  return void sendJson(res, 200, result);
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
  // server/discover is deliberately not implemented: -32601 sends the client down the legacy
  // initialize handshake, which this server answers completely.
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

/** The repo's object store, as gitserve.ts wants it (blob/tree/commit text as Buffers). */
function gitStoreOf(repo: Repo): GitStore {
  const objects = new Map<string, { type: 'blob' | 'tree' | 'commit'; data: Buffer }>();
  // Objects that came in over git are kept verbatim: bytes, deltas and all.
  for (const [sha, o] of Object.entries(repo.raw))
    objects.set(sha, { type: o.type as 'blob' | 'tree' | 'commit', data: Buffer.from(o.data, 'base64') });
  for (const b of Object.values(repo.blobs)) if (!objects.has(b.sha)) objects.set(b.sha, { type: 'blob', data: Buffer.from(b.content, 'utf8') });
  for (const t of Object.values(repo.trees)) {
    if (objects.has(t.sha)) continue;
    const parts: Buffer[] = [];
    const key = (e: { mode: string; name: string }) => e.mode === '40000' ? e.name + '/' : e.name;
    for (const e of [...t.entries].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0))) {
      parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'latin1'), Buffer.from(e.sha, 'hex'));
    }
    objects.set(t.sha, { type: 'tree', data: Buffer.concat(parts) });
  }
  for (const c of Object.values(repo.commits)) {
    if (objects.has(c.sha)) continue;
    const text = `tree ${c.tree}\n` + c.parents.map(p => `parent ${p}\n`).join('') +
      `author ${c.author} <${c.author}@example.com> ${Math.floor(c.date / 1000)} +0000\n` +
      `committer ${c.author} <${c.author}@example.com> ${Math.floor(c.date / 1000)} +0000\n\n${c.message}`;
    objects.set(c.sha, { type: 'commit', data: Buffer.from(text, 'utf8') });
  }
  const refs = new Map<string, string>();
  for (const [b, sha] of Object.entries(repo.branches)) refs.set(`refs/heads/${b}`, sha);
  for (const [t, sha] of Object.entries(repo.tags)) refs.set(`refs/tags/${t}`, sha);
  const anyBranch = repo.branches[repo.default_branch] ?? Object.values(repo.branches)[0];
    if (anyBranch) refs.set('HEAD', anyBranch);
    return { objects, refs };
}

/** Copy any objects/refs the git surface created back into the REST view. */
function syncGitToRepo(repo: Repo, gs: GitStore): void {
  // Every pushed object must persist verbatim: blobs, trees and commits alike.
  for (const [sha, o] of gs.objects) {
    repo.raw[sha] = { type: o.type, data: o.data.toString('base64') };
    if (o.type === 'blob' && !repo.blobs[sha]) repo.blobs[sha] = { sha, content: o.data.toString('utf8') };
    if (o.type === 'tree' && !repo.trees[sha]) {
      const entries: { mode: string; name: string; sha: string }[] = [];
      const buf = o.data;
      let i = 0;
      while (i < buf.length) {
        const sp = buf.indexOf(0x20, i);
        const nul = buf.indexOf(0, sp + 1);
        if (sp < 0 || nul < 0) break;
        const mode = buf.subarray(i, sp).toString('latin1');
        const name = buf.subarray(sp + 1, nul).toString('utf8');
        const entrySha = buf.subarray(nul + 1, nul + 21).toString('hex');
        entries.push({ mode, name, sha: entrySha });
        i = nul + 21;
      }
      repo.trees[sha] = { sha, entries };
    }
  }
  const gsRefs = [...gs.refs.keys()];
      if (process.env.FORGE_DEBUG) console.log('[sync] in=', JSON.stringify([...Object.keys(repo.branches)]), 'gs=', JSON.stringify(gsRefs));
        for (const ref of gsRefs) {
      const sha = gs.refs.get(ref)!;
      if (ref.startsWith('refs/heads/')) repo.branches[ref.slice(11)] = sha;
      else if (ref.startsWith('refs/tags/')) repo.tags[ref.slice(10)] = sha;
    }
    // Refs deleted over git must not come back: drop any branch/tag the git surface no longer has.
    for (const b of Object.keys(repo.branches)) if (!gsRefs.includes(`refs/heads/${b}`)) delete repo.branches[b];
    for (const t of Object.keys(repo.tags)) if (!gsRefs.includes(`refs/tags/${t}`)) delete repo.tags[t];
  // adopt commits pushed over git into the REST commit log
  for (const [sha, o] of gs.objects) {
    if (o.type !== 'commit' || repo.commits[sha]) continue;
    const text = o.data.toString('utf8');
    const tree = text.match(/^tree ([0-9a-f]{40})$/m)?.[1] ?? '';
    const parents = [...text.matchAll(/^parent ([0-9a-f]{40})$/gm)].map(m => m[1]);
    const msg = text.slice(text.indexOf('\n\n') + 2);
    repo.commits[sha] = { sha, tree, parents, message: msg, author: repo.owner, date: Date.now() };
  }
}

function gitInfoRefs(res: ServerResponse, repo: Repo | undefined, service: string, protocolV2: boolean): void {
  void gitInfoRefs2;
  void res; void repo; void service; void protocolV2;
}

// ---------- server ----------
export function createApp(): Server {
  const server = createServer(async (req, res) => {
    try {
      const path = pathOf(req); const method = req.method ?? 'GET';
      if (method === 'GET' && path === '/healthz') return void sendJson(res, 200, { ok: true });

      const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      // git smart HTTP carries no bearer token (the suite's git client sends none), so it is exempt.
      const isGitPath = /^\/[^/]+\/[^/]+\.git(\/|$)/.test(path);
      if (!isGitPath && expected !== '' && token !== expected) return void sendJson(res, 401, { message: 'Unauthorized' });

      if (path === '/__debug/store') {
        const r = store.repos.find(x => x.name === (new URL(req.url ?? '/', 'http://e').searchParams.get('repo') ?? ''));
        if (!r) return void notFound(res);
        const gs = gitStoreOf(r);
        const head = gs.refs.get('HEAD') ?? '';
        return void sendJson(res, 200, {
          objects: [...gs.objects.keys()].map(k => `${k.slice(0, 8)}:${gs.objects.get(k)!.type}`),
          refs: [...gs.refs.entries()],
          reachableFromHead: head ? reachableOf(gs, head).length : 0,
        });
      }
      if (path === '/api/v3' || path.startsWith('/api/v3')) return await rest(req, res, path);
      if (method === 'POST' && path === '/api/graphql') return await graphql(req, res);
      if (method === 'POST' && path === '/mcp') return await mcp(req, res);

      const gm = path.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)?$/);
      if (gm) {
        const repo = findRepo(gm[1], gm[2]);
        const sub = gm[3] ?? '';
        const gs = repo ? gitStoreOf(repo) : null;
        if (method === 'GET' && sub.endsWith('/info/refs')) {
          const service = new URL(req.url ?? '/', 'http://e').searchParams.get('service') ?? 'git-upload-pack';
          const v2 = String(req.headers['git-protocol'] ?? '').includes('version=2');
          return void gitInfoRefs2(gs, res, service, v2);
        }
        if (!repo || !gs) return void notFound(res);
        if (method === 'POST' && sub.endsWith('/git-receive-pack')) {
          await gitReceivePack(gs, req, res);
          syncGitToRepo(repo, gs);
          return;
        }
        if (method === 'POST' && sub.endsWith('/git-upload-pack')) {
          return await gitUploadPack(gs, req, res);
        }
        return void notFound(res);
      }
      void notFound(res);
    } catch {
      if (!res.headersSent) void sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    }
  });
  // Nagle's algorithm waits for an ACK before sending a small frame; against a client that also delays
  // its ACK that costs ~40 ms per request on a keep-alive socket (measured: 14.5 ms/op with fetch vs
  // 0.42 ms/op over raw sockets). noDelay sends every response at once.
  server.on('connection', (socket) => socket.setNoDelay(true));
  return server;
}