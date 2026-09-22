import test from "node:test";
import assert from "node:assert/strict";
import {
	RERUNNABLE_READ_TOOLS,
	buildUnits,
	classifyProtection,
	isVerifiableReread,
	renderOriginals,
	spanBalanced
} from "../lib/units.js";
import {
	addAssistantMessage,
	addSystemMessage,
	addToolResult,
	addUserMessage,
	createFakeSession,
	surfaceNodes
} from "./helpers.js";

function unitsOf(session) {
	return buildUnits(surfaceNodes(session));
}

test("a tool call and its results form one indivisible unit", () => {
	const session = createFakeSession();
	addUserMessage(session, "please read a.txt");
	addAssistantMessage(session, [
		{ type: "text", text: "reading" },
		{ type: "tool-call", id: "call-1", name: "read", arguments: "{\"path\":\"a.txt\"}" }
	]);
	addToolResult(session, "call-1", "contents of a.txt");
	addUserMessage(session, "thanks");
	const units = classifyProtection(unitsOf(session), { keepRecentMessages: 0 });
	assert.equal(units.length, 3);
	assert.equal(units[1].kind, "tool-group");
	assert.deepEqual(units[1].seqs, [1, 2]);
	assert.equal(units[1].complete, true);
	assert.deepEqual(spanBalanced(units, 1, 1), true);
});

test("an unfinished tool pair is protected as an incomplete pair", () => {
	const session = createFakeSession();
	addUserMessage(session, "go");
	addAssistantMessage(session, [{ type: "tool-call", id: "call-1", name: "bash", arguments: "{}" }]);
	const units = classifyProtection(unitsOf(session), { keepRecentMessages: 0 });
	assert.equal(units[1].complete, false);
	assert.equal(units[1].protection.reason, "incomplete-tool-pair");
	assert.deepEqual(spanBalanced(units, 1, 1), false);
});

test("default hard protection covers prompts, goals, pins, approvals and attachments", () => {
	const session = createFakeSession();
	addSystemMessage(session, "system prompt");
	addUserMessage(session, "first: the standing goal");
	addUserMessage(session, "old chat");
	addUserMessage(session, "keep this content forever");
	addUserMessage(session, "deploy approved by human");
	const units = classifyProtection(unitsOf(session), { keepRecentMessages: 0 });
	const reasons = units.map((unit) => unit.protection.reason);
	assert.equal(reasons[0], "system-prompt");
	assert.equal(reasons[1], "user-goal");
	assert.equal(reasons[2], "");
	assert.equal(reasons[3], "user-pinned");
	assert.equal(reasons[4], "approval-boundary");
});

test("an image block protects its unit from removal", () => {
	const session = createFakeSession();
	addUserMessage(session, "goal");
	addAssistantMessage(session, [{ type: "image", attachment: { id: "img" } }]);
	const units = classifyProtection(unitsOf(session), { keepRecentMessages: 0 });
	assert.equal(units[1].protection.reason, "attachment");
});

test("only verifiable re-reads may become candidates; one-shot output is protected", () => {
	const session = createFakeSession();
	addUserMessage(session, "goal");
	addAssistantMessage(session, [{ type: "tool-call", id: "c1", name: "read", arguments: "{\"path\":\"a\"}" }]);
	addToolResult(session, "c1", "file bytes");
	addAssistantMessage(session, [{ type: "tool-call", id: "c2", name: "web_fetch", arguments: "{\"url\":\"https://x\"}" }]);
	addToolResult(session, "c2", "remote response body");
	addAssistantMessage(session, [{ type: "tool-call", id: "c3", name: "write", arguments: "{\"path\":\"a\"}" }]);
	addToolResult(session, "c3", "patch applied");
	addAssistantMessage(session, [{ type: "tool-call", id: "c4", name: "read", arguments: "{\"path\":\"b\"}" }]);
	addToolResult(session, "c4", "boom", { isError: true });
	const units = classifyProtection(unitsOf(session), { keepRecentMessages: 0 });
	assert.ok(RERUNNABLE_READ_TOOLS.includes("read"));
	assert.equal(isVerifiableReread(units[1]), true);
	assert.equal(units[1].protection.reason, "");
	assert.equal(units[2].protection.reason, "one-shot-output");
	assert.equal(units[3].protection.reason, "unlanded-edit");
	assert.equal(units[4].protection.reason, "error-site");
});

test("content referenced by later reasoning is kept", () => {
	const session = createFakeSession();
	addUserMessage(session, "goal");
	addAssistantMessage(session, [{ type: "tool-call", id: "c1", name: "read", arguments: "{\"path\":\"a\"}" }]);
	addToolResult(session, "c1", "a".repeat(80));
	addAssistantMessage(session, [{ type: "text", text: "based on call c1 and " + "a".repeat(80) + " we proceed" }]);
	const units = classifyProtection(unitsOf(session), { keepRecentMessages: 0 });
	assert.equal(units[1].protection.reason, "referenced");
});

test("keepRecentMessages is a floor expanded to whole units", () => {
	const session = createFakeSession();
	addUserMessage(session, "goal");
	addAssistantMessage(session, [{ type: "tool-call", id: "c1", name: "read", arguments: "{\"path\":\"a\"}" }]);
	addToolResult(session, "c1", "file bytes");
	addAssistantMessage(session, [{ type: "text", text: "done" }]);
	const units = classifyProtection(unitsOf(session), { keepRecentMessages: 2 });
	assert.equal(units.length, 3);
	assert.equal(units[0].protection.reason, "user-goal");
	assert.equal(units[1].protection.reason, "recent", "the recent floor covers the whole tool pair, not half of it");
	assert.equal(units[2].protection.reason, "recent");
});

test("renderOriginals preserves original bytes with role and tool identity labels", () => {
	const session = createFakeSession();
	addUserMessage(session, "原始内容 ¥ unicode");
	addAssistantMessage(session, [{ type: "tool-call", id: "c1", name: "read", arguments: "{\"path\":\"a\"}" }]);
	addToolResult(session, "c1", "result bytes");
	const originals = session.surface.nodes.map((seq) => session.eventAt(seq));
	const rendered = renderOriginals(originals);
	assert.ok(rendered.includes("原始内容 ¥ unicode"));
	assert.ok(rendered.includes("result bytes"));
	assert.ok(rendered.includes("[user/message seq=0"));
	assert.ok(rendered.includes("[tool/result seq=2"));
});
