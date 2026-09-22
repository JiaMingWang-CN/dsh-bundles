/**
 * Re-embed the shared rules block into the client bundle.
 *
 * `lib/rules.js` owns the configuration rules; `lib/client.js` embeds the very
 * same `//#region rules.js` block so the settings page and the runtime gate can
 * never disagree (enforced by `test/rules-parity.test.js`). After editing
 * `lib/rules.js`, run `node scripts/sync-rules.mjs` to copy the block across.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Extract one region block from a source file.
 * @param {string} source - file text.
 * @returns {string} the region text, markers included.
 */
function region(source) {
	const start = source.indexOf("\n//#region rules.js\n");
	const end = source.indexOf("\n//#endregion", start);
	if (start < 0 || end < 0) throw new Error("shared rules block not found");
	return source.slice(start + 1, end + "\n//#endregion".length);
}

const rulesSource = readFileSync(join(root, "lib", "rules.js"), "utf8");
const clientPath = join(root, "lib", "client.js");
const clientSource = readFileSync(clientPath, "utf8");
const block = region(rulesSource);
const current = region(clientSource);
if (current === block) {
	console.log("lib/client.js is already in sync");
	process.exit(0);
}
writeFileSync(clientPath, clientSource.replace(current, block), "utf8");
console.log("lib/client.js updated from lib/rules.js");
