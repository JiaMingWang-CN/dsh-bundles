import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Extract the shared rules block from one source file.
 * @param {string} path - file to read.
 * @returns {string} the `//#region rules.js` … `//#endregion` block.
 */
function rulesBlock(path) {
	const source = readFileSync(path, "utf8");
	const start = source.indexOf("\n//#region rules.js\n");
	const end = source.indexOf("\n//#endregion", start);
	assert.notEqual(start, -1, path + " must contain the shared rules block");
	assert.notEqual(end, -1, path + " must close the shared rules block");
	return source.slice(start + 1, end + "\n//#endregion".length);
}

test("the settings page and the runtime share one copy of the rules", () => {
	const hostCopy = rulesBlock(join(root, "lib", "rules.js"));
	const clientCopy = rulesBlock(join(root, "lib", "client.js"));
	assert.equal(clientCopy, hostCopy, "lib/client.js drifted from lib/rules.js — re-embed the shared block");
});
