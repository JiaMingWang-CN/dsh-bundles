import test from "node:test";
import assert from "node:assert/strict";
import { resolveSelection } from "../lib/selection.js";

const config = (provider, model, effort) => ({
	dreamProvider: { get: () => provider },
	dreamModel: { get: () => model },
	dreamEffort: { get: () => effort }
});
const defaults = { currentSelection: () => ({ provider: "deepseek-official", model: "deepseek-pro", reasoningEffort: "high" }) };

test("a chosen model passes its reasoning effort when one is set", () => {
	assert.deepEqual(resolveSelection(config("mimo", "mimo-v2", "low"), defaults), { provider: "mimo", model: "mimo-v2", reasoningEffort: "low" });
});

test("an empty effort leaves the model's own default", () => {
	assert.deepEqual(resolveSelection(config("mimo", "mimo-v2", ""), defaults), { provider: "mimo", model: "mimo-v2" });
});

test("the default model follows DSH's default selection, effort included", () => {
	assert.deepEqual(resolveSelection(config("", "", "low"), defaults), { provider: "deepseek-official", model: "deepseek-pro", reasoningEffort: "high" });
	assert.equal(resolveSelection(config("", "", ""), undefined), undefined);
});
