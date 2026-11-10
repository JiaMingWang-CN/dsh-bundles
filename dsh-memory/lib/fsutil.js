/**
 * Small filesystem helpers shared by the store and the dreaming state.
 */
import { rename } from "node:fs/promises";

/** Errors Windows raises while an antivirus scanner or indexer briefly holds a file. */
const TRANSIENT_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * `rename`, retried a few times on the transient errors above.
 * @param {string} from
 * @param {string} to
 * @param {{ attempts?: number, delayMs?: number }} [options]
 */
export async function renameWithRetry(from, to, { attempts = 5, delayMs = 40 } = {}) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await rename(from, to);
		} catch (error) {
			if (attempt >= attempts || !TRANSIENT_RENAME.has(error?.code)) throw error;
			await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
		}
	}
}
