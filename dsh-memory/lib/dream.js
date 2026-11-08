/**
 * One dreaming run: a hidden, tool-restricted background agent that
 * consolidates one project's memory against the transcripts of a batch of
 * ended sessions.
 *
 * Mechanism (verified by the 2026-11-08 spike on DSH 0.2.2-rc.1):
 * - `ctx.agents.create()` without `parentAgent` makes a runtime root agent;
 * - `meta: { origin: "subagent" }` without `cwd`: the session is stored under
 *   `sessions/_no-cwd/`, never listed or searched, and hidden from the sidebar;
 * - `agentCtx.tools.restrict({ allow: [] })` masks every global tool; the
 *   scoped registrations below stay visible;
 * - messages must be built with `createUserMessage()` (it sets `role`).
 *
 * Outcome: the loop appends `turn/end` with `reason.kind` one of
 * "completed", "error" (model/tool failure, `reason.error.message`),
 * "aborted", "max-tokens" (output cut off) or "blocked". Only "completed"
 * counts as success; a missing turn is a failure too.
 */
import { randomUUID } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { createChangeTracker } from "./store.js";
import { memoryTools } from "./tools.js";
import { sameProject } from "./paths.js";
import { dreamPrompt } from "./prompt.js";

const TOOL_RESULT_CHARS = 400;
const TOOL_CALL_CHARS = 200;
const PAGE_CHARS = 12_000;
const SEARCH_HITS = 50;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
const oneLine = (text) => text.replace(/\s+/g, " ").trim();

function blockText(block, max) {
	if (block?.type === "text") return block.text;
	if (block?.type === "reasoning") return "";
	return clip(`[${block?.type}] ${JSON.stringify(block)}`, max);
}

/**
 * Render a session's events as compact transcript lines: real user input,
 * assistant text and tool activity. Injected context (workspace instructions,
 * reminders) and model reasoning are dropped.
 * @param {Array<{ seq: number, type: string, data: any }>} events
 * @returns {string} one `[seq N] ROLE: text` line per kept message.
 */
export function renderTranscript(events) {
	const lines = [];
	for (const event of events) {
		const message = event.data?.message;
		if (message === undefined) continue;
		const content = Array.isArray(message.content) ? message.content : [];
		if (event.type === "user/message") {
			if (message.source?.kind !== "user") continue;
			lines.push(`[seq ${event.seq}] USER: ${oneLine(content.map((block) => blockText(block, TOOL_CALL_CHARS)).join(" "))}`);
		} else if (event.type === "assistant/message") {
			const text = oneLine(content.filter((block) => block.type === "text").map((block) => block.text).join(" "));
			if (text !== "") lines.push(`[seq ${event.seq}] ASSISTANT: ${text}`);
			for (const block of content) {
				if (block.type !== "text" && block.type !== "reasoning") lines.push(`[seq ${event.seq}] TOOL CALL: ${oneLine(blockText(block, TOOL_CALL_CHARS))}`);
			}
		} else if (event.type === "tool/result") {
			const text = oneLine(content.map((block) => blockText(block, TOOL_RESULT_CHARS)).join(" "));
			lines.push(`[seq ${event.seq}] TOOL RESULT${message.isError ? " (error)" : ""}: ${clip(text, TOOL_RESULT_CHARS)}`);
		}
	}
	return lines.join("\n");
}

const TEXT_OUTPUT = {
	schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true, description: "Result text." } } },
	render: (_args, value) => [{ type: "text", text: value.text }]
};

/**
 * Read-only transcript tools for the dreaming agent, limited to sessions of
 * the project being consolidated.
 * @param ctx - context providing `sessionQuery`.
 * @param {{ cwd: string, sessionIds: string[] }} job
 */
export function transcriptTools(ctx, { cwd, sessionIds }) {
	const cache = new Map();
	const load = async (sessionId) => {
		if (!cache.has(sessionId)) {
			cache.set(sessionId, ctx.sessionQuery.readSession(sessionId).then(({ session, events }) => {
				if (typeof session.cwd !== "string" || !sameProject(session.cwd, cwd)) throw new Error(`Session ${sessionId} belongs to another project; only this project's sessions can be read.`);
				return renderTranscript(events).split("\n").filter((line) => line !== "");
			}));
		}
		return cache.get(sessionId);
	};
	return [
		defineTool({
			name: "transcript_read",
			description: "Read a session transcript of this project as `[seq N] ROLE: text` lines, one page at a time. Transcripts are the ground truth for checking memory notes.",
			parameters: {
				sessionId: { type: "string", required: true, description: "Session id, e.g. one listed in your task." },
				fromSeq: { type: "integer", description: "Start at this event seq; omit to start from the beginning." }
			},
			output: TEXT_OUTPUT,
			isConcurrencySafe: () => true,
			async execute(args) {
				const lines = await load(args.sessionId);
				const from = args.fromSeq ?? 0;
				const out = [];
				let size = 0;
				for (const line of lines) {
					const seq = Number(line.match(/^\[seq (\d+)\]/)?.[1] ?? 0);
					if (seq < from) continue;
					if (size + line.length > PAGE_CHARS && out.length > 0) {
						out.push(`[more: call transcript_read with fromSeq=${seq}]`);
						break;
					}
					out.push(line);
					size += line.length + 1;
				}
				return { text: out.length === 0 ? "No transcript lines at or after that seq." : out.join("\n") };
			}
		}),
		defineTool({
			name: "transcript_search",
			description: "Case-insensitive literal search across the transcripts of the sessions under review.",
			parameters: { query: { type: "string", required: true, description: "Literal text to find." } },
			output: TEXT_OUTPUT,
			isConcurrencySafe: () => true,
			async execute(args) {
				const needle = args.query.toLowerCase();
				const hits = [];
				for (const sessionId of sessionIds) {
					for (const line of await load(sessionId)) {
						if (line.toLowerCase().includes(needle)) hits.push(`${sessionId} ${line}`);
						if (hits.length >= SEARCH_HITS) break;
					}
					if (hits.length >= SEARCH_HITS) break;
				}
				return { text: hits.length === 0 ? "No matches." : hits.join("\n") };
			}
		})
	];
}

/**
 * Run one dreaming pass.
 * @param ctx - context providing `agents` and `sessionQuery`.
 * @param {{ cwd: string, sessionIds: string[], selection?: { provider: string, model: string, reasoningEffort?: string },
 *   store: import("./store.js").MemoryStore, indexMaxBytes: number, signal?: AbortSignal }} job
 * @returns {Promise<{ ok: true, changes: object, dreamSessionId: string } | { ok: false, error: string, dreamSessionId?: string }>}
 */
export async function runDream(ctx, { cwd, sessionIds, selection, store, indexMaxBytes, signal }) {
	const tracker = createChangeTracker();
	const sessionId = `session-${randomUUID()}`;
	let handle;
	try {
		handle = await ctx.agents.create({
			sessionId,
			meta: { origin: "subagent" },
			agentOptions: selection === undefined ? {} : { ...selection },
			setup(agentCtx) {
				agentCtx.tools.restrict({ allow: [] });
				for (const tool of [...memoryTools(store, { cwdOf: () => cwd, tracker }), ...transcriptTools(ctx, { cwd, sessionIds })]) agentCtx.tools.register(tool);
			}
		});
		const agent = handle.agent;
		const onAbort = () => agent.cancel(signal.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			agent.followup(createUserMessage({
				content: [{ type: "text", text: dreamPrompt({ cwd, sessionIds, indexMaxBytes }) }],
				source: { kind: "user" }
			}));
			await agent.whenIdle();
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
		const turnEnd = [...agent.session.snapshotEvents(0)].reverse().find((event) => event.type === "turn/end");
		const reason = turnEnd?.data?.reason;
		if (turnEnd === undefined) return { ok: false, error: "dreaming agent did not finish a turn", dreamSessionId: sessionId };
		if (reason?.kind === "completed") return { ok: true, changes: tracker.summary(), dreamSessionId: sessionId };
		if (reason?.kind === "error") return { ok: false, error: reason.error?.message ?? "model error", dreamSessionId: sessionId };
		return { ok: false, error: `dreaming turn ended with "${reason?.kind ?? "unknown"}"`, dreamSessionId: sessionId };
	} catch (error) {
		return { ok: false, error: error?.message ?? String(error), ...(handle ? { dreamSessionId: sessionId } : {}) };
	} finally {
		await handle?.dispose().catch(() => {});
	}
}
