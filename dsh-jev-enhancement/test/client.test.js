import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Cordis facade members every context exposes without `inject`. */
const FACADE = new Set(["effect"]);

/**
 * A hook harness: `useState` keeps slots across manual re-renders and `useEffect`
 * runs inline, so one component can be rendered, settled, and rendered again to
 * observe async-loaded state (the model catalog) without a real React runtime.
 */
function createHarness() {
	const React = {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
		slots: [],
		cursor: 0,
		useState(initial) {
			const index = React.cursor;
			React.cursor += 1;
			if (!(index in React.slots)) React.slots[index] = typeof initial === "function" ? initial() : initial;
			return [React.slots[index], (value) => { React.slots[index] = typeof value === "function" ? value(React.slots[index]) : value; }];
		},
		useEffect(fn) {
			fn();
		},
		useCallback(fn) {
			return fn;
		},
		/** Render (or re-render) one element with the persistent hook slots. */
		render(element) {
			React.cursor = 0;
			return element.type(element.props);
		}
	};
	return React;
}

/** Load the browser bundle through a stub ModuleLoader + the hook harness. */
function loadClient(React) {
	const source = readFileSync(join(root, "lib", "client.js"), "utf8");
	let loaded;
	const sandbox = {
		window: { __ModuleLoader__: { load: (entry) => { loaded = entry; } } },
		document: { createElement: () => ({ remove() {} }), head: { append() {} } },
		fetch: async () => ({ json: async () => ({}) }),
		console
	};
	vm.runInNewContext(source, sandbox, { filename: "client.js" });
	assert.ok(loaded !== undefined, "the bundle registers itself with the module loader");
	assert.equal(loaded.id, "dsh-jev-enhancement");
	return loaded.factory((name) => {
		assert.equal(name, "react");
		return React;
	});
}

/**
 * A context double enforcing the cordis access guard: any property outside the
 * plugin's declared `inject` (plus the facade) throws exactly like the harness,
 * so a missing declaration fails the test instead of blanking the settings page.
 */
function guardedContext(module, services) {
	const ctx = new Proxy({}, {
		get(_target, prop) {
			if (typeof prop === "symbol") return undefined;
			const name = String(prop);
			if (FACADE.has(name)) return services[name];
			if (Array.from(module.inject).includes(name)) return services[name];
			throw new Error(`cannot get property "${name}" without inject`);
		}
	});
	return ctx;
}

/** Collect every string rendered anywhere in an element tree. */
function texts(node, out = []) {
	if (node === null || node === undefined || node === false) return out;
	if (typeof node === "string" || typeof node === "number") {
		out.push(String(node));
		return out;
	}
	if (Array.isArray(node)) {
		for (const child of node) texts(child, out);
		return out;
	}
	for (const child of node.children ?? []) texts(child, out);
	return out;
}

/** Mount the settings page and return its root element. */
function mount(React) {
	const module = loadClient(React);
	let render;
	const scopeSnapshot = { writable: true, value: {} };
	const services = {
		effect: () => {},
		remote: {
			credentials: { describe: async () => ({ ok: true, value: {} }) },
			session: {
				modelCatalog: async () => ({
					ok: true,
					value: {
						default: { provider: "deepseek", model: "chat" },
						routableProviders: ["deepseek"],
						failures: [],
						groups: [
							{ id: "deepseek", name: "DeepSeek", models: [{ id: "chat", name: "DeepSeek Chat" }, { id: "reasoner", name: "DeepSeek Reasoner" }] },
							{ id: "openai", name: "OpenAI", models: [{ id: "gpt-5", name: "GPT-5" }] }
						]
					}
				})
			}
		},
		sessions: { list: { getSnapshot: () => ({ current: "session-1" }) } },
		settingsScope: {
			bind: (spec) => {
				assert.equal(spec.namespace, "jev-enhancement");
				return { getSnapshot: () => scopeSnapshot, subscribe: () => () => {}, mutate: async () => {} };
			}
		},
		slots: {
			inject: (slot, register) => {
				assert.equal(slot, "settings.section");
				register();
			},
			register: (descriptor, factory) => {
				mount.registration = descriptor;
				render = factory;
			}
		}
	};
	const ctx = guardedContext(module, services);
	module.apply(ctx);
	return { module, element: render(), registration: mount.registration };
}

/** Let pending promises (catalog and status loads) settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the client bundle loads and registers the Jev 增强 settings section", async () => {
	const React = createHarness();
	const { module, element, registration } = mount(React);
	assert.equal(module.name, "jev-enhancement");
	assert.deepEqual(
		Array.from(module.inject),
		["slots", "sessions", "settingsScope", "remote", "remote.credentials", "remote.session"],
		"every ctx service the page touches must be declared in inject"
	);
	assert.equal(registration.id, "jev-enhancement");
	assert.equal(registration.label, "Jev 增强");
	assert.equal(registration.order, 36);
	assert.equal(element.type.name, "SettingsPage");
	assert.equal(element.props.sessions.list.getSnapshot().current, "session-1", "the page resolves the current session at click time");
	assert.doesNotThrow(() => React.render(element), "the first render must not crash the settings section");
	await settle();
});

test("the model list renders from the configured-model catalog, with no manual add", async () => {
	const React = createHarness();
	const { element } = mount(React);
	React.render(element);
	await settle();
	const tree = React.render(element);
	const text = texts(tree).join("\n");
	assert.ok(text.includes("DeepSeek Chat"), "catalog model names render");
	assert.ok(text.includes("deepseek/reasoner"), "rows carry the exact provider/model identity");
	assert.ok(text.includes("GPT-5"));
	assert.ok(text.includes("原生流程"), "unenabled models are labeled as native");
	assert.ok(text.includes("导出日志"), "the audit log exports as one file from the page");
	assert.ok(!text.includes("添加模型"), "manual model entry is gone");
	assert.ok(!text.includes("模型 ID"), "no free-form model id field");
});

test("rosterGroups merges the catalog with saved policies and keeps stale entries removable", () => {
	const React = createHarness();
	const { module } = mount(React);
	const catalog = { groups: [{ id: "deepseek", name: "DeepSeek", models: [{ id: "chat", name: "DeepSeek Chat" }] }] };
	const saved = [
		{ key: "deepseek/chat", providerId: "deepseek", modelId: "chat", enabled: true },
		{ key: "gone/model", providerId: "gone", modelId: "model", enabled: false }
	];
	const roster = module.testing.rosterGroups(catalog, saved.map((entry) => ({ ...entry, compaction: {}, decision: {} })));
	assert.equal(roster.groups.length, 1);
	assert.equal(roster.groups[0].providerId, "deepseek");
	assert.equal(roster.groups[0].models[0].modelName, "DeepSeek Chat");
	assert.equal(roster.groups[0].models[0].policy.enabled, true, "a saved policy attaches to its catalog row");
	assert.equal(roster.stale.length, 1);
	assert.equal(roster.stale[0].key, "gone/model");
	assert.equal(roster.stale[0].stale, true);
	const empty = module.testing.rosterGroups(null, []);
	assert.equal(empty.groups.length, 0);
	assert.equal(empty.stale.length, 0);
	const fresh = module.testing.rosterGroups(catalog, []);
	assert.equal(fresh.groups[0].models[0].policy.enabled, false, "an unsaved catalog model is never implicitly enabled");
});

test("accessing an undeclared service throws exactly like the harness guard", () => {
	const React = createHarness();
	const module = loadClient(React);
	const ctx = guardedContext(module, { effect: () => {} });
	assert.throws(() => ctx.llm, /cannot get property "llm" without inject/);
});
