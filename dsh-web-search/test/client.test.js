import test from "node:test";
import assert from "node:assert/strict";

function reactHarness() {
	const state = [];
	const effects = [];
	let cursor = 0;
	let effectCursor = 0;
	const React = {
		createElement(type, props, ...children) {
			if (typeof type === "function") return type(props ?? {});
			return { type, props: props ?? {}, children };
		},
		useState(initial) {
			const index = cursor++;
			if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
			return [state[index], (value) => {
				state[index] = typeof value === "function" ? value(state[index]) : value;
			}];
		},
		useEffect(effect, deps) {
			const index = effectCursor++;
			const prev = effects[index];
			if (prev !== undefined && deps !== undefined && deps.length === prev.deps.length && deps.every((dep, i) => Object.is(dep, prev.deps[i]))) return;
			prev?.cleanup?.();
			effects[index] = { deps, cleanup: effect() };
		},
		useCallback(value) { return value; }
	};
	return { React, reset: () => { cursor = 0; effectCursor = 0; } };
}

function find(node, predicate, found = []) {
	if (Array.isArray(node)) {
		for (const child of node) find(child, predicate, found);
		return found;
	}
	if (node === null || typeof node !== "object") return found;
	if (predicate(node)) found.push(node);
	find(node.children, predicate, found);
	return found;
}

/** One settings scope stand-in: value, inherited base, revision, and writes. */
function makeForm(initial = {}, mutate) {
	const snapshot = {
		writable: true,
		value: { ...(initial.value ?? {}) },
		base: { ...(initial.base ?? {}) },
		revision: "r1"
	};
	const listeners = new Set();
	const calls = [];
	let revision = 1;
	const publish = () => {
		for (const listener of listeners) listener();
	};
	const apply = (ops) => {
		for (const op of ops) {
			const key = op.path[0];
			if (op.op === "set") snapshot.value[key] = op.value;
			else snapshot.value[key] = snapshot.base?.[key];
		}
		snapshot.revision = `r${++revision}`;
		publish();
	};
	return {
		calls,
		snapshot,
		apply,
		publish,
		getSnapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async mutate(ops) {
			calls.push(ops);
			if (mutate !== undefined) return mutate(ops, { apply, snapshot, publish });
			apply(ops);
		}
	};
}

async function mount(remote, mutate, options = {}) {
	const hooks = reactHarness();
	let plugin;
	const renders = {};
	const previousWindow = globalThis.window;
	const previousDocument = globalThis.document;
	globalThis.window = { __ModuleLoader__: { load: (record) => { plugin = record.factory(() => hooks.React); } } };
	globalThis.document = {
		createElement: () => ({ remove() {} }),
		head: { append() {} }
	};
	try {
		await import(`../lib/client.js?test=${Math.random()}`);
		const pluginForm = makeForm(options.plugin ?? { value: {} }, mutate);
		const webForm = makeForm(options.web ?? {
			value: { searchProvider: "web-search", fetchProvider: "http" },
			base: { searchProvider: "web-search", fetchProvider: "http" }
		});
		plugin.apply({
			configForms: {
				get: (namespace) => namespace === "web" ? webForm : pluginForm,
				whileServed: (_namespaces, register) => {
					const off = register();
					return () => off?.();
				}
			},
			remote,
			effect: (effect) => effect(),
			slots: {
				inject: (_name, install) => install(),
				register: (spec, render) => { renders[spec.name] = render; return () => {}; }
			}
		});
		return {
			host: pluginForm,
			web: webForm,
			render(slot = "settings.section", props = {}) {
				hooks.reset();
				return renders[slot](props);
			}
		};
	} finally {
		globalThis.window = previousWindow;
		globalThis.document = previousDocument;
	}
}

/** A remote whose credential lookup reports a configured key. */
function configuredRemote(configured = true) {
	return { credentials: {
		describe: async ([ref]) => ({ ok: true, value: { [ref]: { configured } } }),
		set: async () => ({ ok: true, value: undefined })
	} };
}

test("API key alone enables save and waits for credential persistence", async () => {
	let resolveSet;
	const writes = [];
	const mounted = await mount({ credentials: {
		describe: async () => ({ ok: true, value: {} }),
		set: (ref, value) => new Promise((resolve) => {
			writes.push({ ref, value });
			resolveSet = resolve;
		})
	} });
	let tree = mounted.render();
	tree = mounted.render();
	const key = find(tree, (node) => node.props.type === "password")[0];
	key.props.onChange({ target: { value: "secret" } });
	tree = mounted.render();
	let save = find(tree, (node) => node.props.className === "dsh-ws-save")[0];
	assert.equal(save.props.disabled, false);
	const pending = save.props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	tree = mounted.render();
	save = find(tree, (node) => node.props.className === "dsh-ws-save")[0];
	assert.equal(save.props.disabled, true);
	assert.deepEqual(writes, [{ ref: "TAVILY_API_KEY", value: "secret" }]);
	resolveSet({ ok: true, value: undefined });
	await pending;
});

test("engine selection remains a discardable draft", async () => {
	const mounted = await mount(configuredRemote());
	let tree = mounted.render();
	tree = mounted.render();
	const engineButtons = find(tree, (node) => typeof node.props.className === "string" && node.props.className.startsWith("dsh-ws-segbtn"));
	engineButtons[1].props.onClick();
	assert.equal(mounted.host.getSnapshot().value.engine, undefined);
	tree = mounted.render();
	assert.match(find(tree, (node) => node.props.className === "dsh-ws-segbtn on")[0].children.join(""), /模型/);
	find(tree, (node) => node.props.className === "dsh-ws-discard")[0].props.onClick();
	tree = mounted.render();
	assert.match(find(tree, (node) => node.props.className === "dsh-ws-segbtn on")[0].children.join(""), /Tavily/);
});

test("credential refusal stays open and reports a save failure", async () => {
	const mounted = await mount({ credentials: {
		describe: async () => ({ ok: true, value: {} }),
		set: async () => ({ ok: false, error: { message: "denied" } })
	} });
	let tree = mounted.render();
	tree = mounted.render();
	find(tree, (node) => node.props.type === "password")[0].props.onChange({ target: { value: "secret" } });
	tree = mounted.render();
	await find(tree, (node) => node.props.className === "dsh-ws-save")[0].props.onClick();
	tree = mounted.render();
	assert.equal(find(tree, (node) => node.props.className === "dsh-ws-failed").length, 1);
	assert.equal(find(tree, (node) => node.props.type === "password")[0].props.value, "secret");
});

test("a delayed settings publication does not report a false failure", async () => {
	const mounted = await mount(configuredRemote(), async (ops, form) => {
		setTimeout(() => form.apply(ops), 10);
	});
	let tree = mounted.render();
	tree = mounted.render();
	find(tree, (node) => node.children.join("") === "advanced")[0].props.onClick();
	tree = mounted.render();
	await find(tree, (node) => node.props.className === "dsh-ws-save")[0].props.onClick();
	tree = mounted.render();
	assert.equal(find(tree, (node) => node.props.className === "dsh-ws-failed").length, 0);
});

test("settings refusal is detected instead of silently closing", async () => {
	const mounted = await mount(configuredRemote(), async () => {});
	let tree = mounted.render();
	tree = mounted.render();
	find(tree, (node) => node.children.join("") === "advanced")[0].props.onClick();
	tree = mounted.render();
	await find(tree, (node) => node.props.className === "dsh-ws-save")[0].props.onClick();
	tree = mounted.render();
	assert.equal(find(tree, (node) => node.props.className === "dsh-ws-failed").length, 1);
});

test("a late credential lookup for a previous engine does not overwrite the badge", async () => {
	const pending = {};
	const mounted = await mount({ credentials: {
		describe: ([ref]) => new Promise((resolve) => { pending[ref] = resolve; }),
		set: async () => ({ ok: true, value: undefined })
	} });
	let tree = mounted.render();
	find(tree, (node) => node.props.className === "dsh-ws-segbtn")[0].props.onClick();
	tree = mounted.render();
	pending.MIMO1_API_KEY({ ok: true, value: { MIMO1_API_KEY: { configured: false } } });
	pending.TAVILY_API_KEY({ ok: true, value: { TAVILY_API_KEY: { configured: true } } });
	await new Promise((resolve) => setImmediate(resolve));
	tree = mounted.render();
	const badge = find(tree, (node) => {
		const text = Array.isArray(node.children) ? node.children.join("") : "";
		return text === "未配置密钥" || text === "已配置密钥";
	})[0];
	assert.equal(badge.children.join(""), "未配置密钥");
});

test("turning third-party search off writes the remembered built-in group", async () => {
	const mounted = await mount(configuredRemote(), undefined, {
		plugin: { value: { engine: "tavily", builtin: "api" } }
	});
	let tree = mounted.render();
	const toggle = find(tree, (node) => node.props.role === "switch")[0];
	assert.equal(toggle.props["aria-checked"], "true");
	await toggle.props.onClick();
	assert.deepEqual(mounted.web.calls[0], [
		{ op: "set", path: ["searchProvider"], value: "deepseek-search-api" },
		{ op: "set", path: ["fetchProvider"], value: "deepseek-fetch-api" }
	]);
	assert.deepEqual(mounted.web.snapshot.value, {
		searchProvider: "deepseek-search-api",
		fetchProvider: "deepseek-fetch-api"
	});
});

test("turning third-party search on remembers the built-in group and unsets web", async () => {
	const mounted = await mount(configuredRemote(), undefined, {
		plugin: { value: { engine: "tavily" } },
		web: {
			value: { searchProvider: "deepseek-official", fetchProvider: "http" },
			base: { searchProvider: "web-search", fetchProvider: "http" }
		}
	});
	let tree = mounted.render();
	const toggle = find(tree, (node) => node.props.role === "switch")[0];
	assert.equal(toggle.props["aria-checked"], "false");
	await toggle.props.onClick();
	assert.deepEqual(mounted.host.calls[0], [{ op: "set", path: ["builtin"], value: "messages" }]);
	assert.deepEqual(mounted.web.calls[0], [
		{ op: "unset", path: ["searchProvider"] },
		{ op: "unset", path: ["fetchProvider"] }
	]);
	assert.deepEqual(mounted.web.snapshot.value, {
		searchProvider: "web-search",
		fetchProvider: "http"
	});
	tree = mounted.render();
	assert.equal(find(tree, (node) => node.props.role === "switch")[0].props["aria-checked"], "true");
});

test("the master switch follows the web provider and disables without a key", async () => {
	const mounted = await mount(configuredRemote(false), undefined, {
		plugin: { value: { engine: "tavily" } },
		web: {
			value: { searchProvider: "deepseek-official", fetchProvider: "http" },
			base: { searchProvider: "web-search", fetchProvider: "http" }
		}
	});
	let tree = mounted.render();
	let toggle = find(tree, (node) => node.props.role === "switch")[0];
	assert.equal(toggle.props.disabled, true);
	assert.equal(find(tree, (node) => node.props.className === "dsh-ws-invalid").length, 1);

	mounted.web.snapshot.value.searchProvider = "web-search";
	mounted.web.publish();
	tree = mounted.render();
	toggle = find(tree, (node) => node.props.role === "switch")[0];
	assert.equal(toggle.props["aria-checked"], "true");
	assert.equal(toggle.props.disabled, false);
});

test("the row summary renders the one-liner without a credential lookup", async () => {
	let lookups = 0;
	const mounted = await mount({ credentials: {
		describe: async () => { lookups++; return { ok: true, value: {} }; },
		set: async () => ({ ok: true, value: undefined })
	} });
	assert.match(mounted.render("plugins.row.config", { view: "summary" }), /web_search/);
	assert.equal(lookups, 0);
});
