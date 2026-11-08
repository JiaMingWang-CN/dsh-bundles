/**
 * Model-facing prompt text. Kept in English like DSH's own tool and prompt
 * text; user-facing copy lives in the client half.
 *
 * Per the design (§5.2) the session guidance states what memory is FOR and
 * adds two light process steps (check the index first, verify before relying
 * on a note). It deliberately prescribes no "only record X" rules: the
 * source article found such rules reduce the benefit on strong models.
 */

/** Guidance prepended to the injected INDEX snapshot in every session. */
export const SESSION_GUIDANCE = `# Memory

You have a persistent memory that survives across sessions, in two partitions:
- scope "project": lessons that hold in this project (the current working directory);
- scope "user": the user's preferences and lessons that hold across projects.

Use it to keep what the environment cannot give you back: lessons from mistakes, approaches that worked, verified rules, pitfalls, plans in progress. For each note record why it holds and how it was verified. Do not store what you can re-read at any time (code, file contents, git history, command output).

Before you start a task, check the indexes below and read the notes that look relevant (memory_read). Memory can be wrong or stale: verify a note against the current state before relying on it, and fix or delete it when it turns out wrong.

Each partition has an INDEX.md that lists its notes, one line per note: a link plus a one-sentence summary. When you add or remove a note, update that partition's INDEX.md too. Keep INDEX.md short; put details in the note files.

Writes use optimistic versions: memory_read returns a version; pass it to memory_write or memory_delete. Omit the version only to create a new note. If a write reports that the note changed, read it again and rewrite based on the new content.

Index snapshots below were taken when this session started; changes made during the session appear in the next session.`;

/**
 * Prompt for one dreaming run. Filled in by Task 6.
 * @param {object} _job - the batch being consolidated.
 * @returns {string}
 */
export function dreamPrompt(_job) {
	return "";
}
