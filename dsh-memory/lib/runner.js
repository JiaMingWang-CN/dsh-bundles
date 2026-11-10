/**
 * Parallel dreaming runner.
 *
 * Runs for different projects proceed in parallel, up to `concurrency`
 * (a volatile setting); one project never has two runs at once. Runs that
 * write the same user-partition note at once are kept apart by the store's
 * versions: the later write conflicts and is redone on the new content.
 * Policy:
 * - auto: after a session ends, unless paused or `autoDream` is off. Each auto
 *   run consolidates ONE project; a freed slot goes first to a waiting manual
 *   request, then to the project whose queued session ended first;
 * - failures are sorted by cause. An authentication or quota error pauses auto
 *   dreaming at once; a transient one (rate limit, network, 5xx) backs off and
 *   retries, and only a streak of them pauses. A batch that keeps failing for
 *   its own reasons (blocked, cut off) is set aside after a few attempts
 *   instead of blocking the queue. While paused, ended sessions keep queueing;
 *   runs already in flight finish;
 * - manual (`/dream`, settings button): runs even while paused; after a
 *   successful manual run that started paused, it drains the whole queue and
 *   then resumes auto. A manual failure stays paused.
 * - cross-project: the one run that sees every partition, so the one that
 *   moves notes between them. It runs alone (it waits for the slots to empty
 *   and holds new project runs meanwhile): automatically once a day after
 *   project runs happened (and only when there is something to compare), and
 *   after the settings page's manual run.
 * A batch leaves the queue only after its run succeeded; a run cut off by its
 * step budget advances each session only as far as the agent read it.
 */
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { isEligible, accumulate, emptyActivity, isSubstantive } from "./trigger.js";
import { sameProject } from "./paths.js";
import { DREAM_PROMPT_MARKERS } from "./dream.js";

const DAY_MS = 86_400_000;
const STATUS_LOG_SIZE = 20;
/** Slot marker of the cross-project run. */
const CROSS = Symbol("cross-project");
/** Least time between two automatic cross-project runs. */
export const CROSS_INTERVAL_MS = DAY_MS;
/** Waits after the 1st, 2nd, ... consecutive transient failure. */
export const BACKOFF_MS = [60_000, 180_000];
/** Consecutive failures that pause auto dreaming. */
export const MAX_STREAK = BACKOFF_MS.length + 1;
/** Failed (or no-progress) runs after which a session is set aside. */
export const POISON_LIMIT = 3;
/** How long a project whose directory cannot be reached is left alone. */
export const SNOOZE_MS = 600_000;
/** Dreaming sessions are small; anything bigger on disk is not one and is not worth reading. */
const MAX_DREAM_SESSION_BYTES = 8 * 1024 * 1024;

/**
 * Sort a failed run's error message by what to do about it.
 * - "fatal": retrying cannot help until the user acts (bad key, no quota, no access);
 * - "transient": likely to pass by itself (rate limit, overload, network, timeout, 5xx);
 * - "other": the batch itself is the likely cause (blocked, cut off, rejected input).
 * @param {string | undefined} message
 * @returns {"fatal" | "transient" | "other"}
 */
export function classifyError(message) {
	const text = String(message ?? "");
	if (/\b(401|402|403)\b|unauthori[sz]ed|forbidden|invalid[ _-]?(api[ _-]?)?key|authenticat|insufficient|quota|billing|credit/i.test(text)) return "fatal";
	if (/(?:http|status|code|error)\s*:?\s*(?:408|425|429|5\d\d)\b|\b(?:408|425|429|5\d\d)\s+(?:too many|request timeout|internal|bad gateway|service|gateway)|rate[ _-]?limit|too many requests|overload|timed? ?out|timeout|ETIMEDOUT|ECONN\w*|ENOTFOUND|EAI_AGAIN|EPIPE|socket|network|fetch failed|temporar|unavailable|capacity/i.test(text)) return "transient";
	return "other";
}

/**
 * @typedef {import("./state.js").LogEntry} LogEntry
 * @typedef {{ ok: boolean, runs: LogEntry[] }} RunReport
 */

export class DreamRunner {
	/**
	 * @param {{ state: import("./state.js").DreamState,
	 *   runDream: (job: { cwd?: string, sessionIds?: string[], fromSeqs?: Record<string, number>, projects?: object[], selection?: object, indexMaxBytes: number, signal?: AbortSignal }) => Promise<object>,
	 *   resolveSelection: () => object | undefined, config: object, now?: () => number,
	 *   listProjects?: () => Promise<Array<{ cwd: string, notes: number }>>,
	 *   countUserNotes?: () => Promise<number>,
	 *   onStatus?: (status: object) => void, afterRun?: () => Promise<void> }} deps
	 */
	constructor({ state, runDream, resolveSelection, config, now = Date.now, listProjects = async () => [], countUserNotes = async () => 1, onStatus, afterRun }) {
		Object.assign(this, { state, runDream, resolveSelection, config, now, listProjects, countUserNotes, onStatus, afterRun });
		/** Projects with a run in flight, in start order. */
		this.active = [];
		/** Manual requests waiting for their project or a free slot. */
		this.waiters = [];
		this.tasks = new Set();
		this.stopped = false;
		/** Abort controllers of the runs in flight. */
		this.aborts = new Set();
		/** Consecutive failed runs (reset by a success). */
		this.streak = 0;
		/** When the last counted failure happened: runs that started before it belong to the same wave. */
		this.waveEnd = -1;
		/** Auto runs wait until this time after a transient failure. */
		this.backoffUntil = 0;
		/** Projects left alone until a time: `{ cwd, until }`. */
		this.snoozed = [];
		/** Pending wake-ups from `pumpLater`. */
		this.pumpTimers = new Set();
		/** What the last manual run found, for the settings page: `{ at, text }`. */
		this.notice = null;
	}

	/**
	 * Called when the plugin unloads (including app shutdown, which also
	 * disposes sessions and so fires session endings). Endings still queue;
	 * no new run starts, runs in flight are cancelled, and a run that fails
	 * because services are going away is neither logged nor allowed to pause
	 * auto dreaming.
	 */
	stop() {
		this.stopped = true;
		for (const timer of this.pumpTimers) clearTimeout(timer);
		this.pumpTimers.clear();
		this.cancelAll("dsh-memory is stopping");
	}

	/** Cancel every run in flight (plugin stopping or turned off); their batches stay queued. */
	cancelAll(reason) {
		for (const controller of this.aborts) controller.abort(new Error(reason));
	}

	/** Snapshot for the settings page; `running` is null or the projects in flight. */
	status() {
		return {
			paused: this.state.paused,
			running: this.active.length === 0 ? null : this.active.map((cwd) => (cwd === CROSS ? { scope: "cross" } : { cwd })),
			pendingCount: this.state.pending().length,
			log: this.state.recentLog(STATUS_LOG_SIZE),
			...(this.backoffUntil > this.now() ? { retryAt: this.backoffUntil } : {}),
			...(this.notice ? { notice: this.notice } : {})
		};
	}

	emit() {
		this.onStatus?.(this.status());
	}

	/** Keep a task visible to `idle()` until it settles. */
	track(promise) {
		this.tasks.add(promise);
		promise.then(() => this.tasks.delete(promise), () => this.tasks.delete(promise));
		return promise;
	}

	/** Resolves once every run, including runs started meanwhile, has settled. */
	async idle() {
		while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
	}

	/** Auto path: queue an ended session and start consolidating if allowed. */
	async onSessionEnded(info) {
		if (!this.config.enabled.get()) return;
		if (info.seq <= this.state.watermark(info.sessionId)) return;
		await this.state.enqueue(info);
		this.notice = null;
		this.emit();
		this.pump();
	}

	/** Whether automatic dreaming may start a run right now. */
	autoAllowed() {
		return !this.stopped && this.config.enabled.get() && this.config.autoDream.get() && this.state.paused === null && this.now() >= this.backoffUntil;
	}

	/** Call `pump()` once `ms` have passed (backoff or snooze ended). */
	pumpLater(ms) {
		const timer = setTimeout(() => {
			this.pumpTimers.delete(timer);
			this.emit();
			this.pump();
		}, ms);
		timer.unref?.();
		this.pumpTimers.add(timer);
	}

	/**
	 * Whether a run for `cwd` may start now: a free slot and no run in flight
	 * for that project; the cross-project run needs every slot empty and
	 * blocks every other run.
	 */
	canStart(cwd) {
		if (cwd === CROSS) return this.active.length === 0;
		return this.active.length < this.config.concurrency.get() && !this.active.some((running) => running === CROSS || sameProject(running, cwd));
	}

	/** An automatic cross-project run is due: projects were consolidated since the last one, and a day has passed. */
	crossDue() {
		return this.state.crossProjects().length > 0 && this.now() - (this.state.crossAt ?? 0) >= CROSS_INTERVAL_MS;
	}

	/** Queued sessions with events past their watermark, oldest ending first; projects that were snoozed are left out. */
	freshJobs(excludeSessionId) {
		const now = this.now();
		this.snoozed = this.snoozed.filter((entry) => entry.until > now);
		return this.state.pending().filter((job) => job.sessionId !== excludeSessionId && job.seq > this.state.watermark(job.sessionId) && !this.snoozed.some((entry) => sameProject(entry.cwd, job.cwd)));
	}

	/** Leave a project alone for a while (its directory cannot be reached) and look again afterwards. */
	snooze(cwd) {
		this.snoozed.push({ cwd, until: this.now() + SNOOZE_MS });
		this.pumpLater(SNOOZE_MS);
	}

	/** Start auto runs for waiting projects while slots are free; a due cross-project run goes first. */
	pump() {
		if (this.autoAllowed() && this.crossDue()) {
			if (this.active.length === 0 && this.waiters.length === 0) {
				this.active.push(CROSS);
				this.track(this.runCross("auto", []));
			}
			return;
		}
		while (this.autoAllowed()) {
			const job = this.freshJobs().find((candidate) => this.canStart(candidate.cwd) && !this.waiters.some((waiter) => sameProject(waiter.cwd, candidate.cwd)));
			if (job === undefined) return;
			this.active.push(job.cwd);
			this.track(this.runGroup("auto", job.cwd, {}, []));
		}
	}

	/** Wait for a slot for `cwd` and hold it; the run releases it. */
	acquire(cwd) {
		if (this.waiters.length === 0 && this.canStart(cwd)) {
			this.active.push(cwd);
			return Promise.resolve();
		}
		return new Promise((resolve) => this.waiters.push({ cwd, resolve }));
	}

	/** Free a slot: waiting manual requests first, then auto. */
	release(cwd) {
		const index = this.active.indexOf(cwd);
		if (index !== -1) this.active.splice(index, 1);
		for (const waiter of [...this.waiters]) {
			if (!this.canStart(waiter.cwd)) continue;
			this.waiters.splice(this.waiters.indexOf(waiter), 1);
			this.active.push(waiter.cwd);
			waiter.resolve();
		}
		this.emit();
		this.pump();
	}

	/**
	 * Manual path.
	 * @param {{ cwd?: string, excludeSessionId?: string, cross?: boolean }} scope - project to consolidate first
	 *   (all when omitted), a session to leave out, and whether to finish with a cross-project run.
	 * @returns {Promise<RunReport>}
	 */
	runManual({ cwd, excludeSessionId, cross = false } = {}) {
		return this.track((async () => {
			const runs = [];
			this.notice = null;
			const report = await this.manual({ cwd, excludeSessionId, cross }, runs);
			if (report.ok && runs.length === 0 && !this.stopped) {
				this.notice = { at: this.now(), text: "没有需要整理的会话。" };
				this.emit();
			}
			return report;
		})());
	}

	async manual({ cwd, excludeSessionId, cross }, runs) {
		if (!(await this.drain("manual", { cwd, excludeSessionId }, runs)) || this.stopped) return { ok: false, runs };
		const wasPaused = this.state.paused !== null;
		if (wasPaused && !(await this.drain("manual", { excludeSessionId }, runs))) return { ok: false, runs };
		if (cross && !this.stopped) {
			await this.acquire(CROSS);
			if ((await this.runCross("manual", runs)) === "failed") return { ok: false, runs };
		}
		if (this.stopped) return { ok: false, runs };
		if (wasPaused) {
			this.streak = 0;
			this.backoffUntil = 0;
			await this.state.setPaused(null);
			this.emit();
			this.pump();
		}
		return { ok: true, runs };
	}

	/**
	 * Run every project in scope, in parallel, until none has sessions left;
	 * false once any run failed (no further batch starts after that).
	 */
	async drain(trigger, { cwd, excludeSessionId }, runs) {
		const outcome = { failed: false };
		while (!outcome.failed && !this.stopped) {
			const projects = [];
			for (const job of this.freshJobs(excludeSessionId)) {
				if (cwd !== undefined && !sameProject(job.cwd, cwd)) continue;
				if (!projects.some((project) => sameProject(project, job.cwd))) projects.push(job.cwd);
			}
			if (projects.length === 0) break;
			await Promise.all(projects.map((project) => this.drainProject(trigger, project, excludeSessionId, runs, outcome)));
		}
		return !outcome.failed;
	}

	/** Run one project's batches one after another until it has none left. */
	async drainProject(trigger, cwd, excludeSessionId, runs, outcome) {
		while (!outcome.failed && !this.stopped) {
			await this.acquire(cwd);
			const result = await this.runGroup(trigger, cwd, { excludeSessionId }, runs);
			if (result === "empty") return;
			if (result === "failed") outcome.failed = true;
		}
	}

	/**
	 * Consolidate one project's queued sessions. The caller holds the
	 * project's slot; this releases it.
	 * @returns {Promise<"empty" | "ran" | "failed">}
	 */
	async runGroup(trigger, groupCwd, { excludeSessionId }, runs) {
		try {
			const queued = this.state.pending().filter((job) => job.sessionId !== excludeSessionId);
			const stale = queued.filter((job) => job.seq <= this.state.watermark(job.sessionId));
			if (stale.length > 0) await this.state.complete(stale);
			/* Capture the seqs this run covers: a session that ends again meanwhile is re-queued with a higher seq and must stay queued. */
			let batch = this.freshJobs(excludeSessionId).filter((job) => sameProject(job.cwd, groupCwd)).map(({ sessionId, seq }) => ({ sessionId, seq }));
			/* A session that already failed twice runs alone, so one bad session cannot drag the others in when it is finally set aside. */
			const suspect = batch.find((job) => this.state.attempts(job.sessionId) >= 2);
			if (suspect !== undefined) batch = [suspect];
			if (batch.length === 0 || this.stopped) return "empty";
			const sessionIds = batch.map((job) => job.sessionId);
			/* Where an earlier, cut-off run left each session: this run starts there. */
			const fromSeqs = Object.fromEntries(sessionIds.map((id) => [id, this.state.watermark(id)]));
			this.emit();
			const result = await this.invoke({ cwd: groupCwd, sessionIds, fromSeqs });
			if (result.skipped) {
				/* Project directory unreachable (unmounted drive): leave the batch queued and look again later. */
				this.snooze(groupCwd);
				return "empty";
			}
			if (!result.ok && (this.stopped || result.cancelled)) return "empty";
			const ok = await this.finish({ trigger, cwd: groupCwd, sessionIds }, result, runs);
			if (ok) {
				await this.completeBatch(trigger, groupCwd, batch, fromSeqs, result, runs);
				await this.state.noteProjectRun(groupCwd);
			} else await this.handleFailure(trigger, groupCwd, batch, result, runs);
			await this.afterRun?.().catch(() => {});
			return ok ? "ran" : "failed";
		} finally {
			this.release(groupCwd);
		}
	}

	/**
	 * Take a successful run's batch off the queue. A session the run did not
	 * read to the end only advances to where it got to and stays queued; one
	 * that makes no progress run after run is set aside.
	 */
	async completeBatch(trigger, cwd, batch, fromSeqs, result, runs) {
		const unfinished = result.unfinished ?? {};
		const covered = batch.map((job) => ({ sessionId: job.sessionId, seq: job.sessionId in unfinished ? unfinished[job.sessionId] : job.seq }));
		await this.state.complete(covered);
		const progressed = batch.filter((job) => job.sessionId in unfinished && unfinished[job.sessionId] > fromSeqs[job.sessionId]).map((job) => job.sessionId);
		await this.state.clearAttempts(progressed);
		const stalled = batch.filter((job) => job.sessionId in unfinished && unfinished[job.sessionId] <= fromSeqs[job.sessionId]).map((job) => job.sessionId);
		if (stalled.length > 0) {
			const counts = await this.state.noteFailure(stalled);
			const giveUp = batch.filter((job) => counts[job.sessionId] >= POISON_LIMIT);
			if (giveUp.length > 0) await this.setAside(trigger, cwd, giveUp, `read no further in ${POISON_LIMIT} runs (step budget)`, runs);
		}
	}

	/** Dequeue sessions that keep failing, and say so in the log. */
	async setAside(trigger, cwd, jobs, why, runs) {
		await this.state.complete(jobs);
		const entry = { at: this.now(), trigger, cwd, sessionIds: jobs.map((job) => job.sessionId), ok: false, error: `skipped after ${POISON_LIMIT} attempts: ${why}`, skipped: true };
		await this.state.appendLog(entry);
		runs.push(entry);
	}

	/**
	 * What a failed run means for the queue and for auto dreaming (see the
	 * header): set aside a batch that keeps failing for its own reasons; pause
	 * on an auth/quota error, on any manual failure, or on a streak; otherwise
	 * back off and retry.
	 */
	async handleFailure(trigger, cwd, batch, result, runs) {
		const kind = classifyError(result.error);
		if (cwd !== undefined && batch.length > 0 && kind === "other") {
			const counts = await this.state.noteFailure(batch.map((job) => job.sessionId));
			const giveUp = batch.filter((job) => counts[job.sessionId] >= POISON_LIMIT);
			if (giveUp.length > 0) {
				await this.setAside(trigger, cwd, giveUp, result.error, runs);
				this.streak = 0;
				return;
			}
		}
		const since = this.now();
		if (trigger === "manual" || kind === "fatal") {
			await this.state.setPaused({ since, reason: result.error, kind: kind === "fatal" ? "auth" : "manual" });
			return;
		}
		/* Failures of runs that started together (several projects in parallel) are one event, not several. */
		const newWave = (result.startedAt ?? since) > this.waveEnd;
		if (newWave) {
			this.streak++;
			this.waveEnd = since;
		}
		if (this.streak >= MAX_STREAK) {
			await this.state.setPaused({ since, reason: `连续失败 ${this.streak} 次：${result.error}`, kind: "repeated" });
			return;
		}
		if (!newWave) return;
		const wait = BACKOFF_MS[this.streak - 1];
		this.backoffUntil = since + wait;
		this.pumpLater(wait);
	}

	/**
	 * The cross-project run. The caller holds the cross slot; this releases it.
	 * @returns {Promise<"empty" | "ran" | "failed">}
	 */
	async runCross(trigger, runs) {
		try {
			if (this.stopped) return "empty";
			const projects = await this.listProjects();
			/* Nothing to compare: fewer than two projects have notes and the user partition is empty. An automatic run counts as done, or the due check would start it again at once. */
			const nothingToDo = projects.length === 0 || (trigger === "auto" && projects.filter((project) => project.notes > 0).length < 2 && (await this.countUserNotes()) === 0);
			if (nothingToDo) {
				await this.state.completeCross(this.now());
				return "empty";
			}
			this.emit();
			const result = await this.invoke({ projects });
			if (!result.ok && (this.stopped || result.cancelled)) return "empty";
			const ok = await this.finish({ trigger, scope: "cross", sessionIds: [] }, result, runs);
			if (ok) await this.state.completeCross(this.now());
			else await this.handleFailure(trigger, undefined, [], result, runs);
			await this.afterRun?.().catch(() => {});
			return ok ? "ran" : "failed";
		} catch (error) {
			if (this.stopped) return "empty";
			const result = { ok: false, error: error?.message ?? String(error) };
			await this.finish({ trigger, scope: "cross", sessionIds: [] }, result, runs);
			await this.handleFailure(trigger, undefined, [], result, runs);
			return "failed";
		} finally {
			this.release(CROSS);
		}
	}

	/** Call `runDream`, turning a throw into a failed result. A run cancelled by `stop()` or `cancelAll()` comes back with `cancelled`. */
	async invoke(job) {
		const controller = new AbortController();
		const startedAt = this.now();
		this.aborts.add(controller);
		try {
			const result = await this.runDream({ ...job, selection: this.resolveSelection(), indexMaxBytes: this.config.indexMaxBytes.get(), signal: controller.signal });
			return !result.ok && controller.signal.aborted ? { ...result, startedAt, cancelled: true } : { ...result, startedAt };
		} catch (error) {
			return { ok: false, startedAt, error: error?.message ?? String(error), ...(controller.signal.aborted ? { cancelled: true } : {}) };
		} finally {
			this.aborts.delete(controller);
		}
	}

	/** Log one run. @returns {Promise<boolean>} whether it succeeded. */
	async finish(base, result, runs) {
		const entry = {
			at: this.now(),
			...base,
			ok: result.ok,
			...(result.ok ? { changes: result.changes, issues: result.issues ?? [] } : { error: result.error }),
			...(result.ok && result.summary ? { summary: result.summary } : {}),
			...(result.dreamSessionId ? { dreamSessionId: result.dreamSessionId } : {})
		};
		await this.state.appendLog(entry);
		runs.push(entry);
		if (result.ok) {
			this.streak = 0;
			this.waveEnd = -1;
		}
		return result.ok;
	}
}

/**
 * Queue sessions that ended without being noticed (host restart, idle timer
 * lost): recent, cold, eligible sessions whose events past their watermark
 * are worth a run (`isSubstantive`).
 * @param sessionQuery - `ctx.sessionQuery`.
 * @param {import("./state.js").DreamState} state
 * @param {{ now?: () => number, cwd?: string, excludeSessionId?: string, maxAgeMs?: number }} [options]
 * @returns {Promise<string[]>} ids newly queued.
 */
export async function reconcile(sessionQuery, state, { now = Date.now, cwd, excludeSessionId, maxAgeMs = 7 * DAY_MS } = {}) {
	const queued = new Set(state.pending().map((job) => job.sessionId));
	const added = [];
	const sessions = await sessionQuery.listSessions();
	/* A full scan also forgets the watermarks of deleted sessions (an empty listing is not trusted). */
	if (cwd === undefined && sessions.length > 0) await state.pruneSessions(sessions.map(({ header }) => header.id));
	for (const { header, live } of sessions) {
		if (live || !isEligible(header) || header.id === excludeSessionId || queued.has(header.id)) continue;
		if (cwd !== undefined && !sameProject(header.cwd, cwd)) continue;
		if ((header.createdAt ?? 0) < Math.max(now() - maxAgeMs, state.installedAt ?? 0)) continue;
		const events = await sessionQuery.listEvents(header.id);
		const last = events.at(-1);
		const seq = last?.seq ?? 0;
		const watermark = state.watermark(header.id);
		if (seq <= watermark) continue;
		if (!isSubstantive(events.filter((event) => event.seq > watermark).reduce(accumulate, emptyActivity()))) continue;
		await state.enqueue({ sessionId: header.id, cwd: header.cwd, endedAt: last?.time ?? header.createdAt ?? now(), seq });
		added.push(header.id);
	}
	return added;
}

/**
 * Identify a stored hidden session as a dreaming run: its first user message
 * opens with a dreaming prompt marker. Returns its creation time, or null
 * when it is not ours or cannot be read.
 * @param {string} dir - `<sessions>/_no-cwd/<id>`.
 * @returns {Promise<number | null>}
 */
async function dreamSessionCreatedAt(dir) {
	let raw;
	try {
		const file = (await readdir(dir)).find((name) => /^session\..*\.jsonl(\.zstd)?$/.test(name));
		if (file === undefined) return null;
		if ((await stat(join(dir, file))).size > MAX_DREAM_SESSION_BYTES) return null;
		raw = await readFile(join(dir, file));
		if (file.endsWith(".zstd")) {
			if (typeof zlib.zstdDecompress !== "function") return null;
			raw = await promisify(zlib.zstdDecompress)(raw);
		}
	} catch {
		return null;
	}
	let createdAt = 0;
	for (const line of raw.toString("utf8").split("\n")) {
		if (line.trim() === "") continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			return null;
		}
		if (event.type === "session") createdAt = event.createdAt ?? 0;
		else if (event.type === "user/message") {
			const text = (event.data?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
			return DREAM_PROMPT_MARKERS.some((marker) => text.startsWith(marker)) ? createdAt : null;
		}
	}
	return null;
}

/**
 * Delete the stored sessions of old dreaming runs, keeping the newest `keep`.
 * Runs are found on disk, not in plugin state, so sessions left by a reset or
 * reinstalled plugin are cleaned too; any other hidden session is untouched.
 * @param {string} sessionsRoot - `<DSH home>/sessions`.
 * @param {{ keep?: number, cache?: Map<string, number | null> }} [options]
 *   `cache` remembers what each session id turned out to be across calls.
 */
export async function pruneDreamSessions(sessionsRoot, { keep = 50, cache = new Map() } = {}) {
	const root = join(sessionsRoot, "_no-cwd");
	let ids;
	try {
		ids = (await readdir(root)).filter((id) => /^session-[\w-]+$/.test(id));
	} catch {
		return;
	}
	const ours = [];
	for (const id of ids) {
		if (!cache.has(id)) cache.set(id, await dreamSessionCreatedAt(join(root, id)));
		const createdAt = cache.get(id);
		if (createdAt !== null) ours.push({ id, createdAt });
	}
	ours.sort((a, b) => a.createdAt - b.createdAt);
	for (const { id } of ours.slice(0, Math.max(0, ours.length - keep))) {
		await rm(join(root, id), { recursive: true, force: true });
		cache.delete(id);
	}
}
