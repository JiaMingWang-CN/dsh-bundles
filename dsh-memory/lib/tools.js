/**
 * Model-facing memory tools: memory_list / memory_read / memory_write /
 * memory_delete. Sessions use them with the partition taken from the calling
 * session's working directory; dreaming reuses them with a fixed `cwdOf` and a
 * change tracker.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { MemoryStore } from "./store.js";

const SCOPE = {
	type: "string",
	enum: ["project", "user"],
	required: true,
	description: 'Memory partition: "project" (this working directory) or "user" (across projects).'
};
const PATH = { type: "string", required: true, description: 'Note path relative to the partition, ending in .md, e.g. "INDEX.md" or "testing/db.md".' };
const TEXT_OUTPUT = {
	schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true, description: "Result text." } } },
	render: (_args, value) => [{ type: "text", text: value.text }]
};

const CONFLICT_HINT = "the note was changed by another session or by dreaming since you read it. Call memory_read again and rewrite it based on the new content.";

/** Turn store errors into model-actionable tool errors. */
function explain(error) {
	if (error?.code === "MEMORY_CONFLICT") return new Error(`Memory conflict: ${CONFLICT_HINT}`);
	if (error?.code === "MEMORY_PATH_INVALID") return new Error(error.message);
	return error;
}

/**
 * Build the four memory tools.
 * @param {MemoryStore} store
 * @param {{ cwdOf?: (exec: object) => string | undefined, tracker?: ReturnType<import("./store.js").createChangeTracker> }} [options]
 *   `cwdOf` defaults to the calling session's working directory.
 * @returns {object[]} tool definitions for `ctx.tools.register`.
 */
export function memoryTools(store, { cwdOf = (exec) => exec?.agent?.session?.header?.cwd, tracker } = {}) {
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
			parameters: { scope: SCOPE },
			output: TEXT_OUTPUT,
			isConcurrencySafe: () => true,
			execute: (args, exec) => run(async () => {
				const entries = await store.list(args.scope, cwdOf(exec));
				if (entries.length === 0) return `No notes in the ${args.scope} partition.`;
				return entries.map((entry) => `${entry.path} (${entry.bytes} bytes, version: ${entry.version})`).join("\n");
			})
		}),
		defineTool({
			name: "memory_read",
			description: "Read one memory note. Returns its content and the version to pass to memory_write or memory_delete.",
			parameters: { scope: SCOPE, path: PATH },
			output: TEXT_OUTPUT,
			isConcurrencySafe: () => true,
			execute: (args, exec) => run(async () => {
				const note = await store.read(args.scope, cwdOf(exec), args.path);
				if (note === null) throw new Error(`No note ${args.path} in the ${args.scope} partition.`);
				return `version: ${note.version}\n\n${note.content}`;
			})
		}),
		defineTool({
			name: "memory_write",
			description: "Create or replace a memory note. Pass the version from memory_read when replacing; omit it only when creating a new note.",
			parameters: {
				scope: SCOPE,
				path: PATH,
				content: { type: "string", required: true, description: "Full new content of the note (Markdown)." },
				version: { type: "string", description: "Version returned by memory_read; omit when creating a new note." }
			},
			output: TEXT_OUTPUT,
			execute: (args, exec) => run(async () => {
				const { version } = await store.write(args.scope, cwdOf(exec), args.path, args.content, args.version ?? null, tracker);
				return `Saved ${args.path} (${args.scope}). version: ${version}`;
			})
		}),
		defineTool({
			name: "memory_delete",
			description: "Delete a memory note. Pass the version from memory_read.",
			parameters: { scope: SCOPE, path: PATH, version: { type: "string", required: true, description: "Version returned by memory_read." } },
			output: TEXT_OUTPUT,
			execute: (args, exec) => run(async () => {
				await store.remove(args.scope, cwdOf(exec), args.path, args.version, tracker);
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
 * @param config - live config references (`enabled`).
 */
export function installMemoryTools(ctx, store, config) {
	let disposers = [];
	const sync = () => {
		const want = config.enabled.get();
		if (want && disposers.length === 0) disposers = memoryTools(store).map((tool) => ctx.tools.register(tool));
		else if (!want && disposers.length > 0) {
			for (const dispose of disposers) dispose();
			disposers = [];
		}
	};
	sync();
	ctx.on("loader/volatile-update", sync);
}
