import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamState } from "../lib/state.js";
import { DreamRunner, reconcile, pruneDreamSessions } from "../lib/runner.js";

const A = "C:\\a";
const B = "C:\\b";

async function setup(t, { outcomes = [], enabled = true, autoDream = true } = {}) {
	const root = await mkdtemp(join(tmpdir(), "dsh-memory-runner-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new DreamState(root);
	await state.load();
	const calls = [];
	let active = 0;
	let maxActive = 0;
	const gates = [];
	const runDream = async (job) => {
		active++;
		maxActive = Math.max(maxActive, active);
		calls.push({ cwd: job.cwd, sessionIds: job.sessionIds });
		const gate = gates.shift();
		if (gate) await gate;
		active--;
		const outcome = outcomes.shift() ?? { ok: true };
		return outcome.ok ? { ok: true, changes: { created: 1, modified: 0, deleted: 0 }, dreamSessionId: `d${calls.length}` } : { ok: false, error: outcome.error ?? "boom", dreamSessionId: `d${calls.length}` };
	};
	const statuses = [];
	const runner = new DreamRunner({
		state,
		runDream,
		resolveSelection: () => ({ provider: "p", model: "m" }),
		config: { enabled: { get: () => enabled }, autoDream: { get: () => autoDream }, indexMaxBytes: { get: () => 4096 } },
		now: () => 1000,
		onStatus: (status) => statuses.push(status)
	});
	return { root, state, runner, calls, statuses, gates, get maxActive() { return maxActive; } };
}

const ended = (sessionId, cwd, endedAt, seq = 10) => ({ sessionId, cwd, endedAt, seq });

test("auto run consolidates one project per run and completes the batch only after ok", async (t) => {
	const h = await setup(t);
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.idle();
	assert.deepEqual(h.calls, [{ cwd: A, sessionIds: ["s1"] }]);
	assert.deepEqual(h.state.pending(), []);
	assert.equal(h.state.watermark("s1"), 10);
	assert.equal(h.state.recentLog(1)[0].trigger, "auto");
	assert.deepEqual(h.state.recentLog(1)[0].changes, { created: 1, modified: 0, deleted: 0 });
});

test("runs are strictly serial across projects", async (t) => {
	const h = await setup(t);
	let release;
	h.gates.push(new Promise((resolve) => { release = resolve; }));
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.onSessionEnded(ended("s2", B, 2));
	release();
	await h.runner.idle();
	assert.equal(h.maxActive, 1);
	assert.deepEqual(h.calls.map((call) => call.cwd), [A, B]);
});

test("failure pauses auto; later endings only enqueue; batch stays queued", async (t) => {
	const h = await setup(t, { outcomes: [{ ok: false, error: "401 Unauthorized" }] });
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.idle();
	assert.equal(h.state.paused.reason, "401 Unauthorized");
	assert.deepEqual(h.state.pending().map((job) => job.sessionId), ["s1"]);
	await h.runner.onSessionEnded(ended("s2", B, 2));
	await h.runner.idle();
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.state.pending().map((job) => job.sessionId), ["s1", "s2"]);
	assert.equal(h.statuses.at(-1).paused.reason, "401 Unauthorized");
	assert.equal(h.statuses.at(-1).pendingCount, 2);
});

test("manual success drains whole queue in endedAt order then resumes auto", async (t) => {
	const h = await setup(t, { outcomes: [{ ok: false }] });
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.idle();
	await h.runner.onSessionEnded(ended("s2", B, 2));
	await h.runner.onSessionEnded(ended("s3", A, 3));
	const report = await h.runner.runManual({ cwd: B });
	assert.equal(report.ok, true);
	assert.deepEqual(h.calls.slice(1).map((call) => [call.cwd, call.sessionIds]), [[B, ["s2"]], [A, ["s1", "s3"]]]);
	assert.equal(h.state.paused, null);
	assert.deepEqual(h.state.pending(), []);
	await h.runner.onSessionEnded(ended("s4", A, 4));
	await h.runner.idle();
	assert.deepEqual(h.calls.at(-1).sessionIds, ["s4"]);
});

test("manual failure keeps paused", async (t) => {
	const h = await setup(t, { outcomes: [{ ok: false }, { ok: false, error: "still broken" }] });
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.idle();
	const report = await h.runner.runManual({});
	assert.equal(report.ok, false);
	assert.equal(h.state.paused.reason, "still broken");
	assert.equal(h.state.recentLog(1)[0].trigger, "manual");
});

test("manual during running auto waits and both are logged", async (t) => {
	const h = await setup(t);
	let release;
	h.gates.push(new Promise((resolve) => { release = resolve; }));
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.state.enqueue(ended("s2", B, 2));
	const manual = h.runner.runManual({ cwd: B });
	assert.equal(h.maxActive, 1);
	release();
	await manual;
	await h.runner.idle();
	assert.equal(h.maxActive, 1);
	assert.deepEqual(h.state.recentLog(10).map((entry) => [entry.cwd, entry.trigger]), [[A, "auto"], [B, "manual"]]);
});

test("manual run excludes the invoking session", async (t) => {
	const h = await setup(t, { autoDream: false });
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.onSessionEnded(ended("me", A, 2));
	await h.runner.runManual({ cwd: A, excludeSessionId: "me" });
	assert.deepEqual(h.calls, [{ cwd: A, sessionIds: ["s1"] }]);
	assert.deepEqual(h.state.pending().map((job) => job.sessionId), ["me"]);
});

test("manual run with nothing to do reports ok without logging", async (t) => {
	const h = await setup(t);
	const report = await h.runner.runManual({ cwd: A });
	assert.deepEqual(report, { ok: true, runs: [] });
	assert.deepEqual(h.state.recentLog(5), []);
});

test("skips sessions whose seq <= watermark", async (t) => {
	const h = await setup(t);
	await h.runner.onSessionEnded(ended("s1", A, 1, 10));
	await h.runner.idle();
	await h.runner.onSessionEnded(ended("s1", A, 2, 10));
	await h.runner.idle();
	assert.equal(h.calls.length, 1);
});

test("a run failing because the plugin is shutting down neither pauses nor logs; the batch stays queued", async (t) => {
	const h = await setup(t, { outcomes: [{ ok: false, error: 'cannot get required service "agents" in inactive context' }] });
	let release;
	h.gates.push(new Promise((resolve) => { release = resolve; }));
	await h.runner.onSessionEnded(ended("s1", A, 1));
	h.runner.stop();
	release();
	await h.runner.idle();
	assert.equal(h.state.paused, null);
	assert.deepEqual(h.state.recentLog(5), []);
	assert.deepEqual(h.state.pending().map((job) => job.sessionId), ["s1"]);
});

test("a stopped runner still queues endings but starts no run", async (t) => {
	const h = await setup(t);
	h.runner.stop();
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.idle();
	assert.equal(h.calls.length, 0);
	assert.deepEqual(h.state.pending().map((job) => job.sessionId), ["s1"]);
});

test("enabled=false ignores session endings entirely", async (t) => {
	const h = await setup(t, { enabled: false });
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.idle();
	assert.equal(h.calls.length, 0);
	assert.deepEqual(h.state.pending(), []);
});

test("autoDream=false queues without running", async (t) => {
	const h = await setup(t, { autoDream: false });
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.idle();
	assert.equal(h.calls.length, 0);
	assert.equal(h.state.pending().length, 1);
});

test("reconcile queues recent eligible cold sessions with events past the watermark", async (t) => {
	const h = await setup(t);
	const day = 86_400_000;
	const now = 10 * day;
	const sessions = [
		{ header: { id: "fresh", cwd: A, createdAt: now - day }, live: false },
		{ header: { id: "live", cwd: A, createdAt: now - day }, live: true },
		{ header: { id: "old", cwd: A, createdAt: now - 8 * day }, live: false },
		{ header: { id: "child", cwd: A, createdAt: now - day, origin: "subagent" }, live: false },
		{ header: { id: "seen", cwd: A, createdAt: now - day }, live: false },
		{ header: { id: "otherProject", cwd: B, createdAt: now - day }, live: false }
	];
	await h.state.enqueue(ended("seen", A, 1, 5));
	await h.state.complete(["seen"]);
	const sessionQuery = {
		listSessions: async () => sessions,
		listEvents: async (id) => Array.from({ length: id === "seen" ? 5 : 7 }, (_v, i) => ({ seq: i + 1 }))
	};
	const added = await reconcile(sessionQuery, h.state, { now: () => now, cwd: A });
	assert.deepEqual(added, ["fresh"]);
	assert.deepEqual(h.state.pending().map((job) => [job.sessionId, job.seq]), [["fresh", 7]]);
});

test("pruneDreamSessions deletes only logged dreaming sessions beyond the newest 50", async (t) => {
	const h = await setup(t);
	const noCwd = join(h.root, "sessions", "_no-cwd");
	for (let i = 0; i < 53; i++) {
		await mkdir(join(noCwd, `session-${i}`), { recursive: true });
		await h.state.appendLog({ at: i, cwd: A, sessionIds: [], ok: true, trigger: "auto", dreamSessionId: `session-${i}` });
	}
	await mkdir(join(noCwd, "session-not-ours"), { recursive: true });
	await pruneDreamSessions(h.state, join(h.root, "sessions"));
	const left = (await readdir(noCwd)).sort();
	assert.equal(left.length, 51);
	assert.ok(left.includes("session-not-ours"));
	assert.ok(!left.includes("session-0") && !left.includes("session-2"));
	assert.ok(left.includes("session-3"));
});
