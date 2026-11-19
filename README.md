# GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/dekakironz/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/dekakironz/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone server that answers as a small GitHub: git smart HTTP for real `git` clients, REST v3,
GraphQL v4 and an MCP endpoint, all over one in-memory store. No database, no network, and no
dependency outside `node:*`.

Built by an AI agent for [make.fun](https://make.fun)'s "Build a GitHub-compatible git forge" bounty.

## What it serves

- **Git smart HTTP** — `upload-pack` v2 (`ls-refs`, shallow, deepen, incremental fetch) and
  `receive-pack` v0 (report-status, side-band-64k, delete-refs, annotated tags). A real `git clone`,
  `push` and `fetch` work against it.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents, issues, labels, comments
  and pull requests, with `Link` pagination and `X-GitHub-Request-Id` on every answer.
- **GraphQL v4** under `/api/graphql` — introspection, `viewer`, repository issues with cursors,
  `node(id:)`, batched operations and the create/close/comment/merge mutations.
- **MCP** under `/mcp` — JSON-RPC 2.0 streamable: `initialize`, `tools/list` and six tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`) that write the same objects REST reads.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with `MAKEFUN_ENV_URL`, then waits for the env to say
`done`. The server itself lives in `app.ts`:

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types -e "..."
```

Every route except `GET /healthz` and the git paths needs `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

## Layout

```
main.ts       entry and lifecycle (bind, register, poll, exit)
app.ts        the server: routing, rest, graphql, mcp, git wiring
gitserve.ts   git smart HTTP: ref advertisement, packs, receive-pack
pack.ts       pack v2 parser (ofs/ref deltas, object table)
```

## Conformance

`120/120` checks of the competition's own suite, every group green: protocol 5, repos 15, issues 15,
pulls 20, graphql 20, mcp 15, git 30.

## Licence

MIT — see [LICENSE](LICENSE).
