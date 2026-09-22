/**
 * The plugin's own audit log file (plan §9 observability).
 *
 * Every Jev activity lands here as one JSONL record: call counts and
 * latencies, compaction advice/commits/restores, decision outcomes, fallbacks
 * and circuit state. Records are metadata only — the same field whitelist the
 * in-memory audit enforces, so no message text, state payload, or credential
 * can ever reach the file. Written under the harness' plugin storage root with
 * owner-only permissions and bounded by one rotation.
 *
 * Node-only module (fs/os/path); `node --test` runs it against a temp root.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Plugin-owned storage directory name under the harness `storages` root. */
const STORE_DIR = "jev-enhancement";

/** Log file name inside the storage directory. */
const LOG_FILE = "jev-audit.jsonl";

/** Rotated predecessor suffix. */
const ROTATED_SUFFIX = ".1";

/** Rotate once the live file reaches this size (one predecessor is kept). */
const MAX_LOG_BYTES = 1024 * 1024;

/** Private file mode: owner read/write only (POSIX; on Windows this is advisory). */
const FILE_MODE = 0o600;

/** Owner-only directory mode. */
const DIR_MODE = 0o700;

/**
 * This plugin's storage root, honoring an explicit `DSH_HOME` exactly as the
 * harness does.
 * @param {object} [env] - environment record.
 * @param {string} [home] - the user's home directory.
 * @returns {string} absolute path of the plugin's storage directory.
 */
function storageRoot(env = process.env, home = homedir()) {
	return join(env.DSH_HOME || join(home, ".dsh"), "storages", STORE_DIR);
}

/**
 * Open the Jev audit log. Nothing is created until the first append, and every
 * failure degrades to "no log" — observability never breaks the request path.
 * @param {object} [options] - `root` override, `maxBytes` rotation size.
 * @returns {object} the log handle.
 */
function createJevLog(options = {}) {
	const root = options.root ?? storageRoot();
	const file = join(root, LOG_FILE);
	const rotated = file + ROTATED_SUFFIX;
	const maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
	let writable;

	/** Lazily create the owner-only directory exactly once. */
	const ensure = () => {
		if (writable !== undefined) return writable;
		try {
			mkdirSync(root, { recursive: true, mode: DIR_MODE });
			writable = true;
		} catch {
			writable = false;
		}
		return writable;
	};

	/** Keep one predecessor so an export cannot silently lose history. */
	const rotate = () => {
		try {
			if (statSync(file).size >= maxBytes) renameSync(file, rotated);
		} catch {
			/* missing or unreadable file simply starts fresh */
		}
	};

	return {
		path: file,
		/**
		 * Append one JSONL record.
		 * @param {object} record - already-redacted metadata.
		 * @returns {boolean} whether the record was written.
		 */
		append(record) {
			if (!ensure()) return false;
			try {
				rotate();
				appendFileSync(file, JSON.stringify(record) + "\n", { mode: FILE_MODE });
				return true;
			} catch {
				return false;
			}
		},
		/**
		 * Read the complete export body: rotated predecessor first, then live.
		 * @returns {string} JSONL text (empty when nothing was ever written).
		 */
		read() {
			const readOne = (path) => {
				try {
					return readFileSync(path, "utf8");
				} catch {
					return "";
				}
			};
			return readOne(rotated) + readOne(file);
		}
	};
}

export { DIR_MODE, FILE_MODE, LOG_FILE, MAX_LOG_BYTES, ROTATED_SUFFIX, STORE_DIR, createJevLog, storageRoot };
