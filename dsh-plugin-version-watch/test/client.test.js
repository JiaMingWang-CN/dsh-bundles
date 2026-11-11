import test from "node:test";
import assert from "node:assert/strict";

/** Load the client half against a fake module loader and a tree-building React. */
async function load() {
	let plugin;
	const React = {
		createElement: (type, props, ...children) => ({
			type,
			props: props ?? {},
			children: children.flat().filter((child) => child !== null && child !== undefined && typeof child !== "boolean"),
		}),
	};
	globalThis.window = { __ModuleLoader__: { load: (record) => { plugin = record.factory(() => React); } } };
	globalThis.document = { createElement: () => ({ remove() {} }), head: { append() {} }, baseURI: "http://127.0.0.1:3000/" };
	await import(`../lib/client.js?test=${Math.random()}`);
	return plugin;
}

const texts = (node) => {
	if (node === null || node === undefined || typeof node === "boolean") return [];
	if (typeof node !== "object") return [String(node)];
	if (Array.isArray(node)) return node.flatMap(texts);
	return node.children.flatMap(texts);
};
const find = (node, predicate) => {
	if (node === null || typeof node !== "object") return [];
	if (Array.isArray(node)) return node.flatMap((child) => find(child, predicate));
	return [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => find(child, predicate))];
};

const DATA = {
	checkedAt: 1794207982297,
	hmr: true,
	profileKnown: true,
	plugins: [
		{
			name: "dsh-memory",
			title: { zh: "记忆", en: "Memory" },
			version: "0.1.0",
			enabled: true,
			kind: "git",
			source: "github:JiaMingWang-CN/dsh-bundles#path:dsh-memory",
			check: {
				status: "available",
				installedCommit: "508da581e6119619eef1ebf3c5d9478c6917a0a2",
				remoteCommit: "6253040adcf7ceea66f496e119a08acf76259fda",
				remoteVersion: "0.1.0",
			},
		},
		{
			name: "dsh-client-ui-task-notify",
			title: "dsh-client-ui-task-notify",
			version: "1.0.0",
			enabled: true,
			kind: "git",
			source: "github:JiaMingWang-CN/dsh-bundles#path:dsh-client-ui-task-notify",
			check: {
				status: "current",
				installedCommit: "dc7cc3428831fbad50f2cc7df8b5fefa9f6a19cd",
				remoteCommit: "dc7cc3428831fbad50f2cc7df8b5fefa9f6a19cd",
				remoteVersion: "1.0.0",
			},
		},
		{
			name: "dsh-plugin-version-watch",
			title: null,
			version: "0.1.0",
			enabled: true,
			kind: "local",
			source: "file:C:\\Programs\\dsh-bundles\\dsh-plugin-version-watch",
			check: { status: "unsupported", reason: "local" },
		},
	],
};

test("registers the 插件更新 Settings section and its icon", async () => {
	const plugin = await load();
	const registered = [];
	const t = (key) => plugin.DICT.zh[key] ?? key;
	const ctx = {
		effect: (effect) => effect(),
		locale: {
			register: () => () => {},
			bind: () => t,
			resolveText: (text) => (typeof text === "string" ? text : text?.zh ?? ""),
		},
		slots: {
			inject: (_name, factory) => factory(),
			register: (options, render) => {
				registered.push({ options, render });
				return () => {};
			},
		},
	};
	plugin.apply(ctx);
	const section = registered.find((entry) => entry.options.name === "settings.section");
	assert.equal(section.options.id, "plugin-updates");
	assert.equal(section.options.order, 35);
	assert.equal(section.options.label(), "插件更新");
	assert.equal(typeof section.render, "function");
	const icon = registered.find((entry) => entry.options.name === "settings.section.icon");
	assert.equal(icon.options.id, "plugin-updates");
	assert.equal(typeof icon.render, "function");
});

test("renders updates, up-to-date rows, and unsupported sources", async () => {
	const plugin = await load();
	const t = (key) => plugin.DICT.zh[key] ?? key;
	const tree = plugin.UpdatesView({
		t,
		data: DATA,
		phase: "ready",
		error: null,
		results: {},
		busy: null,
		resolveText: (text) => (typeof text === "string" ? text : text?.zh ?? ""),
	});
	const all = texts(tree).join("|");
	assert.match(all, /有新提交/);
	assert.match(all, /已是最新/);
	assert.match(all, /不支持自动更新/);
	assert.match(all, /1 个插件有可用更新/);
	assert.match(all, /提交 508da58/);
	assert.match(all, /→ 6253040/);
	assert.match(all, /记忆/);
});

test("the update button fires only for a plugin with an available update", async () => {
	const plugin = await load();
	const t = (key) => plugin.DICT.zh[key] ?? key;
	const clicked = [];
	const tree = plugin.UpdatesView({
		t,
		data: DATA,
		phase: "ready",
		error: null,
		results: {},
		busy: null,
		onUpdate: (item) => clicked.push(item.name),
		resolveText: (text) => (typeof text === "string" ? text : text?.zh ?? ""),
	});
	const buttons = find(tree, (node) => node.type === "button" && String(node.props.className ?? "").includes("dsh-vw-btn"));
	const updateButton = buttons.find((button) => texts(button).join("") === "更新 6253040");
	assert.ok(updateButton, "update button for the available plugin");
	assert.equal(updateButton.props.disabled, false);
	updateButton.props.onClick();
	assert.deepEqual(clicked, ["dsh-memory"]);
	assert.equal(buttons.find((button) => texts(button).join("") === "已是最新").props.disabled, true);
	assert.equal(buttons.find((button) => texts(button).join("").startsWith("不支持自动更新")).props.disabled, true);
});

test("update outcomes are worded by status and failure code", async () => {
	const plugin = await load();
	const t = (key) => plugin.DICT.zh[key] ?? key;
	assert.equal(plugin.resultText({ phase: "done", answer: { ok: true, status: "updated" } }, t).text, "已更新，新版本已实时生效，无需重启。");
	assert.match(
		plugin.resultText({ phase: "done", answer: { ok: true, status: "restart-required", restartReason: "no-hmr" } }, t).text,
		/需要重启/,
	);
	assert.match(
		plugin.resultText(
			{ phase: "done", answer: { ok: false, status: "failed", error: { code: "install-failed" }, source: "github:owner/repo#path:x" } },
			t,
		).text,
		/重装失败/,
	);
	assert.match(plugin.resultText({ phase: "failed", error: "boom" }, t).text, /更新失败 · boom/);
});

test("the update action targets the route this bundle registers", async () => {
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
	assert.match(source, /requestJson\(UPDATE_ROUTE/);
	assert.doesNotMatch(source, /UPDATE_URL/);
	assert.match(source, /const UPDATE_ROUTE = "api\/version-watch\/update"/);
});

test("a failed read replaces the list with an error line", async () => {
	const plugin = await load();
	const t = (key) => plugin.DICT.zh[key] ?? key;
	const tree = plugin.UpdatesView({
		t,
		data: null,
		phase: "failed",
		error: "HTTP 401",
		results: {},
		busy: null,
		resolveText: (text) => text,
	});
	assert.match(texts(tree).join("|"), /读取插件列表失败/);
});
