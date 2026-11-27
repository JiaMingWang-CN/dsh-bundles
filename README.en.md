# dsh-bundles

[中文](README.md) · **English**

A set of standalone plugins for the DeepSeek Harness (dsh) web profile: task-completion notifications, a CodeGraph + Context7 MCP toolkit, a third-party web search provider with one switch back to the built-in search. All three packages are published on npm under the `@wjm200509` scope.

Each directory is an independently installable bundle. Install only what you need.

## Table of Contents

- [What's included](#whats-included)
- [Quick install](#quick-install)
- [Plugin index](#plugin-index)
- [Installing the MCP tools](#installing-the-mcp-tools)
  - [CodeGraph](#codegraph)
  - [Context7](#context7)
- [Using the bundles](#using-the-bundles)
- [Updating and uninstalling](#updating-and-uninstalling)
- [Troubleshooting](#troubleshooting)
- [Local development](#local-development)

## What's included

### Task notifications

`dsh-client-ui-task-notify` sends a system notification when a main session finishes while the DSH page is not in the foreground.

- Sub-agent completions do not notify;
- Includes system default, ding, chime, rising, and muted sound options;
- Persists the enabled state and selected sound in DSH settings;
- Custom sounds are synthesized with Web Audio and follow system volume.

### MCP toolkit

`dsh-bundle-mcp-toolkit` registers two stdio MCP servers with DSH:

- **CodeGraph**: uses a local code index for symbol lookup, call paths, and architecture exploration;
- **Context7**: supplies current third-party library documentation and examples to the agent.

CodeGraph and Context7 launch through `npx -y`; no global package installation is required.

### Third-party search

`dsh-web-search` gives the `web_search` tool a third-party search backend, with a master switch on the Third-party search page in the Settings sidebar; switching is live and turning the switch off hands search back to DSH's built-in provider. DSH itself is never modified; uninstalling restores the shipped behavior.

- Tavily (default, switchable off): free tier of 1000 searches/month, LLM-optimized results;
- Model-native web search: MiMo server-side `web_search`, billed per search round (about ¥16 per 1000 plus token fees; activate the "Web Search plugin" in the MiMo console);
- Master switch off: hands `web_search` back to DSH's built-in DeepSeek search (Messages, or the newer Search API if that was selected last);
- API keys are stored through the credentials domain, never as profile-settings plaintext.

## Quick install

### Requirements

- DeepSeek Harness (dsh) is installed;
- Node.js 20 or newer when using the MCP toolkit;
- `npx` is available on Windows, macOS, or Linux.

### Install from npm

All three packages are published on npm under the `@wjm200509` scope. Run the commands for the bundles you want:

```powershell
# Task-completion notifications
dsh plugin --profile web add -w "@wjm200509/dsh-client-ui-task-notify"

# CodeGraph + Context7 MCP toolkit
dsh plugin --profile web add -w "@wjm200509/dsh-bundle-mcp-toolkit"

# Third-party web search (Tavily / model-native, one switch back to built-in)
dsh plugin --profile web add -w "@wjm200509/dsh-web-search"
```

Source-directory installs from GitHub still work:

```powershell
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-client-ui-task-notify"
# Replace path: with the directory of another bundle
```

Confirm that the bundles are present in the web profile:

```powershell
dsh --profile web --dump-config
```

The first MCP startup takes longer because `npx` must download the server packages.

## Plugin index

This repository also serves as a DSH plugin-market index. `index.json` is generated from the npm registry by `scripts/build-market-index.mjs`, and GitHub Actions publishes it to Pages on every push to main:

```text
https://jiamingwang-cn.github.io/dsh-bundles/index.json
```

Add that URL under **Plugins → Discover → Add index source** to search, open and install the three packages (enable the "Custom plugin indexes" experimental bundle first).

Regenerate and check locally:

```powershell
node scripts/build-market-index.mjs   # writes _site/index.json
```

## Installing the MCP tools

The MCP bundle already contains the server configuration required by DSH. You only need to prepare the runtime and project indexes.

### CodeGraph

- **Project**: https://github.com/colbymchenry/codegraph

CodeGraph builds a local knowledge graph for source code. One MCP server can serve multiple projects, but every project needs its own `.codegraph/` index.

### Context7

- **Project**: https://github.com/upstash/context7

Context7 runs in API-key mode and the key is never typed by hand: on first use the plugin reuses an existing `ctx7` login or starts the device-code login, then stores the issued key in the DSH credential store (see `dsh-bundle-mcp-toolkit/README.md`).

## Using the bundles

### Enable task notifications

1. Open DSH Settings;
2. Select Task notifications;
3. Enable notifications and choose a sound;
4. Allow system notifications when the browser asks for permission.

A notification is sent only when a main session transitions from running to complete while the page is not focused.

### Switch third-party search

1. Open DSH Settings;
2. Go to Third-party search in the settings sidebar;
3. Pick the third-party backend (Tavily / model-native), enter the API key, and save; turn the top-level master switch off to hand search back to DSH's built-in provider.

Switching takes effect immediately with no restart; per-engine setup and billing notes live in `dsh-web-search/README.md`.

### Use the MCP tools

- CodeGraph queries require a `.codegraph/` index in the target project;
- Context7 requires no project initialization;
- A slow first server launch is expected while `npx` downloads packages;
- Use `dsh --profile web --dump-config` to verify that the MCP clients are in the configuration stack.

## Updating and uninstalling

Update every installed plugin:

```powershell
dsh plugin --profile web update
```

Update one plugin:

```powershell
dsh plugin --profile web update @wjm200509/dsh-web-search
```

Remove these bundles:

```powershell
dsh plugin --profile web remove -w @wjm200509/dsh-client-ui-task-notify @wjm200509/dsh-bundle-mcp-toolkit @wjm200509/dsh-web-search
```

Restart DSH after updating or uninstalling.

## Troubleshooting

### CodeGraph cannot find an index

Run this from the root of the project being queried:

```powershell
codegraph init -i
```

### The MCP server is slow on first launch

CodeGraph and Context7 use `npx -y`. The first run downloads the package; later runs use the local cache. Both versions are pinned, so startup never re-resolves the latest release over the network: CodeGraph `@colbymchenry/codegraph@1.6.2` in `dsh-bundle-mcp-toolkit/patch.yml`, and Context7 `@upstash/context7-mcp@4.5.0` in `dsh-bundle-mcp-toolkit/lib/context7-mcp.js` (the Context7 MCP row is mounted by the plugin once the credentials provider is active, so it cannot be a static loader row); edit the version in the matching file to upgrade.

### Which DSH versions are supported

All three packages are adapted to DSH **0.2.2-rc.1** (current latest): the host halves mount, and the
tests of `dsh-web-search` and `dsh-client-ui-task-notify` run directly against the 0.2.2-rc.1 contract
packages. Their `engines.dsh` range keeps
`0.1.7-rc.2`, `0.2.0-rc.2`, `0.2.1-alpha.x`, and `0.2.2-rc.1`. The search plugin only adds a third-party provider;
turning the master switch off writes a built-in provider back, so 0.2.1's built-in
`web-deepseek-api` and this bundle do not interfere.

### A plugin did not change after editing

- Changed `lib/client.js`: refresh the browser;
- Changed `lib/index.js`: restart DSH, then refresh.

### A local task-notify install is missing dependencies

Local directory installs use `link:` and do not install package dependencies automatically. Run:

```powershell
cd dsh-client-ui-task-notify
pnpm install
```

## Local development

Clone the repository and install each bundle by local path:

```powershell
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-client-ui-task-notify
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-bundle-mcp-toolkit
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-web-search
```

Run the tests (web search ships a `node --test` suite):

```powershell
cd dsh-web-search
npm test
```

Repository layout:

```text
dsh-bundles/
├── dsh-client-ui-task-notify/
├── dsh-bundle-mcp-toolkit/
├── dsh-web-search/
├── market/display.json              # titles, descriptions and categories for the index
├── scripts/build-market-index.mjs   # writes _site/index.json from the npm registry
└── .github/workflows/plugin-market.yml
```
