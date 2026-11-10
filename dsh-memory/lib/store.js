/**
 * Memory note storage with optimistic concurrency.
 *
 * Sessions and dreaming can write the same note. Every read returns a
 * `version` (content hash); a write or delete must present the version it
 * read, or `null` to create a note that must not exist yet. A mismatch throws
 * `MemoryConflictError` and leaves the file untouched, so the caller re-reads
 * and rewrites instead of silently overwriting. The version is a content hash
 * rather than mtime/size, which two quick same-length writes could collide on.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, rmdir, stat, writeFile, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { partitionDir, resolveEntry } from "./paths.js";
import { renameWithRetry } from "./fsutil.js";

/** Dreaming runs whose pre-change note copies are kept. */
export const HISTORY_KEEP = 20;
/** Leftover `.tmp` files older than this are swept. */
const STALE_TMP_MS = 3_600_000;
const SEARCH_HITS = 50;

/** Error for a write or delete whose expected version no longer matches. */
export class MemoryConflictError extends Error {
	code = "MEMORY_CONFLICT";
	/**
	 * @param {string} path - the note path.
	 * @param {string | null} currentVersion - version on disk, or null when the note is gone.
	 */
	constructor(path, currentVersion) {
		super(`memory note ${path} changed since it was read`);
		this.name = "MemoryConflictError";
		this.currentVersion = currentVersion;
	}
}

const versionOf = (content) => createHash("sha256").update(content).digest("hex").slice(0, 16);

async function readIfExists(file) {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

/**
 * Copies a note's content aside before a dreaming run first changes it, to
 * `<root>/.state/history/<runId>/<path relative to the root>`, so a run's
 * changes can be undone by copying the files back.
 * @param {string} root - memory root.
 * @param {string} runId - directory name for this run.
 * @returns {(file: string, content: string) => Promise<void>}
 */
export function createBackup(root, runId) {
	const done = new Set();
	return async (file, content) => {
		const rel = relative(root, file);
		if (done.has(rel.toLowerCase())) return;
		done.add(rel.toLowerCase());
		const dest = join(root, ".state", "history", runId, rel);
		await mkdir(dirname(dest), { recursive: true });
		await writeFile(dest, content, "utf8");
	};
}

/** Keep only the newest `keep` run snapshots under `<root>/.state/history/`. */
export async function pruneHistory(root, keep = HISTORY_KEEP) {
	const dir = join(root, ".state", "history");
	let names;
	try {
		names = await readdir(dir);
	} catch {
		return;
	}
	const runs = [];
	for (const name of names) {
		const info = await stat(join(dir, name)).catch(() => null);
		if (info?.isDirectory()) runs.push({ name, at: info.mtimeMs });
	}
	runs.sort((a, b) => b.at - a.at);
	for (const { name } of runs.slice(keep)) await rm(join(dir, name), { recursive: true, force: true });
}

/**
 * Records the notes one run changed, for the dreaming log. A note counts
 * once, by its state before and after the run: written three times is one
 * modification; created and then deleted is no change.
 * @param {{ backup?: (file: string, content: string) => Promise<void> }} [options] - copies a note aside before its first change.
 */
export function createChangeTracker({ backup } = {}) {
	/** path → whether it existed before the run, and whether it exists now. */
	const notes = new Map();
	return {
		backup,
		/** @param {"created" | "modified" | "deleted"} kind @param {string} path - note label, e.g. "user/INDEX.md". */
		record(kind, path) {
			const note = notes.get(path) ?? { before: kind !== "created" };
			note.after = kind !== "deleted";
			notes.set(path, note);
		},
		/** @returns {{ created: number, modified: number, deleted: number, paths: { created: string[], modified: string[], deleted: string[] } }} */
		summary() {
			const paths = { created: [], modified: [], deleted: [] };
			for (const [path, { before, after }] of notes) {
				if (!before && after) paths.created.push(path);
				else if (before && after) paths.modified.push(path);
				else if (before && !after) paths.deleted.push(path);
			}
			return { created: paths.created.length, modified: paths.modified.length, deleted: paths.deleted.length, paths };
		}
	};
}

export class MemoryStore {
	/** @param {string} root - memory root (see `resolveMemoryRoot`). */
	constructor(root) {
		this.root = root;
		/** Per-file tail of the in-process write queue; sessions and dreaming share one process. */
		this.locks = new Map();
	}

	/** Run `fn` after every earlier mutation of the same file, so check-then-rename is atomic in-process. */
	async exclusive(file, fn) {
		/* Case-folded: on Windows and macOS `Note.md` and `note.md` are one file. */
		const key = file.toLowerCase();
		const previous = this.locks.get(key) ?? Promise.resolve();
		let release;
		const current = new Promise((resolve) => { release = resolve; });
		const tail = previous.then(() => current);
		this.locks.set(key, tail);
		await previous;
		try {
			return await fn();
		} finally {
			release();
			if (this.locks.get(key) === tail) this.locks.delete(key);
		}
	}

	/** @returns {Promise<Array<{ path: string, bytes: number, version: string }>>} every note in the partition. */
	async list(scope, cwd) {
		const dir = partitionDir(this.root, scope, cwd);
		const out = [];
		const walk = async (abs, rel) => {
			let entries;
			try {
				entries = await readdir(abs, { withFileTypes: true });
			} catch (error) {
				if (error.code === "ENOENT") return;
				throw error;
			}
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;
				const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
				if (entry.isDirectory()) await walk(join(abs, entry.name), relPath);
				else if (entry.isFile() && entry.name.endsWith(".md")) {
					const content = await readFile(join(abs, entry.name), "utf8");
					out.push({ path: relPath, bytes: Buffer.byteLength(content), version: versionOf(content) });
				}
			}
		};
		await walk(dir, "");
		return out;
	}

	/** @returns {Promise<{ content: string, version: string } | null>} the note, or null when absent. */
	async read(scope, cwd, path) {
		const content = await readIfExists(resolveEntry(partitionDir(this.root, scope, cwd), path));
		return content === null ? null : { content, version: versionOf(content) };
	}

	/**
	 * Create or replace a note.
	 * @param {string | null} expectedVersion - version read before editing, or null to create.
	 * @param {ReturnType<typeof createChangeTracker>} [tracker]
	 * @returns {Promise<{ version: string }>}
	 */
	async write(scope, cwd, path, content, expectedVersion, tracker) {
		const file = resolveEntry(partitionDir(this.root, scope, cwd), path);
		return this.exclusive(file, async () => {
			const current = await readIfExists(file);
			const currentVersion = current === null ? null : versionOf(current);
			if (currentVersion !== expectedVersion) throw new MemoryConflictError(path, currentVersion);
			await mkdir(dirname(file), { recursive: true });
			if (current !== null) await tracker?.backup?.(file, current);
			const temp = join(dirname(file), `.${randomUUID()}.tmp`);
			try {
				await writeFile(temp, content, "utf8");
				await renameWithRetry(temp, file);
			} catch (error) {
				await rm(temp, { force: true });
				throw error;
			}
			tracker?.record(current === null ? "created" : "modified", path);
			return { version: versionOf(content) };
		});
	}

	/**
	 * Delete a note.
	 * @param {string} expectedVersion - version read before deleting.
	 * @param {ReturnType<typeof createChangeTracker>} [tracker]
	 */
	async remove(scope, cwd, path, expectedVersion, tracker) {
		const file = resolveEntry(partitionDir(this.root, scope, cwd), path);
		await this.exclusive(file, async () => {
			const current = await readIfExists(file);
			const currentVersion = current === null ? null : versionOf(current);
			if (currentVersion === null || currentVersion !== expectedVersion) throw new MemoryConflictError(path, currentVersion);
			await tracker?.backup?.(file, current);
			await unlink(file);
			tracker?.record("deleted", path);
		});
		await this.pruneEmptyDirs(partitionDir(this.root, scope, cwd), dirname(file));
	}

	/**
	 * Move a note, possibly into another partition, in one rename: the note is
	 * never missing and never duplicated. The target must not exist.
	 * @param {{ scope: "project" | "user", cwd?: string, path: string }} from
	 * @param {{ scope: "project" | "user", cwd?: string, path: string }} to
	 * @param {string} expectedVersion - version of the source read before moving.
	 * @param {{ backup?: Function }} [tracker] - only `backup` is used; the caller records the change under its own labels.
	 * @returns {Promise<{ version: string }>}
	 */
	async move(from, to, expectedVersion, tracker) {
		const source = resolveEntry(partitionDir(this.root, from.scope, from.cwd), from.path);
		const target = resolveEntry(partitionDir(this.root, to.scope, to.cwd), to.path);
		if (source.toLowerCase() === target.toLowerCase()) throw new Error("source and target are the same note");
		const [first, second] = source.toLowerCase() < target.toLowerCase() ? [source, target] : [target, source];
		const result = await this.exclusive(first, () => this.exclusive(second, async () => {
			const current = await readIfExists(source);
			const currentVersion = current === null ? null : versionOf(current);
			if (currentVersion === null || currentVersion !== expectedVersion) throw new MemoryConflictError(from.path, currentVersion);
			if ((await readIfExists(target)) !== null) throw new Error(`${to.path} already exists in the target partition; pick another path, or merge into it with memory_write and delete the source.`);
			await tracker?.backup?.(source, current);
			await mkdir(dirname(target), { recursive: true });
			await renameWithRetry(source, target);
			return { version: versionOf(current) };
		}));
		await this.pruneEmptyDirs(partitionDir(this.root, from.scope, from.cwd), dirname(source));
		return result;
	}

	/** Remove now-empty note directories up to (not including) the partition directory. */
	async pruneEmptyDirs(partition, dir) {
		for (;;) {
			const rel = relative(partition, dir);
			if (rel === "" || rel.startsWith("..") || rel === dir) return;
			try {
				await rmdir(dir);
			} catch {
				return;
			}
			dir = dirname(dir);
		}
	}

	/**
	 * Case-insensitive literal search across one partition's notes.
	 * @returns {Promise<string[]>} `path:line: text` hits, at most 50.
	 */
	async search(scope, cwd, query) {
		const needle = query.toLowerCase();
		const hits = [];
		for (const { path } of await this.list(scope, cwd)) {
			const note = await this.read(scope, cwd, path);
			for (const [index, line] of (note?.content ?? "").split("\n").entries()) {
				if (!line.toLowerCase().includes(needle)) continue;
				hits.push(`${path}:${index + 1}: ${line.trim().slice(0, 200)}`);
				if (hits.length >= SEARCH_HITS) return hits;
			}
		}
		return hits;
	}

	/** Delete `.tmp` files that a crash left in the partitions. */
	async sweep(now = Date.now()) {
		const walk = async (dir) => {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const abs = join(dir, entry.name);
				if (entry.isDirectory()) await walk(abs);
				else if (entry.isFile() && entry.name.endsWith(".tmp")) {
					const info = await stat(abs).catch(() => null);
					if (info !== null && now - info.mtimeMs > STALE_TMP_MS) await rm(abs, { force: true });
				}
			}
		};
		await walk(join(this.root, "user"));
		await walk(join(this.root, "projects"));
	}

	/** @returns {Promise<string | null>} the partition's INDEX.md content, or null. */
	async readIndex(scope, cwd) {
		return (await this.read(scope, cwd, "INDEX.md"))?.content ?? null;
	}

	/**
	 * Synchronous INDEX read for system-prompt section callbacks, which DSH
	 * evaluates synchronously; called once per session snapshot.
	 * @returns {string | null} the partition's INDEX.md content, or null.
	 */
	readIndexSync(scope, cwd) {
		try {
			return readFileSync(resolveEntry(partitionDir(this.root, scope, cwd), "INDEX.md"), "utf8");
		} catch {
			/* A missing or unreadable INDEX (EACCES, EISDIR) must not break the session's prompt assembly: act as if empty. */
			return null;
		}
	}
}
