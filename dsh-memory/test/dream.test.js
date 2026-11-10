import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, mkdir, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, HISTORY_KEEP } from "../lib/store.js";
import { runDream, transcriptTools, renderTranscript, projectState } from "../lib/dream.js";

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

function fakeAgents({ turnEnd = { kind: "completed" }, createError, extraEvents = [], onIdle } = {}) {
	const record = { disposed: false, restricted: undefined, registered: [], tools: {}, followups: [], options: undefined, cancelled: [], session: undefined };
	return {
		record,
		agents: {
			async create(options) {
				record.options = options;
				if (createError) throw createError;
				options.setup({
					tools: {
						restrict: (filter) => { record.restricted = filter; },
						register: (tool) => { record.registered.push(tool.name); record.tools[tool.name] = tool; return () => {}; }
					}
				});
				const events = [userMsg(1, "dream"), assistantMsg(2, "done"), ...extraEvents, { seq: 99, type: "turn/end", data: { turn: 1, reason: turnEnd } }];
				record.session = { header: { id: options.sessionId }, snapshotEvents: () => events };
				return {
					agent: {
						followup: (message) => record.followups.push(message),
						whenIdle: async () => { await onIdle?.(record); },
						cancel: (reason) => { record.cancelled.push(reason); },
						session: record.session
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
	assert.deepEqual(fake.record.registered.sort(), ["dream_report", "memory_delete", "memory_list", "memory_move", "memory_read", "memory_search", "memory_write", "transcript_read", "transcript_search"]);
	assert.equal(fake.record.followups[0].role, "user");
	assert.match(fake.record.followups[0].content[0].text, /s1/);
	assert.equal(result.dreamSessionId, fake.record.options.sessionId);
	assert.deepEqual(result.changes, { created: 0, modified: 0, deleted: 0, paths: { created: [], modified: [], deleted: [] } });
	assert.deepEqual(result.issues, ["ended without dream_report"]);
});

test("reports failure when the turn ends on model error, and always disposes", async (t) => {
	const fake = fakeAgents({ turnEnd: { kind: "error", error: { message: "401 Unauthorized", code: "AUTH" } } });
	const result = await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { cwd: CWD, sessionIds: ["s1"], store: await storeFor(t), indexMaxBytes: 4096 });
	assert.equal(result.ok, false);
	assert.match(result.error, /401 Unauthorized/);
	assert.equal(fake.record.disposed, true);
});

test("an ok run lists tool errors and what the agent reported unresolved", async (t) => {
	const fake = fakeAgents({
		extraEvents: [toolResult(3, "Error: session not found: 3f2a", true)],
		onIdle: (record) => record.tools.dream_report.execute({ summary: "merged two notes", unresolved: "windows.md: cited session missing\n" }, {})
	});
	const result = await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { cwd: CWD, sessionIds: ["s1"], store: await storeFor(t), indexMaxBytes: 4096 });
	assert.equal(result.ok, true);
	assert.equal(result.summary, "merged two notes");
	assert.deepEqual(result.issues, ["tool error: Error: session not found: 3f2a", "windows.md: cited session missing"]);
});

test("the run is cancelled at the step budget and still counts as a run, with the budget as an issue", async (t) => {
	let listener;
	const fake = fakeAgents({
		turnEnd: { kind: "aborted" },
		onIdle: (record) => {
			for (let i = 0; i < 45; i++) listener(record.session, { type: "assistant/message" });
			listener({ header: { id: "someone-else" } }, { type: "assistant/message" });
		}
	});
	const ctx = { agents: fake.agents, sessionQuery: fakeSessionQuery({}), on: (name, fn) => { if (name === "session/event") listener = fn; return () => { listener = undefined; }; } };
	const result = await runDream(ctx, { cwd: CWD, sessionIds: ["s1"], store: await storeFor(t), indexMaxBytes: 4096 });
	assert.equal(fake.record.cancelled.length, 1);
	assert.match(String(fake.record.cancelled[0]?.message), /step budget of 40/);
	assert.equal(result.ok, true);
	assert.match(result.issues[0], /step budget of 40 reached/);
	assert.equal(listener, undefined, "the budget listener is removed");
});

test("the hidden session gets a readable pinned title", async (t) => {
	const renamed = [];
	const fake = fakeAgents();
	const ctx = { agents: fake.agents, sessionQuery: fakeSessionQuery({}), get: (name) => (name === "sessionTitle" ? { rename: (session, title) => renamed.push([session.header.id, title]) } : undefined) };
	await runDream(ctx, { cwd: CWD, sessionIds: ["s1"], store: await storeFor(t), indexMaxBytes: 4096 });
	assert.deepEqual(renamed, [[fake.record.options.sessionId, "记忆整理 · demo"]]);
	assert.match(fake.record.followups[0].content[0].text, /^Memory consolidation · demo\n/);
});

test("a cross-project run sees every listed project, reads any project's transcript, and has no search", async (t) => {
	const fake = fakeAgents();
	const projects = [{ cwd: CWD, notes: 3 }, { cwd: "C:\\Programs\\n2sql", notes: 0 }];
	const result = await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { projects, store: await storeFor(t), indexMaxBytes: 4096 });
	assert.equal(result.ok, true);
	assert.deepEqual(fake.record.registered.sort(), ["dream_report", "memory_delete", "memory_list", "memory_move", "memory_read", "memory_search", "memory_write", "transcript_read"]);
	const prompt = fake.record.followups[0].content[0].text;
	assert.match(prompt, /^Memory consolidation · all projects/);
	assert.match(prompt, /n2sql · 0 notes/);
	assert.match(prompt, /Demote/);
	assert.match(prompt, /Promote/);
});

test("transcript_read resolves a unique id prefix and names the session's project", async () => {
	const full = "session-3f2a9c11-0000-4000-8000-000000000001";
	const near = "session-3f2b0000-0000-4000-8000-000000000002";
	const sessions = {
		[full]: { header: { id: full, cwd: CWD }, events: [userMsg(1, "use port from config")] },
		[near]: { header: { id: near, cwd: CWD }, events: [] },
		"session-9999": { header: { id: "session-9999", cwd: "C:\\elsewhere" }, events: [] }
	};
	const query = { ...fakeSessionQuery(sessions), listSessions: async () => Object.values(sessions).map(({ header }) => ({ header, live: false })) };
	const tools = Object.fromEntries(transcriptTools({ sessionQuery: query }, { cwd: CWD, sessionIds: [] }).map((tool) => [tool.name, tool]));
	const page = (await tools.transcript_read.execute({ sessionId: "3f2a9c11" }, {})).text;
	assert.ok(page.startsWith(`Session ${full} · project ${CWD}`));
	assert.match(page, /use port from config/);
	await assert.rejects(tools.transcript_read.execute({ sessionId: "3f2" }, {}), /ambiguous/);
	await assert.rejects(tools.transcript_read.execute({ sessionId: "9999" }, {}), /No session "9999"/);
	const cross = Object.fromEntries(transcriptTools({ sessionQuery: query }, { sessionIds: [] }).map((tool) => [tool.name, tool]));
	assert.deepEqual(Object.keys(cross), ["transcript_read"]);
	assert.ok((await cross.transcript_read.execute({ sessionId: "9999" }, {})).text.startsWith("Session session-9999 · project C:\\elsewhere"));
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

const assistantWithCalls = (seq, count) => ({ seq, type: "assistant/message", data: { message: { role: "assistant", content: Array.from({ length: count }, (_, i) => ({ type: "tool-call", name: "pwsh", arguments: JSON.stringify({ command: "x".repeat(150) + i }) })) } } });

test("transcript_read always advances: huge messages are clipped and one event's lines are never split across pages", async () => {
	const events = [
		userMsg(1, "pasted log ".repeat(5000)),
		assistantMsg(2, "y".repeat(50_000)),
		assistantWithCalls(3, 120),
		userMsg(4, "last")
	];
	const sessions = { s1: { header: { id: "s1", cwd: CWD }, events } };
	const progress = new Map();
	const read = transcriptTools({ sessionQuery: fakeSessionQuery(sessions) }, { cwd: CWD, sessionIds: ["s1"], progress })[0];
	let from;
	const pages = [];
	for (let page = 0; page < 10; page++) {
		const { text } = await read.execute({ sessionId: "s1", ...(from === undefined ? {} : { fromSeq: from }) }, {});
		pages.push(text);
		const next = text.match(/\[more: call transcript_read with fromSeq=(\d+)\]/);
		if (next === null) break;
		assert.ok(from === undefined || Number(next[1]) > from, "fromSeq moves forward");
		from = Number(next[1]);
	}
	assert.match(pages.at(-1), /\[seq 4\] USER: last/, "the last event is reached");
	assert.ok(pages.length > 1 && pages.length < 10);
	for (const page of pages) assert.ok(!page.split("\n").some((line) => line.length > 2_100), "no line is longer than the cap");
	assert.equal(pages.join("\n").match(/\[seq 3\] TOOL CALL/g).length, 120, "no line of the 120-call event is lost");
	assert.deepEqual(progress.get("s1"), { seq: 4, done: true });
});

test("transcript_read progress records how far the agent got when it stops early", async () => {
	const events = [userMsg(1, "a".repeat(1900)), ...Array.from({ length: 30 }, (_, i) => assistantMsg(2 + i, "b".repeat(1900)))];
	const sessions = { s1: { header: { id: "s1", cwd: CWD }, events } };
	const progress = new Map();
	const read = transcriptTools({ sessionQuery: fakeSessionQuery(sessions) }, { cwd: CWD, sessionIds: ["s1"], progress })[0];
	const { text } = await read.execute({ sessionId: "s1" }, {});
	const next = Number(text.match(/fromSeq=(\d+)/)[1]);
	assert.deepEqual(progress.get("s1"), { seq: next - 1, done: false });
	await read.execute({ sessionId: "s1", fromSeq: next }, {});
	assert.ok(progress.get("s1").seq >= next, "reading on from where it stopped moves progress forward");
	for (let guard = 0; guard < 10 && !progress.get("s1").done; guard++) await read.execute({ sessionId: "s1", fromSeq: progress.get("s1").seq + 1 }, {});
	assert.deepEqual(progress.get("s1"), { seq: 31, done: true });
	await read.execute({ sessionId: "s1" }, {});
	assert.deepEqual(progress.get("s1"), { seq: 31, done: true }, "progress never moves backwards");
});

test("skipping ahead does not mark the skipped part as read", async () => {
	const events = Array.from({ length: 30 }, (_, i) => assistantMsg(1 + i, "b".repeat(1900)));
	const sessions = { s1: { header: { id: "s1", cwd: CWD }, events } };
	const progress = new Map();
	const read = transcriptTools({ sessionQuery: fakeSessionQuery(sessions) }, { cwd: CWD, sessionIds: ["s1"], progress, fromSeqs: { s1: 5 } })[0];
	await read.execute({ sessionId: "s1", fromSeq: 28 }, {});
	assert.deepEqual(progress.get("s1"), undefined, "seqs 6-27 were never shown");
	await read.execute({ sessionId: "s1", fromSeq: 6 }, {});
	assert.equal(progress.get("s1").done, false);
	assert.ok(progress.get("s1").seq >= 6);
});

test("transcript_read stops after the reading budget so steps stay free for writing", async () => {
	const sessions = { s1: { header: { id: "s1", cwd: CWD }, events: [userMsg(1, "hello")] } };
	const read = transcriptTools({ sessionQuery: fakeSessionQuery(sessions) }, { cwd: CWD, sessionIds: ["s1"], readPages: 2 })[0];
	assert.match((await read.execute({ sessionId: "s1" }, {})).text, /hello/);
	assert.match((await read.execute({ sessionId: "s1" }, {})).text, /hello/);
	assert.match((await read.execute({ sessionId: "s1" }, {})).text, /Reading budget used up \(2 pages per run\)/);
});

test("a run cut off at the budget reports which sessions were not read to the end, and how far it got", async (t) => {
	let listener;
	const sessions = { s1: { header: { id: "s1", cwd: CWD }, events: [userMsg(1, "hello"), assistantMsg(2, "done")] } };
	const fake = fakeAgents({
		turnEnd: { kind: "aborted" },
		onIdle: async (record) => {
			await record.tools.transcript_read.execute({ sessionId: "s1" }, {});
			await record.tools.memory_write.execute({ scope: "user", path: "a.md", content: "learned", basis: "user-stated" }, {});
			for (let i = 0; i < 45; i++) listener(record.session, { type: "assistant/message" });
		}
	});
	const ctx = { agents: fake.agents, sessionQuery: fakeSessionQuery(sessions), on: (name, fn) => { if (name === "session/event") listener = fn; return () => { listener = undefined; }; } };
	const result = await runDream(ctx, { cwd: CWD, sessionIds: ["s1", "s2"], store: await storeFor(t), indexMaxBytes: 4096 });
	assert.equal(result.ok, true);
	assert.deepEqual(result.unfinished, { s2: 0 }, "s1 was read to the end and written up; s2 was never opened");
	assert.match(result.issues[0], /1 session\(s\) not read to the end/);
});

test("a run that filed its report before the cut counts every session as covered", async (t) => {
	let listener;
	const fake = fakeAgents({
		turnEnd: { kind: "aborted" },
		onIdle: async (record) => {
			await record.tools.dream_report.execute({ summary: "done early" }, {});
			for (let i = 0; i < 45; i++) listener(record.session, { type: "assistant/message" });
		}
	});
	const ctx = { agents: fake.agents, sessionQuery: fakeSessionQuery({}), on: (name, fn) => { if (name === "session/event") listener = fn; return () => { listener = undefined; }; } };
	const result = await runDream(ctx, { cwd: CWD, sessionIds: ["s1"], store: await storeFor(t), indexMaxBytes: 4096 });
	assert.equal(result.unfinished, undefined);
});

test("a completed turn without a report is not a partial run", async (t) => {
	const fake = fakeAgents();
	const result = await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { cwd: CWD, sessionIds: ["s1"], store: await storeFor(t), indexMaxBytes: 4096 });
	assert.equal(result.unfinished, undefined);
});

test("the prompt names where each session's unreviewed events start", async (t) => {
	const fake = fakeAgents();
	await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { cwd: CWD, sessionIds: ["s1", "s2"], fromSeqs: { s1: 40, s2: 0 }, store: await storeFor(t), indexMaxBytes: 4096 });
	assert.match(fake.record.followups[0].content[0].text, /s1 \(from seq 41\), s2/);
});

test("projectState tells a deleted project from a directory that cannot be reached", async (t) => {
	const existing = await mkdtemp(join(tmpdir(), "dsh-memory-project-"));
	t.after(() => rm(existing, { recursive: true, force: true }));
	assert.equal(await projectState(existing), "present");
	assert.equal(await projectState(join(existing, "deleted")), "gone");
	assert.equal(await projectState(join(existing, "a", "b", "deleted")), "gone", "a nearer ancestor that exists is enough");
	if (process.platform === "win32") {
		let free;
		for (const letter of "ZYXWVUTSRQPONMLKJIHGFED") if (!(await stat(letter + ":\\").then(() => true, () => false))) { free = letter; break; }
		if (free !== undefined) assert.equal(await projectState(free + ":\\proj"), "unreachable");
	}
});

test("a project directory that cannot be reached skips the run before any agent is created", async (t) => {
	if (process.platform !== "win32") return t.skip("needs an unmounted drive letter");
	let free;
	for (const letter of "ZYXWVUTSRQPONMLKJIHGFED") if (!(await stat(letter + ":\\").then(() => true, () => false))) { free = letter; break; }
	if (free === undefined) return t.skip("no free drive letter");
	const fake = fakeAgents();
	const result = await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { cwd: free + ":\\proj", sessionIds: ["s1"], store: await storeFor(t), indexMaxBytes: 4096 });
	assert.equal(result.ok, false);
	assert.equal(result.skipped, true);
	assert.equal(fake.record.options, undefined, "no hidden session was created");
});

test("a deleted project's partition is read-only for the dreaming agent", async (t) => {
	const existing = await mkdtemp(join(tmpdir(), "dsh-memory-project-"));
	t.after(() => rm(existing, { recursive: true, force: true }));
	const fake = fakeAgents({
		onIdle: async (record) => {
			await assert.rejects(record.tools.memory_write.execute({ scope: "project", path: "n.md", content: "x" }, {}), /no longer exists/);
			await record.tools.memory_write.execute({ scope: "user", path: "pref.md", content: "x", basis: "user-stated" }, {});
		}
	});
	const result = await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { cwd: join(existing, "deleted"), sessionIds: ["s1"], store: await storeFor(t), indexMaxBytes: 4096 });
	assert.equal(result.ok, true);
	assert.deepEqual(result.changes.paths.created, ["user/pref.md"]);
});

test("notes a run changes are copied aside first, under the run's own session id", async (t) => {
	const store = await storeFor(t);
	const { version } = await store.write("user", undefined, "pref.md", "original", null);
	const fake = fakeAgents({
		onIdle: async (record) => {
			await record.tools.memory_write.execute({ scope: "user", path: "pref.md", content: "rewritten", version }, {});
		}
	});
	const result = await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { cwd: CWD, sessionIds: ["s1"], store, indexMaxBytes: 4096 }).catch((error) => { throw error; });
	assert.equal(result.ok, true);
	assert.deepEqual(result.changes.paths.modified, ["user/pref.md"]);
	assert.equal(await readFile(join(store.root, ".state", "history", result.dreamSessionId, "user", "pref.md"), "utf8"), "original");
	assert.equal((await store.read("user", undefined, "pref.md")).content, "rewritten");
});

test("only history of the newest runs is kept", async (t) => {
	const store = await storeFor(t);
	for (let i = 0; i < HISTORY_KEEP + 3; i++) {
		const dir = join(store.root, ".state", "history", `run-${i}`);
		await mkdir(dir, { recursive: true });
		await utimes(dir, 1000 + i, 1000 + i);
	}
	const fake = fakeAgents();
	await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { cwd: CWD, sessionIds: ["s1"], store, indexMaxBytes: 4096 });
	assert.equal((await readdir(join(store.root, ".state", "history"))).length, HISTORY_KEEP);
});

test("a resolved version conflict and the user-level gate are not reported as problems; a real tool error still is", async (t) => {
	const fake = fakeAgents({
		extraEvents: [
			toolResult(3, "Memory conflict: the note was changed by another session", true),
			toolResult(4, 'A new user-level note needs basis "user-stated": only preferences', true),
			toolResult(5, "No note x.md in the project partition.", true)
		]
	});
	const result = await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { cwd: CWD, sessionIds: ["s1"], store: await storeFor(t), indexMaxBytes: 4096 });
	assert.deepEqual(result.issues, ["tool error: No note x.md in the project partition.", "ended without dream_report"]);
});

test("the prompt carries the checks computed from the notes on disk", async (t) => {
	const store = await storeFor(t);
	await store.write("user", undefined, "INDEX.md", "- [gone](gone.md) missing", null);
	const fake = fakeAgents();
	await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { cwd: CWD, sessionIds: ["s1"], store, indexMaxBytes: 4096 });
	assert.match(fake.record.followups[0].content[0].text, /user: INDEX\.md links to gone\.md, which does not exist/);
});

test("reading alone earns no credit: a run cut off without changing any note leaves every session where it started", async (t) => {
	let listener;
	const sessions = { s1: { header: { id: "s1", cwd: CWD }, events: [userMsg(1, "hello"), assistantMsg(2, "done")] } };
	const fake = fakeAgents({
		turnEnd: { kind: "aborted" },
		onIdle: async (record) => {
			await record.tools.transcript_read.execute({ sessionId: "s1" }, {});
			for (let i = 0; i < 45; i++) listener(record.session, { type: "assistant/message" });
		}
	});
	const ctx = { agents: fake.agents, sessionQuery: fakeSessionQuery(sessions), on: (name, fn) => { if (name === "session/event") listener = fn; return () => { listener = undefined; }; } };
	const result = await runDream(ctx, { cwd: CWD, sessionIds: ["s1"], fromSeqs: { s1: 7 }, store: await storeFor(t), indexMaxBytes: 4096 });
	assert.deepEqual(result.unfinished, { s1: 7 });
});

test("credit stops at the agent's last note change, not at what it read afterwards", async (t) => {
	let listener;
	const events = [userMsg(1, "a".repeat(1900)), ...Array.from({ length: 30 }, (_, i) => assistantMsg(2 + i, "b".repeat(1900)))];
	const sessions = { s1: { header: { id: "s1", cwd: CWD }, events } };
	const fake = fakeAgents({
		turnEnd: { kind: "aborted" },
		onIdle: async (record) => {
			const first = await record.tools.transcript_read.execute({ sessionId: "s1" }, {});
			await record.tools.memory_write.execute({ scope: "user", path: "a.md", content: "learned", basis: "user-stated" }, {});
			await record.tools.transcript_read.execute({ sessionId: "s1", fromSeq: Number(first.text.match(/fromSeq=(\d+)/)[1]) }, {});
			for (let i = 0; i < 45; i++) listener(record.session, { type: "assistant/message" });
		}
	});
	const ctx = { agents: fake.agents, sessionQuery: fakeSessionQuery(sessions), on: (name, fn) => { if (name === "session/event") listener = fn; return () => { listener = undefined; }; } };
	const result = await runDream(ctx, { cwd: CWD, sessionIds: ["s1"], store: await storeFor(t), indexMaxBytes: 4096 });
	const firstPageEnd = Number((await transcriptTools({ sessionQuery: fakeSessionQuery(sessions) }, { cwd: CWD, sessionIds: ["s1"] })[0].execute({ sessionId: "s1" }, {})).text.match(/fromSeq=(\d+)/)[1]) - 1;
	assert.deepEqual(result.unfinished, { s1: firstPageEnd });
});

test("a run cancelled while the checks run never creates an agent", async (t) => {
	const fake = fakeAgents();
	const controller = new AbortController();
	controller.abort(new Error("memory was turned off"));
	const result = await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { cwd: CWD, sessionIds: ["s1"], store: await storeFor(t), indexMaxBytes: 4096, signal: controller.signal });
	assert.equal(result.ok, false);
	assert.equal(fake.record.options, undefined);
});

test("a run cancelled while the agent is being created stops it before the prompt is sent", async (t) => {
	const controller = new AbortController();
	const fake = fakeAgents();
	const create = fake.agents.create;
	fake.agents.create = async (options) => {
		const handle = await create(options);
		controller.abort(new Error("plugin stopping"));
		return handle;
	};
	const result = await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { cwd: CWD, sessionIds: ["s1"], store: await storeFor(t), indexMaxBytes: 4096, signal: controller.signal });
	assert.equal(result.ok, false);
	assert.deepEqual(fake.record.followups, [], "no prompt was sent");
	assert.equal(fake.record.disposed, true);
});

test("the dreaming agent itself is a subagent session but may still write notes", async (t) => {
	const fake = fakeAgents({
		onIdle: async (record) => {
			await record.tools.memory_write.execute({ scope: "user", path: "a.md", content: "x", basis: "user-stated" }, { agent: { session: { header: { id: "d", origin: "subagent" } } } });
		}
	});
	const result = await runDream({ agents: fake.agents, sessionQuery: fakeSessionQuery({}) }, { cwd: CWD, sessionIds: ["s1"], store: await storeFor(t), indexMaxBytes: 4096 });
	assert.equal(result.ok, true, result.error);
	assert.deepEqual(result.changes.paths.created, ["user/a.md"]);
});
