import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../lib/store.js";
import { runDream, transcriptTools, renderTranscript } from "../lib/dream.js";

const CWD = "C:\\Programs\\demo";

// Shapes match real DSH 0.2.2-rc.1 logs: a user/message event carries the message itself as `data`;
// assistant/message and tool/result wrap it in `data.message`.
const userMsg = (seq, text, kind = "user") => ({ seq, type: "user/message", data: { role: "user", content: [{ type: "text", text }], source: { kind } } });
const assistantMsg = (seq, text) => ({ seq, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "reasoning", text: "hidden" }, { type: "text", text }] } } });
const toolResult = (seq, text, isError) => ({ seq, type: "tool/result", data: { message: { role: "tool", content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } } });

function fakeSessionQuery(sessions) {
	return {
		async readSession(id) {
			const found = sessions[id];
			if (!found) throw Object.assign(new Error("not found"), { code: "SESSION_QUERY_SESSION_NOT_FOUND" });
			return { session: found.header, inheritedEventCount: 0, events: found.events };
		}
	};
}

test("renderTranscript keeps user input, assistant text and tool results; drops injected context and reasoning", () => {
	const text = renderTranscript([
		userMsg(1, "AGENTS.md baseline", "workspace-instructions"),
		userMsg(2, "run the tests"),
		assistantMsg(3, "Running them now"),
		toolResult(4, "x".repeat(2000), true),
		{ seq: 5, type: "turn/end", data: {} }
	]);
	assert.doesNotMatch(text, /AGENTS\.md baseline/);
	assert.doesNotMatch(text, /hidden/);
	assert.match(text, /\[seq 2\] USER: run the tests/);
	assert.match(text, /\[seq 3\] ASSISTANT: Running them now/);
	assert.match(text, /\[seq 4\] TOOL RESULT \(error\): x+…/);
	assert.ok(text.length < 1500);
});

test("renderTranscript shows a tool call as its name and arguments, without call ids", () => {
	// Real DSH tool-call block: a long provider id plus `arguments` as a JSON string.
	const id = "call_00_06ad3c5g6rj0j01gr0qnysgk|fc_02179412637310300000000000000000000ffffac153111f54622";
	const args = JSON.stringify({ description: "List workspace root files", command: "Get-ChildItem -Force" });
	const text = renderTranscript([
		{ seq: 20, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "tool-call", id, name: "pwsh", arguments: args }] } } }
	]);
	assert.equal(text, `[seq 20] TOOL CALL pwsh: ${args}`);
	assert.doesNotMatch(text, /call_00|fc_0217/);
});

test("transcript tools read pages and search within the batch, refusing other projects", async () => {
	const sessions = {
		s1: { header: { id: "s1", cwd: CWD }, events: [userMsg(1, "the db fixture needs --runInBand"), assistantMsg(2, "ok")] },
		other: { header: { id: "other", cwd: "C:\\elsewhere" }, events: [userMsg(1, "secret")] }
	};
	const tools = Object.fromEntries(transcriptTools({ sessionQuery: fakeSessionQuery(sessions) }, { cwd: CWD, sessionIds: ["s1"] }).map((tool) => [tool.name, tool]));
	assert.deepEqual(Object.keys(tools).sort(), ["transcript_read", "transcript_search"]);
	assert.match((await tools.transcript_read.execute({ sessionId: "s1" }, {})).text, /runInBand/);
	assert.match((await tools.transcript_read.execute({ sessionId: "s1", fromSeq: 2 }, {})).text, /ASSISTANT: ok/);
	assert.doesNotMatch((await tools.transcript_read.execute({ sessionId: "s1", fromSeq: 2 }, {})).text, /runInBand/);
	assert.match((await tools.transcript_search.execute({ query: "RUNINBAND" }, {})).text, /s1 \[seq 1\]/);
	await assert.rejects(tools.transcript_read.execute({ sessionId: "other" }, {}), /another project/);
});

function fakeAgents({ turnEnd = { kind: "completed" }, createError } = {}) {
	const record = { disposed: false, restricted: undefined, registered: [], followups: [], options: undefined };
	return {
		record,
		agents: {
			async create(options) {
				record.options = options;
				if (createError) throw createError;
				options.setup({
					tools: {
						restrict: (filter) => { record.restricted = filter; },
						register: (tool) => { record.registered.push(tool.name); return () => {}; }
					}
				});
				const events = [userMsg(1, "dream"), assistantMsg(2, "done"), { seq: 3, type: "turn/end", data: { turn: 1, reason: turnEnd } }];
				return {
					agent: {
						followup: (message) => record.followups.push(message),
						whenIdle: async () => {},
						cancel: () => {},
						session: { snapshotEvents: () => events }
					},
					dispose: async () => { record.disposed = true; }
				};
			}
		}
	};
}

async function storeFor(t) {
	const root = await mkdtemp(join(tmpdir(), "dsh-memory-dream-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return new MemoryStore(root);
}

test("creates hidden root agent with restricted tools", async (t) => {
	const fake = fakeAgents({ turnEnd: { kind: "completed" } });
	const result = await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { cwd: CWD, sessionIds: ["s1"], selection: { provider: "p", model: "m" }, store: await storeFor(t), indexMaxBytes: 4096 });
	assert.equal(result.ok, true);
	assert.deepEqual(fake.record.options.meta, { origin: "subagent" });
	assert.equal(fake.record.options.parentAgent, undefined);
	assert.deepEqual(fake.record.options.agentOptions, { provider: "p", model: "m" });
	assert.deepEqual(fake.record.restricted, { allow: [] });
	assert.deepEqual(fake.record.registered.sort(), ["memory_delete", "memory_list", "memory_read", "memory_write", "transcript_read", "transcript_search"]);
	assert.equal(fake.record.followups[0].role, "user");
	assert.match(fake.record.followups[0].content[0].text, /s1/);
	assert.equal(result.dreamSessionId, fake.record.options.sessionId);
	assert.deepEqual(result.changes, { created: 0, modified: 0, deleted: 0 });
});

test("reports failure when the turn ends on model error, and always disposes", async (t) => {
	const fake = fakeAgents({ turnEnd: { kind: "error", error: { message: "401 Unauthorized", code: "AUTH" } } });
	const result = await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { cwd: CWD, sessionIds: ["s1"], store: await storeFor(t), indexMaxBytes: 4096 });
	assert.equal(result.ok, false);
	assert.match(result.error, /401 Unauthorized/);
	assert.equal(fake.record.disposed, true);
});

test("only a completed turn counts as success", async (t) => {
	for (const kind of ["max-tokens", "blocked", "aborted"]) {
		const fake = fakeAgents({ turnEnd: { kind } });
		const result = await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { cwd: CWD, sessionIds: ["s1"], store: await storeFor(t), indexMaxBytes: 4096 });
		assert.equal(result.ok, false, kind);
		assert.match(result.error, new RegExp(kind));
	}
});

test("reports failure when agents.create throws", async (t) => {
	const fake = fakeAgents({ createError: new Error("no factory") });
	const result = await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { cwd: CWD, sessionIds: ["s1"], store: await storeFor(t), indexMaxBytes: 4096 });
	assert.deepEqual({ ok: result.ok, error: result.error }, { ok: false, error: "no factory" });
});

test("tells the agent when the project directory no longer exists", async (t) => {
	const existing = await mkdtemp(join(tmpdir(), "dsh-memory-project-"));
	t.after(() => rm(existing, { recursive: true, force: true }));
	const prompts = {};
	for (const [label, cwd] of [["gone", join(existing, "deleted")], ["present", existing]]) {
		const fake = fakeAgents();
		await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { cwd, sessionIds: ["s1"], store: await storeFor(t), indexMaxBytes: 4096 });
		prompts[label] = fake.record.followups[0].content[0].text;
	}
	assert.match(prompts.gone, /no longer exists/);
	assert.doesNotMatch(prompts.present, /no longer exists/);
});
