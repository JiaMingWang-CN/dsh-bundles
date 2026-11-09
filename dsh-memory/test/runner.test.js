import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readdir, writeFile } from "node:fs/promises";
import { zstdCompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamState } from "../lib/state.js";
import { DreamRunner, reconcile, pruneDreamSessions } from "../lib/runner.js";

const A = "C:\\a";
const B = "C:\\b";
const C = "C:\\c";

async function setup(t, { outcomes = [], enabled = true, autoDream = true, concurrency = 4, listProjects } = {}) {
	const root = await mkdtemp(join(tmpdir(), "dsh-memory-runner-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new DreamState(root, { now: () => 0 });
	await state.load();
	const calls = [];
	let active = 0;
	let maxActive = 0;
	const gates = [];
	const runDream = async (job) => {
		active++;
		maxActive = Math.max(maxActive, active);
		calls.push(job.projects ? { projects: job.projects } : { cwd: job.cwd, sessionIds: job.sessionIds });
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
		config: { enabled: { get: () => enabled }, autoDream: { get: () => autoDream }, indexMaxBytes: { get: () => 4096 }, concurrency: { get: () => concurrency } },
		now: () => 1000,
		...(listProjects ? { listProjects } : {}),
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

async function until(condition) {
	for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(condition(), "condition not reached");
}

const gate = (h) => {
	let release;
	h.gates.push(new Promise((resolve) => { release = resolve; }));
	return () => release();
};

test("different projects run in parallel up to the concurrency limit", async (t) => {
	const h = await setup(t, { concurrency: 2 });
	const releases = [gate(h), gate(h), gate(h)];
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.onSessionEnded(ended("s2", B, 2));
	await h.runner.onSessionEnded(ended("s3", C, 3));
	assert.deepEqual(h.calls.map((call) => call.cwd), [A, B], "a third project waits for a free slot");
	assert.deepEqual(h.runner.status().running.map((run) => run.cwd), [A, B]);
	releases[0]();
	await until(() => h.calls.length === 3);
	assert.deepEqual(h.runner.status().running.map((run) => run.cwd), [B, C], "a freed slot goes to the waiting project");
	for (const release of releases) release();
	await h.runner.idle();
	assert.equal(h.maxActive, 2);
	assert.deepEqual(h.calls.map((call) => call.cwd), [A, B, C]);
	assert.deepEqual(h.state.pending(), []);
	assert.equal(h.runner.status().running, null);
});

test("concurrency 1 keeps runs serial across projects", async (t) => {
	const h = await setup(t, { concurrency: 1 });
	const release = gate(h);
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.onSessionEnded(ended("s2", B, 2));
	release();
	await h.runner.idle();
	assert.equal(h.maxActive, 1);
	assert.deepEqual(h.calls.map((call) => call.cwd), [A, B]);
});

test("one project never has two runs at once", async (t) => {
	const h = await setup(t);
	const release = gate(h);
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.onSessionEnded(ended("s2", A, 2));
	assert.equal(h.calls.length, 1);
	release();
	await h.runner.idle();
	assert.equal(h.maxActive, 1);
	assert.deepEqual(h.calls.map((call) => call.sessionIds), [["s1"], ["s2"]]);
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

test("manual for a project being consolidated waits for that run; both are logged", async (t) => {
	const h = await setup(t);
	const release = gate(h);
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.state.enqueue(ended("s2", A, 2));
	const manual = h.runner.runManual({ cwd: A });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(h.calls.length, 1);
	release();
	await manual;
	await h.runner.idle();
	assert.equal(h.maxActive, 1);
	assert.deepEqual(h.state.recentLog(10).map((entry) => [entry.cwd, entry.trigger]), [[A, "auto"], [A, "manual"]]);
});

test("manual for another project runs alongside a running auto", async (t) => {
	const h = await setup(t);
	const release = gate(h);
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.state.enqueue(ended("s2", B, 2));
	const report = await h.runner.runManual({ cwd: B });
	assert.equal(report.ok, true);
	assert.equal(h.maxActive, 2);
	release();
	await h.runner.idle();
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
	await h.state.complete([{ sessionId: "seen", seq: 5 }]);
	const sessionQuery = {
		listSessions: async () => sessions,
		listEvents: async (id) => Array.from({ length: id === "seen" ? 5 : 7 }, (_v, i) => ({ seq: i + 1, type: "turn/end", data: { reason: { kind: "completed" } } }))
	};
	const added = await reconcile(sessionQuery, h.state, { now: () => now, cwd: A });
	assert.deepEqual(added, ["fresh"]);
	assert.deepEqual(h.state.pending().map((job) => [job.sessionId, job.seq]), [["fresh", 7]]);
});

test("reconcile skips sessions whose new events are not worth a run", async (t) => {
	const h = await setup(t);
	const day = 86_400_000;
	const completed = (seq) => ({ seq, type: "turn/end", data: { reason: { kind: "completed" } } });
	const sessionQuery = {
		listSessions: async () => [
			{ header: { id: "greeting", cwd: A, createdAt: h.state.installedAt + 1 }, live: false },
			{ header: { id: "aborted", cwd: A, createdAt: h.state.installedAt + 1 }, live: false },
			{ header: { id: "work", cwd: A, createdAt: h.state.installedAt + 1 }, live: false }
		],
		listEvents: async (id) => ({
			greeting: [{ seq: 1, type: "user/message" }, completed(2)],
			aborted: [{ seq: 1, type: "turn/end", data: { reason: { kind: "aborted" } } }],
			work: [{ seq: 1, type: "assistant/message", data: { message: { content: [{ type: "tool-call", name: "pwsh" }] } } }, completed(2)]
		})[id]
	};
	assert.deepEqual(await reconcile(sessionQuery, h.state, { now: () => h.state.installedAt + day }), ["work"]);
});

test("reconcile never backfills sessions created before the plugin was installed", async (t) => {
	const h = await setup(t);
	const day = 86_400_000;
	const sessionQuery = {
		listSessions: async () => [
			{ header: { id: "beforeInstall", cwd: A, createdAt: h.state.installedAt - 1 }, live: false },
			{ header: { id: "afterInstall", cwd: A, createdAt: h.state.installedAt + 1 }, live: false }
		],
		listEvents: async () => [{ seq: 1, type: "turn/end", data: { reason: { kind: "completed" } } }, { seq: 2, type: "turn/end", data: { reason: { kind: "completed" } } }]
	};
	const added = await reconcile(sessionQuery, h.state, { now: () => h.state.installedAt + day });
	assert.deepEqual(added, ["afterInstall"]);
});

async function writeSession(noCwd, id, createdAt, prompt) {
	await mkdir(join(noCwd, id), { recursive: true });
	const lines = [{ type: "session", version: 4, id, createdAt, origin: "subagent" }, { type: "user/message", data: { role: "user", content: [{ type: "text", text: prompt }], source: { kind: "user" } } }];
	await writeFile(join(noCwd, id, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join("\n") + "\n")));
}

test("pruneDreamSessions finds dreaming sessions on disk and keeps the newest, leaving other hidden sessions", async (t) => {
	const h = await setup(t);
	const noCwd = join(h.root, "sessions", "_no-cwd");
	for (let i = 0; i < 4; i++) await writeSession(noCwd, `session-new-${i}`, 100 + i, "Memory consolidation · demo\n\nYou are consolidating…");
	await writeSession(noCwd, "session-legacy", 1, 'You are "dreaming": consolidating the long-term memory…');
	await writeSession(noCwd, "session-other", 0, "an unrelated hidden subagent task");
	await mkdir(join(noCwd, "session-unreadable"), { recursive: true });
	await pruneDreamSessions(join(h.root, "sessions"), { keep: 3 });
	assert.deepEqual((await readdir(noCwd)).sort(), ["session-new-1", "session-new-2", "session-new-3", "session-other", "session-unreadable"]);
});

test("an ok run's issues and summary reach the log", async (t) => {
	const h = await setup(t);
	h.runner.runDream = async () => ({ ok: true, changes: { created: 0, modified: 1, deleted: 0 }, issues: ["tool error: session not found"], summary: "fixed a note" });
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.idle();
	const entry = h.state.recentLog(1)[0];
	assert.deepEqual([entry.ok, entry.issues, entry.summary], [true, ["tool error: session not found"], "fixed a note"]);
	assert.deepEqual(h.state.pending(), [], "a run with issues still completes its batch");
	assert.equal(h.state.paused, null);
});

test("a cross-project run is due a day after the last one once projects ran, and runs alone", async (t) => {
	let clock = 10 * 86_400_000;
	const h = await setup(t, { listProjects: async () => [{ cwd: A, notes: 2 }, { cwd: B, notes: 0 }] });
	h.runner.now = () => clock;
	await h.state.completeCross(clock - 1000);
	const release = gate(h);
	await h.runner.onSessionEnded(ended("s1", A, 1));
	release();
	await h.runner.idle();
	assert.deepEqual(h.calls.map((call) => call.cwd ?? "cross"), [A], "not due within a day");
	assert.deepEqual(h.state.crossProjects(), [A]);
	clock += 86_400_000;
	const releaseB = gate(h);
	await h.runner.onSessionEnded(ended("s2", B, 2));
	await h.runner.onSessionEnded(ended("s3", C, 3));
	assert.deepEqual(h.calls.map((call) => call.cwd ?? "cross"), [A, "cross"], "a due cross run starts first and holds new project runs");
	releaseB();
	await h.runner.idle();
	assert.deepEqual(h.calls.map((call) => call.cwd ?? "cross"), [A, "cross", B, C]);
	assert.deepEqual(h.calls[1].projects, [{ cwd: A, notes: 2 }, { cwd: B, notes: 0 }]);
	assert.equal(h.maxActive, 1, "nothing ran alongside the gated cross run");
	assert.equal(h.state.recentLog(3)[0].scope, "cross");
	assert.equal(h.state.crossAt, clock);
});

test("the settings page's manual run ends with a cross-project run; /dream does not", async (t) => {
	const h = await setup(t, { autoDream: false, listProjects: async () => [{ cwd: A, notes: 1 }] });
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.runManual({ cwd: A });
	assert.deepEqual(h.calls.map((call) => call.cwd ?? "cross"), [A]);
	const report = await h.runner.runManual({ cross: true });
	assert.equal(report.ok, true);
	assert.deepEqual(h.calls.map((call) => call.cwd ?? "cross"), [A, "cross"]);
	assert.deepEqual(report.runs.map((run) => run.scope), ["cross"]);
});

test("a cross-project run with no projects is marked done instead of retried", async (t) => {
	const h = await setup(t, { listProjects: async () => [] });
	h.runner.now = () => 10 * 86_400_000;
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.idle();
	assert.deepEqual(h.calls.map((call) => call.cwd ?? "cross"), [A]);
	assert.deepEqual(h.state.crossProjects(), []);
	assert.equal(typeof h.state.crossAt, "number");
});

test("a session that ends again during its run stays queued with the newer events", async (t) => {
	const h = await setup(t);
	let release;
	h.gates.push(new Promise((resolve) => { release = resolve; }));
	await h.runner.onSessionEnded(ended("s1", A, 1, 100));
	await h.runner.onSessionEnded(ended("s1", A, 2, 200));
	release();
	await h.runner.idle();
	assert.deepEqual(h.calls.map((call) => call.sessionIds), [["s1"], ["s1"]]);
	assert.equal(h.state.watermark("s1"), 200);
	assert.deepEqual(h.state.pending(), []);
});

test("turning the master switch off stops queued auto runs", async (t) => {
	let enabled = true;
	const h = await setup(t);
	h.runner.config.enabled = { get: () => enabled };
	let release;
	h.gates.push(new Promise((resolve) => { release = resolve; }));
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.state.enqueue(ended("s2", B, 2));
	enabled = false;
	release();
	await h.runner.idle();
	assert.deepEqual(h.calls.map((call) => call.cwd), [A]);
});

test("stopping during a paused manual run keeps auto paused", async (t) => {
	const h = await setup(t, { outcomes: [{ ok: false, error: "bad key" }, { ok: false, error: "inactive context" }] });
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.idle();
	let release;
	h.gates.push(new Promise((resolve) => { release = resolve; }));
	const manual = h.runner.runManual({});
	h.runner.stop();
	release();
	const report = await manual;
	assert.equal(report.ok, false);
	assert.equal(h.state.paused.reason, "bad key");
});

test("project matching ignores Windows path case", { skip: process.platform !== "win32" }, async (t) => {
	const h = await setup(t, { autoDream: false });
	await h.runner.onSessionEnded(ended("s1", "C:\\Proj", 1));
	await h.runner.onSessionEnded(ended("s2", "c:\\proj", 2));
	await h.runner.runManual({ cwd: "C:\\PROJ" });
	assert.deepEqual(h.calls.map((call) => call.sessionIds), [["s1", "s2"]]);
});
