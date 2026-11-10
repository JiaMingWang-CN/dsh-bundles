import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../lib/store.js";
import { checkPartition, renderHealth } from "../lib/health.js";

async function fresh(t) {
	const root = await mkdtemp(join(tmpdir(), "dsh-memory-health-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return new MemoryStore(root);
}

test("a tidy partition has no issues", async (t) => {
	const store = await fresh(t);
	await store.write("user", undefined, "INDEX.md", "- [Testing](testing/db.md) how to run DB tests\n", null);
	await store.write("user", undefined, "testing/db.md", "See [index](../INDEX.md). External [link](https://example.com/x.md).", null);
	assert.deepEqual(await checkPartition(store, "user", undefined, 4096), []);
	assert.equal(renderHealth([{ label: "user", issues: [] }]), "");
});

test("dangling links, unlisted notes, oversize notes and an oversize INDEX are found", async (t) => {
	const store = await fresh(t);
	await store.write("user", undefined, "INDEX.md", "- [A](a.md) ok\n- [Gone](gone.md) missing\n" + "z".repeat(300) + "\n", null);
	await store.write("user", undefined, "a.md", "see [b](sub/b.md#part)", null);
	await store.write("user", undefined, "orphan.md", "x".repeat(4000), null);
	const issues = await checkPartition(store, "user", undefined, 200);
	assert.ok(issues.some((issue) => /INDEX\.md is \d+ bytes; the limit is 200/.test(issue)), issues.join("\n"));
	assert.ok(issues.some((issue) => /INDEX\.md has 1 line\(s\) over 240 bytes/.test(issue)));
	assert.ok(issues.includes("INDEX.md links to gone.md, which does not exist"));
	assert.ok(issues.includes("a.md links to sub/b.md, which does not exist"));
	assert.ok(issues.includes("orphan.md is not listed in INDEX.md"));
	assert.ok(issues.some((issue) => /^orphan\.md is 4000 bytes/.test(issue)));
	assert.match(renderHealth([{ label: "project", issues: ["x"] }]), /^- project: x$/);
});

test("notes without any INDEX.md are reported once, and long lists are capped", async (t) => {
	const store = await fresh(t);
	await store.write("user", undefined, "a.md", "x", null);
	assert.deepEqual(await checkPartition(store, "user", undefined, 4096), ["there is no INDEX.md although the partition has notes"]);
	const many = await fresh(t);
	await many.write("user", undefined, "INDEX.md", "-", null);
	for (let i = 0; i < 20; i++) await many.write("user", undefined, `n${i}.md`, "x", null);
	const issues = await checkPartition(many, "user", undefined, 4096);
	assert.equal(issues.length, 13);
	assert.match(issues.at(-1), /…and 8 more/);
	assert.deepEqual(await checkPartition(await fresh(t), "project", "C:\\none", 4096), []);
});
