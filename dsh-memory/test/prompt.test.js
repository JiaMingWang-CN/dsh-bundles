import test from "node:test";
import assert from "node:assert/strict";
import { dreamPrompt, SESSION_GUIDANCE } from "../lib/prompt.js";

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

test("dream prompt routes lessons that hold beyond this project to the user partition", () => {
	assert.match(prompt, /would hold in any other project.*user/is);
	assert.match(SESSION_GUIDANCE, /would hold in any other project/i);
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

