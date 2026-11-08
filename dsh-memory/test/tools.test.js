import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, createChangeTracker } from "../lib/store.js";
import { memoryTools, installMemoryTools } from "../lib/tools.js";

const CWD = "C:\\Programs\\demo";
const execIn = (cwd) => ({ agent: { session: { header: { id: "s1", ...(cwd ? { cwd } : {}) } } } });

async function setup(t, options = {}) {
	const root = await mkdtemp(join(tmpdir(), "dsh-memory-tools-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new MemoryStore(root);
	const tools = Object.fromEntries(memoryTools(store, options).map((tool) => [tool.name, tool]));
	return { store, tools };
}

test("memory tools are list/read/write/delete", async (t) => {
	const { tools } = await setup(t);
	assert.deepEqual(Object.keys(tools).sort(), ["memory_delete", "memory_list", "memory_read", "memory_write"]);
});

test("memory_write then memory_read round-trips with version", async (t) => {
	const { tools } = await setup(t);
	const written = await tools.memory_write.execute({ scope: "project", path: "a.md", content: "rule" }, execIn(CWD));
	const read = await tools.memory_read.execute({ scope: "project", path: "a.md" }, execIn(CWD));
	assert.match(read.text, /rule/);
	assert.ok(read.text.includes(written.text.match(/version: (\w+)/)[1]));
});

test("project scope without a session cwd returns a tool error", async (t) => {
	const { tools } = await setup(t);
	await assert.rejects(tools.memory_write.execute({ scope: "project", path: "a.md", content: "x" }, execIn(undefined)), /working directory/);
	await tools.memory_write.execute({ scope: "user", path: "a.md", content: "x" }, execIn(undefined));
});

test("memory_write conflict surfaces re-read guidance", async (t) => {
	const { store, tools } = await setup(t);
	await store.write("project", CWD, "a.md", "from dreaming", null);
	await assert.rejects(tools.memory_write.execute({ scope: "project", path: "a.md", content: "mine" }, execIn(CWD)), /memory_read/);
	assert.equal((await store.read("project", CWD, "a.md")).content, "from dreaming");
});

test("invalid paths are refused", async (t) => {
	const { tools } = await setup(t);
	await assert.rejects(tools.memory_write.execute({ scope: "user", path: "../x.md", content: "x" }, execIn(CWD)), /invalid memory path|relative/);
});

test("cwdOf override and tracker are honored (dreaming mode)", async (t) => {
	const tracker = createChangeTracker();
	const { store, tools } = await setup(t, { cwdOf: () => CWD, tracker });
	await tools.memory_write.execute({ scope: "project", path: "a.md", content: "x" }, execIn(undefined));
	assert.equal((await store.read("project", CWD, "a.md")).content, "x");
	assert.deepEqual(tracker.summary(), { created: 1, modified: 0, deleted: 0 });
});

test("enabled=false unregisters tools; true re-registers", () => {
	const registered = new Set();
	const listeners = {};
	let enabled = true;
	const ctx = {
		tools: { register: (tool) => { registered.add(tool.name); return () => registered.delete(tool.name); } },
		on: (event, fn) => { listeners[event] = fn; return () => {}; }
	};
	installMemoryTools(ctx, new MemoryStore("/unused"), { enabled: { get: () => enabled } });
	assert.equal(registered.size, 4);
	enabled = false;
	listeners["loader/volatile-update"]();
	assert.equal(registered.size, 0);
	enabled = true;
	listeners["loader/volatile-update"]();
	assert.equal(registered.size, 4);
});
