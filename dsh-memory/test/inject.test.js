import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../lib/store.js";
import { truncateUtf8Lines, renderIndexSection, installIndexInjection } from "../lib/inject.js";

const CWD = "C:\\Programs\\demo";

test("truncateUtf8Lines keeps text within budget untouched", () => {
	assert.deepEqual(truncateUtf8Lines("a\nb", 100), { text: "a\nb", truncated: false });
});

test("truncateUtf8Lines cuts at a full line within budget for Chinese text", () => {
	const line = "- [规则](规则.md) — 测试命令必须加串行参数，否则数据库夹具会互相覆盖";
	const text = Array.from({ length: 60 }, (_v, i) => `${line}${i}`).join("\n");
	const { text: cut, truncated } = truncateUtf8Lines(text, 4096);
	assert.equal(truncated, true);
	assert.ok(Buffer.byteLength(cut) <= 4096);
	assert.ok(!cut.includes("\uFFFD"));
	assert.ok(text.split("\n").includes(cut.split("\n").at(-1)), "last kept line is a whole original line");
});

test("truncateUtf8Lines falls back to a character-safe cut when the first line alone overflows", () => {
	const { text, truncated } = truncateUtf8Lines("记".repeat(100), 10);
	assert.equal(truncated, true);
	assert.equal(text, "记记记");
});

test("renderIndexSection appends overflow notice only when truncated", () => {
	const small = renderIndexSection("- [a](a.md) — x", null, 4096);
	assert.match(small, /a\.md/);
	assert.match(small, /No user memory index yet/);
	assert.doesNotMatch(small, /truncated/);
	const big = renderIndexSection("x\n".repeat(5000), null, 512);
	assert.match(big, /truncated/);
});

function fakeCtx() {
	const listeners = {};
	let section;
	return {
		listeners,
		get section() { return section; },
		systemPrompt: { section: (def) => { section = def; return () => {}; } },
		on: (event, fn) => { listeners[event] = fn; return () => {}; }
	};
}

const agentIn = (id, cwd) => ({ agent: { session: { header: { id, ...(cwd ? { cwd } : {}) } } } });

test("index snapshot is fixed per session and released on dispose", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "dsh-memory-inject-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new MemoryStore(root);
	const v1 = await store.write("project", CWD, "INDEX.md", "- first", null);
	const ctx = fakeCtx();
	installIndexInjection(ctx, store, { enabled: { get: () => true }, indexMaxBytes: { get: () => 4096 } });
	assert.equal(ctx.section.name, "memory:index");
	assert.equal(ctx.section.order, 9000);
	assert.match(ctx.section.text(agentIn("s1", CWD)), /- first/);
	await store.write("project", CWD, "INDEX.md", "- second", v1.version);
	assert.match(ctx.section.text(agentIn("s1", CWD)), /- first/);
	assert.match(ctx.section.text(agentIn("s2", CWD)), /- second/);
	ctx.listeners["session/disposed"]({ header: { id: "s1" } });
	assert.match(ctx.section.text(agentIn("s1", CWD)), /- second/);
});

test("section is empty without an agent, without cwd, or when disabled", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "dsh-memory-inject-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let enabled = true;
	const ctx = fakeCtx();
	installIndexInjection(ctx, new MemoryStore(root), { enabled: { get: () => enabled }, indexMaxBytes: { get: () => 4096 } });
	assert.equal(ctx.section.text({}), "");
	assert.equal(ctx.section.text(agentIn("s1", undefined)), "");
	enabled = false;
	assert.equal(ctx.section.text(agentIn("s2", CWD)), "");
});

test("a subagent session gets the short read-only guidance and both indexes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "dsh-memory-inject-sub-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new MemoryStore(root);
	await store.write("user", undefined, "INDEX.md", "- [u](u.md)", null);
	let section;
	installIndexInjection({ systemPrompt: { section: (definition) => { section = definition; } }, on: () => {} }, store, { enabled: { get: () => true }, indexMaxBytes: { get: () => 4096 } });
	const render = (header) => section.text({ agent: { session: { header } } });
	const sub = render({ id: "c1", cwd: CWD, origin: "subagent" });
	const child = render({ id: "c2", cwd: CWD, parentSession: "p" });
	const top = render({ id: "t1", cwd: CWD });
	for (const text of [sub, child]) {
		assert.match(text, /^# Memory \(read-only\)/);
		assert.match(text, /cannot change memory/);
		assert.match(text, /\[u\]\(u\.md\)/, "the indexes are still given");
		assert.doesNotMatch(text, /memory_write/);
	}
	assert.match(top, /memory_write/);
	assert.ok(Buffer.byteLength(sub) < Buffer.byteLength(top));
	assert.equal(render({ id: "x", origin: "subagent" }), "", "no cwd, no memory (the dreaming agent)");
});
