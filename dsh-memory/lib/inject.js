/**
 * Per-session INDEX injection.
 *
 * DSH evaluates section text synchronously on every step, so each session's
 * text is built once, on its first assembly, and cached until the session is
 * disposed. Freezing the snapshot keeps the prompt prefix (and the KV cache)
 * stable for the whole session; changes appear in the next session.
 */
import { SESSION_GUIDANCE } from "./prompt.js";

/** Section name and position (before the deployment persona suffix at 10200). */
const SECTION_NAME = "memory:index";
const SECTION_ORDER = 9000;

/**
 * Cut text to at most `maxBytes` UTF-8 bytes at a whole line. When even the
 * first line overflows, cut that line at a character boundary instead.
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncateUtf8Lines(text, maxBytes) {
	if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
	const lines = text.split("\n");
	let kept = "";
	for (const line of lines) {
		const next = kept === "" ? line : `${kept}\n${line}`;
		if (Buffer.byteLength(next) > maxBytes) break;
		kept = next;
	}
	if (kept === "") {
		let bytes = 0;
		for (const ch of lines[0]) {
			const size = Buffer.byteLength(ch);
			if (bytes + size > maxBytes) break;
			kept += ch;
			bytes += size;
		}
	}
	return { text: kept, truncated: true };
}

function renderPartition(title, emptyText, index, maxBytes) {
	if (index === null || index.trim() === "") return `## ${title}\n\n${emptyText}`;
	const { text, truncated } = truncateUtf8Lines(index.trim(), maxBytes);
	const notice = truncated ? `\n\n[INDEX.md truncated at ${maxBytes} bytes; dreaming will compact it. Read the full file with memory_read if needed.]` : "";
	return `## ${title}\n\n${text}${notice}`;
}

/**
 * Render both partition indexes, each limited to `maxBytes` independently.
 * @returns {string}
 */
export function renderIndexSection(projectIndex, userIndex, maxBytes) {
	return [
		renderPartition('Project memory index (scope "project")', "No project memory index yet.", projectIndex, maxBytes),
		renderPartition('User memory index (scope "user")', "No user memory index yet.", userIndex, maxBytes)
	].join("\n\n");
}

/**
 * Register the `memory:index` section. Sessions without a working directory
 * (including the hidden dreaming agent) get nothing; so does every session
 * while the master switch is off.
 * @param ctx - host plugin context (`systemPrompt`, `on`).
 * @param {import("./store.js").MemoryStore} store
 * @param config - live config references (`enabled`, `indexMaxBytes`).
 */
export function installIndexInjection(ctx, store, config) {
	const snapshots = new Map();
	ctx.systemPrompt.section({
		name: SECTION_NAME,
		order: SECTION_ORDER,
		interpolate: false,
		text: (context) => {
			const header = context?.agent?.session?.header;
			if (header?.cwd === undefined || !config.enabled.get()) return "";
			let text = snapshots.get(header.id);
			if (text === undefined) {
				const maxBytes = config.indexMaxBytes.get();
				text = `${SESSION_GUIDANCE}\n\n${renderIndexSection(store.readIndexSync("project", header.cwd), store.readIndexSync("user"), maxBytes)}`;
				snapshots.set(header.id, text);
			}
			return text;
		}
	});
	ctx.on("session/disposed", (session) => {
		snapshots.delete(session.header.id);
	});
}
