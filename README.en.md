# dsh-bundles

**English** | [中文](README.md)

dsh-bundles is a collection of `dsh.bundle` plugin packages for DeepSeek Harness (dsh). Each subdirectory is a standalone, installable bundle that drops into your web profile through the official plugin channel — one pings you when a session finishes, one lays out your local token usage, and one gives your agent a code index and up-to-date library docs.

## Table of Contents

- [How it works](#how-it-works)
- [Installation](#installation)
  - [Prerequisites](#prerequisites)
  - [From GitHub](#from-github)
  - [Local development](#local-development)
- [The Bundles](#the-bundles)
  - [ui-task-notify](#ui-task-notify)
  - [ui-usage-stats](#ui-usage-stats)
  - [mcp-toolkit](#mcp-toolkit)
- [When Something Goes Wrong](#when-something-goes-wrong)
- [Updating](#updating)
- [Philosophy](#philosophy)
- [Development notes](#development-notes)

## How it works

Once installed, the bundles just sit there. You don't need to do anything special.

The task notification plugin watches the main session: when a task finishes, if you're looking at the interface, it does nothing; if you've switched away or minimized the window, it fires a system notification. Sub-agent completions don't notify — that's more noise than signal. Tones are synthesized on the fly with Web Audio and follow your system volume, and both the toggle and the tone choice persist in DSH config.

The usage stats plugin folds every local session log in the background and shows token usage in three views: provider → model, by model, and by session. It only reads logs — it doesn't bill anything and it doesn't call models. When you reopen the panel, it draws the previous results immediately and refreshes in the background, so you never stare at a blank page.

The MCP toolkit registers two stdio servers: **codegraph** answers questions like "where is this symbol and what calls it" (requires a `.codegraph/` index in the project), and **context7** feeds your agent current library docs instead of letting it bluff from stale memory. Both launch through `npx -y`, so nothing pollutes your global environment.

After three `dsh plugin add` commands, the profile's `patchReload: live` picks up the new bundles in the running dsh — no restart, just refresh the page.

## Installation

### Prerequisites

The two UI bundles (task-notify, usage-stats) have no prerequisites — install and go.

The MCP toolkit depends on the two tools below. Install each one following its own repo, and confirm the commands work (`codegraph --version`, `context7-mcp --help`):

- **CodeGraph**: https://github.com/colbymchenry/codegraph
- **Context7**: https://github.com/upstash/context7

Also note that codegraph only answers for **indexed projects** — run `codegraph init` in the project you want to query to generate a `.codegraph/` index.

### From GitHub

With dsh installed, run three commands (the first two are tested end-to-end on a fresh profile):

```powershell
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-client-ui-task-notify"
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-client-ui-usage-stats"
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-bundle-mcp-toolkit"
```

- Installing from git lets pnpm pull in each package's dependencies (`@deepseek-ai/schemastery` etc.) automatically — no manual `pnpm install`;
- MCP servers are pulled via `npx -y` on first launch, so the first start is a little slow;
- After installing, `dsh --profile web --dump-config` confirms the bundles made it into the layer stack.

### Local development

Clone this repo and install by local path — source changes take effect immediately:

```powershell
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-client-ui-task-notify
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-client-ui-usage-stats
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-bundle-mcp-toolkit
```

## The Bundles

### ui-task-notify

System notifications on session completion. Fires a notification when the main session finishes a task and the window is unfocused or minimized; sub-agents don't notify. Settings sit under "Agent presets" (`settings.section` slot, order 25) with a master toggle and tone selection (system default / ding / ding-dong / rising / mute), persisted to the `ui-task-notify` section of `settings.yaml`. Tones are synthesized with Web Audio at fixed gain, following system volume.

### ui-usage-stats

Usage statistics. Settings sit under "Task notifications" (`settings.section` slot, order 30). Folds every local session log (sub-agents included) and shows token usage (input / cache read / cache write / output; reasoning listed separately but not double-counted) in three views: provider → model, by model, and by session. When the same model name comes from multiple providers, they're counted separately, and the "by model" view merges them while listing every provider. Read-only — no cost conversion, no model calls.

### mcp-toolkit

Two stdio MCP server configs, launched via `npx -y`, no global install needed:

- **codegraph** (`mcp__codegraph__codegraph_explore`): answers symbol lookups, call paths, and architecture questions for any **indexed** project, resolving the index per call via its `projectPath` argument.
- **context7** (`mcp__context7__resolve-library-id` / `mcp__context7__query-docs`): feeds your agent current third-party library docs instead of stale training memory.

## When Something Goes Wrong

- **Changed the host half (`lib/index.js`) and the page didn't update**: expected. `patchReload: live` only hot-rebuilds the client bundle; the host half loads at startup, so **restart dsh** for changes to take effect. If you only changed `lib/client.js`, refreshing the page is enough.
- **task-notify complains about missing dependencies after a `link:` install**: `dsh plugin add` defaults to `link:` for local directories, and pnpm won't install dependencies for you. Run `pnpm install` once inside `dsh-client-ui-task-notify` (it depends on `@deepseek-ai/schemastery`). `dsh-client-ui-usage-stats` has no dependencies and doesn't need this.
- **codegraph queries can't find an index**: there's no `.codegraph/` in the queried project. Run `codegraph init`.
- **First MCP server launch is slow**: `npx -y` is downloading the package; it's fast after that.

## Updating

- Update everything: `dsh plugin --profile web update`; update one: `dsh plugin --profile web update dsh-client-ui-usage-stats`. Restart dsh after updating.
- Uninstall: `dsh plugin --profile web remove -w dsh-client-ui-task-notify dsh-client-ui-usage-stats dsh-bundle-mcp-toolkit`.

## Philosophy

- **One job per bundle**: each bundle has a single clear responsibility, they don't depend on each other, install what you need.
- **Read-only data**: the stats plugin only decodes logs and displays them — it doesn't touch sessions, call models, or convert costs.
- **Fast is a feature**: stats skip replay validation, decode logs directly, and cache by `path + size + mtime` — first fold ≈ 0.9 s, repeat open ≈ 5 ms, instead of 14 s.
- **Reuse existing mechanisms**: settings ride the `settings.section` slot, cross-half communication rides a `ctx.webServer` route inside the package — same approach as the official bundles (`dsh-client-hmr`, `dsh-host-open-in-app`), no invented channels.

## Development notes

- **Hot-reload boundary**: `dsh plugin add` defaults to `link:` for local directories, so changes to `lib/` source take effect on page refresh, no reinstall. But the host half (`lib/index.js`) loads at startup — **restart dsh** after changing it; if you only touched `lib/client.js`, a page refresh is enough.
- **task-notify's dependency**: the host half (`lib/index.js`) registers the `ui-task-notify` settings namespace and depends on `@deepseek-ai/schemastery`. With a `link:` install pnpm doesn't pull dependencies, so run `pnpm install` once inside the package. The client half (`lib/client.js`) reads and writes persisted state via `ctx.settingsScope` and mounts its settings page through the `settings.section` slot (order 25).
- **usage-stats has no dependencies**: the host half only uses `ctx.webServer`; no `pnpm install` needed after a `link:` install.
- **Read session logs directly**: the host half reads `$DSH_HOME/sessions/*/*/session.v3.jsonl.zstd` directly and folds tokens by provider + model (following `dsh-token-meter`'s `tokenUsage` semantics: same `(turn, step)` slots replace instead of accumulate, and `llm/retry-started` ends the replacement scope). **Don't switch back to `ctx.sessionQuery`**: that service does a full replay validation per session, and 40 sessions / 50 MB took 14 seconds in testing; decoding the same data directly takes 0.9 seconds, and the size/mtime signature lets subsequent opens skip decoding entirely:
  - first fold ≈ 0.9 s; repeat open ≈ 5 ms; `?includeSubagents=false` variant ≈ 15 ms (no re-decode);
  - each session is cached by `path + size + mtime` and only re-parsed when the log actually grew; the report itself is reused for 15 s, so even without a "refresh" button in the panel, reopening gives you the latest stats.
- **Main vs sub sessions are told apart by directory name**: stats **include sub-agent sessions by default** (the panel has no toggle) because the log header is written when the session is created, before the harness knows it'll be delegated, so the **`origin` field doesn't exist in any persisted log** (verified 40/40). Main sessions are `session-<uuid>`; sub-agents are bare uuids.
- **Don't use `harness.handle`**: that's a sandbox RPC exclusive to dynamic Cordis plugins (`cordis_define`), while a bundle package's host half is a plain cordis plugin with **no `harness` global** (using it fails the entire profile startup). Instead, the host half registers an in-package route `GET /plugins/ui-usage-stats/summary` (JSON, `no-store`) on `ctx.webServer`, and the browser half reads it via `fetch` — same as `dsh-client-hmr`, `dsh-host-open-in-app`, and the other official bundles.
- **Formatting belongs in the host half**: numbers (thousands / 万 / 億) are formatted with `Intl` in the host half before being sent down, because the client runtime doesn't guarantee `Intl`. The panel keeps the previous result in memory and draws the old data immediately on reopen before updating in the background, so there's never a blank wait.
- **The client half uses `ctx.slots` directly**: it must declare `inject: ["slots"]` explicitly and use `ctx.slots` directly (`ctx.slots.inject` → `ctx.slots.register`), matching how the official `settings.section` registrant does it; don't switch to `ctx.get("slots")` and then forward the registration through the injected service.
