import test from "node:test";
import assert from "node:assert/strict";

/** Load the client half against a fake module loader and a tree-building React. */
async function load() {
	let plugin;
	const React = {
		createElement: (type, props, ...children) => typeof type === "function"
			? type({ ...props, children: children.flat() })
			: { type, props: props ?? {}, children: children.flat() },
		useState: (init) => [typeof init === "function" ? init() : init, () => {}],
		useEffect: () => {}
	};
	globalThis.window = { __ModuleLoader__: { load: (record) => { plugin = record.factory(() => React); } } };
	globalThis.document = { createElement: () => ({ remove() {} }), head: { append() {} } };
	await import(`../lib/client.js?test=${Math.random()}`);
	return plugin;
}

function fakeHost(value) {
	const writes = [];
	return { writes, getSnapshot: () => ({ value }), subscribe: () => () => {}, set: (field, next) => writes.push([field, next]) };
}

const texts = (node) => (node === null || node === undefined || typeof node === "boolean" ? [] : typeof node !== "object" ? [String(node)] : node.children.flatMap(texts));
const find = (node, predicate) => {
	if (node === null || typeof node !== "object") return [];
	return [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => find(child, predicate))];
};

const STATUS = {
	root: "C:\\Users\\me\\.dsh\\memory",
	paused: { since: Date.UTC(2026, 10, 8, 1, 10), reason: "401 Unauthorized" },
	running: null,
	pendingCount: 2,
	log: [
		{ at: Date.UTC(2026, 10, 8, 6, 32), cwd: "C:\\Programs\\dsh-bundles", sessionIds: ["a", "b", "c"], ok: true, trigger: "auto", changes: { created: 1, modified: 2, deleted: 0 } },
		{ at: Date.UTC(2026, 10, 8, 7, 0), cwd: "C:\\Programs\\minibot", sessionIds: ["d"], ok: false, trigger: "auto", error: "401 Unauthorized" }
	]
};
const VALUE = { enabled: true, autoDream: true, idleMinutes: 10, indexMaxBytes: 4096, dreamProvider: "", dreamModel: "", dreamRequest: "", status: STATUS };

test("registers the 记忆 settings section", async () => {
	const plugin = await load();
	const registered = [];
	plugin.apply({
		configForms: { get: (ns) => { assert.equal(ns, "memory"); return fakeHost(VALUE); } },
		effect: (fn) => fn(),
		slots: { inject: (_name, fn) => fn(), register: (def, render) => { registered.push({ def, render }); return () => {}; } }
	});
	assert.equal(registered[0].def.name, "settings.section");
	assert.equal(registered[0].def.label, "记忆");
});

test("renders paused banner, pending count, newest-first log and memory paths", async () => {
	const plugin = await load();
	const all = texts(plugin.SettingsPage({ host: fakeHost(VALUE) })).join("|");
	assert.match(all, /自动 dreaming 已暂停/);
	assert.match(all, /401 Unauthorized/);
	assert.match(all, /待处理：2 个会话/);
	assert.ok(all.indexOf("minibot") < all.indexOf("dsh-bundles"), "newest run first");
	assert.match(all, /新增 1 \/ 修改 2 \/ 删除 0/);
	assert.match(all, /C:\\Users\\me\\\.dsh\\memory\\projects/);
});

test("dream-now button writes a fresh dreamRequest and is disabled while running", async () => {
	const plugin = await load();
	const host = fakeHost(VALUE);
	const [button] = find(plugin.SettingsPage({ host }), (node) => node.type === "button" && texts(node).join("") === "立即 dream");
	button.props.onClick();
	assert.equal(host.writes[0][0], "dreamRequest");
	assert.match(host.writes[0][1], /^\d+$/);
	const busy = fakeHost({ ...VALUE, status: { ...STATUS, running: { cwd: "C:\\x" } } });
	const [disabled] = find(plugin.SettingsPage({ host: busy }), (node) => node.type === "button" && texts(node).join("") === "立即 dream");
	assert.equal(disabled.props.disabled, true);
	assert.match(texts(plugin.SettingsPage({ host: busy })).join("|"), /正在整理：x/);
});

test("retry on a failed log row also requests a manual run", async () => {
	const plugin = await load();
	const host = fakeHost(VALUE);
	const [retry] = find(plugin.SettingsPage({ host }), (node) => node.type === "button" && texts(node).join("") === "重试");
	retry.props.onClick();
	assert.equal(host.writes[0][0], "dreamRequest");
});

test("toggles and inputs write volatile config fields", async () => {
	const plugin = await load();
	const host = fakeHost(VALUE);
	const tree = plugin.SettingsPage({ host });
	const switches = find(tree, (node) => node.props.role === "switch");
	assert.deepEqual(switches.map((node) => node.props["aria-label"]), ["记忆", "自动 dreaming"]);
	switches[1].props.onClick();
	assert.deepEqual(host.writes.at(-1), ["autoDream", false]);
	const [idle] = find(tree, (node) => node.props["aria-label"] === "空闲阈值（分钟）");
	idle.props.onChange({ target: { value: "15" } });
	assert.deepEqual(host.writes.at(-1), ["idleMinutes", 15]);
	idle.props.onChange({ target: { value: "0" } });
	assert.deepEqual(host.writes.at(-1), ["idleMinutes", 15], "invalid values are not written");
	const [model] = find(tree, (node) => node.props["aria-label"] === "dreaming 模型 id");
	model.props.onBlur({ target: { value: " deepseek-flash " } });
	assert.deepEqual(host.writes.at(-1), ["dreamModel", "deepseek-flash"]);
});
