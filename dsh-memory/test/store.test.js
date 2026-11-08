import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, createChangeTracker } from "../lib/store.js";
import { partitionDir } from "../lib/paths.js";

const CWD = "C:\\Programs\\demo";

async function fresh() {
	const root = await mkdtemp(join(tmpdir(), "dsh-memory-store-"));
	return { root, store: new MemoryStore(root), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("write with null version creates and returns a version", async (t) => {
	const { store, cleanup } = await fresh();
	t.after(cleanup);
	const { version } = await store.write("project", CWD, "rules/test.md", "hello", null);
	assert.equal(typeof version, "string");
	const read = await store.read("project", CWD, "rules/test.md");
	assert.deepEqual(read, { content: "hello", version });
});

test("read of a missing note returns null", async (t) => {
	const { store, cleanup } = await fresh();
	t.after(cleanup);
	assert.equal(await store.read("user", undefined, "nope.md"), null);
});

test("write with stale version throws MEMORY_CONFLICT and leaves file unchanged", async (t) => {
	const { store, cleanup } = await fresh();
	t.after(cleanup);
	const first = await store.write("project", CWD, "a.md", "v1", null);
	const second = await store.write("project", CWD, "a.md", "v2 longer", first.version);
	await assert.rejects(store.write("project", CWD, "a.md", "stale", first.version), (error) => {
		assert.equal(error.code, "MEMORY_CONFLICT");
		assert.equal(error.currentVersion, second.version);
		return true;
	});
	assert.equal((await store.read("project", CWD, "a.md")).content, "v2 longer");
});

test("write with null version on an existing file throws MEMORY_CONFLICT", async (t) => {
	const { store, cleanup } = await fresh();
	t.after(cleanup);
	await store.write("user", undefined, "a.md", "v1", null);
	await assert.rejects(store.write("user", undefined, "a.md", "v2", null), { code: "MEMORY_CONFLICT" });
});

test("remove with matching version deletes; tracker counts created/modified/deleted", async (t) => {
	const { store, cleanup } = await fresh();
	t.after(cleanup);
	const tracker = createChangeTracker();
	const a = await store.write("project", CWD, "a.md", "1", null, tracker);
	await store.write("project", CWD, "a.md", "2", a.version, tracker);
	const b = await store.write("project", CWD, "b.md", "1", null, tracker);
	await assert.rejects(store.remove("project", CWD, "b.md", "stale"), { code: "MEMORY_CONFLICT" });
	await store.remove("project", CWD, "b.md", b.version, tracker);
	assert.equal(await store.read("project", CWD, "b.md"), null);
	assert.deepEqual(tracker.summary(), { created: 2, modified: 1, deleted: 1 });
});

test("list omits .state and non-.md files and reports nested paths with forward slashes", async (t) => {
	const { root, store, cleanup } = await fresh();
	t.after(cleanup);
	await store.write("project", CWD, "INDEX.md", "# index", null);
	await store.write("project", CWD, "gameplay/rules.md", "r", null);
	const dir = partitionDir(root, "project", CWD);
	await writeFile(join(dir, "notes.txt"), "x");
	await mkdir(join(root, ".state"), { recursive: true });
	await writeFile(join(root, ".state", "x.md"), "x");
	const listed = (await store.list("project", CWD)).map((entry) => entry.path).sort();
	assert.deepEqual(listed, ["INDEX.md", "gameplay/rules.md"]);
	assert.deepEqual(await store.list("user", undefined), []);
});

test("readIndex returns INDEX.md content or null", async (t) => {
	const { store, cleanup } = await fresh();
	t.after(cleanup);
	assert.equal(await store.readIndex("project", CWD), null);
	await store.write("project", CWD, "INDEX.md", "- [a](a.md) — x", null);
	assert.equal(await store.readIndex("project", CWD), "- [a](a.md) — x");
});

test("interleaved writes with the same version: exactly one wins, the other conflicts", async (t) => {
	const { store, cleanup } = await fresh();
	t.after(cleanup);
	const { version } = await store.write("project", CWD, "a.md", "base", null);
	const results = await Promise.allSettled([
		store.write("project", CWD, "a.md", "from session", version),
		store.write("project", CWD, "a.md", "from dreaming", version)
	]);
	assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
	assert.equal(results.find((r) => r.status === "rejected").reason.code, "MEMORY_CONFLICT");
	const winner = results[0].status === "fulfilled" ? "from session" : "from dreaming";
	assert.equal((await store.read("project", CWD, "a.md")).content, winner);
});

test("write leaves no temporary files behind", async (t) => {
	const { root, store, cleanup } = await fresh();
	t.after(cleanup);
	await store.write("user", undefined, "a.md", "x", null);
	const { readdir } = await import("node:fs/promises");
	assert.deepEqual(await readdir(join(root, "user")), ["a.md"]);
	assert.equal(await readFile(join(root, "user", "a.md"), "utf8"), "x");
});
