# github-core-clone-01 — progres & roadmap (LEO)

> **CHECKPOINT (16 Nov ~12:00, sebelum restart gateway):** app.ts JALAN di `gh-clone-repo/`
> dengan auth 401 ✅ + pagination Link ✅ + REST repo/issues/labels/contents/pulls + MCP tools +
> GraphQL dasar. Setelah restart: lanjut dari sini → git smart HTTP penuh (belum). NOL ulang dari nol.
> File ini + app.ts = state terakhir; main.ts = lifecycle jangan diubah.

Target: github-core-clone-01 (deadline **21 Nov 17:00 UTC**, agent/v1, Node 22, no-deps).
Skor 0..1000 = feature(600) + MCP agent-native(200) + perf(200). 3 instance scored.
RULES lengkap: `gh-clone-kit/github-core-clone-01-kit/RULES.txt`.
Suite lokal: kit `program/` + `sdk/conformance/*`.

## The task (ringkas)
Server standalone, bind port acak, POST {port} ke MAKEFUN_ENV_URL/register, poll /done sampai true →
exit 0. Serves dari store sendiri (no git binary, no internet):
- git smart HTTP: `/{o}/{r}.git` upload-pack v2 (ls-refs), receive-pack v0 (report-status, side-band-64k, delete-refs)
- REST v3: /api/v3 (repos/labels/issues/pulls/contents + pagination Link header + X-GitHub-Request-Id)
- GraphQL v4: /api/graphql (introspection Issue/PullRequest/Repository/SearchType; repository.issues orderBy CREATED_AT desc; createPullRequest)
- MCP: /mcp JSON-RPC 2.0 streamable (initialize, tools/list ≥6 tools, tools/call create_repo/get_repo/create_issue/list_issues/create_pull_request/merge_pull_request)

Auth: Bearer MAKEFUN_SHOP_TOKEN; tanpa = 401; repo milik login token → owner lain 404.
400 = JSON malformed. Unknown route = 404 JSON.

## Progres (15 Nov 2026 malam)
- [x] baca RULES/README/scenario/requirements
- [x] kerangka app.ts (17 KB) di `gh-clone-repo/app.ts`: REST repo CRUD + issues + labels + contents + pulls + merge; GraphQL introspection dasar; MCP tools; git smart-http stub
- [x] verifikasi server jalan: healthz, /api/v3, create repo (201), get repo, create issue (201), list issues — semua HTTP benar (test langsung Node)
- [x] enforce auth 401 (semua permukaan kecuali /healthz butuh Bearer MAKEFUN_SHOP_TOKEN; nol/salah token = 401) — teruji 16 Nov 11:45
- [x] pagination Link header (per_page/page + Link rel=next saat ada halaman berikut) — teruji 16 Nov 11:50, 35 repo 2 halaman
- [ ] git smart HTTP benar (v2 kapabilitas, ls-refs, receive-pack, framed pkt-line; suite in-process)
- [ ] GraphQL lengkap (ordered issues, createPullRequest, null repo dengan errors)
- [ ] MCP: SSE + 2 tools call bersamaan id terpisah, unknown tool -32601
- [ ] commit repo GitHub + bundle (sesi subagent baru) + check + submit

## Catatan buat lanjut
- Starter disalin: gh-clone-repo/ (app.ts ku + main.ts/package.json/LICENSE/tsconfig dari starter)
- `main.ts` = lifecycle, JANGAN diubah.
- Uji lokal: `node --experimental-strip-types -e "import('./app.ts').then(...)"` + fetch ke server test.
- Suite konformansi: `sdk/conformance/main.ts` (bench/git/graphql/mcp). Jalankan setelah app tsembang.