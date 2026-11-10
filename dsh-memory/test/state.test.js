import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamState } from "../lib/state.js";

async function freshRoot(t) {
	const root = await mkdtemp(join(tmpdir(), "dsh-memory-state-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

async function loaded(root) {
	const state = new DreamState(root);
	await state.load();
	return state;
}

test("installedAt is set on first load and kept across reloads", async (t) => {
	const root = await freshRoot(t);
	const first = new DreamState(root, { now: () => 500 });
	await first.load();
	assert.equal(first.installedAt, 500);
	const second = new DreamState(root, { now: () => 900 });
	await second.load();
	assert.equal(second.installedAt, 500);
});

test("load on an empty root starts empty and unpaused", async (t) => {
	const state = await loaded(await freshRoot(t));
	assert.deepEqual(state.pending(), []);
	assert.equal(state.paused, null);
	assert.equal(state.watermark("s1"), 0);
	assert.deepEqual(state.recentLog(5), []);
});

test("queue survives reload until complete", async (t) => {
	const root = await freshRoot(t);
	const first = await loaded(root);
	await first.enqueue({ sessionId: "s1", cwd: "C:\\a", endedAt: 10, seq: 40 });
	const second = await loaded(root);
	assert.deepEqual(second.pending().map((job) => job.sessionId), ["s1"]);
	await second.complete([{ sessionId: "s1", seq: 40 }]);
	assert.equal(second.watermark("s1"), 40);
	const third = await loaded(root);
	assert.deepEqual(third.pending(), []);
	assert.equal(third.watermark("s1"), 40);
});

test("complete never lowers a watermark", async (t) => {
	const state = await loaded(await freshRoot(t));
	await state.enqueue({ sessionId: "s1", cwd: "C:\\a", endedAt: 1, seq: 50 });
	await state.complete([{ sessionId: "s1", seq: 50 }]);
	await state.enqueue({ sessionId: "s1", cwd: "C:\\a", endedAt: 2, seq: 30 });
	await state.complete([{ sessionId: "s1", seq: 30 }]);
	assert.equal(state.watermark("s1"), 50);
});

test("complete keeps a session re-queued with newer events during the run", async (t) => {
	const state = await loaded(await freshRoot(t));
	await state.enqueue({ sessionId: "s1", cwd: "C:\\a", endedAt: 1, seq: 100 });
	const batch = state.pending().map(({ sessionId, seq }) => ({ sessionId, seq }));
	await state.enqueue({ sessionId: "s1", cwd: "C:\\a", endedAt: 2, seq: 200 });
	await state.complete(batch);
	assert.equal(state.watermark("s1"), 100);
	assert.deepEqual(state.pending().map((job) => job.seq), [200]);
});

test("a torn log line is skipped instead of breaking load", async (t) => {
	const root = await freshRoot(t);
	const state = await loaded(root);
	await state.appendLog({ at: 1, cwd: "C:\\a", sessionIds: [], ok: true, trigger: "auto" });
	const { appendFile } = await import("node:fs/promises");
	await appendFile(join(root, ".state", "log.jsonl"), '{"at":2,"cwd":"C:');
	const reloaded = await loaded(root);
	assert.deepEqual(reloaded.recentLog(5).map((entry) => entry.at), [1]);
});

test("cross-project bookkeeping persists projects run since the last cross run", async (t) => {
	const root = await freshRoot(t);
	const state = await loaded(root);
	assert.deepEqual([state.crossProjects(), state.crossAt], [[], undefined]);
	await state.noteProjectRun("C:\\a");
	await state.noteProjectRun("C:\\a");
	await state.noteProjectRun("C:\\b");
	assert.deepEqual((await loaded(root)).crossProjects(), ["C:\\a", "C:\\b"]);
	await state.completeCross(42);
	const reloaded = await loaded(root);
	assert.deepEqual([reloaded.crossProjects(), reloaded.crossAt], [[], 42]);
});

test("enqueue dedupes by sessionId keeping latest seq", async (t) => {
	const state = await loaded(await freshRoot(t));
	await state.enqueue({ sessionId: "s1", cwd: "C:\\a", endedAt: 10, seq: 40 });
	await state.enqueue({ sessionId: "s1", cwd: "C:\\a", endedAt: 20, seq: 55 });
	assert.deepEqual(state.pending(), [{ sessionId: "s1", cwd: "C:\\a", endedAt: 20, seq: 55 }]);
});

test("pending orders by endedAt and filters by cwd", async (t) => {
	const state = await loaded(await freshRoot(t));
	await state.enqueue({ sessionId: "late", cwd: "C:\\a", endedAt: 30, seq: 1 });
	await state.enqueue({ sessionId: "other", cwd: "C:\\b", endedAt: 20, seq: 1 });
	await state.enqueue({ sessionId: "early", cwd: "C:\\a", endedAt: 10, seq: 1 });
	assert.deepEqual(state.pending().map((job) => job.sessionId), ["early", "other", "late"]);
	assert.deepEqual(state.pending("C:\\a").map((job) => job.sessionId), ["early", "late"]);
});

test("paused persists across reload", async (t) => {
	const root = await freshRoot(t);
	const state = await loaded(root);
	await state.setPaused({ since: 5, reason: "401 Unauthorized" });
	assert.deepEqual((await loaded(root)).paused, { since: 5, reason: "401 Unauthorized" });
	await state.setPaused(null);
	assert.equal((await loaded(root)).paused, null);
});

test("log keeps last 200 entries, newest last, across reload", async (t) => {
	const root = await freshRoot(t);
	const state = await loaded(root);
	for (let i = 0; i < 205; i++) await state.appendLog({ at: i, cwd: "C:\\a", sessionIds: [], ok: true, trigger: "auto" });
	const reloaded = await loaded(root);
	const all = reloaded.recentLog(1000);
	assert.equal(all.length, 200);
	assert.equal(all[0].at, 5);
	assert.equal(all.at(-1).at, 204);
	assert.deepEqual(reloaded.recentLog(2).map((entry) => entry.at), [203, 204]);
});

test("concurrent writes do not lose updates", async (t) => {
	const root = await freshRoot(t);
	const state = await loaded(root);
	await Promise.all(Array.from({ length: 20 }, (_v, i) => state.enqueue({ sessionId: `s${i}`, cwd: "C:\\a", endedAt: i, seq: 1 })));
	assert.equal((await loaded(root)).pending().length, 20);
});

test("a corrupt state.json is set aside and the plugin starts fresh", async (t) => {
	const root = await freshRoot(t);
	await mkdir(join(root, ".state"), { recursive: true });
	await writeFile(join(root, ".state", "state.json"), "{ not json", "utf8");
	const state = new DreamState(root, { now: () => 777 });
	await state.load();
	assert.equal(state.recovered, true);
	assert.deepEqual(state.pending(), []);
	assert.equal(state.installedAt, 777);
	assert.ok((await readdir(join(root, ".state"))).includes("state.json.corrupt-777"));
	for (const shape of ["[]", "null", '{"queue": 5}']) {
		await writeFile(join(root, ".state", "state.json"), shape, "utf8");
		const again = new DreamState(root);
		await again.load();
		assert.equal(again.recovered, true, shape);
	}
});

test("failures are counted per session and cleared when the session completes", async (t) => {
	const state = await loaded(await freshRoot(t));
	await state.enqueue({ sessionId: "s1", cwd: "C:\\a", endedAt: 1, seq: 10 });
	assert.deepEqual(await state.noteFailure(["s1", "s2"]), { s1: 1, s2: 1 });
	assert.deepEqual(await state.noteFailure(["s1"]), { s1: 2 });
	assert.equal(state.attempts("s1"), 2);
	await state.complete([{ sessionId: "s1", seq: 4 }]);
	assert.equal(state.attempts("s1"), 2, "partial progress is not a fresh start");
	await state.complete([{ sessionId: "s1", seq: 10 }]);
	assert.equal(state.attempts("s1"), 0);
	const reloaded = await loaded(state.dir.replace(/[\\/]\.state$/, ""));
	assert.equal(reloaded.attempts("s2"), 1, "counts survive a restart");
});

test("pruneSessions forgets finished sessions' bookkeeping but not queued ones", async (t) => {
	const state = await loaded(await freshRoot(t));
	await state.complete([{ sessionId: "old", seq: 3 }, { sessionId: "live", seq: 3 }, { sessionId: "queued", seq: 3 }]);
	await state.noteFailure(["old"]);
	await state.enqueue({ sessionId: "queued", cwd: "C:\\a", endedAt: 1, seq: 9 });
	await state.pruneSessions(["live"]);
	assert.deepEqual([state.watermark("old"), state.watermark("live"), state.watermark("queued")], [0, 3, 3]);
	assert.equal(state.attempts("old"), 0);
});

test("the first project run starts the cross-project clock", async (t) => {
	const state = new DreamState(await freshRoot(t), { now: () => 5000 });
	await state.load();
	await state.noteProjectRun("C:\\a");
	assert.equal(state.crossAt, 5000);
	assert.deepEqual(state.crossProjects(), ["C:\\a"]);
	const later = new DreamState(state.dir.replace(/[\\/]\.state$/, ""), { now: () => 9000 });
	await later.load();
	await later.noteProjectRun("C:\\b");
	assert.equal(later.crossAt, 5000, "an existing time is kept");
});

test("a failed state write leaves no temp file behind", async (t) => {
	const root = await freshRoot(t);
	const state = await loaded(root);
	await rm(state.stateFile, { force: true });
	await mkdir(state.stateFile);
	await assert.rejects(state.enqueue({ sessionId: "s", cwd: "C:\\a", endedAt: 1, seq: 1 }));
	assert.deepEqual((await readdir(state.dir)).filter((name) => name.endsWith(".tmp")), []);
});
