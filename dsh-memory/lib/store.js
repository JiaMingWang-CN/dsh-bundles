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
import { mkdir, readFile, readdir, rename, rm, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { partitionDir, resolveEntry } from "./paths.js";

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

/** Counts the note changes made during one run, for the dreaming log. */
export function createChangeTracker() {
	const counts = { created: 0, modified: 0, deleted: 0 };
	return {
		/** @param {"created" | "modified" | "deleted"} kind @param {string} _path */
		record(kind, _path) {
			counts[kind]++;
		},
		summary() {
			return { ...counts };
		}
	};
}

export class MemoryStore {
	/** @param {string} root - memory root (see `resolveMemoryRoot`). */
	constructor(root) {
		this.root = root;
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
		const current = await readIfExists(file);
		const currentVersion = current === null ? null : versionOf(current);
		if (currentVersion !== expectedVersion) throw new MemoryConflictError(path, currentVersion);
		await mkdir(dirname(file), { recursive: true });
		const temp = join(dirname(file), `.${randomUUID()}.tmp`);
		await writeFile(temp, content, "utf8");
		try {
			await rename(temp, file);
		} catch (error) {
			await rm(temp, { force: true });
			throw error;
		}
		tracker?.record(current === null ? "created" : "modified", path);
		return { version: versionOf(content) };
	}

	/**
	 * Delete a note.
	 * @param {string} expectedVersion - version read before deleting.
	 * @param {ReturnType<typeof createChangeTracker>} [tracker]
	 */
	async remove(scope, cwd, path, expectedVersion, tracker) {
		const file = resolveEntry(partitionDir(this.root, scope, cwd), path);
		const current = await readIfExists(file);
		const currentVersion = current === null ? null : versionOf(current);
		if (currentVersion === null || currentVersion !== expectedVersion) throw new MemoryConflictError(path, currentVersion);
		await unlink(file);
		tracker?.record("deleted", path);
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
		} catch (error) {
			if (error.code === "ENOENT") return null;
			throw error;
		}
	}
}
