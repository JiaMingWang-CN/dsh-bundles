import test from "node:test";
import assert from "node:assert/strict";

function reactHarness() {
	const state = [];
	let cursor = 0;
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
		useEffect() {},
		useCallback(value) { return value; }
	};
	return { React, reset: () => { cursor = 0; } };
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

async function mount(remote, mutate) {
	const hooks = reactHarness();
	let plugin;
	let renderCard;
	const previousWindow = globalThis.window;
	const previousDocument = globalThis.document;
	globalThis.window = { __ModuleLoader__: { load: (record) => { plugin = record.factory(() => hooks.React); } } };
	globalThis.document = {
		createElement: () => ({ remove() {} }),
		head: { append() {} }
	};
	try {
		await import(`../lib/client.js?test=${Math.random()}`);
		const snapshot = { writable: true, value: {}, revision: "r1" };
		const listeners = new Set();
		const publish = (ops) => {
			for (const op of ops) snapshot.value[op.path[0]] = op.value;
			for (const listener of listeners) listener();
		};
		const host = {
			getSnapshot: () => snapshot,
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			async mutate(ops) {
				if (mutate !== undefined) return mutate(ops, snapshot, publish);
				publish(ops);
			}
		};
		plugin.apply({
			settingsScope: { bind: () => host },
			remote,
			effect: (effect) => effect(),
			slots: {
				inject: (_name, install) => install(),
				register: (_spec, render) => { renderCard = render; return () => {}; }
			}
		});
		return {
			host,
			render() {
				hooks.reset();
				return renderCard();
			}
		};
	} finally {
		globalThis.window = previousWindow;
		globalThis.document = previousDocument;
	}
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
	find(tree, (node) => node.props.className === "dsh-ws-header")[0].props.onClick();
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
	const mounted = await mount({ credentials: {
		describe: async () => ({ ok: true, value: {} }),
		set: async () => ({ ok: true, value: undefined })
	} });
	let tree = mounted.render();
	find(tree, (node) => node.props.className === "dsh-ws-header")[0].props.onClick();
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
	find(tree, (node) => node.props.className === "dsh-ws-header")[0].props.onClick();
	tree = mounted.render();
	find(tree, (node) => node.props.type === "password")[0].props.onChange({ target: { value: "secret" } });
	tree = mounted.render();
	await find(tree, (node) => node.props.className === "dsh-ws-save")[0].props.onClick();
	tree = mounted.render();
	assert.equal(find(tree, (node) => node.props.className === "dsh-ws-failed").length, 1);
	assert.equal(find(tree, (node) => node.props.type === "password")[0].props.value, "secret");
});

test("a delayed settings publication does not report a false failure", async () => {
	const mounted = await mount({ credentials: {
		describe: async () => ({ ok: true, value: {} }),
		set: async () => ({ ok: true, value: undefined })
	} }, async (ops, _snapshot, publish) => {
		setTimeout(() => publish(ops), 10);
	});
	let tree = mounted.render();
	find(tree, (node) => node.props.className === "dsh-ws-header")[0].props.onClick();
	tree = mounted.render();
	find(tree, (node) => node.children.join("") === "advanced")[0].props.onClick();
	tree = mounted.render();
	await find(tree, (node) => node.props.className === "dsh-ws-save")[0].props.onClick();
	tree = mounted.render();
	assert.equal(find(tree, (node) => node.props.className === "dsh-ws-failed").length, 0);
});

test("settings refusal is detected instead of silently closing", async () => {
	const mounted = await mount({ credentials: {
		describe: async () => ({ ok: true, value: {} }),
		set: async () => ({ ok: true, value: undefined })
	} }, async () => {});
	let tree = mounted.render();
	find(tree, (node) => node.props.className === "dsh-ws-header")[0].props.onClick();
	tree = mounted.render();
	find(tree, (node) => node.children.join("") === "advanced")[0].props.onClick();
	tree = mounted.render();
	await find(tree, (node) => node.props.className === "dsh-ws-save")[0].props.onClick();
	tree = mounted.render();
	assert.equal(find(tree, (node) => node.props.className === "dsh-ws-failed").length, 1);
});
