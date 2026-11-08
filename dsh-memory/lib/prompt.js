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
 * Prompt for one dreaming run (design §5.3, tasks in priority order).
 * @param {{ cwd: string, sessionIds: string[], indexMaxBytes: number }} job
 * @returns {string}
 */
export function dreamPrompt({ cwd, sessionIds, indexMaxBytes }) {
	return `You are "dreaming": consolidating the long-term memory of a coding agent offline, after its sessions ended. No user is present; do not ask questions.

Project directory: ${cwd}
Sessions to review (newest work the memory has not seen yet): ${sessionIds.join(", ")}

Tools: memory_list / memory_read / memory_write / memory_delete for the "project" partition (this project) and the "user" partition (shared by all of the user's projects); transcript_read / transcript_search for session transcripts of this project. Transcripts record what actually happened and are the ground truth; notes are claims written in the moment and may be wrong or stale.

Do these, in priority order:
1. Correct: check existing notes against the transcripts. Fix or delete any note the transcripts contradict (wrong facts, wrong locations, rules that failed, plans marked done that were not).
2. Merge duplicate or overlapping notes into one.
3. Keep each partition's INDEX.md within ${indexMaxBytes} bytes: one line per note, a link plus a one-sentence summary. Move details into the note files.
4. Fix dangling links: every INDEX.md entry and every link between notes must point to an existing note; redirect, create or remove as appropriate.
5. Capture what the sessions taught but the memory missed: mistakes and how they were fixed, approaches that worked, verified rules, pitfalls. For each, record why it holds and the evidence (session id and seq).

Rules:
- Weigh evidence by its source. A fact stated by the user in a transcript counts as evidence: record it as user-stated with the session id and seq, and do not downgrade or delete it for lack of a tool check. Only a claim made by the agent without a tool result or a user statement behind it is unsupported: mark it unverified or remove it. When a later transcript contradicts a user-stated fact, the later transcript wins; correct the note and cite both.
- Record only what the environment cannot give back. Never store re-readable state such as code, file contents, git history or command output.
- User partition: change or delete a user-level note only when the transcripts show it does not hold in general. If it merely does not apply to this project, keep it and record the exception in the project partition.
- Writes use versions from memory_read. If a write reports a conflict, the note was changed by a live session: skip that note and move on.
- Prefer small, precise edits over rewriting everything. Do not create notes just to have notes.

When done, reply with a short summary of what you changed and why.`;
}
