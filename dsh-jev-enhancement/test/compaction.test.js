import test from "node:test";
import assert from "node:assert/strict";
import {
	batchCandidates,
	buildState,
	commitPlan,
	findJevMarkers,
	markerMessage,
	planCompaction,
	restoreMarker
} from "../lib/compaction.js";
import { buildUnits, classifyProtection } from "../lib/units.js";
import {
	addAssistantMessage,
	addSystemMessage,
	addToolResult,
	addUserMessage,
	createFakeSession,
	surfaceNodes
} from "./helpers.js";

const POLICY = {
	compaction: {
		enabled: true,
		mode: "active",
		triggerRatio: 0.7,
		targetRatio: 0.3,
		keepRecentMessages: 0,
		maxRemovalRatio: 0.6,
		minIntervalSteps: 0,
		removalAcceptance: { choice: 0.8, noul: 0.8 }
	}
};

/** Build a session with `count` removable stale chat messages behind a goal. */
function staleChat(count) {
	const session = createFakeSession();
	addUserMessage(session, "the standing goal of this task");
	for (let index = 0; index < count; index += 1) addUserMessage(session, "old chatter " + index + " " + "x".repeat(50));
	return session;
}

function unitsFrom(session, tokens = 100) {
	return classifyProtection(buildUnits(surfaceNodes(session, tokens)), { keepRecentMessages: POLICY.compaction.keepRecentMessages });
}

/** An `ask` double that removes everything with high confidence. */
function askRemovingAll() {
	return async ({ questions }) => {
		const answers = {};
		for (const id of Object.keys(questions)) {
			answers[id] = id.startsWith("removal_safe_")
				? { type: "noul", noul: 0.95 }
				: { type: "choice", choice: "remove", confidence: 0.95, probabilities: { remove: 0.95 } };
		}
		return { model: "jev-1.13.0", answers, usage: { inputTokens: 1, outputTokens: 1 } };
	};
}

test("planning keeps everything without candidates and records the reason", async () => {
	const session = staleChat(0);
	const plan = await planCompaction({
		units: unitsFrom(session),
		policy: POLICY,
		budgetTokens: 1000,
		totalTokens: 200,
		goal: "g",
		constraints: "",
		ask: askRemovingAll()
	});
	assert.equal(plan.spans.length, 0);
	assert.equal(plan.reason, "no-candidates");
});

test("low-confidence and uncertain answers keep the content", async () => {
	const session = staleChat(3);
	const ask = async ({ questions }) => {
		const answers = {};
		const ids = Object.keys(questions);
		answers[ids[0]] = { type: "choice", choice: "remove", confidence: 0.5, probabilities: {} };
		answers[ids[1]] = { type: "noul", noul: 0.95 };
		answers[ids[2]] = { type: "choice", choice: "remove", confidence: 0.95, probabilities: {} };
		answers[ids[3]] = { type: "noul", noul: 0.2 };
		return { answers };
	};
	const plan = await planCompaction({
		units: unitsFrom(session),
		policy: POLICY,
		budgetTokens: 1000,
		totalTokens: 200,
		goal: "g",
		constraints: "",
		ask
	});
	assert.equal(plan.spans.length, 0);
	assert.equal(plan.reason, "nothing-accepted");
	assert.equal(plan.unknownCount, 1, "the unanswered candidate is counted as unknown");
	assert.equal(plan.keptCandidates, 3);
});

test("a validated plan removes contiguous runs and reports its evidence", async () => {
	const session = staleChat(4);
	const plan = await planCompaction({
		units: unitsFrom(session),
		policy: POLICY,
		budgetTokens: 1000,
		totalTokens: 500,
		goal: "the standing goal",
		constraints: "",
		ask: askRemovingAll()
	});
	assert.equal(plan.reason, "ok");
	assert.equal(plan.spans.length, 1);
	assert.deepEqual(plan.spans[0].seqs, [1, 2, 3]);
	assert.equal(plan.removedTokens, 300);
	assert.equal(plan.jevCalls, 1);
});

test("maxRemovalRatio caps a single pass", async () => {
	const session = staleChat(4);
	const policy = structuredClone(POLICY);
	policy.compaction.maxRemovalRatio = 0.45;
	const plan = await planCompaction({
		units: unitsFrom(session),
		policy,
		budgetTokens: 1000,
		totalTokens: 500,
		goal: "g",
		constraints: "",
		ask: askRemovingAll()
	});
	assert.equal(plan.removedTokens, 200);
	assert.equal(plan.spans[0].seqs.length, 2);
});

test("a pass with too little gain is abandoned", async () => {
	const session = staleChat(1);
	const plan = await planCompaction({
		units: unitsFrom(session, 5),
		policy: POLICY,
		budgetTokens: 1000,
		totalTokens: 500,
		goal: "g",
		constraints: "",
		ask: askRemovingAll()
	});
	assert.equal(plan.spans.length, 0);
	assert.equal(plan.reason, "insufficient-gain");
});

test("candidates that cannot fit the evidence budget are kept, never guessed", () => {
	const huge = { id: "u1", text: "y".repeat(30000), roles: ["user"], kind: "message", toolNames: [] };
	const small = { id: "u2", text: "ok", roles: ["user"], kind: "message", toolNames: [] };
	const { batches, skipped } = batchCandidates("goal", "", [huge, small]);
	assert.deepEqual(skipped.map((unit) => unit.id), ["u1"]);
	assert.deepEqual(batches, [[small]]);
	const probe = buildState("goal", "", [huge]);
	assert.deepEqual(probe.dropped, ["u1"]);
	assert.deepEqual(probe.state.candidates, [], "truncated fragments never serve as removal evidence");
});

test("the state never drops the goal or constraints and marks candidates as data", () => {
	const { state } = buildState("the goal", "the constraints", [{ id: "u1", text: "content", roles: ["user"], kind: "message", toolNames: [] }]);
	assert.equal(state.goal, "the goal");
	assert.equal(state.constraints, "the constraints");
	assert.equal(state.candidates[0].id, "u1");
});

test("commit lands one shadow price plus one replacement per span, tail first", () => {
	const session = staleChat(4);
	const plan = {
		spans: [
			{ startSeq: 1, endSeq: 1, seqs: [1], unitIds: ["u1"], tokens: 100, heuristicTokens: 100 },
			{ startSeq: 3, endSeq: 3, seqs: [3], unitIds: ["u3"], tokens: 100, heuristicTokens: 100 }
		],
		removedTokens: 200
	};
	const { committed } = commitPlan({ session, plan });
	assert.equal(committed.length, 2);
	assert.equal(committed[0].startSeq, 3, "tail span commits first");
	const events = session.snapshotEvents();
	const prune = events[events.length - 4];
	const replacement = events[events.length - 3];
	assert.equal(prune.type, "compaction/prune");
	assert.equal(prune.data.shadowedTokenCount, 100);
	assert.deepEqual(prune.data.shadowedSeqs, [3]);
	assert.equal(replacement.type, "user/message");
	assert.equal(replacement.surfaceOp.op, "replace");
	assert.deepEqual(replacement.sourceEventSeqs, [prune.seq, 3]);
	assert.equal(replacement.data.source.plugin, "jev-enhancement");
	/* Shadowed nodes left the surface; the marker is a surface node. */
	assert.equal(session.surface.nodes.includes(3), false);
	assert.equal(session.surface.nodes.includes(replacement.seq), true);
	/* Originals are still in the log. */
	assert.equal(session.eventAt(4).data.content[0].text.includes("old chatter 3"), true);
});

test("findJevMarkers locates landed markers with their originals and restore puts the bytes back", () => {
	const session = staleChat(2);
	const plan = {
		spans: [{ startSeq: 1, endSeq: 2, seqs: [1, 2], unitIds: ["u1", "u2"], tokens: 200, heuristicTokens: 200 }],
		removedTokens: 200
	};
	commitPlan({ session, plan });
	const markers = findJevMarkers(session);
	assert.equal(markers.length, 1);
	assert.deepEqual(markers[0].shadowedSeqs, [1, 2]);
	assert.equal(markers[0].originals.length, 2);
	const before = session.surface.nodes.length;
	const record = restoreMarker({ session, marker: markers[0], estimate: () => 5 });
	assert.equal(typeof record.restoredSeq, "number");
	assert.equal(session.surface.nodes.length, before);
	const restored = session.eventAt(record.restoredSeq);
	assert.ok(restored.data.content[0].text.includes("old chatter 0"));
	assert.ok(restored.data.content[0].text.includes("old chatter 1"));
	assert.equal(findJevMarkers(session).length, 0, "a restored marker is gone");
});

test("system prompts and tool pairing are never part of a span", async () => {
	const session = createFakeSession();
	addSystemMessage(session, "system prompt");
	addUserMessage(session, "goal");
	addAssistantMessage(session, [{ type: "tool-call", id: "c1", name: "web_fetch", arguments: "{}" }]);
	addToolResult(session, "c1", "remote payload");
	const plan = await planCompaction({
		units: unitsFrom(session),
		policy: POLICY,
		budgetTokens: 1000,
		totalTokens: 500,
		goal: "g",
		constraints: "",
		ask: askRemovingAll()
	});
	assert.equal(plan.spans.length, 0);
	assert.equal(plan.reason, "no-candidates");
});

test("the marker message carries no original content", () => {
	const message = markerMessage({ unitIds: ["u1", "u2"], seqs: [3, 4] });
	assert.equal(message.role, "user");
	assert.equal(message.content.length, 1);
	assert.ok(!message.content[0].text.includes("old chatter"));
	assert.equal(message.source.plugin, "jev-enhancement");
});
