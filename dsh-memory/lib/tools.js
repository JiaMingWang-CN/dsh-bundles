/**
 * Model-facing memory tools: memory_list / memory_read / memory_write /
 * memory_delete / memory_move / memory_search. Sessions use them with the partition taken from the calling
 * session's working directory; dreaming reuses them with a fixed `cwdOf` and a
 * change tracker. Cross-project dreaming names the project on every
 * project-scope call instead.
 *
 * Rules enforced here rather than left to the prompt:
 * - a NEW user-level note needs `basis: "user-stated"` outside cross-project
 *   dreaming; everything else starts in the project partition, and only
 *   cross-project dreaming promotes it once two projects confirm it;
 * - INDEX.md must fit the injected budget, one short line per note;
 * - a note over NOTE_SOFT_BYTES is saved with a warning to split it.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { basename } from "node:path";
import { MemoryStore } from "./store.js";
import { sameProject, isIndexPath } from "./paths.js";
import { isSubagent } from "./trigger.js";

/** Longest INDEX.md line: a link plus one short sentence. */
export const INDEX_LINE_BYTES = 240;
/** Note size above which a write returns a warning. */
export const NOTE_SOFT_BYTES = 3072;

const SCOPE = {
	type: "string",
	enum: ["project", "user"],
	required: true,
	description: 'Memory partition: "project" (this working directory) or "user" (across projects).'
};
const PATH = { type: "string", required: true, description: 'Note path relative to the partition, ending in .md, e.g. "INDEX.md" or "testing/db.md".' };
const PROJECT = { type: "string", description: 'Project directory, required with scope "project"; one of the projects listed in your task.' };
const BASIS = {
	type: "string",
	enum: ["user-stated"],
	description: 'Required to create a new user-level note: "user-stated" when the user explicitly stated this preference or way of working. Anything else goes to the project partition.'
};
const TEXT_OUTPUT = {
	schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true, description: "Result text." } } },
	render: (_args, value) => [{ type: "text", text: value.text }]
};

const CONFLICT_HINT = "the note was changed by another session or by dreaming since you read it. Call memory_read again and rewrite it based on the new content.";
const USER_GATE = 'A new user-level note needs basis "user-stated": only preferences or ways of working the user explicitly stated go straight to the user partition. Write other lessons to the project partition, with a front-matter line "candidate: user" when they look general; cross-project dreaming promotes them once a second project confirms them.';

/** Turn store errors into model-actionable tool errors. */
function explain(error) {
	if (error?.code === "MEMORY_CONFLICT") return new Error(`Memory conflict: ${CONFLICT_HINT}`);
	if (error?.code === "MEMORY_PATH_INVALID") return new Error(error.message);
	return error;
}

const isIndex = isIndexPath;

const PROJECT_GONE = "This project's directory no longer exists, so no future session will load its notes: do not write to the project partition.";
const SUBAGENT_READONLY = "Subagents cannot change memory. Put what is worth remembering in your final result and let the parent agent decide.";
/** Secrets that are recognisable with near certainty: a note holding one is refused. */
const SECRET_PATTERNS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{36,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{35}\b/];
const SECRET_REFUSED = "The note contains what looks like a secret (private key, API key or token). Remove it and say where the credential is configured instead; secrets are never stored in memory.";
const PRIVACY = "Never store secrets (API keys, tokens, passwords, private keys, credentials in connection strings) or personal data; note where a credential is configured, not its value.";

/** Refuse an INDEX.md that would be truncated on injection or carries paragraph-long lines. */
function checkIndex(content, maxBytes) {
	const bytes = Buffer.byteLength(content);
	if (bytes > maxBytes) throw new Error(`INDEX.md would be ${bytes} bytes; the limit is ${maxBytes}. Shorten summaries or merge notes, then write it again.`);
	const long = content.split("\n").filter((line) => Buffer.byteLength(line) > INDEX_LINE_BYTES);
	if (long.length > 0) throw new Error(`Each INDEX.md line must stay within ${INDEX_LINE_BYTES} bytes (a link plus one short sentence); ${long.length} line(s) are longer, e.g. "${long[0].slice(0, 60)}…". Move the details into the note.`);
}

/**
 * Build the memory tools.
 * @param {MemoryStore} store
 * @param {{ cwdOf?: (exec: object) => string | undefined, tracker?: ReturnType<import("./store.js").createChangeTracker>,
 *   indexMaxBytes?: () => number, projects?: string[], projectWritable?: boolean }} [options]
 *   `cwdOf` defaults to the calling session's working directory. `projects`
 *   switches to cross-project mode: project-scope calls name one of them.
 *   `projectWritable: false` makes the project partition read-only (its project is gone).
 * @returns {object[]} tool definitions for `ctx.tools.register`.
 */
export function memoryTools(store, { cwdOf = (exec) => exec?.agent?.session?.header?.cwd, tracker, indexMaxBytes = () => 4096, projects, projectWritable = true, subagentReadOnly = true } = {}) {
	const cross = projects !== undefined;
	const mayWrite = (scope, exec) => {
		if (subagentReadOnly && isSubagent(exec?.agent?.session?.header)) throw new Error(SUBAGENT_READONLY);
		if (scope === "project" && !projectWritable) throw new Error(PROJECT_GONE);
	};
	const labelOf = (scope, cwd, path) => (scope === "project" && cross ? `project:${basename(cwd)}/${path}` : `${scope}/${path}`);
	/** The change tracker as the store sees it: records under a note label, and copies the old content aside. */
	const trackFor = (label) => tracker && { record: (kind) => tracker.record(kind, label), backup: tracker.backup };
	const cwdFor = (args, exec) => {
		if (!cross || args.scope !== "project") return cwdOf(exec);
		const project = projects.find((candidate) => typeof args.project === "string" && args.project !== "" && sameProject(candidate, args.project));
		if (project === undefined) throw new Error(`Unknown project "${args.project ?? ""}". Use one of: ${projects.join(", ")}.`);
		return project;
	};
	const label = (args, cwd) => labelOf(args.scope, cwd, args.path);
	const where = cross ? { scope: SCOPE, project: PROJECT } : { scope: SCOPE };
	const run = async (fn) => {
		try {
			return { text: await fn() };
		} catch (error) {
			throw explain(error);
		}
	};
	return [
		defineTool({
			name: "memory_list",
			description: "List the notes in a memory partition with their size and version.",
			parameters: where,
			output: TEXT_OUTPUT,
			isConcurrencySafe: () => true,
			execute: (args, exec) => run(async () => {
				const entries = await store.list(args.scope, cwdFor(args, exec));
				if (entries.length === 0) return `No notes in the ${args.scope} partition.`;
				return entries.map((entry) => `${entry.path} (${entry.bytes} bytes, version: ${entry.version})`).join("\n");
			})
		}),
		defineTool({
			name: "memory_read",
			description: "Read one memory note. Returns its content and the version to pass to memory_write or memory_delete.",
			parameters: { ...where, path: PATH },
			output: TEXT_OUTPUT,
			isConcurrencySafe: () => true,
			execute: (args, exec) => run(async () => {
				const note = await store.read(args.scope, cwdFor(args, exec), args.path);
				if (note === null) throw new Error(`No note ${args.path} in the ${args.scope} partition.`);
				return `version: ${note.version}\n\n${note.content}`;
			})
		}),
		defineTool({
			name: "memory_write",
			description: `Create or replace a memory note. Pass the version from memory_read when replacing; omit it only when creating a new note. Keep one topic per note, under ${NOTE_SOFT_BYTES} bytes. ${PRIVACY}`,
			parameters: {
				...where,
				path: PATH,
				content: { type: "string", required: true, description: "Full new content of the note (Markdown)." },
				version: { type: "string", description: "Version returned by memory_read; omit when creating a new note." },
				...(cross ? {} : { basis: BASIS })
			},
			output: TEXT_OUTPUT,
			execute: (args, exec) => run(async () => {
				const cwd = cwdFor(args, exec);
				mayWrite(args.scope, exec);
				if (SECRET_PATTERNS.some((pattern) => pattern.test(args.content))) throw new Error(SECRET_REFUSED);
				if (!cross && args.scope === "user" && args.version === undefined && !isIndex(args.path) && args.basis !== "user-stated") throw new Error(USER_GATE);
				if (isIndex(args.path)) checkIndex(args.content, indexMaxBytes());
				const { version } = await store.write(args.scope, cwd, args.path, args.content, args.version ?? null, trackFor(label(args, cwd)));
				const bytes = Buffer.byteLength(args.content);
				const warning = !isIndex(args.path) && bytes > NOTE_SOFT_BYTES ? `\nWarning: this note is ${bytes} bytes. Keep notes under ${NOTE_SOFT_BYTES} bytes with one topic each: split it or cut details.` : "";
				return `Saved ${args.path} (${args.scope}). version: ${version}${warning}`;
			})
		}),
		defineTool({
			name: "memory_delete",
			description: "Delete a memory note. Pass the version from memory_read.",
			parameters: { ...where, path: PATH, version: { type: "string", required: true, description: "Version returned by memory_read." } },
			output: TEXT_OUTPUT,
			execute: (args, exec) => run(async () => {
				const cwd = cwdFor(args, exec);
				mayWrite(args.scope, exec);
				await store.remove(args.scope, cwd, args.path, args.version, trackFor(label(args, cwd)));
				return `Deleted ${args.path} (${args.scope}).`;
			})
		}),
		defineTool({
			name: "memory_move",
			description: cross
				? "Move a note to another path or partition in one step, keeping its content: the note is never missing or duplicated. Pass the version from memory_read. The target must not exist. Update both INDEX.md files afterwards."
				: "Rename or move a note within its partition in one step, keeping its content. Pass the version from memory_read. The target must not exist. Update INDEX.md afterwards.",
			parameters: {
				...where,
				path: PATH,
				version: { type: "string", required: true, description: "Version returned by memory_read." },
				...(cross ? { toScope: { ...SCOPE, description: "Partition to move the note into." }, toProject: { ...PROJECT, description: 'Target project directory, required with toScope "project".' } } : {}),
				toPath: { ...PATH, description: "New note path in the target partition, ending in .md." }
			},
			output: TEXT_OUTPUT,
			execute: (args, exec) => run(async () => {
				const cwd = cwdFor(args, exec);
				const toScope = cross ? args.toScope : args.scope;
				const toCwd = cross ? cwdFor({ scope: toScope, project: args.toProject }, exec) : cwd;
				if (isIndex(args.path) || isIndex(args.toPath)) throw new Error("INDEX.md cannot be moved; rewrite it with memory_write.");
				mayWrite(args.scope, exec);
				mayWrite(toScope, exec);
				const from = { scope: args.scope, cwd, path: args.path };
				const to = { scope: toScope, cwd: toCwd, path: args.toPath };
				const { version } = await store.move(from, to, args.version, tracker && { backup: tracker.backup });
				tracker?.record("deleted", labelOf(args.scope, cwd, args.path));
				tracker?.record("created", labelOf(toScope, toCwd, args.toPath));
				return `Moved ${args.path} (${args.scope}) to ${args.toPath} (${toScope}). version: ${version}`;
			})
		}),
		defineTool({
			name: "memory_search",
			description: "Case-insensitive literal search across the notes of one memory partition. Returns `path:line: text` hits.",
			parameters: { ...where, query: { type: "string", required: true, description: "Literal text to find." } },
			output: TEXT_OUTPUT,
			isConcurrencySafe: () => true,
			execute: (args, exec) => run(async () => {
				const hits = await store.search(args.scope, cwdFor(args, exec), args.query);
				return hits.length === 0 ? "No matches." : hits.join("\n");
			})
		})
	];
}

/**
 * Register the session memory tools globally while the master switch is on,
 * and withdraw them while it is off.
 * @param ctx - host plugin context (`tools`, `on`).
 * @param {MemoryStore} store
 * @param config - live config references (`enabled`, `indexMaxBytes`).
 */
export function installMemoryTools(ctx, store, config) {
	let disposers = [];
	const sync = () => {
		const want = config.enabled.get();
		if (want && disposers.length === 0) disposers = memoryTools(store, { indexMaxBytes: () => config.indexMaxBytes.get() }).map((tool) => ctx.tools.register(tool));
		else if (!want && disposers.length > 0) {
			for (const dispose of disposers) dispose();
			disposers = [];
		}
	};
	sync();
	ctx.on("loader/volatile-update", sync);
}
