import test from "node:test";
import assert from "node:assert/strict";
import { isEligible, installTrigger } from "../lib/trigger.js";

const CWD = "C:\\Programs\\demo";

function harness(t, idleMs = 600_000) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const listeners = {};
	const effects = [];
	const ended = [];
	let clock = 1000;
	const ctx = {
		on: (event, fn) => { listeners[event] = fn; return () => {}; },
		effect: (fn) => { effects.push(fn()); }
	};
	installTrigger(ctx, { idleMs: () => idleMs, onEnded: (info) => ended.push(info), now: () => clock });
	const session = (id, header = { cwd: CWD }) => ({ seq: 0, header: { id, ...header } });
	return {
		ended,
		effects,
		advance(ms) { clock += ms; t.mock.timers.tick(ms); },
		event(s, type) { s.seq++; listeners["session/event"](s, { type, seq: s.seq }); },
		dispose(s) { listeners["session/disposed"](s); },
		session
	};
}

test("isEligible accepts only top-level sessions with a working directory", () => {
	assert.equal(isEligible({ id: "a", cwd: CWD }), true);
	assert.equal(isEligible({ id: "a" }), false);
	assert.equal(isEligible({ id: "a", cwd: CWD, origin: "subagent" }), false);
	assert.equal(isEligible({ id: "a", cwd: CWD, parentSession: "p" }), false);
});

test("fires once after idle following turn/end", (t) => {
	const h = harness(t);
	const s = h.session("s1");
	h.event(s, "turn/start");
	h.event(s, "turn/end");
	h.advance(599_999);
	assert.equal(h.ended.length, 0);
	h.advance(1);
	assert.deepEqual(h.ended, [{ sessionId: "s1", cwd: CWD, endedAt: 1000 + 600_000, seq: 2 }]);
	h.advance(600_000);
	assert.equal(h.ended.length, 1);
});

test("new turn/start cancels pending idle timer", (t) => {
	const h = harness(t);
	const s = h.session("s1");
	h.event(s, "turn/end");
	h.advance(300_000);
	h.event(s, "turn/start");
	h.advance(600_000);
	assert.equal(h.ended.length, 0);
	h.event(s, "turn/end");
	h.advance(600_000);
	assert.equal(h.ended.length, 1);
	assert.equal(h.ended[0].seq, 3);
});

test("session/disposed fires immediately and cancels timer", (t) => {
	const h = harness(t);
	const s = h.session("s1");
	h.event(s, "turn/end");
	h.dispose(s);
	assert.equal(h.ended.length, 1);
	h.advance(600_000);
	assert.equal(h.ended.length, 1);
});

test("disposing a session that never finished a turn does not fire", (t) => {
	const h = harness(t);
	const s = h.session("s1");
	h.event(s, "turn/start");
	h.dispose(s);
	assert.equal(h.ended.length, 0);
});

test("ignores subagent, parented and cwd-less sessions", (t) => {
	const h = harness(t);
	for (const header of [{ cwd: CWD, origin: "subagent" }, { cwd: CWD, parentSession: "p" }, {}]) {
		const s = h.session("x", header);
		h.event(s, "turn/end");
		h.dispose(s);
	}
	h.advance(600_000);
	assert.equal(h.ended.length, 0);
});

test("plugin dispose clears pending timers", (t) => {
	const h = harness(t);
	const s = h.session("s1");
	h.event(s, "turn/end");
	for (const dispose of h.effects) dispose();
	h.advance(600_000);
	assert.equal(h.ended.length, 0);
});
