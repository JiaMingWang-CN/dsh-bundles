import test from "node:test";
import assert from "node:assert/strict";

/** Load the client half against fake browser globals and a fake client context. */
async function mount({ enabled = true, sound = "system", permission = "granted", visible = false, focused = false } = {}) {
	let plugin;
	const notifications = [];
	const opened = [];
	globalThis.window = { __ModuleLoader__: { load: (record) => { plugin = record.factory(() => ({ createElement: () => null })); } }, focus() {} };
	globalThis.document = {
		createElement: () => ({ remove() {} }),
		head: { append() {} },
		get visibilityState() { return visible ? "visible" : "hidden"; },
		hasFocus: () => focused
	};
	globalThis.Notification = class {
		static permission = permission;
		constructor(title, options) {
			this.title = title;
			this.options = options;
			notifications.push(this);
		}
	};
	await import(`../lib/client.js?test=${Math.random()}`);
	let list = { ids: [], byId: {} };
	const listeners = new Set();
	const host = { getSnapshot: () => ({ value: { enabled, sound } }), subscribe: () => () => {} };
	plugin.apply({
		configForms: { get: () => host },
		sessions: { list: { getSnapshot: () => list, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } } },
		uiWorkspace: { openSession: (id) => opened.push(id) },
		effect: (effect) => effect(),
		slots: { inject: () => {}, register: () => () => {} }
	});
	return {
		notifications,
		opened,
		/** Publish a new session list; rows are { id, running, ...extra }. */
		publish(rows) {
			list = { ids: rows.map((row) => row.id), byId: Object.fromEntries(rows.map((row) => [row.id, row])) };
			for (const listener of listeners) listener();
		}
	};
}

test("a main session finishing off-screen raises one notification", async () => {
	const mounted = await mount();
	mounted.publish([{ id: "s1", running: true, displayTitle: "Fix bug" }]);
	mounted.publish([{ id: "s1", running: false, displayTitle: "Fix bug" }]);
	mounted.publish([{ id: "s1", running: false, displayTitle: "Fix bug" }]);
	assert.equal(mounted.notifications.length, 1);
	assert.match(mounted.notifications[0].options.body, /^Fix bug/);
	assert.equal(mounted.notifications[0].options.silent, false);
	mounted.notifications[0].onclick();
	assert.deepEqual(mounted.opened, ["s1"]);
});

test("subagent sessions never notify", async () => {
	const mounted = await mount();
	mounted.publish([{ id: "child", running: true, parentId: "s1" }]);
	mounted.publish([{ id: "child", running: false, parentId: "s1" }]);
	assert.equal(mounted.notifications.length, 0);
});

test("the session shown in a focused, visible view does not notify", async () => {
	const mounted = await mount({ visible: true, focused: true });
	mounted.publish([{ id: "s1", running: true, retainedBy: { mainView: 1 } }]);
	mounted.publish([{ id: "s1", running: false, retainedBy: { mainView: 1 } }]);
	assert.equal(mounted.notifications.length, 0);
});

test("disabled setting or ungranted permission suppresses notifications", async () => {
	for (const options of [{ enabled: false }, { permission: "default" }]) {
		const mounted = await mount(options);
		mounted.publish([{ id: "s1", running: true }]);
		mounted.publish([{ id: "s1", running: false }]);
		assert.equal(mounted.notifications.length, 0);
	}
});

test("a removed session that reappears idle does not notify", async () => {
	const mounted = await mount();
	mounted.publish([{ id: "s1", running: true }]);
	mounted.publish([]);
	mounted.publish([{ id: "s1", running: false }]);
	assert.equal(mounted.notifications.length, 0);
});

test("a custom sound silences the OS notification sound", async () => {
	const mounted = await mount({ sound: "silent" });
	mounted.publish([{ id: "s1", running: true }]);
	mounted.publish([{ id: "s1", running: false }]);
	assert.equal(mounted.notifications[0].options.silent, true);
});
