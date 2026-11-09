import test from "node:test";
import assert from "node:assert/strict";
import { dreamPrompt, crossDreamPrompt, SESSION_GUIDANCE } from "../lib/prompt.js";

const prompt = dreamPrompt({ cwd: "C:\\Programs\\demo", sessionIds: ["s1"], indexMaxBytes: 4096 });

test("dream prompt treats what the user stated as evidence, not as unverified", () => {
	assert.match(prompt, /stated by the user .* counts as evidence/i);
	assert.match(prompt, /user-stated/);
	assert.match(prompt, /do not downgrade or delete/i);
});

test("dream prompt still flags agent claims without support and lets later transcripts win", () => {
	assert.match(prompt, /made by the agent without a tool result or a user statement/i);
	assert.match(prompt, /later transcript contradicts/i);
});

test("partition rules: project is the default; user notes only for what the user stated; general lessons wait as candidates", () => {
	assert.match(prompt, /project partition is the default/i);
	assert.match(prompt, /basis "user-stated"/);
	assert.match(prompt, /candidate: user/);
	assert.match(prompt, /never user-level/);
	assert.match(SESSION_GUIDANCE, /scope "project" \(the default\)/);
	assert.match(SESSION_GUIDANCE, /basis "user-stated"/);
	assert.match(SESSION_GUIDANCE, /candidate: user/);
});

test("dream prompt asks for one topic per note, no value judgments, final states and full session ids", () => {
	assert.match(prompt, /One topic per note/);
	assert.match(prompt, /not value judgments/);
	assert.match(prompt, /final state/);
	assert.match(prompt, /configuration values/);
	assert.match(prompt, /full id \(session-<uuid>\)/);
	assert.match(prompt, /dream_report/);
	assert.match(prompt, /at most 40 steps/);
});

test("dream prompt opens with a readable title line", () => {
	assert.match(prompt, /^Memory consolidation · demo\n/);
});

test("cross-project prompt demotes single-project user notes and promotes lessons two projects confirm", () => {
	const cross = crossDreamPrompt({ projects: [{ cwd: "C:\\a", notes: 1 }, { cwd: "C:\\b", notes: 2 }], indexMaxBytes: 4096 });
	assert.match(cross, /^Memory consolidation · all projects/);
	assert.ok(cross.includes("- C:\\a · 1 note\n- C:\\b · 2 notes"));
	assert.match(cross, /Demote:.*confirmed only in one project/s);
	assert.match(cross, /Promote:.*two or more projects/s);
	assert.match(cross, /at least two projects/);
	assert.match(cross, /redo your change on the new content/);
});

test("dream prompt skips tool-schema facts and one-off events, and cites evidence once per note", () => {
	assert.match(prompt, /tool definitions already state/i);
	assert.match(prompt, /one-off events/i);
	assert.match(prompt, /once per note/i);
});

test("dream prompt for a deleted project directory writes only the user partition", () => {
	const gone = dreamPrompt({ cwd: "C:\gone", sessionIds: ["s1"], indexMaxBytes: 4096, projectGone: true });
	assert.match(gone, /no longer exists/);
	assert.match(gone, /do not write to the project partition/i);
	assert.doesNotMatch(prompt, /no longer exists/);
});


test("dream prompt redoes a conflicting write on the new content instead of skipping it", () => {
	assert.match(prompt, /conflict.*read it again and redo your change on the new content/is);
	assert.doesNotMatch(prompt, /skip that note/i);
});
