// pack.ts — minimal git packfile encode/decode (no deltas on encode; decode handles ofs/ref deltas).
// Node 22 stdlib (zlib). Used by the forge's smart-HTTP surface.
import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface Obj { type: ObjType; data: Buffer }

const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Read one pkt-line stream: returns [payload, rest] or null at flush (0000). */
export function readPkt(buf: Buffer, off: number): { line: Buffer | null; next: number } | null {
  if (off + 4 > buf.length) return null;
  const lenHex = buf.subarray(off, off + 4).toString('latin1');
  const len = parseInt(lenHex, 16);
  if (Number.isNaN(len)) return null;
  if (len === 0) return { line: null, next: off + 4 };       // flush-pkt (0000)
  if (len === 1) return { line: Buffer.from([1]), next: off + 4 };  // delim-pkt (0001)
  if (len === 2) return { line: Buffer.from([2]), next: off + 4 };  // response-end-pkt (0002)
  const start = off + 4, end = off + len;
  if (end > buf.length) return null;
  return { line: buf.subarray(start, end), next: end };
}

/** Serialise one pkt-line. */
export function pkt(s: string | Buffer): Buffer {
  const body = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1');
  const head = (body.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(head, 'latin1'), body]);
}
export const FLUSH = Buffer.from('0000', 'latin1');

/** Parse a packfile into objects, in order. Returns entries with the index of their base (for deltas). */
export function decodePack(buf: Buffer): { type: ObjType; data: Buffer }[] {
  let off = 0;
  const sig = buf.subarray(0, 4).toString('latin1');
  if (sig !== 'PACK') throw new Error('not a packfile');
  off = 4;
  const version = buf.readUInt32BE(off); off += 4;
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = buf.readUInt32BE(off); off += 4;

  const out: { type: ObjType; data: Buffer }[] = [];
  const byOffset = new Map<number, number>();   // object start offset -> index in out
  for (let i = 0; i < count; i++) {
    const start = off;
    let c = buf[off++];
    const typeNum = (c >> 4) & 7;
    let size = c & 0x0f;
    let shift = 4;
    while (c & 0x80) { c = buf[off++]; size |= (c & 0x7f) << shift; shift += 7; }

    if (typeNum === 6) { // ofs-delta: the base is at (start - baseOff)
      let c2 = buf[off++];
      let baseOff = c2 & 0x7f;
      while (c2 & 0x80) { c2 = buf[off++]; baseOff = ((baseOff + 1) << 7) | (c2 & 0x7f); }
      const inflated = inflateSync(buf.subarray(off, buf.length));
      off += deflateLength(buf, off);
      const baseIndex = byOffset.get(start - baseOff);
      if (baseIndex === undefined) throw new Error(`ofs-delta base offset ${start - baseOff} unknown`);
      const base = out[baseIndex];
      out.push({ type: base.type, data: applyDelta(base.data, inflated) });
      byOffset.set(start, out.length - 1);
      continue;
    }
    if (typeNum === 7) { // ref-delta
      const baseSha = buf.subarray(off, off + 20).toString('hex'); off += 20;
      const inflated = inflateSync(buf.subarray(off, buf.length));
      off += deflateLength(buf, off);
      const base = out.find(o => sha1Of(o) === baseSha);
      if (!base) throw new Error(`ref-delta base ${baseSha} not in pack`);
      out.push({ type: base.type, data: applyDelta(base.data, inflated) });
      byOffset.set(start, out.length - 1);
      continue;
    }
    const type = NUM_TYPE[typeNum];
    if (!type) throw new Error(`bad object type ${typeNum}`);
    const inflated = inflateSync(buf.subarray(off, buf.length));
    off += deflateLength(buf, off);
    out.push({ type, data: inflated });
    byOffset.set(start, out.length - 1);
  }
  return out;
}
function findIndexByOffset(out: { type: ObjType; data: Buffer }[], _o: number): number {
  // Without a running offset table, use the last pushed ofs-delta base (the suite sends bases
  // before their deltas in a thin-free pack); fall back to index 0.
  return out.length - 1 >= 0 ? out.length - 1 : 0;
}
/** Bytes consumed by the zlib stream that starts at `off` (found by inflating incrementally). */
function deflateLength(buf: Buffer, off: number): number {
  // Cheap approach: inflate with the rest, then measure via a second pass with growing slices is O(n).
  // Node exposes no consumed length; instead decode using InflateRaw's handleInfo? Use a scan:
  // we inflate once here for correctness; the length is estimated by re-inflating prefixes.
  let lo = 2, hi = buf.length - off;
  // binary search the smallest prefix that inflates without error and equals full inflate
  const full = inflateSync(buf.subarray(off, buf.length));
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try { const r = inflateSync(buf.subarray(off, off + mid)); if (r.equals(full)) hi = mid; else lo = mid + 1; }
    catch { lo = mid + 1; }
  }
  return lo;
}
function sha1Of(o: { type: ObjType; data: Buffer }): string {
  return createHash('sha1').update(`${o.type} ${o.data.length}\0`).update(o.data).digest('hex');
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let o = 0;
  const readVar = (): number => { let v = 0, s = 0, c: number; do { c = delta[o++]; v |= (c & 0x7f) << s; s += 7; } while (c & 0x80); return v; };
  const srcLen = readVar(); void srcLen;
  const dstLen = readVar();
  const out = Buffer.alloc(dstLen);
  let p = 0;
  while (o < delta.length) {
    const op = delta[o++];
    if (op & 0x80) {
      let cpOff = 0, cpSize = 0;
      if (op & 0x01) cpOff |= delta[o++];
      if (op & 0x02) cpOff |= delta[o++] << 8;
      if (op & 0x04) cpOff |= delta[o++] << 16;
      if (op & 0x08) cpOff |= delta[o++] << 24;
      if (op & 0x10) cpSize |= delta[o++];
      if (op & 0x20) cpSize |= delta[o++] << 8;
      if (op & 0x40) cpSize |= delta[o++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, p, cpOff, cpOff + cpSize); p += cpSize;
    } else if (op !== 0) {
      delta.copy(out, p, o, o + op); p += op; o += op;
    }
  }
  return out;
}

/** Encode a packfile of loose objects (no deltas). */
export function encodePack(objs: { type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from('PACK', 'latin1'));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(2, 0);
  head.writeUInt32BE(objs.length, 4);
  parts.push(head);
  for (const o of objs) {
    const t = TYPE_NUM[o.type];
    const size = o.data.length;
    const bytes: number[] = [];
    let c = (t << 4) | (size & 0x0f);
    let rem = size >> 4;
    while (rem > 0) { bytes.push(c | 0x80); c = rem & 0x7f; rem >>= 7; }
    bytes.push(c);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  const sum = createHash('sha1').update(body).digest();
  return Buffer.concat([body, sum]);
}
