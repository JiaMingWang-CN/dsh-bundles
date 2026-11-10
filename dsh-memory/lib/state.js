/**
 * Durable dreaming state under `<memory root>/.state/`:
 *   state.json  — pending queue, per-session watermarks, pause flag,
 *                 cross-project bookkeeping
 *   log.jsonl   — run log, last 200 entries
 *
 * A session leaves the queue only through `complete()` after a successful
 * run, so a host shutdown mid-run keeps the batch queued. Writes are chained
 * so concurrent callers never interleave a read-modify-write.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renameWithRetry } from "./fsutil.js";

const LOG_LIMIT = 200;

/**
 * @typedef {{ sessionId: string, cwd: string, endedAt: number, seq: number }} Job
 * @typedef {{ at: number, cwd?: string, scope?: "cross", sessionIds: string[], ok: boolean, trigger: "auto" | "manual",
 *   changes?: { created: number, modified: number, deleted: number, paths?: object }, issues?: string[], summary?: string,
 *   error?: string, dreamSessionId?: string }} LogEntry
 *   A cross-project run has `scope: "cross"` and no `cwd`; `issues` lists what an ok run left unresolved.
 */

async function readIfExists(file) {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

async function writeAtomic(file, content) {
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, content, "utf8");
		await renameWithRetry(temp, file);
	} catch (error) {
		await rm(temp, { force: true }).catch(() => {});
		throw error;
	}
}

export class DreamState {
	/**
	 * @param {string} root - memory root.
	 * @param {{ now?: () => number }} [options]
	 */
	constructor(root, { now = Date.now } = {}) {
		this.now = now;
		this.dir = join(root, ".state");
		this.stateFile = join(this.dir, "state.json");
		this.logFile = join(this.dir, "log.jsonl");
		/** @type {{ queue: Job[], watermarks: Record<string, number>, paused: { since: number, reason: string } | null, cross?: { at?: number, projects: string[] } }} */
		this.data = { queue: [], watermarks: {}, paused: null };
		/** @type {LogEntry[]} */
		this.log = [];
		/** True when `load()` found an unreadable state.json and started fresh. */
		this.recovered = false;
		this.chain = Promise.resolve();
	}

	/** Read persisted state; a missing directory means a fresh install. */
	async load() {
		const raw = await readIfExists(this.stateFile);
		if (raw !== null) {
			try {
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("state.json is not an object");
				const data = { queue: [], watermarks: {}, paused: null, ...parsed };
				if (!Array.isArray(data.queue) || typeof data.watermarks !== "object" || data.watermarks === null) throw new Error("state.json has a bad shape");
				this.data = data;
			} catch {
				/* A corrupt state file must not stop the plugin: keep it aside for inspection and start fresh. */
				await rename(this.stateFile, `${this.stateFile}.corrupt-${this.now()}`).catch(() => {});
				this.recovered = true;
			}
		}
		/* First load marks the install time: sessions created earlier are never backfilled. */
		if (typeof this.data.installedAt !== "number") {
			const installedAt = this.now();
			await this.persist(() => {
				this.data.installedAt = installedAt;
			});
		}
		const log = await readIfExists(this.logFile);
		/* An append torn by a crash leaves a partial last line; skip unparsable lines rather than refuse to load. */
		this.log = log === null ? [] : log.split("\n").flatMap((line) => {
			try {
				return line.trim() === "" ? [] : [JSON.parse(line)];
			} catch {
				return [];
			}
		}).slice(-LOG_LIMIT);
	}

	/** Run one mutation after every earlier one, then persist. */
	persist(mutate) {
		const next = this.chain.then(async () => {
			mutate();
			await mkdir(this.dir, { recursive: true });
			await writeAtomic(this.stateFile, JSON.stringify(this.data));
		});
		this.chain = next.catch(() => {});
		return next;
	}

	/** Queue one ended session; a re-queued session keeps only its latest position. */
	enqueue(job) {
		return this.persist(() => {
			this.data.queue = this.data.queue.filter((queued) => queued.sessionId !== job.sessionId);
			this.data.queue.push({ sessionId: job.sessionId, cwd: job.cwd, endedAt: job.endedAt, seq: job.seq });
		});
	}

	/** @returns {Job[]} queued sessions, oldest ending first, optionally for one project. */
	pending(cwd) {
		return this.data.queue.filter((job) => cwd === undefined || job.cwd === cwd).sort((a, b) => a.endedAt - b.endedAt).map((job) => ({ ...job }));
	}

	/**
	 * Advance watermarks to the seqs a run actually covered, and dequeue those
	 * sessions unless they were re-queued with newer events meanwhile.
	 * @param {Array<{ sessionId: string, seq: number }>} covered - the batch as captured when the run started.
	 */
	complete(covered) {
		const seqs = new Map(covered.map((job) => [job.sessionId, job.seq]));
		return this.persist(() => {
			for (const [sessionId, seq] of seqs) this.data.watermarks[sessionId] = Math.max(seq, this.data.watermarks[sessionId] ?? 0);
			for (const [sessionId, seq] of seqs) {
				const queued = this.data.queue.find((job) => job.sessionId === sessionId);
				if (queued === undefined || queued.seq <= seq) delete this.data.attempts?.[sessionId];
			}
			this.data.queue = this.data.queue.filter((job) => !seqs.has(job.sessionId) || job.seq > seqs.get(job.sessionId));
		});
	}

	/**
	 * Count one failed run against each session of its batch.
	 * @returns {Promise<Record<string, number>>} the new counts.
	 */
	noteFailure(sessionIds) {
		const counts = {};
		return this.persist(() => {
			this.data.attempts ??= {};
			for (const id of sessionIds) counts[id] = this.data.attempts[id] = (this.data.attempts[id] ?? 0) + 1;
		}).then(() => counts);
	}

	/** A session made progress: its earlier failures no longer count against it. */
	clearAttempts(sessionIds) {
		if (!sessionIds.some((id) => this.data.attempts?.[id] !== undefined)) return Promise.resolve();
		return this.persist(() => {
			for (const id of sessionIds) delete this.data.attempts?.[id];
		});
	}

	/** @returns {number} failed runs counted against a session since it last completed. */
	attempts(sessionId) {
		return this.data.attempts?.[sessionId] ?? 0;
	}

	/** Forget watermarks and failure counts of sessions that no longer exist (queued ones are kept). */
	pruneSessions(existingIds) {
		const keep = new Set(existingIds);
		const stale = (id) => !keep.has(id) && !this.data.queue.some((job) => job.sessionId === id);
		const ids = [...Object.keys(this.data.watermarks), ...Object.keys(this.data.attempts ?? {})];
		if (!ids.some(stale)) return Promise.resolve();
		return this.persist(() => {
			for (const id of Object.keys(this.data.watermarks)) if (stale(id)) delete this.data.watermarks[id];
			for (const id of Object.keys(this.data.attempts ?? {})) if (stale(id)) delete this.data.attempts[id];
		});
	}

	/** @returns {string[]} projects consolidated since the last cross-project run. */
	crossProjects() {
		return [...(this.data.cross?.projects ?? [])];
	}

	/** @returns {number | undefined} epoch ms of the last cross-project run. */
	get crossAt() {
		return this.data.cross?.at;
	}

	/** Note a successful project run, so a cross-project run becomes due. */
	noteProjectRun(cwd) {
		return this.persist(() => {
			const projects = this.data.cross?.projects ?? [];
			/* The first project run starts the day: a cross-project run is never due right after it. */
			this.data.cross = { ...this.data.cross, at: this.data.cross?.at ?? this.now(), projects: projects.includes(cwd) ? projects : [...projects, cwd] };
		});
	}

	/** Mark a cross-project run done. */
	completeCross(at) {
		return this.persist(() => {
			this.data.cross = { at, projects: [] };
		});
	}

	/** @returns {number} last consolidated event seq for a session, 0 if never. */
	watermark(sessionId) {
		return this.data.watermarks[sessionId] ?? 0;
	}

	/** @returns {number} epoch ms when this memory root was first used by the plugin. */
	get installedAt() {
		return this.data.installedAt;
	}

	get paused() {
		return this.data.paused;
	}

	/** @param {{ since: number, reason: string, kind?: "auth" | "repeated" | "manual" } | null} value */
	setPaused(value) {
		return this.persist(() => {
			this.data.paused = value;
		});
	}

	/** Append one run to the log, rewriting the file when it exceeds the limit. */
	appendLog(entry) {
		const next = this.chain.then(async () => {
			this.log.push(entry);
			await mkdir(this.dir, { recursive: true });
			if (this.log.length > LOG_LIMIT) {
				this.log = this.log.slice(-LOG_LIMIT);
				await writeAtomic(this.logFile, this.log.map((item) => JSON.stringify(item)).join("\n") + "\n");
			} else await appendFile(this.logFile, JSON.stringify(entry) + "\n", "utf8");
		});
		this.chain = next.catch(() => {});
		return next;
	}

	/** @returns {LogEntry[]} the last `n` runs, oldest first. */
	recentLog(n) {
		return this.log.slice(-n);
	}
}
