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
	const mutations = [];
	return {
		writes,
		mutations,
		getSnapshot: () => ({ value }),
		subscribe: () => () => {},
		set: (field, next) => writes.push([field, next]),
		mutate: async (ops) => { mutations.push(ops); }
	};
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
	const busy = fakeHost({ ...VALUE, status: { ...STATUS, running: [{ cwd: "C:\\x" }] } });
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
	const [concurrency] = find(tree, (node) => node.props["aria-label"] === "并发数");
	assert.equal(concurrency.props.value, "4");
	concurrency.props.onChange({ target: { value: "2" } });
	assert.deepEqual(host.writes.at(-1), ["concurrency", 2]);
	concurrency.props.onChange({ target: { value: "0" } });
	assert.deepEqual(host.writes.at(-1), ["concurrency", 2], "invalid values are not written");
});

test("status lists every project being consolidated", async () => {
	const plugin = await load();
	const busy = fakeHost({ ...VALUE, status: { ...STATUS, running: [{ cwd: "C:\\x" }, { cwd: "C:\\y" }] } });
	assert.match(texts(plugin.SettingsPage({ host: busy })).join("|"), /正在整理：x、y/);
});

const GROUPS = [
	{ id: "deepseek-official", name: "DeepSeek", models: [{ id: "deepseek-flash", name: "DeepSeek Flash" }, { id: "deepseek-pro", name: "DeepSeek Pro" }] },
	{ id: "mimo", name: "MiMo", models: [{ id: "mimo-v2", name: "MiMo V2" }] }
];

test("modelOptions lists the default first, then every catalog model", async () => {
	const plugin = await load();
	const options = plugin.modelOptions(GROUPS, "", "");
	assert.equal(options[0].value, "");
	assert.match(options[0].label, /默认模型/);
	assert.deepEqual(options.slice(1).map((option) => option.label), ["DeepSeek · DeepSeek Flash", "DeepSeek · DeepSeek Pro", "MiMo · MiMo V2"]);
});

test("modelOptions keeps a saved model that is no longer in the catalog, marked unavailable", async () => {
	const plugin = await load();
	const options = plugin.modelOptions(GROUPS, "gone", "old-model");
	assert.match(options.at(-1).label, /不可用.*gone.*old-model/);
	assert.equal(options.at(-1).value, plugin.modelKey("gone", "old-model"));
});

const REASONING_GROUPS = [
	{ id: "deepseek-official", name: "DeepSeek", models: [
		{ id: "deepseek-pro", name: "DeepSeek Pro", reasoning: { defaultEffort: "high", efforts: [{ id: "low", name: "低" }, { id: "high", name: "高" }] } },
		{ id: "deepseek-lite", name: "DeepSeek Lite" }
	] }
];

test("effortOptions follow the chosen model's supported levels", async () => {
	const plugin = await load();
	const pro = plugin.effortOptions(REASONING_GROUPS, "deepseek-official", "deepseek-pro", "");
	assert.equal(pro.disabled, false);
	assert.deepEqual(pro.options.map((option) => [option.value, option.label]), [["", "模型默认（高）"], ["low", "低"], ["high", "高"]]);
	const lite = plugin.effortOptions(REASONING_GROUPS, "deepseek-official", "deepseek-lite", "");
	assert.equal(lite.disabled, true);
	assert.match(lite.options[0].label, /不支持/);
	const followDefault = plugin.effortOptions(REASONING_GROUPS, "", "", "");
	assert.equal(followDefault.disabled, true);
	assert.match(followDefault.options[0].label, /跟随默认/);
	const stale = plugin.effortOptions(REASONING_GROUPS, "deepseek-official", "deepseek-pro", "max");
	assert.match(stale.options.at(-1).label, /不可用：max/);
});

test("choosing an effort writes dreamEffort", async () => {
	const plugin = await load();
	const host = fakeHost({ ...VALUE, dreamProvider: "deepseek-official", dreamModel: "deepseek-pro" });
	const [select] = find(plugin.SettingsPage({ host }), (node) => node.type === "select" && node.props["aria-label"] === "思考强度");
	select.props.onChange({ target: { value: "low" } });
	assert.deepEqual(host.writes.at(-1), ["dreamEffort", "low"]);
});

test("choosing a model in the select writes provider and model together", async () => {
	const plugin = await load();
	const host = fakeHost({ ...VALUE, dreamProvider: "mimo", dreamModel: "mimo-v2" });
	const [select] = find(plugin.SettingsPage({ host }), (node) => node.type === "select" && node.props["aria-label"] === "dreaming 模型");
	assert.equal(select.props.value, plugin.modelKey("mimo", "mimo-v2"));
	select.props.onChange({ target: { value: plugin.modelKey("deepseek-official", "deepseek-pro") } });
	assert.deepEqual(host.mutations.at(-1), [
		{ op: "set", path: ["dreamProvider"], value: "deepseek-official" },
		{ op: "set", path: ["dreamModel"], value: "deepseek-pro" },
		{ op: "set", path: ["dreamEffort"], value: "" }
	]);
	select.props.onChange({ target: { value: "" } });
	assert.deepEqual(host.mutations.at(-1).map((op) => op.value), ["", "", ""]);
});

test("log rows flag ok runs with issues and name the cross-project run", async () => {
	const plugin = await load();
	const log = [
		{ at: Date.UTC(2026, 10, 8, 8, 0), cwd: "C:\Programs\n2sql", sessionIds: ["a"], ok: true, trigger: "auto", changes: { created: 0, modified: 1, deleted: 0 }, issues: ["tool error: session not found", "x.md: unverified"] },
		{ at: Date.UTC(2026, 10, 8, 9, 0), scope: "cross", sessionIds: [], ok: true, trigger: "auto", changes: { created: 1, modified: 0, deleted: 3 }, issues: [] }
	];
	const tree = plugin.SettingsPage({ host: fakeHost({ ...VALUE, status: { ...STATUS, paused: null, log, running: [{ scope: "cross" }] } }) });
	const all = texts(tree).join("|");
	assert.match(all, /有 2 个问题：tool error: session not found/);
	assert.match(all, /跨项目\|全部分区/);
	assert.match(all, /正在整理：跨项目/);
	assert.equal(find(tree, (node) => typeof node.props?.className === "string" && node.props.className.includes("dsh-mem-dot warn")).length, 1);
});

test("number fields save only whole numbers inside their range, and indexMaxBytes has a field", async () => {
	const plugin = await load();
	const host = fakeHost(VALUE);
	const tree = plugin.SettingsPage({ host });
	const field = (label) => find(tree, (node) => node.props["aria-label"] === label)[0];
	field("并发数").props.onChange({ target: { value: "99" } });
	field("空闲阈值（分钟）").props.onChange({ target: { value: "1.5" } });
	field("空闲阈值（分钟）").props.onChange({ target: { value: "" } });
	assert.deepEqual(host.writes, [], "above the maximum, fractional and empty input are not saved");
	field("索引大小上限（字节）").props.onChange({ target: { value: "100" } });
	assert.deepEqual(host.writes, [], "below the minimum is not saved");
	field("索引大小上限（字节）").props.onChange({ target: { value: "8192" } });
	assert.deepEqual(host.writes.at(-1), ["indexMaxBytes", 8192]);
	assert.equal(field("索引大小上限（字节）").props.value, "4096", "shows the stored value");
});

test("the paused banner says what to do for the cause, and the status shows retry and notice", async () => {
	const plugin = await load();
	const page = (status) => texts(plugin.SettingsPage({ host: fakeHost({ ...VALUE, status: { ...STATUS, ...status } }) })).join("|");
	assert.match(page({ paused: { since: 1, reason: "401", kind: "auth" } }), /修好模型或密钥后/);
	assert.match(page({ paused: { since: 1, reason: "连续失败 3 次：fetch failed", kind: "repeated" } }), /网络或服务暂时不可用/);
	assert.match(page({ paused: { since: 1, reason: "x" } }), /排查原因后点/);
	assert.match(page({ paused: null, retryAt: Date.UTC(2026, 10, 8, 3, 0) }), /将于 \d\d-\d\d \d\d:\d\d 自动重试/);
	assert.match(page({ paused: null, notice: { at: 1, text: "没有需要整理的会话。" } }), /没有需要整理的会话/);
});

test("dream-now and retry are disabled while memory is off", async () => {
	const plugin = await load();
	const tree = plugin.SettingsPage({ host: fakeHost({ ...VALUE, enabled: false }) });
	const [dreamNow] = find(tree, (node) => node.type === "button" && texts(node).join("") === "立即 dream");
	const [retry] = find(tree, (node) => node.type === "button" && texts(node).join("") === "重试");
	assert.equal(dreamNow.props.disabled, true);
	assert.equal(retry.props.disabled, true);
});

test("log rows can be expanded and a skipped batch is labelled as skipped", async () => {
	const plugin = await load();
	const status = { ...STATUS, log: [{ at: 1, cwd: "C:\p", sessionIds: ["a"], ok: false, trigger: "auto", error: "skipped after 3 attempts: blocked", skipped: true }] };
	const tree = plugin.SettingsPage({ host: fakeHost({ ...VALUE, status }) });
	const all = texts(tree).join("|");
	assert.match(all, /已跳过：skipped after 3 attempts/);
	assert.equal(find(tree, (node) => node.type === "button" && texts(node).join("") === "详情").length, 1);
	assert.equal(find(tree, (node) => node.type === "button" && texts(node).join("") === "重试").length, 0, "a skipped batch has nothing to retry");
});
