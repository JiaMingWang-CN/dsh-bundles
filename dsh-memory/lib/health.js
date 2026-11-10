/**
 * Mechanical checks over a partition's notes, computed in code and put into
 * the dreaming prompt so the model spends its steps on judgment instead:
 * oversized or over-long INDEX.md, dangling links, notes the INDEX does not
 * list, notes over the soft size limit.
 */
import { posix } from "node:path";
import { INDEX_LINE_BYTES, NOTE_SOFT_BYTES } from "./tools.js";

const LIMIT_PER_PARTITION = 12;
const LINK = /\]\(([^)\s]+?\.md)(?:#[^)]*)?\)/gi;

/** Link targets of a note, resolved against the note's own directory; web and absolute links are skipped. */
function linkTargets(notePath, content) {
	const targets = [];
	for (const match of content.matchAll(LINK)) {
		const raw = match[1];
		if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("/")) continue;
		targets.push(posix.normalize(posix.join(posix.dirname(notePath), raw)));
	}
	return targets;
}

/**
 * @param {import("./store.js").MemoryStore} store
 * @param {"project" | "user"} scope
 * @param {string | undefined} cwd - project directory for the project scope.
 * @param {number} indexMaxBytes
 * @returns {Promise<string[]>} one line per problem found.
 */
export async function checkPartition(store, scope, cwd, indexMaxBytes) {
	const entries = await store.list(scope, cwd);
	const known = new Map(entries.map((entry) => [entry.path.toLowerCase(), entry.path]));
	const issues = [];
	const linkedFromIndex = new Set();
	for (const entry of entries) {
		const note = await store.read(scope, cwd, entry.path);
		if (note === null) continue;
		const isIndex = entry.path === "INDEX.md";
		if (isIndex) {
			if (entry.bytes > indexMaxBytes) issues.push(`INDEX.md is ${entry.bytes} bytes; the limit is ${indexMaxBytes}`);
			const long = note.content.split("\n").filter((line) => Buffer.byteLength(line) > INDEX_LINE_BYTES).length;
			if (long > 0) issues.push(`INDEX.md has ${long} line(s) over ${INDEX_LINE_BYTES} bytes`);
		} else if (entry.bytes > NOTE_SOFT_BYTES) issues.push(`${entry.path} is ${entry.bytes} bytes (soft limit ${NOTE_SOFT_BYTES}): split it or cut details`);
		for (const target of linkTargets(entry.path, note.content)) {
			const found = known.get(target.toLowerCase());
			if (found === undefined) issues.push(`${entry.path} links to ${target}, which does not exist`);
			else if (isIndex) linkedFromIndex.add(found);
		}
	}
	if (known.has("index.md")) {
		for (const entry of entries) {
			if (entry.path !== "INDEX.md" && !linkedFromIndex.has(entry.path)) issues.push(`${entry.path} is not listed in INDEX.md`);
		}
	} else if (entries.length > 0) issues.push("there is no INDEX.md although the partition has notes");
	return issues.length > LIMIT_PER_PARTITION ? [...issues.slice(0, LIMIT_PER_PARTITION), `…and ${issues.length - LIMIT_PER_PARTITION} more`] : issues;
}

/**
 * Render the checks of several partitions as prompt lines.
 * @param {Array<{ label: string, issues: string[] }>} partitions
 * @returns {string} empty when nothing is wrong.
 */
export function renderHealth(partitions) {
	return partitions.flatMap(({ label, issues }) => issues.map((issue) => `- ${label}: ${issue}`)).join("\n");
}
