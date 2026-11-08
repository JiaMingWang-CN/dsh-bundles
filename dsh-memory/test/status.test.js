import test from "node:test";
import assert from "node:assert/strict";
import { createStatusPublisher } from "../lib/status.js";

const STATUS = { paused: null, running: null, pendingCount: 3, log: [] };

function harness({ failFirst = 0 } = {}) {
	const writes = [];
	const timers = [];
	let failures = failFirst;
	const settings = {
		update: async (ns, patch) => {
			writes.push([ns, patch]);
			if (failures-- > 0) throw new Error('Plugin entry "memory" is no longer configurable');
		}
	};
	const publisher = createStatusPublisher({
		name: "memory",
		root: "C:\\m",
		warn: () => {},
		setTimer: (fn) => { timers.push(fn); return timers.length; },
		clearTimer: () => {}
	});
	return { publisher, settings, writes, timers };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("publishes status with the memory root once settings are attached", async () => {
	const h = harness();
	h.publisher.publish(STATUS);
	assert.equal(h.writes.length, 0, "nothing to write to before settings exist");
	h.publisher.attach(h.settings);
	await flush();
	assert.deepEqual(h.writes, [["memory", { status: { ...STATUS, root: "C:\\m" } }]]);
});

test("identical status is skipped only after a successful write", async () => {
	const h = harness();
	h.publisher.attach(h.settings);
	h.publisher.publish(STATUS);
	await flush();
	h.publisher.publish(STATUS);
	await flush();
	assert.equal(h.writes.length, 1);
});

test("a failed write is retried later and not treated as published", async () => {
	const h = harness({ failFirst: 1 });
	h.publisher.attach(h.settings);
	await flush();
	h.publisher.publish(STATUS);
	await flush();
	assert.equal(h.timers.length, 1, "a retry is scheduled");
	h.timers[0]();
	await flush();
	assert.equal(h.writes.length, 2);
	h.publisher.publish(STATUS);
	await flush();
	assert.equal(h.writes.length, 2, "now published, identical status is skipped");
});

test("detach stops writes", async () => {
	const h = harness();
	h.publisher.attach(h.settings);
	h.publisher.detach();
	h.publisher.publish(STATUS);
	await flush();
	assert.equal(h.writes.length, 0);
});
