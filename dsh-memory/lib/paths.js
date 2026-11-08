/**
 * Memory directory layout and path guards.
 *
 *   <DSH home>/memory/
 *     user/                    cross-project partition
 *     projects/<cwd key>/      per-project partition
 *     .state/                  plugin-private state (never reachable from tools)
 */
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

/** Error for a partition or entry path the memory tools must refuse. */
export class MemoryPathError extends Error {
	code = "MEMORY_PATH_INVALID";
	constructor(message) {
		super(message);
		this.name = "MemoryPathError";
	}
}

/** Root directory holding every memory partition. */
export function resolveMemoryRoot() {
	return join(resolveDshHome(), "memory");
}

/**
 * Directory key for a project path, matching the directory names DSH uses
 * under `~/.dsh/sessions/`. Mirrors `projectKey()` in
 * `@deepseek-ai/dsh-session-persistence-jsonl` (not exported), plus two
 * normalizations so one project always maps to one partition: the drive letter
 * is upper-cased and trailing separators are dropped.
 * @param {string} cwd - absolute project directory.
 * @returns {string} single filesystem-safe directory name.
 */
export function encodeCwd(cwd) {
	let path = cwd.replace(/^([a-z]):/, (_m, drive) => `${drive.toUpperCase()}:`);
	path = path.replace(/(?<!^[A-Za-z]:|^)[\\/]+$/, "");
	if (path.length === 0) throw new MemoryPathError("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < path.length; i++) {
		const code = path.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * Directory of one memory partition.
 * @param {string} root - memory root.
 * @param {"project" | "user"} scope - partition kind.
 * @param {string} [cwd] - project directory; required for `project`.
 * @returns {string} partition directory.
 */
export function partitionDir(root, scope, cwd) {
	if (scope === "user") return join(root, "user");
	if (scope !== "project") throw new MemoryPathError(`unknown memory scope "${scope}"`);
	if (typeof cwd !== "string" || cwd.length === 0) throw new MemoryPathError("project memory needs a session with a working directory");
	return join(root, "projects", encodeCwd(cwd));
}

/**
 * Resolve a model-supplied relative note path inside a partition.
 * Only relative `.md` paths without empty, dot or hidden segments are allowed,
 * which also keeps `.state/` unreachable.
 * @param {string} dir - partition directory.
 * @param {string} relPath - relative note path using `/` or `\`.
 * @returns {string} absolute note path.
 */
export function resolveEntry(dir, relPath) {
	if (typeof relPath !== "string" || relPath.length === 0) throw new MemoryPathError("memory path is empty");
	if (/^[\\/]/.test(relPath) || /^[A-Za-z]:/.test(relPath)) throw new MemoryPathError(`memory path must be relative: ${relPath}`);
	const segments = relPath.split(/[\\/]/);
	for (const segment of segments) {
		if (segment.length === 0 || segment.startsWith(".")) throw new MemoryPathError(`invalid memory path segment in ${relPath}`);
	}
	if (!segments.at(-1).endsWith(".md")) throw new MemoryPathError(`memory notes must be .md files: ${relPath}`);
	return join(dir, ...segments);
}
