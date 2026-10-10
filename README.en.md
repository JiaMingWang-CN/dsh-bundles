# dsh-bundles

[中文](README.md) · **English**

A set of standalone plugins for the DeepSeek Harness (dsh) web profile: task-completion notifications, a CodeGraph + Context7 + Browser-Use MCP toolkit, and a free multi-engine web search provider.

Each directory is an independently installable bundle. Install only what you need.

## Table of Contents

- [What's included](#whats-included)
- [Quick install](#quick-install)
- [Installing the MCP tools](#installing-the-mcp-tools)
  - [CodeGraph](#codegraph)
  - [Context7](#context7)
  - [Browser-Use](#browser-use)
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

`dsh-bundle-mcp-toolkit` registers three stdio MCP servers with DSH:

- **CodeGraph**: uses a local code index for symbol lookup, call paths, and architecture exploration;
- **Context7**: supplies current third-party library documentation and examples to the agent;
- **Browser-Use**: lets the agent drive a real browser (open pages, click, fill forms, scrape content).

CodeGraph and Context7 launch through `npx -y` and Browser-Use through `uvx`; no global package installation is required.

### Web search

`dsh-web-search` gives the `web_search` tool a switchable search backend, chosen from the Web search page in the Settings sidebar and applied live. DSH itself is never modified; uninstalling restores the shipped behavior.

- Tavily (default): free tier of 1000 searches/month, LLM-optimized results;
- Model-native web search: MiMo server-side `web_search`, billed per search round (about ¥16 per 1000 plus token fees; activate the "Web Search plugin" in the MiMo console);
- DeepSeek official: the built-in search route, billed on the DeepSeek account;
- API keys are stored through the credentials domain, never as `settings.yaml` plaintext.

## Quick install

### Requirements

- DeepSeek Harness (dsh) is installed;
- Node.js 20 or newer when using the MCP toolkit;
- `npx` is available on Windows, macOS, or Linux;
- Browser-Use additionally requires `uv` (provides `uvx`; install from https://docs.astral.sh/uv/) and Python 3.12.

### Install from GitHub

Run the commands for the bundles you want:

```powershell
# Task-completion notifications
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-client-ui-task-notify"

# CodeGraph + Context7 + Browser-Use MCP toolkit
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-bundle-mcp-toolkit"

# Free multi-engine web search (Tavily / model-native / DeepSeek switchable)
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-web-search"
```

Confirm that the bundles are present in the web profile:

```powershell
dsh --profile web --dump-config
```

The first MCP startup takes longer because `npx`/`uvx` must download the server packages.

## Installing the MCP tools

The MCP bundle already contains the server configuration required by DSH. You only need to prepare the runtime and project indexes.

### CodeGraph

- **Project**: https://github.com/colbymchenry/codegraph

CodeGraph builds a local knowledge graph for source code. One MCP server can serve multiple projects, but every project needs its own `.codegraph/` index.

### Context7

- **Project**: https://github.com/upstash/context7

Context7 starts without manual setup by default. If the service reports rate limits or requests authentication, run `npx ctx7 setup` and follow the official guided setup.

### Browser-Use

- **Project**: https://github.com/browser-use/browser-use

Browser-Use launches through `uvx` and downloads its Python package on first run; it requires `uv` and Python 3.12 locally. The server process drives a real browser to perform web actions.

## Using the bundles

### Enable task notifications

1. Open DSH Settings;
2. Select Task notifications;
3. Enable notifications and choose a sound;
4. Allow system notifications when the browser asks for permission.

A notification is sent only when a main session transitions from running to complete while the page is not focused.

### Switch the web search tool

1. Open DSH Settings;
2. Go to Web search in the settings sidebar;
3. Pick the search tool (Tavily / model-native / DeepSeek official), enter the API key, and save.

Switching takes effect immediately with no restart; per-engine setup and billing notes live in `dsh-web-search/README.md`.

### Use the MCP tools

- CodeGraph queries require a `.codegraph/` index in the target project;
- Context7 requires no project initialization;
- Browser-Use requires no project initialization; tool calls drive a real browser;
- A slow first server launch is expected while `npx` downloads packages;
- Use `dsh --profile web --dump-config` to verify that the MCP clients are in the configuration stack.

## Updating and uninstalling

Update every installed plugin:

```powershell
dsh plugin --profile web update
```

Update one plugin:

```powershell
dsh plugin --profile web update dsh-web-search
```

Remove these bundles:

```powershell
dsh plugin --profile web remove -w dsh-client-ui-task-notify dsh-bundle-mcp-toolkit dsh-web-search
```

Restart DSH after updating or uninstalling.

## Troubleshooting

### CodeGraph cannot find an index

Run this from the root of the project being queried:

```powershell
codegraph init -i
```

### The MCP server is slow on first launch

CodeGraph and Context7 use `npx -y` and Browser-Use uses `uvx`. The first run downloads the package; later runs use the local cache.

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
└── dsh-web-search/
```
