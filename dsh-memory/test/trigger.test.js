import test from "node:test";
import assert from "node:assert/strict";
import { isEligible, installTrigger, accumulate, emptyActivity, isSubstantive } from "../lib/trigger.js";

const CWD = "C:\\Programs\\demo";

const DATA = {
	"turn/end": { reason: { kind: "completed" } },
	"tool": { message: { role: "assistant", content: [{ type: "tool-call", name: "pwsh", arguments: "{}" }] } }
};

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
	const event = (s, type, data = DATA[type]) => {
		s.seq++;
		listeners["session/event"](s, { type, seq: s.seq, ...(data ? { data } : {}) });
	};
	return {
		ended,
		effects,
		advance(ms) { clock += ms; t.mock.timers.tick(ms); },
		event,
		/** One completed turn that ran a tool: enough to be worth dreaming. */
		work(s) {
			event(s, "assistant/message", DATA.tool);
			event(s, "turn/end");
		},
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

test("fires once after idle following a turn that did work", (t) => {
	const h = harness(t);
	const s = h.session("s1");
	h.event(s, "turn/start");
	h.work(s);
	h.advance(599_999);
	assert.equal(h.ended.length, 0);
	h.advance(1);
	assert.deepEqual(h.ended, [{ sessionId: "s1", cwd: CWD, endedAt: 1000 + 600_000, seq: 3 }]);
	h.advance(600_000);
	assert.equal(h.ended.length, 1);
});

test("new turn/start cancels pending idle timer", (t) => {
	const h = harness(t);
	const s = h.session("s1");
	h.work(s);
	h.advance(300_000);
	h.event(s, "turn/start");
	h.advance(600_000);
	assert.equal(h.ended.length, 0);
	h.event(s, "turn/end");
	h.advance(600_000);
	assert.equal(h.ended.length, 1);
	assert.equal(h.ended[0].seq, 4);
});

test("session/disposed fires immediately and cancels timer", (t) => {
	const h = harness(t);
	const s = h.session("s1");
	h.work(s);
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

test("a greeting or an aborted turn queues nothing; activity carries over until real work", (t) => {
	const h = harness(t);
	const s = h.session("s1");
	h.event(s, "turn/end");
	h.advance(600_000);
	assert.equal(h.ended.length, 0, "one completed turn without tools is a greeting");
	h.event(s, "assistant/message", DATA.tool);
	h.event(s, "turn/end", { reason: { kind: "aborted" } });
	h.advance(600_000);
	assert.equal(h.ended.length, 1, "the earlier completed turn plus a tool call add up");
	const aborted = h.session("s2");
	h.event(aborted, "assistant/message", DATA.tool);
	h.event(aborted, "turn/end", { reason: { kind: "aborted" } });
	h.dispose(aborted);
	assert.equal(h.ended.length, 1, "an aborted-only session is skipped");
});

test("memory tool calls do not count as work", () => {
	const memoryOnly = [
		{ type: "assistant/message", data: { message: { content: [{ type: "tool-call", name: "memory_read" }] } } },
		{ type: "turn/end", data: { reason: { kind: "completed" } } }
	].reduce(accumulate, emptyActivity());
	assert.deepEqual(memoryOnly, { completedTurns: 1, toolCalls: 0 });
	assert.equal(isSubstantive(memoryOnly), false);
	assert.equal(isSubstantive({ completedTurns: 2, toolCalls: 0 }), true);
});

test("ignores subagent, parented and cwd-less sessions", (t) => {
	const h = harness(t);
	for (const header of [{ cwd: CWD, origin: "subagent" }, { cwd: CWD, parentSession: "p" }, {}]) {
		const s = h.session("x", header);
		h.work(s);
		h.dispose(s);
	}
	h.advance(600_000);
	assert.equal(h.ended.length, 0);
});

test("plugin dispose clears pending timers", (t) => {
	const h = harness(t);
	const s = h.session("s1");
	h.work(s);
	for (const dispose of h.effects) dispose();
	h.advance(600_000);
	assert.equal(h.ended.length, 0);
});
