/**
 * One dreaming run: a hidden, tool-restricted background agent that
 * consolidates memory. A project run reviews one project's ended sessions;
 * a cross-project run reviews every partition together and moves notes to
 * the partition where they hold.
 *
 * Mechanism (verified by the 2026-11-08 spike on DSH 0.2.2-rc.1):
 * - `ctx.agents.create()` without `parentAgent` makes a runtime root agent;
 * - `meta: { origin: "subagent" }` without `cwd`: the session is stored under
 *   `sessions/_no-cwd/`, never listed or searched, and hidden from the sidebar;
 * - `agentCtx.tools.restrict({ allow: [] })` masks every global tool; the
 *   scoped registrations below stay visible;
 * - messages must be built with `createUserMessage()` (it sets `role`);
 * - `sessionTitle.rename()` pins the title and stops title generation;
 * - the loop has no turn budget: a policy must `cancel()` the agent itself.
 *
 * Outcome: the loop appends `turn/end` with `reason.kind` one of
 * "completed", "error" (model/tool failure, `reason.error.message`),
 * "aborted", "max-tokens" (output cut off) or "blocked". A completed turn,
 * or one this module cancelled at the step budget, is a success; anything
 * the run could not finish (tool errors, unresolved items the agent
 * reported, a missing report, the budget) is listed in `issues`.
 */
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { createChangeTracker } from "./store.js";
import { memoryTools } from "./tools.js";
import { sameProject } from "./paths.js";
import { dreamPrompt, crossDreamPrompt } from "./prompt.js";

/** Model calls one run may make before it is stopped. */
export const MAX_STEPS = { project: 40, cross: 80 };
/** Marker opening every dreaming prompt; also identifies old runs' sessions on disk. */
export const DREAM_PROMPT_MARKERS = ["Memory consolidation", 'You are "dreaming"'];

const TOOL_RESULT_CHARS = 400;
const TOOL_CALL_CHARS = 200;
const PAGE_CHARS = 12_000;
const SEARCH_HITS = 50;
const ISSUE_CHARS = 200;
const ISSUE_LIMIT = 8;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
const oneLine = (text) => text.replace(/\s+/g, " ").trim();

function blockText(block, max) {
	if (block?.type === "text") return block.text;
	if (block?.type === "reasoning") return "";
	return clip(`[${block?.type}] ${JSON.stringify(block)}`, max);
}

/** A tool call as `TOOL CALL <name>: <arguments>`; provider call ids are noise and dropped. */
function toolCallLine(block) {
	if (block.type !== "tool-call") return `TOOL CALL: ${oneLine(blockText(block, TOOL_CALL_CHARS))}`;
	const args = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {});
	return `TOOL CALL ${block.name}: ${clip(oneLine(args), TOOL_CALL_CHARS)}`;
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
		/* A user/message event carries the message itself as `data`; assistant/message and tool/result wrap it in `data.message`. */
		const message = event.type === "user/message" ? event.data : event.data?.message;
		if (message === undefined || message === null) continue;
		const content = Array.isArray(message.content) ? message.content : [];
		if (event.type === "user/message") {
			if (message.source?.kind !== "user") continue;
			lines.push(`[seq ${event.seq}] USER: ${oneLine(content.map((block) => blockText(block, TOOL_CALL_CHARS)).join(" "))}`);
		} else if (event.type === "assistant/message") {
			const text = oneLine(content.filter((block) => block.type === "text").map((block) => block.text).join(" "));
			if (text !== "") lines.push(`[seq ${event.seq}] ASSISTANT: ${text}`);
			for (const block of content) {
				if (block.type !== "text" && block.type !== "reasoning") lines.push(`[seq ${event.seq}] ${toolCallLine(block)}`);
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
 * Find a session by a full id or a unique prefix (notes written by earlier
 * runs may cite a shortened id), limited to sessions `allowed` accepts.
 * @returns {Promise<{ session: object, events: object[] }>}
 */
async function resolveSession(sessionQuery, sessionId, allowed) {
	try {
		return await sessionQuery.readSession(sessionId);
	} catch (error) {
		if (typeof sessionQuery.listSessions !== "function") throw error;
	}
	const wanted = sessionId.replace(/^session-/, "");
	const matches = (await sessionQuery.listSessions()).map(({ header }) => header).filter((header) => header.id.replace(/^session-/, "").startsWith(wanted) && allowed(header));
	if (matches.length === 1) return sessionQuery.readSession(matches[0].id);
	if (matches.length > 1) throw new Error(`Session id "${sessionId}" is ambiguous: ${matches.slice(0, 5).map((header) => header.id).join(", ")}. Use the full id.`);
	throw new Error(`No session "${sessionId}" here. Cite full session ids (session-<uuid>); a note whose evidence cannot be found stays unverified: list it in dream_report.`);
}

/**
 * Read-only transcript tools for the dreaming agent. A project run reads
 * that project's sessions and searches its batch; a cross-project run
 * (`cwd` undefined) reads any project's session to see where a cited
 * session belongs, and has no search.
 * @param ctx - context providing `sessionQuery`.
 * @param {{ cwd?: string, sessionIds: string[] }} job
 */
export function transcriptTools(ctx, { cwd, sessionIds }) {
	const cross = cwd === undefined;
	const allowed = (header) => typeof header.cwd === "string" && (cross || sameProject(header.cwd, cwd));
	const cache = new Map();
	const load = async (sessionId) => {
		if (!cache.has(sessionId)) {
			cache.set(sessionId, resolveSession(ctx.sessionQuery, sessionId, allowed).then(({ session, events }) => {
				if (!allowed(session)) throw new Error(`Session ${sessionId} belongs to another project; only this project's sessions can be read.`);
				return { id: session.id, cwd: session.cwd, lines: renderTranscript(events).split("\n").filter((line) => line !== "") };
			}));
		}
		return cache.get(sessionId);
	};
	const read = defineTool({
		name: "transcript_read",
		description: "Read a session transcript as `[seq N] ROLE: text` lines, one page at a time. Transcripts are the ground truth for checking memory notes. The first page names the session's full id and project.",
		parameters: {
			sessionId: { type: "string", required: true, description: "Full session id (session-<uuid>); a unique prefix also works." },
			fromSeq: { type: "integer", description: "Start at this event seq; omit to start from the beginning." }
		},
		output: TEXT_OUTPUT,
		isConcurrencySafe: () => true,
		async execute(args) {
			const { id, cwd: project, lines } = await load(args.sessionId);
			const from = args.fromSeq ?? 0;
			const out = from === 0 ? [`Session ${id} · project ${project}`] : [];
			let size = 0;
			for (const line of lines) {
				const seq = Number(line.match(/^\[seq (\d+)\]/)?.[1] ?? 0);
				if (seq < from) continue;
				if (size + line.length > PAGE_CHARS && size > 0) {
					out.push(`[more: call transcript_read with fromSeq=${seq}]`);
					break;
				}
				out.push(line);
				size += line.length + 1;
			}
			return { text: out.length === 0 ? "No transcript lines at or after that seq." : out.join("\n") };
		}
	});
	if (cross) return [read];
	return [
		read,
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
					for (const line of (await load(sessionId)).lines) {
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

/** The closing report the agent must file; `holder.report` receives it. */
export function reportTool(holder) {
	return defineTool({
		name: "dream_report",
		description: "Call once when you are done: what you changed and why, and everything left unresolved.",
		parameters: {
			summary: { type: "string", required: true, description: "Short summary of what you changed and why." },
			unresolved: { type: "string", description: "One item per line: notes you could not verify or fix, checks that failed, work you skipped, and why. Empty when none." }
		},
		output: TEXT_OUTPUT,
		async execute(args) {
			holder.report = { summary: args.summary, unresolved: (args.unresolved ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "") };
			return { text: "Report recorded. End your turn now." };
		}
	});
}

/** Tool errors in the run's own events, as short issue lines. */
function toolErrors(events) {
	return events.filter((event) => event.type === "tool/result" && event.data?.message?.isError).map((event) => {
		const content = Array.isArray(event.data.message.content) ? event.data.message.content : [];
		return `tool error: ${clip(oneLine(content.map((block) => blockText(block, ISSUE_CHARS)).join(" ")), ISSUE_CHARS)}`;
	});
}

/**
 * Run one dreaming pass.
 * @param ctx - context providing `agents`, `sessionQuery`, and optionally `on` (step budget) and `get` (`sessionTitle`).
 * @param {{ cwd?: string, sessionIds?: string[], projects?: Array<{ cwd: string, notes: number }>,
 *   selection?: { provider: string, model: string, reasoningEffort?: string },
 *   store: import("./store.js").MemoryStore, indexMaxBytes: number, signal?: AbortSignal }} job
 *   `projects` makes it a cross-project run; otherwise it consolidates `cwd`.
 * @returns {Promise<{ ok: true, changes: object, issues: string[], summary?: string, dreamSessionId: string }
 *   | { ok: false, error: string, dreamSessionId?: string }>}
 */
export async function runDream(ctx, { cwd, sessionIds = [], projects, selection, store, indexMaxBytes, signal }) {
	const cross = projects !== undefined;
	const maxSteps = cross ? MAX_STEPS.cross : MAX_STEPS.project;
	const tracker = createChangeTracker();
	const holder = { report: undefined };
	const sessionId = `session-${randomUUID()}`;
	let handle;
	let steps = 0;
	let budgetHit = false;
	let stopListening;
	try {
		let prompt;
		let tools;
		if (cross) {
			prompt = crossDreamPrompt({ projects, indexMaxBytes, maxSteps });
			tools = [...memoryTools(store, { projects: projects.map((project) => project.cwd), tracker, indexMaxBytes: () => indexMaxBytes }), ...transcriptTools(ctx, { sessionIds: [] })];
		} else {
			/* Notes in a deleted project's partition would never be loaded again; the prompt then keeps only what the user stated. */
			const projectGone = await stat(cwd).then(() => false, (error) => error.code === "ENOENT");
			prompt = dreamPrompt({ cwd, sessionIds, indexMaxBytes, projectGone, maxSteps });
			tools = [...memoryTools(store, { cwdOf: () => cwd, tracker, indexMaxBytes: () => indexMaxBytes }), ...transcriptTools(ctx, { cwd, sessionIds })];
		}
		handle = await ctx.agents.create({
			sessionId,
			meta: { origin: "subagent" },
			agentOptions: selection === undefined ? {} : { ...selection },
			setup(agentCtx) {
				agentCtx.tools.restrict({ allow: [] });
				for (const tool of [...tools, reportTool(holder)]) agentCtx.tools.register(tool);
			}
		});
		const agent = handle.agent;
		try {
			ctx.get?.("sessionTitle")?.rename(agent.session, `记忆整理 · ${cross ? "跨项目" : basename(cwd)}`);
		} catch {
			/* A missing title only costs a fallback title. */
		}
		stopListening = ctx.on?.("session/event", (session, event) => {
			if (session.header?.id !== sessionId || event.type !== "assistant/message") return;
			if (++steps > maxSteps && !budgetHit) {
				budgetHit = true;
				agent.cancel(new Error(`dreaming step budget of ${maxSteps} reached`));
			}
		});
		const onAbort = () => agent.cancel(signal.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			agent.followup(createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "user" } }));
			await agent.whenIdle();
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
		const events = [...agent.session.snapshotEvents(0)];
		const turnEnd = [...events].reverse().find((event) => event.type === "turn/end");
		const reason = turnEnd?.data?.reason;
		if (turnEnd === undefined) return { ok: false, error: "dreaming agent did not finish a turn", dreamSessionId: sessionId };
		if (reason?.kind === "completed" || budgetHit) {
			const issues = [
				...(budgetHit ? [`step budget of ${maxSteps} reached; unfinished work waits for the next run`] : []),
				...toolErrors(events),
				...(holder.report?.unresolved ?? []).map((item) => clip(item, ISSUE_CHARS)),
				...(holder.report === undefined && !budgetHit ? ["ended without dream_report"] : [])
			];
			return {
				ok: true,
				changes: tracker.summary(),
				issues: issues.length > ISSUE_LIMIT ? [...issues.slice(0, ISSUE_LIMIT), `…and ${issues.length - ISSUE_LIMIT} more`] : issues,
				...(holder.report ? { summary: clip(holder.report.summary, 600) } : {}),
				dreamSessionId: sessionId
			};
		}
		if (reason?.kind === "error") return { ok: false, error: reason.error?.message ?? "model error", dreamSessionId: sessionId };
		return { ok: false, error: `dreaming turn ended with "${reason?.kind ?? "unknown"}"`, dreamSessionId: sessionId };
	} catch (error) {
		return { ok: false, error: error?.message ?? String(error), ...(handle ? { dreamSessionId: sessionId } : {}) };
	} finally {
		stopListening?.();
		await handle?.dispose().catch(() => {});
	}
}
