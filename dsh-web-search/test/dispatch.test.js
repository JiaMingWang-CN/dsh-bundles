import test from "node:test";
import assert from "node:assert/strict";
import { plainErrors } from "../lib/errors.js";
import { DispatchProvider, WEB_SEARCH_PROVIDER_ID } from "../lib/dispatch.js";
import { normalizeSection } from "../lib/options.js";

/** Build deps whose fetch records calls instead of dispatching. */
function deps() {
	return { fetch: async () => { throw new Error("unused"); }, errors: plainErrors };
}

test("DispatchProvider ids itself and dispatches to the selected engine", async () => {
	const calls = [];
	const engines = {
		tavily: async (options, request) => { calls.push(["tavily", options, request]); return { sources: [], truncated: false }; },
		model: async (options, request) => { calls.push(["model", options, request]); return { sources: [], truncated: false }; },
		deepseek: async () => { calls.push(["deepseek"]); return { sources: [], truncated: false }; }
	};
	let section = { engine: "tavily", tavilyApiKey: "k" };
	const provider = new DispatchProvider(() => normalizeSection(section), engines, deps());
	assert.equal(provider.id, WEB_SEARCH_PROVIDER_ID);
	assert.equal(provider.available(), true);
	await provider.search({ query: "q1", maxResults: 8 });
	assert.equal(calls[0][0], "tavily");
	assert.deepEqual(calls[0][2], { query: "q1", maxResults: 8 });
	section = { engine: "model", modelApiKey: "k" };
	await provider.search({ query: "q2" });
	assert.equal(calls[1][0], "model");
});

test("DispatchProvider snapshots options once per search entry", async () => {
	let section = { engine: "tavily", tavilyApiKey: "k" };
	let seenDuringFlight;
	const engines = {
		tavily: async (options) => {
			section = { engine: "model", modelApiKey: "k" };
			seenDuringFlight = options;
			return { sources: [], truncated: false };
		}
	};
	const provider = new DispatchProvider(() => normalizeSection(section), engines, deps());
	await provider.search({ query: "q" });
	assert.equal(seenDuringFlight.apiKey, "k");
});

test("DispatchProvider reports availability of the selected engine only", () => {
	const engines = { tavily: async () => ({ sources: [], truncated: false }) };
	const unavailable = new DispatchProvider(() => normalizeSection({}), engines, deps());
	assert.equal(unavailable.available(), false);
	const deepseekSelected = new DispatchProvider(() => normalizeSection({ engine: "deepseek" }), engines, deps());
	assert.equal(deepseekSelected.available(), false);
});

test("DispatchProvider rejects unknown engines with a coded error", async () => {
	const options = { ...normalizeSection({ engine: "tavily", tavilyApiKey: "k" }), engine: "bing" };
	const provider = new DispatchProvider(() => options, {}, deps());
	await assert.rejects(provider.search({ query: "q" }), (error) => error.code === "WEB_PROVIDER_ERROR" && /unknown web search engine/.test(error.message));
});
