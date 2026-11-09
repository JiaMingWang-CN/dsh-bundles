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
	await tools.memory_write.execute({ scope: "user", path: "a.md", content: "x", basis: "user-stated" }, execIn(undefined));
});

test("memory_write conflict surfaces re-read guidance", async (t) => {
	const { store, tools } = await setup(t);
	await store.write("project", CWD, "a.md", "from dreaming", null);
	await assert.rejects(tools.memory_write.execute({ scope: "project", path: "a.md", content: "mine" }, execIn(CWD)), /memory_read/);
	assert.equal((await store.read("project", CWD, "a.md")).content, "from dreaming");
});

test("invalid paths are refused", async (t) => {
	const { tools } = await setup(t);
	await assert.rejects(tools.memory_write.execute({ scope: "project", path: "../x.md", content: "x" }, execIn(CWD)), /invalid memory path|relative/);
});

test("cwdOf override and tracker are honored (dreaming mode)", async (t) => {
	const tracker = createChangeTracker();
	const { store, tools } = await setup(t, { cwdOf: () => CWD, tracker });
	await tools.memory_write.execute({ scope: "project", path: "a.md", content: "x" }, execIn(undefined));
	assert.equal((await store.read("project", CWD, "a.md")).content, "x");
	assert.deepEqual(tracker.summary(), { created: 1, modified: 0, deleted: 0, paths: { created: ["project/a.md"], modified: [], deleted: [] } });
});

test("the change tracker counts each note once by its state before and after the run", async (t) => {
	const tracker = createChangeTracker();
	const { store, tools } = await setup(t, { cwdOf: () => CWD, tracker });
	await store.write("project", CWD, "old.md", "x", null);
	await store.write("project", CWD, "gone.md", "x", null);
	let version = (await tools.memory_write.execute({ scope: "project", path: "new.md", content: "1" }, {})).text.match(/version: (\w+)/)[1];
	version = (await tools.memory_write.execute({ scope: "project", path: "new.md", content: "2", version }, {})).text.match(/version: (\w+)/)[1];
	let oldVersion = (await store.read("project", CWD, "old.md")).version;
	for (const content of ["a", "b", "c"]) oldVersion = (await tools.memory_write.execute({ scope: "project", path: "old.md", content, version: oldVersion }, {})).text.match(/version: (\w+)/)[1];
	await tools.memory_delete.execute({ scope: "project", path: "gone.md", version: (await store.read("project", CWD, "gone.md")).version }, {});
	const temp = (await tools.memory_write.execute({ scope: "project", path: "temp.md", content: "t" }, {})).text.match(/version: (\w+)/)[1];
	await tools.memory_delete.execute({ scope: "project", path: "temp.md", version: temp }, {});
	assert.deepEqual(tracker.summary(), { created: 1, modified: 1, deleted: 1, paths: { created: ["project/new.md"], modified: ["project/old.md"], deleted: ["project/gone.md"] } });
});

test("a new user note needs basis user-stated; editing one and the user INDEX do not", async (t) => {
	const { store, tools } = await setup(t);
	await assert.rejects(tools.memory_write.execute({ scope: "user", path: "lesson.md", content: "x" }, execIn(CWD)), /basis "user-stated".*project partition/s);
	assert.equal(await store.read("user", undefined, "lesson.md"), null);
	await tools.memory_write.execute({ scope: "user", path: "prefs.md", content: "x", basis: "user-stated" }, execIn(CWD));
	const version = (await store.read("user", undefined, "prefs.md")).version;
	await tools.memory_write.execute({ scope: "user", path: "prefs.md", content: "y", version }, execIn(CWD));
	await tools.memory_write.execute({ scope: "user", path: "INDEX.md", content: "- [prefs](prefs.md) — how the user works" }, execIn(CWD));
	assert.equal((await store.read("user", undefined, "prefs.md")).content, "y");
});

test("INDEX.md writes over the byte budget or with paragraph-long lines are refused", async (t) => {
	const { store, tools } = await setup(t, { indexMaxBytes: () => 600 });
	const lines = Array.from({ length: 12 }, (_v, i) => `- [note ${i}](n${i}.md) — one short sentence about it`).join("\n");
	await assert.rejects(tools.memory_write.execute({ scope: "project", path: "INDEX.md", content: lines }, execIn(CWD)), /limit is 600/);
	await assert.rejects(tools.memory_write.execute({ scope: "project", path: "INDEX.md", content: `- [w](w.md) — ${"long ".repeat(60)}` }, execIn(CWD)), /240 bytes/);
	assert.equal(await store.read("project", CWD, "INDEX.md"), null);
	await tools.memory_write.execute({ scope: "project", path: "INDEX.md", content: "- [w](w.md) — Windows scripts: encoding pitfalls" }, execIn(CWD));
});

test("a note over the soft size is saved with a warning to split it", async (t) => {
	const { tools } = await setup(t);
	const big = await tools.memory_write.execute({ scope: "project", path: "big.md", content: "x".repeat(4000) }, execIn(CWD));
	assert.match(big.text, /Saved big\.md[\s\S]*Warning: this note is 4000 bytes/);
	const small = await tools.memory_write.execute({ scope: "project", path: "small.md", content: "x" }, execIn(CWD));
	assert.doesNotMatch(small.text, /Warning/);
});

test("cross-project mode names the project on project-scope calls and drops the user gate", async (t) => {
	const tracker = createChangeTracker();
	const other = "C:\\Programs\\other";
	const { store, tools } = await setup(t, { projects: [CWD, other], tracker });
	await tools.memory_write.execute({ scope: "project", project: other, path: "a.md", content: "x" }, {});
	assert.equal((await store.read("project", other, "a.md")).content, "x");
	await assert.rejects(tools.memory_read.execute({ scope: "project", project: "C:\\nowhere", path: "a.md" }, {}), /Unknown project/);
	await assert.rejects(tools.memory_read.execute({ scope: "project", path: "a.md" }, {}), /Unknown project/);
	await tools.memory_write.execute({ scope: "user", path: "general.md", content: "x" }, {});
	assert.deepEqual(tracker.summary().paths.created, ["project:other/a.md", "user/general.md"]);
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
