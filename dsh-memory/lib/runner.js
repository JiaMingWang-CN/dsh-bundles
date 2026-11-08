/**
 * Global serial dreaming runner.
 *
 * Every run goes through one promise chain, so at most one dreaming agent is
 * active across all projects (the user partition is shared). Policy:
 * - auto: after a session ends, unless paused or `autoDream` is off. Each auto
 *   task consolidates ONE project, then re-queues itself behind whatever was
 *   requested meanwhile, so a manual request never waits for a whole drain;
 * - any failure pauses auto dreaming globally; ended sessions keep queueing;
 * - manual (`/dream`, settings button): runs even while paused; after a
 *   successful manual run that started paused, it drains the whole queue in
 *   ending order and then resumes auto. A manual failure stays paused.
 * A batch leaves the queue only after its run succeeded.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isEligible } from "./trigger.js";
import { encodeCwd } from "./paths.js";

const DAY_MS = 86_400_000;
const STATUS_LOG_SIZE = 20;

/**
 * @typedef {import("./state.js").LogEntry} LogEntry
 * @typedef {{ ok: boolean, runs: LogEntry[] }} RunReport
 */

export class DreamRunner {
	/**
	 * @param {{ state: import("./state.js").DreamState,
	 *   runDream: (job: { cwd: string, sessionIds: string[], selection?: object, indexMaxBytes: number }) => Promise<object>,
	 *   resolveSelection: () => object | undefined, config: object, now?: () => number,
	 *   onStatus?: (status: object) => void, afterRun?: () => Promise<void> }} deps
	 */
	constructor({ state, runDream, resolveSelection, config, now = Date.now, onStatus, afterRun }) {
		Object.assign(this, { state, runDream, resolveSelection, config, now, onStatus, afterRun });
		this.chain = Promise.resolve();
		this.running = null;
		this.stopped = false;
	}

	/**
	 * Called when the plugin unloads (including app shutdown, which also
	 * disposes sessions and so fires session endings). Endings still queue;
	 * no new run starts, and a run that fails because services are going away
	 * is neither logged nor allowed to pause auto dreaming.
	 */
	stop() {
		this.stopped = true;
	}

	/** Snapshot for the settings page. */
	status() {
		return { paused: this.state.paused, running: this.running, pendingCount: this.state.pending().length, log: this.state.recentLog(STATUS_LOG_SIZE) };
	}

	emit() {
		this.onStatus?.(this.status());
	}

	/** Append a task to the serial chain; the returned promise settles with it. */
	schedule(task) {
		const run = this.chain.then(task);
		this.chain = run.catch(() => {});
		return run;
	}

	/** Resolves once the chain, including self-rescheduled tasks, has drained. */
	async idle() {
		let seen;
		while (seen !== this.chain) {
			seen = this.chain;
			await seen;
		}
	}

	/** Auto path: queue an ended session and start consolidating if allowed. */
	async onSessionEnded(info) {
		if (!this.config.enabled.get()) return;
		if (info.seq <= this.state.watermark(info.sessionId)) return;
		await this.state.enqueue(info);
		this.emit();
		this.scheduleAuto();
	}

	scheduleAuto() {
		if (!this.config.autoDream.get() || this.state.paused !== null) return;
		this.schedule(async () => {
			if (this.state.paused !== null || !this.config.autoDream.get()) return;
			const result = await this.runNextGroup("auto", {}, []);
			if (result === "ran") this.scheduleAuto();
		});
	}

	/**
	 * Manual path.
	 * @param {{ cwd?: string, excludeSessionId?: string }} scope - project to consolidate first (all when omitted) and a session to leave out.
	 * @returns {Promise<RunReport>}
	 */
	runManual({ cwd, excludeSessionId } = {}) {
		return this.schedule(async () => {
			const runs = [];
			if (!(await this.drain("manual", { cwd, excludeSessionId }, runs))) return { ok: false, runs };
			if (this.state.paused !== null) {
				if (!(await this.drain("manual", { excludeSessionId }, runs))) return { ok: false, runs };
				await this.state.setPaused(null);
				this.emit();
				this.scheduleAuto();
			}
			return { ok: true, runs };
		});
	}

	/** Run groups until none is left; false on the first failure. */
	async drain(trigger, scope, runs) {
		while (true) {
			const result = await this.runNextGroup(trigger, scope, runs);
			if (result === "empty") return true;
			if (result === "failed") return false;
		}
	}

	/**
	 * Consolidate the project whose queued session ended first.
	 * @returns {Promise<"empty" | "ran" | "failed">}
	 */
	async runNextGroup(trigger, { cwd, excludeSessionId }, runs) {
		const queued = this.state.pending().filter((job) => job.sessionId !== excludeSessionId);
		const stale = queued.filter((job) => job.seq <= this.state.watermark(job.sessionId));
		if (stale.length > 0) await this.state.complete(stale.map((job) => job.sessionId));
		const jobs = queued.filter((job) => job.seq > this.state.watermark(job.sessionId) && (cwd === undefined || job.cwd === cwd));
		if (jobs.length === 0 || this.stopped) return "empty";
		const groupCwd = jobs[0].cwd;
		const sessionIds = jobs.filter((job) => job.cwd === groupCwd).map((job) => job.sessionId);
		this.running = { cwd: groupCwd };
		this.emit();
		let result;
		try {
			result = await this.runDream({ cwd: groupCwd, sessionIds, selection: this.resolveSelection(), indexMaxBytes: this.config.indexMaxBytes.get() });
		} catch (error) {
			result = { ok: false, error: error?.message ?? String(error) };
		} finally {
			this.running = null;
		}
		if (!result.ok && this.stopped) return "empty";
		const entry = {
			at: this.now(),
			cwd: groupCwd,
			sessionIds,
			ok: result.ok,
			trigger,
			...(result.ok ? { changes: result.changes } : { error: result.error }),
			...(result.dreamSessionId ? { dreamSessionId: result.dreamSessionId } : {})
		};
		await this.state.appendLog(entry);
		runs.push(entry);
		if (result.ok) await this.state.complete(sessionIds);
		else await this.state.setPaused({ since: entry.at, reason: result.error });
		this.emit();
		await this.afterRun?.().catch(() => {});
		return result.ok ? "ran" : "failed";
	}
}

/**
 * Queue sessions that ended without being noticed (host restart, idle timer
 * lost): recent, cold, eligible sessions with events past their watermark.
 * @param sessionQuery - `ctx.sessionQuery`.
 * @param {import("./state.js").DreamState} state
 * @param {{ now?: () => number, cwd?: string, excludeSessionId?: string, maxAgeMs?: number }} [options]
 * @returns {Promise<string[]>} ids newly queued.
 */
export async function reconcile(sessionQuery, state, { now = Date.now, cwd, excludeSessionId, maxAgeMs = 7 * DAY_MS } = {}) {
	const queued = new Set(state.pending().map((job) => job.sessionId));
	const key = cwd === undefined ? undefined : encodeCwd(cwd);
	const added = [];
	for (const { header, live } of await sessionQuery.listSessions()) {
		if (live || !isEligible(header) || header.id === excludeSessionId || queued.has(header.id)) continue;
		if (key !== undefined && encodeCwd(header.cwd) !== key) continue;
		if ((header.createdAt ?? 0) < now() - maxAgeMs) continue;
		const events = await sessionQuery.listEvents(header.id);
		const last = events.at(-1);
		const seq = last?.seq ?? 0;
		if (seq <= state.watermark(header.id)) continue;
		await state.enqueue({ sessionId: header.id, cwd: header.cwd, endedAt: last?.time ?? header.createdAt ?? now(), seq });
		added.push(header.id);
	}
	return added;
}

/**
 * Delete the stored sessions of old dreaming runs, keeping the newest `keep`.
 * Only ids recorded in this plugin's log are touched.
 * @param {import("./state.js").DreamState} state
 * @param {string} sessionsRoot - `<DSH home>/sessions`.
 */
export async function pruneDreamSessions(state, sessionsRoot, keep = 50) {
	const ids = [...new Set(state.recentLog(Infinity).map((entry) => entry.dreamSessionId).filter((id) => typeof id === "string" && /^session-[\w-]+$/.test(id)))];
	for (const id of ids.slice(0, Math.max(0, ids.length - keep))) {
		await rm(join(sessionsRoot, "_no-cwd", id), { recursive: true, force: true });
	}
}
