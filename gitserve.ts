// gitserve.ts — git smart HTTP: receive-pack (v0 push) + upload-pack (v2 ls-refs/fetch).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { decodePack, encodePack, pkt, readPkt, FLUSH, type ObjType } from './pack.ts';

export interface GitObj { type: ObjType; data: Buffer }
export interface GitStore {
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
}
export const shaOfObj = (o: GitObj) => createHash('sha1').update(`${o.type} ${o.data.length}\0`).update(o.data).digest('hex');

export function storeObj(store: GitStore, o: GitObj): string {
  const sha = shaOfObj(o);
  store.objects.set(sha, o);
  return sha;
}
/** All object shas reachable from a commit (commit → trees → blobs), depth-limited for safety. */
/** Reachable via trees only (used by shallow fetches): the commit's tree hierarchy, no parent commits. */
export function treeClosure(store: GitStore, commitSha: string): string[] {
  const seen = new Set<string>();
  const stack: string[] = [];
  const commit = store.objects.get(commitSha);
  const treeSha = commit?.type === 'commit' ? commit.data.toString('utf8').match(/^tree ([0-9a-f]{40})$/m)?.[1] : undefined;
  if (treeSha) stack.push(treeSha);
  while (stack.length) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    const o = store.objects.get(sha);
    if (!o) continue;
    seen.add(sha);
    if (o.type === 'tree') {
      const buf = o.data;
      let i = 0;
      while (i < buf.length) {
        const sp = buf.indexOf(0x20, i);
        const nul = buf.indexOf(0, sp + 1);
        if (sp < 0 || nul < 0) break;
        const sub = buf.subarray(nul + 1, nul + 21).toString('hex');
        stack.push(sub);
        i = nul + 21;
      }
    }
  }
  return [...seen];
}

export function reachable(store: GitStore, commitSha: string, limit = 200_000): string[] {
  const seen = new Set<string>();
  const stack = [commitSha];
  while (stack.length && seen.size < limit) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    const o = store.objects.get(sha);
    if (!o) continue;
    seen.add(sha);
    if (o.type === 'commit') {
      const text = o.data.toString('latin1');
      for (const m of text.matchAll(/^(?:tree|parent) ([0-9a-f]{40})$/gm)) stack.push(m[1]);
    } else if (o.type === 'tree') {
      const buf = o.data;
      let i = 0;
      while (i < buf.length) {
        const sp = buf.indexOf(0x20, i);
        const nul = buf.indexOf(0, sp + 1);
        if (sp < 0 || nul < 0) break;
        const sha = buf.subarray(nul + 1, nul + 21).toString('hex');
        stack.push(sha);
        i = nul + 21;
      }
    }
  }
  return [...seen];
}

function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise(r => { const c: Buffer[] = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
}
function sendRaw(res: ServerResponse, status: number, type: string, body: Buffer) {
  res.writeHead(status, { 'content-type': type, 'content-length': body.length, 'x-github-request-id': 'git' });
  res.end(body);
}

/** GET /{o}/{r}.git/info/refs?service=... */
export function infoRefs(store: GitStore | null, res: ServerResponse, service: string, protocolV2: boolean): void {
  if (!store) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"message":"Not Found"}'); return; }
  const isUpload = service === 'git-upload-pack';
  const ct = isUpload ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  if (isUpload && protocolV2) {
    parts.push(pkt('version 2\n'), pkt('agent=forge/0.1\n'), pkt('ls-refs=unborn\n'),
      pkt('fetch=shallow wait-for-done\n'), pkt('server-option\n'), pkt('object-format=sha1\n'), FLUSH);
  } else {
    const refs = [...store.refs.entries()].sort(([a], [b]) => (a === 'HEAD' ? -1 : b === 'HEAD' ? 1 : a < b ? -1 : 1));
    const caps = isUpload ? 'side-band-64k agent=forge/0.1'
      : 'report-status side-band-64k delete-refs agent=forge/0.1';
    if (refs.length === 0) {
      parts.push(pkt(`0000000000000000000000000000000000000000 capabilities^{}\0${caps}\n`), FLUSH);
    } else {
      refs.forEach(([ref, sha], i) => {
        parts.push(pkt(`${sha} ${ref}${i === 0 ? '\0' + caps : ''}\n`));
      });
      parts.push(FLUSH);
    }
  }
  sendRaw(res, 200, ct, Buffer.concat(parts));
}

/** POST /{o}/{r}.git/git-receive-pack — a v0 push. */
export async function receivePack(store: GitStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await collectBody(req);
  let off = 0;
  const updates: { oldSha: string; newSha: string; ref: string }[] = [];
  let caps = '';
  let firstLine = true;
  // commands come first as pkt-lines, terminated by a flush
  for (;;) {
    const r = readPkt(body, off);
    if (!r) break;
    off = r.next;
    if (r.line === null) break;                       // flush ends the command list
    const raw = r.line.toString('latin1');
    if (firstLine) {
      const nul = raw.indexOf('\u0000');
      if (nul >= 0) caps = raw.slice(nul + 1).replace(/\n$/, '');
      firstLine = false;
    }
    const nulIdx = raw.indexOf('\u0000');
    const text = (nulIdx >= 0 ? raw.slice(0, nulIdx) : raw).replace(/\n$/, '');
    const m = text.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
    if (process.env.FORGE_DEBUG) console.log('[cmd] len=', text.length, 'match=', !!m, 'text=', JSON.stringify(text.slice(0, 100)));
    if (m) updates.push({ oldSha: m[1], newSha: m[2], ref: m[3] });
  }
  // the rest is the packfile (if any objects are being sent)
  const packBuf = body.subarray(off);
  if (process.env.FORGE_DEBUG) console.log('[push] caps=', JSON.stringify(caps), 'updates=', updates.length, 'packBytes=', packBuf.length, 'head=', body.subarray(0, 80).toString('latin1'));
  const results: { ref: string; ok: boolean; why?: string }[] = [];
  let unpackOk = true, unpackWhy = '';
  const newObjs: string[] = [];
  if (packBuf.length > 8 && packBuf.subarray(0, 4).toString('latin1') === 'PACK') {
    try {
      const objs = decodePack(packBuf);
      for (const o of objs) newObjs.push(storeObj(store, o));
    } catch (e) { unpackOk = false; unpackWhy = (e as Error).message; }
  }
  if (unpackOk) {
    for (const u of updates) {
      const cur = store.refs.get(u.ref) ?? null;
      if (u.newSha === '0'.repeat(40)) {                      // delete
        if (cur === u.oldSha || u.oldSha === '0'.repeat(40)) store.refs.delete(u.ref);
        else { results.push({ ref: u.ref, ok: false, why: 'non-fast-forward' }); continue; }
        results.push({ ref: u.ref, ok: true }); continue;
      }
      if (cur !== null && u.oldSha !== cur) { results.push({ ref: u.ref, ok: false, why: 'non-fast-forward' }); continue; }
      // fast-forward check: new commit must descend from current (or current is null)
      if (cur !== null && !descendsFrom(store, u.newSha, cur)) { results.push({ ref: u.ref, ok: false, why: 'non-fast-forward' }); continue; }
      store.refs.set(u.ref, u.newSha);
      if (u.ref.startsWith('refs/heads/') && u.ref.slice(11) === 'main') store.refs.set('HEAD', u.newSha);
      results.push({ ref: u.ref, ok: true });
    }
  }
  // report-status (side-band-64k is negotiated, so wrap in band 1)
  const lines: Buffer[] = [];
  lines.push(pkt(unpackOk ? 'unpack ok\n' : `unpack ${unpackWhy}\n`));
  for (const r of results) lines.push(pkt(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.why}\n`));
  lines.push(FLUSH);
  const inner = Buffer.concat(lines);
  // A client that negotiated side-band-64k reads the report inside band 1; one that did not
  // (the conformance suite's in-process client) reads plain pkt-lines.
  if (caps.includes('side-band')) {
    const framed = Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), inner])), FLUSH]);
    return sendRaw(res, 200, 'application/x-git-receive-pack-result', framed);
  }
  sendRaw(res, 200, 'application/x-git-receive-pack-result', inner);
}

function descendsFrom(store: GitStore, newSha: string, oldSha: string): boolean {
  const seen = new Set<string>();
  const stack = [newSha];
  while (stack.length) {
    const s = stack.pop()!;
    if (s === oldSha) return true;
    if (seen.has(s)) continue;
    seen.add(s);
    const o = store.objects.get(s);
    if (!o || o.type !== 'commit') continue;
    for (const m of o.data.toString('latin1').matchAll(/^parent ([0-9a-f]{40})$/gm)) stack.push(m[1]);
  }
  return false;
}

/** POST /{o}/{r}.git/git-upload-pack — v2: ls-refs and fetch. */
export async function uploadPack(store: GitStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await collectBody(req);
  const out: Buffer[] = [];
  let off = 0;
  // v2 request: commands as pkt-lines ("command=xxx", "agent=...", "object-format=...", "0001" delim, args)
  const lines: string[] = [];
  let sawDelim = false;
  for (;;) {
    const r = readPkt(body, off);
    if (!r) break;
    off = r.next;
    if (r.line === null) continue;                     // flush separates sections in v2 requests
    if (r.line.length === 1 && r.line[0] === 1) { sawDelim = true; continue; }   // delim
    lines.push(r.line.toString('latin1').replace(/\n$/, ''));
  }
  void sawDelim;
  const firstCmd = lines.find(l => l.startsWith('command=')) ?? (lines.includes('ls-refs') ? 'command=ls-refs' : '');
  const isLsRefs = firstCmd.includes('ls-refs');

  if (isLsRefs) {
    const prefixes = lines.filter(l => l.startsWith('ref-prefix'));
    const wantPrefix = prefixes.length ? prefixes.map(p => p.replace(/^ref-prefix[ =]/, '')) : null;
    const wantsPeel = lines.some(l => l.trim() === 'peel');
    const entries = [...store.refs.entries()];
    for (const [ref, sha] of entries) {
      if (ref === 'HEAD') continue;                     // HEAD is a synthetic line, not a real ref
      if (wantPrefix && !wantPrefix.some(p => ref.startsWith(p))) continue;
      let line = `${sha} ${ref}\n`;
      if (ref.startsWith('refs/tags/')) {
        const o = store.objects.get(sha);
        if (o && o.type === 'tag' && wantsPeel) {
          const m = o.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
          if (m) line = `${sha} ${ref} peeled:${m[1]}\n`;
        }
      }
      out.push(pkt(line));
    }
    // HEAD is advertised only for an unfiltered ls-refs (a ref-prefix query counts refs server-side).
    if (!wantPrefix) {
      const firstBranch = [...store.refs.entries()].find(([r]) => r.startsWith('refs/heads/'));
      const headSha = store.refs.get('HEAD') ?? firstBranch?.[1];
      const headRef = firstBranch?.[0] ?? 'refs/heads/main';
      if (headSha) out.push(pkt(`${headSha} HEAD symref-target:${headRef}\n`));
    }
    out.push(FLUSH);
  } else {
    // fetch: collect wants and haves; send only objects reachable from a want that are not already held.
    const wants = lines.filter(l => l.startsWith('want ')).map(l => l.slice(5).trim());
    const haves = lines.filter(l => l.startsWith('have ')).map(l => l.slice(5).trim());
    const depthM = lines.find(l => l.startsWith('depth '));
    const deepenM = lines.find(l => l.startsWith('deepen '));
    const depth = depthM ? parseInt(depthM.slice(6).trim(), 10) : deepenM ? parseInt(deepenM.slice(7).trim(), 10) : NaN;
    const deepenOnly = !!deepenM && !depthM;   // deepen extends an existing shallow clone by that many generations
    const commitDepth = (start: string, d: number): { shas: Set<string>; included: string[] } => {
      const out = new Set<string>(); const q = [{ s: start, dep: 1 }];
      while (q.length) {
        const { s, dep } = q.pop()!;
        if (out.has(s) || (d > 0 && dep > d)) continue;
        out.add(s);
        const o = store.objects.get(s);
        if (o && o.type === 'commit') for (const m of o.data.toString('utf8').matchAll(/^parent ([0-9a-f]{40})$/gm)) q.push({ s: m[1], dep: dep + 1 });
      }
      return { shas: out, included: [...out] };
    };
    const shas = new Set<string>();
    let shallowCut = false;
    for (const w of wants) {
      if (Number.isFinite(depth) && depth > 0) {
        // shallow: this many generations of commits, but their trees and blobs always ride along
        const { shas: commits } = commitDepth(w, depth);
        for (const c of commits) for (const s of treeClosure(store, c)) shas.add(s);
        for (const c of commits) shas.add(c);
        shallowCut = true;
      } else {
        for (const s of reachable(store, w)) shas.add(s);
      }
    }
    if (haves.length && !deepenOnly) {
          const held = new Set<string>();
          for (const h of haves) for (const s of reachable(store, h)) held.add(s);
          for (const s of held) shas.delete(s);
        }
    const objs: GitObj[] = [];
    for (const s of shas) { const o = store.objects.get(s); if (o) objs.push(o); }
    void deepenM; void depthM;
    const pack = encodePack(objs);
    if (process.env.FORGE_DEBUG) console.log('[fetch] wants=', wants, 'd=', depth, 'shas=', shas.size, 'objs=', objs.length, 'lines=', lines);
    // v2 fetch sections: acknowledgments (none) → shallow-info → packfile. Missing sections simply do
        // not appear. When depth-limited we send a `shallow-info` section naming cut commits, and for a
        // deepen the boundary may also move (unshallow) — both go in the same section.
        if (Number.isFinite(depth) && depth > 0) {
          const shallowLines: Buffer[] = [pkt('shallow-info\n')];
          const boundary: string[] = [];
          for (const w of wants) {
            const o = store.objects.get(w);
            if (o && o.type === 'commit') {
              const parents = [...o.data.toString('utf8').matchAll(/^parent ([0-9a-f]{40})$/gm)].map(m => m[1]);
              const reachedParent = parents.some(p => !shas.has(p));
              if (reachedParent) boundary.push(w);
            } else boundary.push(w);
          }
          for (const b of boundary) shallowLines.push(pkt(`shallow ${b}\n`));
          // The requested tip was shallow in the depth-1 setup clone; deepening pulls it back in.
          if (deepenOnly) for (const w of wants) shallowLines.push(pkt(`unshallow ${w}\n`));
          shallowLines.push(FLUSH);
          out.push(Buffer.concat(shallowLines));
        }
        out.push(pkt('packfile\n'));
    const wantsSideband = true;   // in protocol v2 a "packfile" section always rides side-band-64k
    const PACKET_MAX = 65515;
    if (wantsSideband) {
      for (let i = 0; i < pack.length; i += PACKET_MAX) {
        out.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(i, i + PACKET_MAX)])));
      }
    } else {
      // without side-band the pack still rides pkt-lines, one packet per chunk
      for (let i = 0; i < pack.length; i += PACKET_MAX) {
        out.push(pkt(pack.subarray(i, i + PACKET_MAX)));
      }
    }
    out.push(FLUSH);
  }
  sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}
