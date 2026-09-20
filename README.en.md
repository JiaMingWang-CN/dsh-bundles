# dsh-bundles

[中文](README.md) · **English**

A set of standalone plugins for the DeepSeek Harness (dsh) web profile: task-completion notifications, cross-session token analytics, and a CodeGraph + Context7 MCP toolkit.

Each directory is an independently installable bundle. Install only what you need.

## Table of Contents

- [What's included](#whats-included)
- [Quick install](#quick-install)
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

### Usage analytics

`dsh-client-ui-usage-stats` reads local DSH session logs and builds a cross-session token dashboard.

- Browse by provider, model, or session;
- Separately displays input, cache-read, cache-write, output, and reasoning tokens;
- Reasoning tokens are already included in output and are not counted twice;
- Includes both main and sub-agent sessions;
- Reads logs only: no model calls and no cost estimates;
- Caches by log size and modification time, avoiding full history decoding on repeat opens.

### MCP toolkit

`dsh-bundle-mcp-toolkit` registers two stdio MCP servers with DSH:

- **CodeGraph**: uses a local code index for symbol lookup, call paths, and architecture exploration;
- **Context7**: supplies current third-party library documentation and examples to the agent.

Both servers launch through `npx -y`; no global npm package installation is required.

## Quick install

### Requirements

- DeepSeek Harness (dsh) is installed;
- Node.js 20 or newer when using the MCP toolkit;
- `npx` is available on Windows, macOS, or Linux.

### Install from GitHub

Run the commands for the bundles you want:

```powershell
# Task-completion notifications
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-client-ui-task-notify"

# Token usage analytics
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-client-ui-usage-stats"

# CodeGraph + Context7 MCP toolkit
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-bundle-mcp-toolkit"
```

Confirm that the bundles are present in the web profile:

```powershell
dsh --profile web --dump-config
```

The first MCP startup takes longer because `npx` must download the server packages.

## Installing the MCP tools

The MCP bundle already contains the server configuration required by DSH. You only need to prepare the runtime and project indexes.

### CodeGraph

- **Project**: https://github.com/colbymchenry/codegraph

CodeGraph builds a local knowledge graph for source code. One MCP server can serve multiple projects, but every project needs its own `.codegraph/` index.

### Context7

- **Project**: https://github.com/upstash/context7

Context7 starts without manual setup by default. If the service reports rate limits or requests authentication, run `npx ctx7 setup` and follow the official guided setup.

## Using the bundles

### Enable task notifications

1. Open DSH Settings;
2. Select Task notifications;
3. Enable notifications and choose a sound;
4. Allow system notifications when the browser asks for permission.

A notification is sent only when a main session transitions from running to complete while the page is not focused.

### View token usage

1. Open DSH Settings;
2. Select Usage statistics;
3. Switch between Provider, Model, and Session views.

Host-side changes require a DSH restart. Client-only UI changes require only a page refresh.

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
dsh plugin --profile web update dsh-client-ui-usage-stats
```

Remove all three bundles from this repository:

```powershell
dsh plugin --profile web remove -w dsh-client-ui-task-notify dsh-client-ui-usage-stats dsh-bundle-mcp-toolkit
```

Restart DSH after updating or uninstalling.

## Troubleshooting

### CodeGraph cannot find an index

Run this from the root of the project being queried:

```powershell
codegraph init -i
```

### The MCP server is slow on first launch

The bundle uses `npx -y`. The first run downloads the package; later runs use the local cache.

### Usage analytics did not change after editing

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
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-client-ui-usage-stats
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-bundle-mcp-toolkit
```

Run the usage analytics tests:

```powershell
cd dsh-client-ui-usage-stats
npm test
```

Repository layout:

```text
dsh-bundles/
├── dsh-client-ui-task-notify/
├── dsh-client-ui-usage-stats/
└── dsh-bundle-mcp-toolkit/
```
