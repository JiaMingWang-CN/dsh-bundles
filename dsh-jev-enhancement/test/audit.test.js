import test from "node:test";
import assert from "node:assert/strict";
import { COUNTER_KEYS, createAudit } from "../lib/audit.js";

const SECRET = "sk-super-secret-key";
const CONTENT = "sensitive conversation content";

test("records are redacted: no content and no credential ever reaches the sink", () => {
	const lines = [];
	const filed = [];
	const audit = createAudit({
		logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
		onRecord: (entry) => filed.push(entry)
	});
	audit.count("jevCalls", { latencyMs: 12, code: "ok", content: CONTENT, key: SECRET });
	audit.decision({ node: "fault-classification", decision: "transient", accepted: true, source: "jev", state: CONTENT });
	audit.fallback("budget", { code: "budget", message: CONTENT });
	audit.log("info", "no secrets here");
	const snapshot = JSON.stringify(audit.snapshot());
	assert.ok(!snapshot.includes(SECRET));
	assert.ok(!snapshot.includes(CONTENT), "the published snapshot is a field whitelist");
	assert.equal(filed.length, 3, "every record also reaches the durable sink");
	assert.ok(!JSON.stringify(filed).includes(SECRET), "the durable log is redacted at the door");
	assert.ok(!JSON.stringify(filed).includes(CONTENT));
	for (const line of lines) assert.ok(!line.includes(SECRET));
});

test("counters, token totals and latency aggregates are maintained", () => {
	const audit = createAudit({ now: () => 42 });
	audit.count("jevCalls", { latencyMs: 10 });
	audit.count("jevCalls", { latencyMs: 30 });
	audit.count("jevCallFailures", { code: "timeout" });
	audit.add("jevInputTokens", 100);
	audit.add("jevInputTokens", 50);
	audit.add("unitsRemoved", 3);
	const snapshot = audit.snapshot();
	assert.equal(snapshot.counters.jevCalls, 2);
	assert.equal(snapshot.counters.jevCallFailures, 1);
	assert.equal(snapshot.counters.jevInputTokens, 150);
	assert.equal(snapshot.counters.unitsRemoved, 3);
	assert.equal(snapshot.latency.count, 2);
	assert.equal(snapshot.latency.maxMs, 30);
	assert.equal(snapshot.recent.length, 3);
	assert.equal(snapshot.recent[0].at, 42);
});

test("fallbacks count toward the native path and keep their reason", () => {
	const audit = createAudit();
	audit.fallback("fault-classification-failed");
	const snapshot = audit.snapshot();
	assert.equal(snapshot.counters.nativeFallbacks, 1);
	assert.equal(snapshot.recent[0].reason, "fault-classification-failed");
});

test("every counter key is stable and starts at zero", () => {
	const snapshot = createAudit().snapshot();
	for (const key of COUNTER_KEYS) assert.equal(snapshot.counters[key], 0, key);
});

test("a broken logger can never break the request path", () => {
	const audit = createAudit({ logger: { info: () => { throw new Error("logger down"); } } });
	assert.doesNotThrow(() => audit.log("info", "hello"));
});
