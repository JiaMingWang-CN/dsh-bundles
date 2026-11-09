/**
 * Model-facing prompt text. Kept in English like DSH's own tool and prompt
 * text; user-facing copy lives in the client half.
 *
 * Per the design (§5.2) the session guidance states what memory is FOR and
 * adds two light process steps (check the index first, verify before relying
 * on a note). Where a rule must hold (which partition a note may enter, index
 * size), the tools enforce it and the prompt only explains it.
 */
import { basename } from "node:path";

const projectName = (cwd) => basename(cwd.replace(/[\\/]+$/, "")) || cwd;

/** Guidance prepended to the injected INDEX snapshot in every session. */
export const SESSION_GUIDANCE = `# Memory

You have a persistent memory that survives across sessions, in two partitions:
- scope "project" (the default): what you learn while working in this project (the current working directory), including lessons that look general, such as how a tool behaves or this machine's environment;
- scope "user": the user's own preferences and ways of working, as the user stated them. Creating a user note requires basis "user-stated". A lesson that looks general but was learned here goes to the project partition with a front-matter line "candidate: user"; it moves to the user partition once a second project confirms it. What the user is working on (a thesis, a dataset, devices, a model they deploy) is project content.

Use it to keep what the environment cannot give you back: lessons from mistakes, approaches that worked, verified rules, pitfalls, plans in progress. For each note record why it holds and how it was verified. Keep one topic per note, and record facts and lessons, not value judgments about what to accept or refuse. Do not store what you can re-read at any time (code, file contents, current configuration values, git history, command output).

Before you start a task, check the indexes below and read the notes that look relevant (memory_read). Memory can be wrong or stale: verify a note against the current state before relying on it, and fix or delete it when it turns out wrong.

Each partition has an INDEX.md that lists its notes, one line per note: a link plus a one-sentence summary. When you add or remove a note, update that partition's INDEX.md too. Keep INDEX.md short; put details in the note files.

Writes use optimistic versions: memory_read returns a version; pass it to memory_write or memory_delete. Omit the version only to create a new note. If a write reports that the note changed, read it again and rewrite based on the new content.

Index snapshots below were taken when this session started; changes made during the session appear in the next session.`;

const BUDGET = (maxSteps) => `Budget: at most ${maxSteps} steps (model calls); the run is stopped there and the rest waits for the next run. Read the transcripts first, then only the notes they bear on; do not reread every note.`;

const SHARED_RULES = `- Writes use versions from memory_read. If a write reports a conflict, the note was changed by a live session or by a dreaming run for another project: read it again and redo your change on the new content, never discard theirs.
- Prefer small, precise edits over rewriting everything. Do not create notes just to have notes.
- Never shorten a session id when citing it: write the full id (session-<uuid>) so the note can be checked later.
- If a check fails (a tool error, a transcript or note you cannot read), do not treat it as done: list it in dream_report.`;

/**
 * Prompt for one project's dreaming run (design §5.3, tasks in priority order).
 * @param {{ cwd: string, sessionIds: string[], indexMaxBytes: number, projectGone?: boolean, maxSteps?: number }} job
 * @returns {string}
 */
export function dreamPrompt({ cwd, sessionIds, indexMaxBytes, projectGone = false, maxSteps = 40 }) {
	const gone = projectGone
		? `
The project directory no longer exists, so no future session will load this project's notes. Do not write to the project partition; keep only preferences the user stated, in the user partition, and drop the rest.
`
		: "";
	return `Memory consolidation · ${projectName(cwd)}

You are consolidating the long-term memory of a coding agent offline ("dreaming"), after its sessions ended. No user is present; do not ask questions.

Project directory: ${cwd}
${gone}Sessions to review (newest work the memory has not seen yet): ${sessionIds.join(", ")}

Tools: memory_list / memory_read / memory_write / memory_delete for the "project" partition (this project) and the "user" partition (shared by all of the user's projects); transcript_read / transcript_search for session transcripts of this project; dream_report to finish. Transcripts record what actually happened and are the ground truth; notes are claims written in the moment and may be wrong or stale.

${BUDGET(maxSteps)}

Do these, in priority order:
1. Correct: check existing notes against the transcripts. Fix or delete any note the transcripts contradict (wrong facts, wrong locations, rules that failed, plans marked done that were not).
2. Merge duplicate or overlapping notes into one.
3. Keep each partition's INDEX.md within ${indexMaxBytes} bytes (larger writes are refused): one line per note, a link plus one short sentence. Move details into the note files.
4. Fix dangling links: every INDEX.md entry and every link between notes must point to an existing note; redirect, create or remove as appropriate.
5. Capture what the sessions taught but the memory missed: mistakes and how they were fixed, approaches that worked, verified rules, pitfalls. For each, record why it holds and the evidence (full session id and seq), cited once per note or per rule rather than after every sentence.

Rules:
- Weigh evidence by its source. A fact stated by the user in a transcript counts as evidence: record it as user-stated with the session id and seq, and do not downgrade or delete it for lack of a tool check. Only a claim made by the agent without a tool result or a user statement behind it is unsupported: mark it unverified or remove it. When a later transcript contradicts a user-stated fact, the later transcript wins; correct the note and cite both.
- Choose the partition: the project partition is the default, also for lessons that look general (how a tool or the host behaves, this machine's environment). Create a user note only for a preference or way of working the user explicitly stated (memory_write basis "user-stated"). Mark a project note that looks general with a front-matter line "candidate: user"; cross-project consolidation moves it to the user partition once a second project confirms it. What the user is working on (a thesis, a dataset, devices, a model they deploy) is project content, never user-level.
- One topic per note; split a note that mixes topics. Record facts and lessons, not value judgments or policies about what to accept or refuse.
- Before recording a fact, check whether later transcript lines changed it (transcript_search): record the final state, not an intermediate one. Never record current configuration values (ports, paths, versions) that can be reread.
- Record the lasting rule, not one-off events: "the workspace may have parallel sessions, check mtimes before blaming a failure" is a note; "this run also had 12 review fixes" is not. Skip constraints the tool definitions already state (required parameters, argument formats): the agent sees them on every call.
- Record only what the environment cannot give back. Never store re-readable state such as code, file contents, git history or command output.
- User partition: change or delete a user-level note only when the transcripts show it does not hold in general. If it merely does not apply to this project, keep it and record the exception in the project partition. A user note that is plainly about this project only belongs in the project partition: move it.
${SHARED_RULES}

Finish by calling dream_report once: a short summary of what you changed and why, and everything left unresolved.`;
}

/**
 * Prompt for a cross-project run: the only run that sees every partition,
 * so the only one that can tell a general lesson from a project's own.
 * @param {{ projects: Array<{ cwd: string, notes: number }>, indexMaxBytes: number, maxSteps?: number }} job
 * @returns {string}
 */
export function crossDreamPrompt({ projects, indexMaxBytes, maxSteps = 80 }) {
	const list = projects.map((project) => `- ${project.cwd} · ${project.notes} note${project.notes === 1 ? "" : "s"}`).join("\n");
	return `Memory consolidation · all projects

You are consolidating the long-term memory of a coding agent across all of the user's projects ("dreaming"). No user is present; do not ask questions.

The user partition is loaded into every session of every project; a project partition only into that project's sessions. Projects (directory · notes):
${list}

Tools: memory_list / memory_read / memory_write / memory_delete for the "user" partition and, with the project parameter, any project partition above; transcript_read to read a session a note cites (its first line names the session's project); dream_report to finish.

${BUDGET(maxSteps)} Start from the user INDEX.md and the project indexes.

Do these, in priority order:
1. Demote: a user note about one project's subject, or confirmed only in one project (every session it cites belongs to that project), moves to that project's partition: write it there, delete it from the user partition, update both INDEX.md files.
2. Promote: a lesson that two or more projects confirm (notes marked "candidate: user", or the same lesson in several project partitions) becomes one user note citing the evidence from each; remove the project copies, or keep only a project-specific exception.
3. Deduplicate across partitions: keep one copy, in the partition where it holds.
4. Split notes that mix topics; drop value judgments and current configuration values.
5. Keep every INDEX.md within ${indexMaxBytes} bytes (larger writes are refused), one short line per note, every link pointing to an existing note.

Rules:
- The user partition holds only preferences and ways of working the user stated, and lessons confirmed in at least two projects. What the user is working on in a project (a thesis, a dataset, devices, a model they deploy) is never user-level.
- Move notes as they are, keeping their evidence and citations; do not invent evidence.
${SHARED_RULES}

Finish by calling dream_report once: a short summary of what you moved and why, and everything left unresolved.`;
}
