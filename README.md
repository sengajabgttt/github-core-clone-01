# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/sengajabgttt/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/sengajabgttt/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Forge is a standalone GitHub-compatible git forge in one process: git smart HTTP (upload-pack protocol v2 and receive-pack v0) at `/{owner}/{repo}.git`, REST v3 under `/api/v3`, GraphQL v4 at `/api/graphql`, and MCP at `/mcp`, all backed by a real git object store (SHA-1 blobs, trees, commits and tags) kept in memory. It is written in TypeScript for Node 22 with standard library only and no build step — `node --experimental-strip-types main.ts` binds an ephemeral port, registers it with the environment, and serves until the trial is done. The forge passes all 120 conformance checks in the kit's sealed suite locally (git, repos, issues, pulls, GraphQL, MCP and protocol) and scores 940/1000 on the local grade (feature 600/600, agent 200/200, perf 140/200).

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=1c6jcmp6&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
