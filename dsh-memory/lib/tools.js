/**
 * Model-facing memory tools: memory_list / memory_read / memory_write /
 * memory_delete. Sessions use them with the partition taken from the calling
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
import { sameProject } from "./paths.js";

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

const isIndex = (path) => path.replace(/\\/g, "/") === "INDEX.md";

/** Refuse an INDEX.md that would be truncated on injection or carries paragraph-long lines. */
function checkIndex(content, maxBytes) {
	const bytes = Buffer.byteLength(content);
	if (bytes > maxBytes) throw new Error(`INDEX.md would be ${bytes} bytes; the limit is ${maxBytes}. Shorten summaries or merge notes, then write it again.`);
	const long = content.split("\n").filter((line) => Buffer.byteLength(line) > INDEX_LINE_BYTES);
	if (long.length > 0) throw new Error(`Each INDEX.md line must stay within ${INDEX_LINE_BYTES} bytes (a link plus one short sentence); ${long.length} line(s) are longer, e.g. "${long[0].slice(0, 60)}…". Move the details into the note.`);
}

/**
 * Build the four memory tools.
 * @param {MemoryStore} store
 * @param {{ cwdOf?: (exec: object) => string | undefined, tracker?: ReturnType<import("./store.js").createChangeTracker>,
 *   indexMaxBytes?: () => number, projects?: string[] }} [options]
 *   `cwdOf` defaults to the calling session's working directory. `projects`
 *   switches to cross-project mode: project-scope calls name one of them.
 * @returns {object[]} tool definitions for `ctx.tools.register`.
 */
export function memoryTools(store, { cwdOf = (exec) => exec?.agent?.session?.header?.cwd, tracker, indexMaxBytes = () => 4096, projects } = {}) {
	const cross = projects !== undefined;
	const cwdFor = (args, exec) => {
		if (!cross || args.scope !== "project") return cwdOf(exec);
		const project = projects.find((candidate) => typeof args.project === "string" && args.project !== "" && sameProject(candidate, args.project));
		if (project === undefined) throw new Error(`Unknown project "${args.project ?? ""}". Use one of: ${projects.join(", ")}.`);
		return project;
	};
	const label = (args, cwd) => (args.scope === "project" && cross ? `project:${basename(cwd)}/${args.path}` : `${args.scope}/${args.path}`);
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
			description: `Create or replace a memory note. Pass the version from memory_read when replacing; omit it only when creating a new note. Keep one topic per note, under ${NOTE_SOFT_BYTES} bytes.`,
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
				if (!cross && args.scope === "user" && args.version === undefined && !isIndex(args.path) && args.basis !== "user-stated") throw new Error(USER_GATE);
				if (isIndex(args.path)) checkIndex(args.content, indexMaxBytes());
				const { version } = await store.write(args.scope, cwd, args.path, args.content, args.version ?? null, tracker && { record: (kind) => tracker.record(kind, label(args, cwd)) });
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
				await store.remove(args.scope, cwd, args.path, args.version, tracker && { record: (kind) => tracker.record(kind, label(args, cwd)) });
				return `Deleted ${args.path} (${args.scope}).`;
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
