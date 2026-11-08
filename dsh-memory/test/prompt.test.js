import test from "node:test";
import assert from "node:assert/strict";
import { dreamPrompt } from "../lib/prompt.js";

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
