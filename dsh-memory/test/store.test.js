import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, mkdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, createChangeTracker, createBackup, pruneHistory } from "../lib/store.js";
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

test("remove with matching version deletes; tracker counts each note once by its net change", async (t) => {
	const { store, cleanup } = await fresh();
	t.after(cleanup);
	const tracker = createChangeTracker();
	const a = await store.write("project", CWD, "a.md", "1", null, tracker);
	await store.write("project", CWD, "a.md", "2", a.version, tracker);
	const b = await store.write("project", CWD, "b.md", "1", null, tracker);
	await assert.rejects(store.remove("project", CWD, "b.md", "stale"), { code: "MEMORY_CONFLICT" });
	await store.remove("project", CWD, "b.md", b.version, tracker);
	assert.equal(await store.read("project", CWD, "b.md"), null);
	assert.deepEqual(tracker.summary(), { created: 1, modified: 0, deleted: 0, paths: { created: ["a.md"], modified: [], deleted: [] } });
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

test("the write lock treats names that differ only by case as one file", async (t) => {
	const { store, cleanup } = await fresh();
	t.after(cleanup);
	const order = [];
	let release;
	const first = store.exclusive("C:\\m\\Note.md", async () => {
		order.push("first:start");
		await new Promise((resolve) => { release = resolve; });
		order.push("first:end");
	});
	await new Promise((resolve) => setImmediate(resolve));
	const second = store.exclusive("C:\\m\\note.md", async () => { order.push("second"); });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(order, ["first:start"], "the second waits for the first");
	release();
	await Promise.all([first, second]);
	assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

test("a run's first change to a note is backed up; later changes keep that first copy", async (t) => {
	const { root, store, cleanup } = await fresh();
	t.after(cleanup);
	const { version } = await store.write("user", undefined, "rules.md", "v1", null);
	const tracker = createChangeTracker({ backup: createBackup(root, "session-run1") });
	const second = await store.write("user", undefined, "rules.md", "v2", version, tracker);
	await store.write("user", undefined, "rules.md", "v3", second.version, tracker);
	await store.write("user", undefined, "fresh.md", "new", null, tracker);
	const saved = (name) => readFile(join(root, ".state", "history", "session-run1", "user", name), "utf8");
	assert.equal(await saved("rules.md"), "v1");
	await assert.rejects(saved("fresh.md"), /ENOENT/, "a new note has nothing to back up");
	const current = await store.read("user", undefined, "rules.md");
	await store.remove("user", undefined, "rules.md", current.version, tracker);
	assert.equal(await saved("rules.md"), "v1", "deleting does not replace the first copy");
});

test("deleting a note backs it up and removes the directories it leaves empty", async (t) => {
	const { root, store, cleanup } = await fresh();
	t.after(cleanup);
	const { version } = await store.write("user", undefined, "deep/er/x.md", "bye", null);
	const tracker = createChangeTracker({ backup: createBackup(root, "r") });
	await store.remove("user", undefined, "deep/er/x.md", version, tracker);
	assert.equal(await readFile(join(root, ".state", "history", "r", "user", "deep", "er", "x.md"), "utf8"), "bye");
	assert.deepEqual(await readdir(join(root, "user")), [], "empty directories are gone, the partition stays");
});

test("pruneHistory keeps the newest runs", async (t) => {
	const { root, cleanup } = await fresh();
	t.after(cleanup);
	const history = join(root, ".state", "history");
	for (const [index, name] of ["a", "b", "c", "d"].entries()) {
		await mkdir(join(history, name), { recursive: true });
		await utimes(join(history, name), 1000 + index, 1000 + index);
	}
	await pruneHistory(root, 2);
	assert.deepEqual((await readdir(history)).sort(), ["c", "d"]);
	await pruneHistory(join(root, "nowhere"), 2);
});

test("move renames a note across partitions in one step and refuses to overwrite", async (t) => {
	const { root, store, cleanup } = await fresh();
	t.after(cleanup);
	const { version } = await store.write("project", CWD, "sub/a.md", "lesson", null);
	const tracker = createChangeTracker({ backup: createBackup(root, "r") });
	await assert.rejects(store.move({ scope: "project", cwd: CWD, path: "sub/a.md" }, { scope: "user", path: "a.md" }, "stale", tracker), /changed since it was read/);
	const moved = await store.move({ scope: "project", cwd: CWD, path: "sub/a.md" }, { scope: "user", path: "moved/a.md" }, version, tracker);
	assert.equal(moved.version, version, "content is untouched");
	assert.equal(await store.read("project", CWD, "sub/a.md"), null);
	assert.equal((await store.read("user", undefined, "moved/a.md")).content, "lesson");
	assert.deepEqual(await readdir(partitionDir(root, "project", CWD)), [], "the emptied directory is removed");
	assert.equal(await readFile(join(root, ".state", "history", "r", "projects", (await readdir(join(root, "projects")))[0], "sub", "a.md"), "utf8"), "lesson");
	const other = await store.write("user", undefined, "b.md", "other", null);
	await assert.rejects(store.move({ scope: "user", path: "moved/a.md" }, { scope: "user", path: "b.md" }, version), /already exists/);
	await assert.rejects(store.move({ scope: "user", path: "b.md" }, { scope: "user", path: "B.md" }, other.version), /same note/);
});

test("search finds literal text across a partition's notes", async (t) => {
	const { store, cleanup } = await fresh();
	t.after(cleanup);
	await store.write("user", undefined, "a.md", "one\nUse --runInBand for DB tests\nthree", null);
	await store.write("user", undefined, "sub/b.md", "nothing here", null);
	assert.deepEqual(await store.search("user", undefined, "RUNINBAND"), ["a.md:2: Use --runInBand for DB tests"]);
	assert.deepEqual(await store.search("user", undefined, "absent"), []);
});

test("sweep removes stale .tmp files and leaves notes and fresh temp files", async (t) => {
	const { root, store, cleanup } = await fresh();
	t.after(cleanup);
	await mkdir(join(root, "user"), { recursive: true });
	await writeFile(join(root, "user", "keep.md"), "x");
	await writeFile(join(root, "user", ".old.tmp"), "x");
	await writeFile(join(root, "user", ".new.tmp"), "x");
	await utimes(join(root, "user", ".old.tmp"), 1, 1);
	await store.sweep();
	assert.deepEqual((await readdir(join(root, "user"))).sort(), [".new.tmp", "keep.md"]);
});

test("readIndexSync degrades to an empty index on any read error", async (t) => {
	const { root, store, cleanup } = await fresh();
	t.after(cleanup);
	assert.equal(store.readIndexSync("user"), null);
	await mkdir(join(root, "user", "INDEX.md"), { recursive: true });
	assert.equal(store.readIndexSync("user"), null, "EISDIR is not thrown");
	assert.equal(store.readIndexSync("project", undefined), null, "a bad cwd is not thrown");
});
