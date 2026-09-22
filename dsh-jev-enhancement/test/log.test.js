import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJevLog, storageRoot } from "../lib/log.js";

/** A fresh temp storage root per test. */
function tempRoot() {
	return mkdtempSync(join(tmpdir(), "jev-log-"));
}

test("records land as JSONL and read back in order", () => {
	const log = createJevLog({ root: tempRoot() });
	assert.equal(log.append({ kind: "jevCalls", at: "2026-09-22T00:00:00.000Z", latencyMs: 12 }), true);
	assert.equal(log.append({ kind: "decision", at: "2026-09-22T00:00:01.000Z", node: "risk-judgment" }), true);
	const lines = log.read().trim().split("\n");
	assert.equal(lines.length, 2);
	assert.equal(JSON.parse(lines[0]).kind, "jevCalls");
	assert.equal(JSON.parse(lines[1]).node, "risk-judgment");
});

test("rotation keeps one predecessor and the export contains both", () => {
	const root = tempRoot();
	const log = createJevLog({ root, maxBytes: 32 });
	log.append({ kind: "first" });
	log.append({ kind: "second-a-little-longer" });
	log.append({ kind: "third-also-long-enough-to-rotate" });
	assert.deepEqual(readdirSync(root).sort(), ["jev-audit.jsonl", "jev-audit.jsonl.1"]);
	const body = log.read();
	assert.ok(body.includes('"first"') || body.includes('"second-a-little-longer"'), "older history survives rotation in the export");
	assert.ok(body.includes('"third-also-long-enough-to-rotate"'), "the live tail is exported");
});

test("an unusable root degrades to no log instead of throwing", () => {
	const root = join(tempRoot(), "file-as-dir");
	writeFileSync(root, "not a directory");
	const log = createJevLog({ root });
	assert.equal(log.append({ kind: "jevCalls" }), false);
	assert.equal(log.read(), "");
});

test("nothing is created before the first append", () => {
	const root = join(tempRoot(), "unused");
	createJevLog({ root });
	assert.deepEqual(readdirSync(join(root, "..")), [], "lazy: the directory appears on first write only");
});

test("storageRoot honors DSH_HOME like the harness", () => {
	assert.equal(storageRoot({ DSH_HOME: "/x" }, "/home/u"), join("/x", "storages", "jev-enhancement"));
	assert.equal(storageRoot({}, "/home/u"), join("/home/u", ".dsh", "storages", "jev-enhancement"));
});
