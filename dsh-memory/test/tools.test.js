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

test("memory tools are list/read/write/delete/move/search", async (t) => {
	const { tools } = await setup(t);
	assert.deepEqual(Object.keys(tools).sort(), ["memory_delete", "memory_list", "memory_move", "memory_read", "memory_search", "memory_write"]);
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
	assert.equal(registered.size, 6);
	enabled = false;
	listeners["loader/volatile-update"]();
	assert.equal(registered.size, 0);
	enabled = true;
	listeners["loader/volatile-update"]();
	assert.equal(registered.size, 6);
});

test("INDEX limits apply however the file name is cased", async (t) => {
	const { tools } = await setup(t);
	const big = "x".repeat(5000);
	for (const path of ["INDEX.md", "index.md", "Index.MD"]) {
		await assert.rejects(tools.memory_write.execute({ scope: "project", path, content: big }, execIn(CWD)), /limit is 4096/, path);
	}
	await assert.rejects(tools.memory_write.execute({ scope: "user", path: "index.md", content: big }, execIn(CWD)), /limit is 4096/);
});

test("memory_move renames within a partition, keeps the content and refuses INDEX.md", async (t) => {
	const { tools, store } = await setup(t);
	const written = await tools.memory_write.execute({ scope: "project", path: "a.md", content: "rule" }, execIn(CWD));
	const version = written.text.match(/version: (\w+)/)[1];
	const moved = await tools.memory_move.execute({ scope: "project", path: "a.md", version, toPath: "topic/a.md" }, execIn(CWD));
	assert.match(moved.text, /Moved a.md/);
	assert.equal((await store.read("project", CWD, "topic/a.md")).content, "rule");
	await assert.rejects(tools.memory_move.execute({ scope: "project", path: "topic/a.md", version, toPath: "INDEX.md" }, execIn(CWD)), /INDEX.md cannot be moved/);
	assert.equal(tools.memory_move.parameters.toScope, undefined, "a session cannot move a note between partitions");
});

test("cross-project memory_move promotes between partitions and records both sides", async (t) => {
	const tracker = createChangeTracker();
	const { tools, store } = await setup(t, { projects: [CWD], tracker });
	const written = await tools.memory_write.execute({ scope: "project", project: CWD, path: "lesson.md", content: "x" }, execIn());
	const version = written.text.match(/version: (\w+)/)[1];
	await tools.memory_move.execute({ scope: "project", project: CWD, path: "lesson.md", version, toScope: "user", toPath: "lesson.md" }, execIn());
	assert.equal(await store.read("project", CWD, "lesson.md"), null);
	assert.equal((await store.read("user", undefined, "lesson.md")).content, "x");
	const summary = tracker.summary();
	assert.deepEqual(summary.paths.created, ["user/lesson.md"]);
	assert.deepEqual(summary.paths.deleted, []);
});

test("memory_search returns hits with their location", async (t) => {
	const { tools } = await setup(t);
	await tools.memory_write.execute({ scope: "project", path: "a.md", content: "line one\nFlaky on Windows" }, execIn(CWD));
	assert.equal((await tools.memory_search.execute({ scope: "project", query: "flaky" }, execIn(CWD))).text, "a.md:2: Flaky on Windows");
	assert.equal((await tools.memory_search.execute({ scope: "project", query: "zzz" }, execIn(CWD))).text, "No matches.");
});

test("a read-only project partition refuses writes, deletes and moves into it, but still reads", async (t) => {
	const { tools, store } = await setup(t, { projectWritable: false });
	const { version } = await store.write("project", CWD, "old.md", "kept", null);
	await assert.rejects(tools.memory_write.execute({ scope: "project", path: "n.md", content: "x" }, execIn(CWD)), /no longer exists/);
	await assert.rejects(tools.memory_delete.execute({ scope: "project", path: "old.md", version }, execIn(CWD)), /no longer exists/);
	assert.match((await tools.memory_read.execute({ scope: "project", path: "old.md" }, execIn(CWD))).text, /kept/);
	assert.equal((await tools.memory_write.execute({ scope: "user", path: "u.md", content: "x", basis: "user-stated" }, execIn(CWD))).text.startsWith("Saved"), true);
});

test("a dreaming tracker hands the store a backup hook for every tool that changes a note", async (t) => {
	const backed = [];
	const tracker = createChangeTracker({ backup: async (file) => { backed.push(file); } });
	const { tools } = await setup(t, { tracker });
	const first = await tools.memory_write.execute({ scope: "project", path: "a.md", content: "v1" }, execIn(CWD));
	assert.deepEqual(backed, [], "creating needs no backup");
	const version = first.text.match(/version: (\w+)/)[1];
	await tools.memory_write.execute({ scope: "project", path: "a.md", content: "v2", version }, execIn(CWD));
	assert.equal(backed.length, 1);
});

test("a subagent session can read memory but not change it", async (t) => {
	const { tools, store } = await setup(t);
	const { version } = await store.write("project", CWD, "a.md", "kept", null);
	const sub = { agent: { session: { header: { id: "c", cwd: CWD, origin: "subagent" } } } };
	const child = { agent: { session: { header: { id: "d", cwd: CWD, parentSession: "p" } } } };
	for (const exec of [sub, child]) {
		assert.match((await tools.memory_read.execute({ scope: "project", path: "a.md" }, exec)).text, /kept/);
		assert.match((await tools.memory_list.execute({ scope: "project" }, exec)).text, /a\.md/);
		await assert.rejects(tools.memory_write.execute({ scope: "project", path: "b.md", content: "x" }, exec), /Subagents cannot change memory/);
		await assert.rejects(tools.memory_delete.execute({ scope: "project", path: "a.md", version }, exec), /Subagents cannot change memory/);
		await assert.rejects(tools.memory_move.execute({ scope: "project", path: "a.md", version, toPath: "c.md" }, exec), /Subagents cannot change memory/);
	}
	assert.equal((await store.read("project", CWD, "a.md")).content, "kept");
	assert.match((await tools.memory_write.execute({ scope: "project", path: "b.md", content: "x" }, execIn(CWD))).text, /^Saved/, "the parent session still writes");
});

test("a note holding a recognisable secret is refused", async (t) => {
	const { tools } = await setup(t);
	for (const secret of ["-----BEGIN RSA PRIVATE KEY-----\nabc", "key AKIAABCDEFGHIJKLMNOP", "token sk-abcdefghijklmnopqrstuvwx", "ghp_" + "a".repeat(36), "AIza" + "b".repeat(35)]) {
		await assert.rejects(tools.memory_write.execute({ scope: "project", path: "s.md", content: secret }, execIn(CWD)), /looks like a secret/, secret.slice(0, 12));
	}
	assert.match((await tools.memory_write.execute({ scope: "project", path: "ok.md", content: "The key is configured in .env (OPENAI_API_KEY); sk-... is not stored." }, execIn(CWD))).text, /^Saved/);
});

test("a note created as index.md is stored and found as INDEX.md", async (t) => {
	const { tools, store } = await setup(t);
	await tools.memory_write.execute({ scope: "project", path: "index.md", content: "- [a](a.md)" }, execIn(CWD));
	assert.deepEqual((await store.list("project", CWD)).map((entry) => entry.path), ["INDEX.md"]);
	assert.match((await tools.memory_read.execute({ scope: "project", path: "Index.MD" }, execIn(CWD))).text, /a\.md/);
});
