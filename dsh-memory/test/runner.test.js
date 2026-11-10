import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readdir, writeFile } from "node:fs/promises";
import { zstdCompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamState } from "../lib/state.js";
import { DreamRunner, reconcile, pruneDreamSessions, classifyError, POISON_LIMIT, BACKOFF_MS, SNOOZE_MS, CROSS_INTERVAL_MS } from "../lib/runner.js";

const A = "C:\\a";
const B = "C:\\b";
const C = "C:\\c";

async function setup(t, { outcomes = [], enabled = true, autoDream = true, concurrency = 4, listProjects, countUserNotes } = {}) {
	const root = await mkdtemp(join(tmpdir(), "dsh-memory-runner-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new DreamState(root, { now: () => 0 });
	await state.load();
	const calls = [];
	const jobs = [];
	let clock = 1000;
	let active = 0;
	let maxActive = 0;
	const gates = [];
	const runDream = async (job) => {
		active++;
		maxActive = Math.max(maxActive, active);
		calls.push(job.projects ? { projects: job.projects } : { cwd: job.cwd, sessionIds: job.sessionIds });
		jobs.push(job);
		if (outcomes[0]?.waitForAbort) {
			outcomes.shift();
			await new Promise((resolve) => job.signal.addEventListener("abort", resolve, { once: true }));
			active--;
			return { ok: false, error: "aborted" };
		}
		const gate = gates.shift();
		if (gate) await gate;
		active--;
		const { ok, error, ...extra } = outcomes.shift() ?? { ok: true };
		return ok ? { ok: true, changes: { created: 1, modified: 0, deleted: 0 }, dreamSessionId: `d${calls.length}`, ...extra } : { ok: false, error: error ?? "401 Unauthorized", dreamSessionId: `d${calls.length}`, ...extra };
	};
	const statuses = [];
	const runner = new DreamRunner({
		state,
		runDream,
		resolveSelection: () => ({ provider: "p", model: "m" }),
		config: { enabled: { get: () => enabled }, autoDream: { get: () => autoDream }, indexMaxBytes: { get: () => 4096 }, concurrency: { get: () => concurrency } },
		now: () => clock,
		...(listProjects ? { listProjects } : {}),
		...(countUserNotes ? { countUserNotes } : {}),
		onStatus: (status) => statuses.push(status)
	});
	t.after(() => runner.stop());
	return { root, state, runner, calls, jobs, statuses, gates, tick: (ms) => { clock += ms; }, get maxActive() { return maxActive; } };
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
	const h = await setup(t, { outcomes: [{ ok: false, error: "invalid key" }, { ok: false, error: "inactive context" }] });
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.idle();
	let release;
	h.gates.push(new Promise((resolve) => { release = resolve; }));
	const manual = h.runner.runManual({});
	h.runner.stop();
	release();
	const report = await manual;
	assert.equal(report.ok, false);
	assert.equal(h.state.paused.reason, "invalid key");
});

test("project matching ignores Windows path case", { skip: process.platform !== "win32" }, async (t) => {
	const h = await setup(t, { autoDream: false });
	await h.runner.onSessionEnded(ended("s1", "C:\\Proj", 1));
	await h.runner.onSessionEnded(ended("s2", "c:\\proj", 2));
	await h.runner.runManual({ cwd: "C:\\PROJ" });
	assert.deepEqual(h.calls.map((call) => call.sessionIds), [["s1", "s2"]]);
});

// --- failure handling, partial coverage, cancellation (audit items 1, 2, 5, 6, 7, 12) ---

test("classifyError sorts messages by what to do about them", () => {
	for (const message of ["401 Unauthorized", "HTTP 403 Forbidden", "Invalid API key", "insufficient_quota", "billing hard limit reached"]) assert.equal(classifyError(message), "fatal", message);
	for (const message of ["EACCES: permission denied, open 'C:\\x'", "limit is 512 tokens", "wrote 502 bytes", "ENOENT: no such file"]) assert.equal(classifyError(message), "other", message);
	for (const message of ["429 Too Many Requests", "rate limit exceeded", "503 Service Unavailable", "fetch failed", "ETIMEDOUT", "request timed out", "model is overloaded", "HTTP 502", "status: 529", "Error code 503"]) assert.equal(classifyError(message), "transient", message);
	for (const message of ['dreaming turn ended with "blocked"', 'dreaming turn ended with "max-tokens"', "dreaming agent did not finish a turn", undefined]) assert.equal(classifyError(message), "other", String(message));
});

test("a step-budget cut keeps unread sessions queued from where the run stopped, and the next run starts there", async (t) => {
	const h = await setup(t, { outcomes: [{ ok: true, unfinished: { s1: 40 } }] });
	await h.state.enqueue(ended("s1", A, 1, 100));
	await h.state.enqueue(ended("s2", A, 2, 50));
	h.runner.pump();
	await h.runner.idle();
	assert.deepEqual(h.jobs[0].fromSeqs, { s1: 0, s2: 0 });
	assert.deepEqual(h.calls.map((call) => call.sessionIds), [["s1", "s2"], ["s1"]], "the rest is reviewed by the next run");
	assert.deepEqual(h.jobs[1].fromSeqs, { s1: 40 }, "the next run is told where to start");
	assert.equal(h.state.watermark("s2"), 50, "a session read to the end is complete");
	assert.equal(h.state.watermark("s1"), 100);
	assert.deepEqual(h.state.pending(), []);
});

test("a session that makes no progress run after run is set aside, not retried forever", async (t) => {
	const stuck = { ok: true, unfinished: { s1: 0 } };
	const h = await setup(t, { outcomes: [stuck, stuck, stuck] });
	await h.runner.onSessionEnded(ended("s1", A, 1, 100));
	await h.runner.idle();
	assert.equal(h.calls.length, POISON_LIMIT);
	assert.deepEqual(h.state.pending(), []);
	const last = h.state.recentLog(1)[0];
	assert.equal(last.skipped, true);
	assert.match(last.error, /skipped after 3 attempts/);
	assert.equal(h.state.paused, null);
});

test("an auth error pauses at once; a transient error backs off and only a streak pauses", async (t) => {
	const auth = await setup(t, { outcomes: [{ ok: false, error: "401 Unauthorized" }] });
	await auth.runner.onSessionEnded(ended("s1", A, 1));
	await auth.runner.idle();
	assert.equal(auth.state.paused.kind, "auth");

	const h = await setup(t, { outcomes: [{ ok: false, error: "429 Too Many Requests" }, { ok: false, error: "503 Service Unavailable" }, { ok: false, error: "fetch failed" }, { ok: false, error: "503 Service Unavailable" }, { ok: false, error: "503 Service Unavailable" }] });
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.idle();
	assert.equal(h.state.paused, null, "one transient failure does not pause");
	assert.ok(h.runner.status().retryAt > 1000, "the retry time is published");
	await h.runner.onSessionEnded(ended("s2", B, 2));
	await h.runner.idle();
	assert.equal(h.calls.length, 1, "no new run during the backoff");
	h.tick(BACKOFF_MS[0]);
	h.runner.pump();
	await h.runner.idle();
	assert.equal(h.calls.length, 3, "both projects run once the backoff is over");
	assert.equal(h.state.paused, null, "two parallel failures are one wave, not two strikes");
	assert.equal(h.runner.streak, 2);
	h.tick(BACKOFF_MS[1]);
	h.runner.pump();
	await h.runner.idle();
	assert.equal(h.state.paused.kind, "repeated", "a third wave pauses");
	assert.match(h.state.paused.reason, /连续失败 3 次/);
	assert.deepEqual(h.state.pending().map((job) => job.sessionId).sort(), ["s1", "s2"], "nothing was dropped");
});

test("a success resets the failure streak", async (t) => {
	const h = await setup(t, { outcomes: [{ ok: false, error: "429 Too Many Requests" }, { ok: true }, { ok: false, error: "429 Too Many Requests" }, { ok: true }] });
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.idle();
	h.tick(BACKOFF_MS[0]);
	h.runner.pump();
	await h.runner.idle();
	assert.equal(h.runner.streak, 0);
	await h.runner.onSessionEnded(ended("s2", B, 2));
	await h.runner.idle();
	assert.equal(h.runner.streak, 1);
	assert.equal(h.state.paused, null);
});

test("a batch that keeps failing for its own reasons is set aside instead of pausing forever", async (t) => {
	const blocked = { ok: false, error: 'dreaming turn ended with "blocked"' };
	const h = await setup(t, { outcomes: [blocked, blocked, blocked] });
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.idle();
	assert.equal(h.state.attempts("s1"), 1);
	assert.equal(h.state.paused, null);
	h.tick(BACKOFF_MS[0]);
	h.runner.pump();
	await h.runner.idle();
	assert.equal(h.state.attempts("s1"), 2);
	h.tick(BACKOFF_MS[1]);
	h.runner.pump();
	await h.runner.idle();
	assert.equal(h.state.attempts("s1"), 0, "set aside, so the counter is cleared");
	assert.deepEqual(h.state.pending(), []);
	assert.equal(h.state.watermark("s1"), 10);
	assert.equal(h.state.recentLog(1)[0].skipped, true);
	assert.equal(h.state.paused, null);
	assert.equal(h.runner.streak, 0);
});

test("an unreachable project directory leaves the batch queued without a log entry, a pause or a busy loop", async (t) => {
	const h = await setup(t, { outcomes: [{ ok: false, skipped: true, error: "project directory cannot be reached right now" }] });
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.idle();
	assert.equal(h.calls.length, 1, "not retried at once");
	assert.deepEqual(h.state.pending().map((job) => job.sessionId), ["s1"]);
	assert.deepEqual(h.state.recentLog(5), []);
	assert.equal(h.state.paused, null);
	h.tick(SNOOZE_MS + 1);
	h.runner.pump();
	await h.runner.idle();
	assert.equal(h.calls.length, 2, "looked at again after the snooze");
	assert.deepEqual(h.state.pending(), []);
});

test("stop() cancels runs in flight: no log entry, no pause, the batch stays queued", async (t) => {
	const h = await setup(t, { outcomes: [{ waitForAbort: true }] });
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await until(() => h.jobs.length === 1);
	assert.equal(h.jobs[0].signal.aborted, false);
	h.runner.stop();
	await h.runner.idle();
	assert.equal(h.jobs[0].signal.aborted, true);
	assert.deepEqual(h.state.recentLog(5), []);
	assert.equal(h.state.paused, null);
	assert.deepEqual(h.state.pending().map((job) => job.sessionId), ["s1"]);
});

test("cancelAll() (memory turned off) cancels the same way and leaves the runner usable", async (t) => {
	const h = await setup(t, { outcomes: [{ waitForAbort: true }] });
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await until(() => h.jobs.length === 1);
	let enabled = true;
	h.runner.config.enabled = { get: () => enabled };
	enabled = false;
	h.runner.cancelAll("memory was turned off");
	await h.runner.idle();
	assert.equal(h.state.paused, null);
	assert.deepEqual(h.state.pending().map((job) => job.sessionId), ["s1"]);
	enabled = true;
	h.runner.pump();
	await h.runner.idle();
	assert.deepEqual(h.state.pending(), [], "queue drains once allowed again");
});

test("the first project run starts the cross-project clock instead of making it due at once", async (t) => {
	const h = await setup(t, { listProjects: async () => [{ cwd: A, notes: 3 }] });
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.idle();
	assert.equal(typeof h.state.crossAt, "number");
	assert.equal(h.runner.crossDue(), false);
	h.tick(CROSS_INTERVAL_MS);
	assert.equal(h.runner.crossDue(), true);
});

test("an automatic cross-project run is skipped when there is nothing to compare; a manual one still runs", async (t) => {
	const h = await setup(t, { listProjects: async () => [{ cwd: A, notes: 3 }, { cwd: B, notes: 0 }], countUserNotes: async () => 0 });
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.idle();
	h.tick(CROSS_INTERVAL_MS);
	h.runner.pump();
	await h.runner.idle();
	assert.deepEqual(h.calls.map((call) => call.cwd ?? "cross"), [A], "one project with notes and an empty user partition: nothing to do");
	assert.equal(h.state.crossAt, 1000 + CROSS_INTERVAL_MS, "counted as done");
	await h.runner.runManual({ cross: true });
	assert.deepEqual(h.calls.map((call) => call.cwd ?? "cross"), [A, "cross"]);

	const two = await setup(t, { listProjects: async () => [{ cwd: A, notes: 1 }, { cwd: B, notes: 2 }], countUserNotes: async () => 0 });
	await two.runner.onSessionEnded(ended("s1", A, 1));
	await two.runner.idle();
	two.tick(CROSS_INTERVAL_MS);
	two.runner.pump();
	await two.runner.idle();
	assert.deepEqual(two.calls.map((call) => call.cwd ?? "cross"), [A, "cross"], "two projects with notes are worth comparing");
});

test("a manual run with nothing queued says so in the status", async (t) => {
	const h = await setup(t);
	const report = await h.runner.runManual({});
	assert.equal(report.ok, true);
	assert.equal(h.statuses.at(-1).notice.text, "没有需要整理的会话。");
	await h.runner.onSessionEnded(ended("s1", A, 1));
	await h.runner.idle();
	assert.equal(h.runner.status().notice, undefined, "a new session clears it");
});

test("reconcile forgets watermarks of deleted sessions but keeps queued and existing ones", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "dsh-memory-prune-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new DreamState(root, { now: () => 0 });
	await state.load();
	await state.complete([{ sessionId: "gone", seq: 5 }, { sessionId: "kept", seq: 5 }, { sessionId: "queued", seq: 5 }]);
	await state.enqueue({ sessionId: "queued", cwd: A, endedAt: 1, seq: 9 });
	const sessionQuery = { listSessions: async () => [{ header: { id: "kept", cwd: A, createdAt: 0 }, live: true }], listEvents: async () => [] };
	await reconcile(sessionQuery, state);
	assert.equal(state.watermark("gone"), 0);
	assert.equal(state.watermark("kept"), 5);
	assert.equal(state.watermark("queued"), 5);
	await reconcile({ listSessions: async () => [], listEvents: async () => [] }, state);
	assert.equal(state.watermark("kept"), 5, "an empty listing is not trusted");
});

test("a session that already failed twice runs alone, so the others are not set aside with it", async (t) => {
	const blocked = { ok: false, error: 'dreaming turn ended with "blocked"' };
	const h = await setup(t, { outcomes: [blocked, blocked] });
	await h.state.enqueue(ended("bad", A, 1));
	await h.state.enqueue(ended("good", A, 2));
	h.runner.pump();
	await h.runner.idle();
	h.tick(BACKOFF_MS[0]);
	h.runner.pump();
	await h.runner.idle();
	assert.deepEqual(h.calls.map((call) => call.sessionIds), [["bad", "good"], ["bad", "good"]]);
	h.tick(BACKOFF_MS[1]);
	h.runner.pump();
	await h.runner.idle();
	assert.deepEqual(h.calls.slice(2).map((call) => call.sessionIds), [["bad"], ["good"]], "the suspect goes first and alone; the other is not affected");
	assert.deepEqual(h.state.pending(), []);
});

test("progress clears a session's earlier failures; no progress keeps counting", async (t) => {
	const h = await setup(t, { outcomes: [{ ok: true, unfinished: { s1: 0 } }, { ok: true, unfinished: { s1: 30 } }, { ok: true, unfinished: { s1: 0 } }] });
	await h.state.enqueue(ended("s1", A, 1, 100));
	h.runner.pump();
	await until(() => h.calls.length >= 2);
	await h.runner.idle();
	assert.equal(h.state.attempts("s1"), 0, "the cut that made progress reset the count; the final run finished the session");
	assert.ok(h.calls.length >= 3);
	assert.deepEqual(h.state.pending(), []);
});
