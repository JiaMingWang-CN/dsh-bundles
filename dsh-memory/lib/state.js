/**
 * Durable dreaming state under `<memory root>/.state/`:
 *   state.json  — pending queue, per-session watermarks, pause flag
 *   log.jsonl   — run log, last 200 entries
 *
 * A session leaves the queue only through `complete()` after a successful
 * run, so a host shutdown mid-run keeps the batch queued. Writes are chained
 * so concurrent callers never interleave a read-modify-write.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOG_LIMIT = 200;

/**
 * @typedef {{ sessionId: string, cwd: string, endedAt: number, seq: number }} Job
 * @typedef {{ at: number, cwd: string, sessionIds: string[], ok: boolean, trigger: "auto" | "manual",
 *   changes?: { created: number, modified: number, deleted: number }, error?: string, dreamSessionId?: string }} LogEntry
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
	await writeFile(temp, content, "utf8");
	await rename(temp, file);
}

export class DreamState {
	/** @param {string} root - memory root. */
	constructor(root) {
		this.dir = join(root, ".state");
		this.stateFile = join(this.dir, "state.json");
		this.logFile = join(this.dir, "log.jsonl");
		/** @type {{ queue: Job[], watermarks: Record<string, number>, paused: { since: number, reason: string } | null }} */
		this.data = { queue: [], watermarks: {}, paused: null };
		/** @type {LogEntry[]} */
		this.log = [];
		this.chain = Promise.resolve();
	}

	/** Read persisted state; a missing directory means a fresh install. */
	async load() {
		const raw = await readIfExists(this.stateFile);
		if (raw !== null) this.data = { queue: [], watermarks: {}, paused: null, ...JSON.parse(raw) };
		const log = await readIfExists(this.logFile);
		this.log = log === null ? [] : log.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line)).slice(-LOG_LIMIT);
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

	/** Dequeue sessions after a successful run and advance their watermarks. */
	complete(sessionIds) {
		const done = new Set(sessionIds);
		return this.persist(() => {
			for (const job of this.data.queue) if (done.has(job.sessionId)) this.data.watermarks[job.sessionId] = Math.max(job.seq, this.data.watermarks[job.sessionId] ?? 0);
			this.data.queue = this.data.queue.filter((job) => !done.has(job.sessionId));
		});
	}

	/** @returns {number} last consolidated event seq for a session, 0 if never. */
	watermark(sessionId) {
		return this.data.watermarks[sessionId] ?? 0;
	}

	get paused() {
		return this.data.paused;
	}

	/** @param {{ since: number, reason: string } | null} value */
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
