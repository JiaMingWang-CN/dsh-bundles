import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const value = (initial) => {
	let current = initial;
	return { get: () => current, set: (next) => { current = next; } };
};

/** A project directory, a DSH home whose queue already holds one ended session of it, and a fake host context. */
async function harness(t, { enabled = true, autoDream = true } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "dsh-memory-wiring-"));
	const home = join(dir, "home");
	const project = join(dir, "project");
	await mkdir(project, { recursive: true });
	await mkdir(join(home, "memory", ".state"), { recursive: true });
	await writeFile(join(home, "memory", ".state", "state.json"), JSON.stringify({ installedAt: 1, queue: [{ sessionId: "s1", cwd: project, endedAt: 5, seq: 10 }], watermarks: {}, paused: null }));
	const previousHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const cleanups = [];
	t.after(async () => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		t.mock.timers.reset();
		if (previousHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previousHome;
		await rm(dir, { recursive: true, force: true });
	});

	const agent = { created: 0, cancelled: 0, resolveIdle: undefined };
	const listeners = {};
	const ctx = {
		logger: { warn() {} },
		fiber: {},
		effect: (fn) => { const cleanup = fn(); if (typeof cleanup === "function") cleanups.push(cleanup); },
		tools: { register: () => () => {} },
		systemPrompt: { section() {} },
		on: (event, fn) => { (listeners[event] ??= []).push(fn); return () => {}; },
		inject: (names, fn) => {
			if (names.includes("settings")) fn({ effect: (inner) => ctx.effect(inner), settings: { configure() {}, update: async () => {} } });
			else if (names.includes("commands")) fn({ commands: { register() {} } });
		},
		get: () => undefined,
		sessionQuery: { listSessions: async () => [], listEvents: async () => [] },
		agents: {
			create: async () => {
				agent.created++;
				return {
					agent: {
						followup() {},
						whenIdle: () => new Promise((resolve) => { agent.resolveIdle = resolve; }),
						cancel() { agent.cancelled++; agent.resolveIdle?.(); },
						session: { snapshotEvents: () => [] }
					},
					dispose: async () => {}
				};
			}
		}
	};
	const config = {
		enabled: value(enabled), autoDream: value(autoDream), idleMinutes: value(10), concurrency: value(4), indexMaxBytes: value(4096),
		dreamProvider: value(""), dreamModel: value(""), dreamEffort: value(""), dreamRequest: value("")
	};
	await apply(ctx, config);
	const settingsChanged = () => { for (const fn of listeners["loader/volatile-update"] ?? []) fn(); };
	return { ctx, config, agent, home, settingsChanged, startupScan: () => t.mock.timers.tick(30_000) };
}

async function until(condition) {
	for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(condition(), "condition not reached");
}

test("after the startup scan, a queue left by the last run is consolidated without waiting for another session to end", async (t) => {
	const h = await harness(t);
	assert.equal(h.agent.created, 0, "nothing runs before the scan");
	h.startupScan();
	await until(() => h.agent.created === 1);
});

test("with auto dreaming off nothing starts at startup; turning it on starts the waiting queue", async (t) => {
	const h = await harness(t, { autoDream: false });
	h.startupScan();
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(h.agent.created, 0);
	h.config.autoDream.set(true);
	h.settingsChanged();
	await until(() => h.agent.created === 1);
});

test("turning memory on starts the waiting queue; a settings change while it is off starts nothing", async (t) => {
	const h = await harness(t, { enabled: false });
	h.settingsChanged();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(h.agent.created, 0);
	h.config.enabled.set(true);
	h.settingsChanged();
	await until(() => h.agent.created === 1);
});

test("turning memory off cancels a dreaming run in flight and keeps its batch queued", async (t) => {
	const h = await harness(t);
	h.startupScan();
	await until(() => h.agent.created === 1);
	h.config.enabled.set(false);
	h.settingsChanged();
	await until(() => h.agent.cancelled === 1);
	await new Promise((resolve) => setImmediate(resolve));
	const state = JSON.parse(await readFile(join(h.home, "memory", ".state", "state.json"), "utf8"));
	assert.deepEqual(state.queue.map((job) => job.sessionId), ["s1"]);
	assert.equal(state.paused, null, "a cancelled run does not pause auto dreaming");
	await assert.rejects(readFile(join(h.home, "memory", ".state", "log.jsonl"), "utf8"), /ENOENT/, "and is not logged as a failure");
});
