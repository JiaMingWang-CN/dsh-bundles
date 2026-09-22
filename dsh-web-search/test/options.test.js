import test from "node:test";
import assert from "node:assert/strict";
import { WebError } from "@deepseek-ai/dsh-web";
import { plainErrors } from "../lib/errors.js";
import { normalizeSection, engineAvailable, ENGINES, DEFAULTS } from "../lib/options.js";

test("normalizeSection applies defaults for an empty section", () => {
	const options = normalizeSection({}, {});
	assert.equal(options.engine, DEFAULTS.engine);
	assert.equal(options.tavily.searchDepth, "basic");
	assert.equal(options.model.baseURL, DEFAULTS.modelBaseUrl);
	assert.equal(options.model.modelId, DEFAULTS.modelId);
	assert.equal(options.deepseek.baseURL, DEFAULTS.deepseekBaseUrl);
	assert.equal(options.deepseek.maxUses, 5);
});

test("normalizeSection keeps literals and validated overrides", () => {
	const options = normalizeSection({
		engine: "model",
		tavilyApiKey: "tvly-key",
		tavilySearchDepth: "advanced",
		modelBaseUrl: "https://example.test/v1",
		modelId: "mimo-x",
		deepseekBaseUrl: "https://ds.test/v1",
		deepseekMaxUses: 3
	}, {});
	assert.equal(options.engine, "model");
	assert.equal(options.tavily.apiKey, "tvly-key");
	assert.equal(options.tavily.searchDepth, "advanced");
	assert.equal(options.model.baseURL, "https://example.test/v1");
	assert.equal(options.model.modelId, "mimo-x");
	assert.equal(options.deepseek.baseURL, "https://ds.test/v1");
	assert.equal(options.deepseek.maxUses, 3);
});

test("normalizeSection rejects unknown engines and out-of-range values", () => {
	const options = normalizeSection({ engine: "bing", deepseekMaxUses: 0, modelBaseUrl: "", modelId: "" }, {});
	assert.equal(options.engine, "tavily");
	assert.equal(options.deepseek.maxUses, DEFAULTS.deepseekMaxUses);
	assert.equal(options.model.baseURL, DEFAULTS.modelBaseUrl);
	assert.equal(options.model.modelId, DEFAULTS.modelId);
});

test("engineAvailable requires a key source and valid endpoints", () => {
	const resolver = async () => "key";
	const withKeys = normalizeSection({}, { tavily: resolver, model: resolver, deepseek: resolver });
	for (const engine of ENGINES) assert.equal(engineAvailable(engine, withKeys), true, engine);
	const withLiterals = normalizeSection({ tavilyApiKey: "k", modelApiKey: "k", deepseekApiKey: "k" }, {});
	for (const engine of ENGINES) assert.equal(engineAvailable(engine, withLiterals), true, engine);
	const bare = normalizeSection({}, {});
	for (const engine of ENGINES) assert.equal(engineAvailable(engine, bare), false, engine);
	assert.equal(engineAvailable("unknown", withKeys), false);
	const badModel = normalizeSection({ modelApiKey: "k", modelBaseUrl: "not a url" }, {});
	assert.equal(engineAvailable("model", badModel), false);
});

test("normalizeSection carries credential resolvers per engine", async () => {
	const options = normalizeSection({}, { tavily: async () => "t", model: async () => "m", deepseek: async () => "d" });
	assert.equal(typeof options.tavily.resolveKey, "function");
	assert.equal(typeof options.model.resolveKey, "function");
	assert.equal(typeof options.deepseek.resolveKey, "function");
	assert.equal(await options.tavily.resolveKey(), "t");
	assert.equal(await options.model.resolveKey(), "m");
	assert.equal(await options.deepseek.resolveKey(), "d");
});

test("web errors use the seam's real WebError type", () => {
	const cause = new Error("cause");
	const error = plainErrors.provider("boom", "WEB_PROVIDER_ERROR", cause);
	assert.ok(error instanceof WebError);
	assert.equal(error.name, "WebError");
	assert.equal(error.code, "WEB_PROVIDER_ERROR");
	assert.equal(error.cause, cause);
	assert.equal(plainErrors.aborted("reason").code, "WEB_ABORTED");
	assert.equal(plainErrors.provider("m").code, "WEB_PROVIDER_ERROR");
});
