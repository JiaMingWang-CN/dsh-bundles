import test from "node:test";
import assert from "node:assert/strict";
import { plainErrors } from "../lib/errors.js";
import { buildModelRequest, mapModelResponse, searchModel } from "../lib/engines/model-native.js";

/** Build transport deps around a canned fetch. */
function deps(fetch) {
	return { fetch, errors: plainErrors };
}

/** Build a minimal Response stand-in. */
function response(status, payload) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => payload
	};
}

test("buildModelRequest forces one keyword of server-side web search", () => {
	const body = buildModelRequest({ modelId: "mimo-v2.6-flash" }, "query", 6);
	assert.equal(body.model, "mimo-v2.6-flash");
	assert.deepEqual(body.messages, [{ role: "user", content: "query" }]);
	assert.equal(body.stream, false);
	assert.deepEqual(body.thinking, { type: "disabled" });
	assert.deepEqual(body.tools, [{ type: "web_search", max_keyword: 1, force_search: true, limit: 6 }]);
	assert.equal(buildModelRequest({ modelId: "m" }, "q", undefined).tools[0].limit, undefined);
});

test("mapModelResponse reads url_citation annotations", () => {
	const result = mapModelResponse({
		choices: [{
			message: {
				content: "summary",
				annotations: [
					{ type: "url_citation", url_citation: { url: "https://a.test", title: "A" } },
					{ url: "https://b.test", title: "B", cited_text: "quote" }
				]
			}
		}]
	}, plainErrors);
	assert.equal(result.content, "summary");
	assert.deepEqual(result.sources, [
		{ url: "https://a.test", title: "A" },
		{ url: "https://b.test", title: "B", snippet: "quote" }
	]);
});

test("mapModelResponse reads structured search_results arrays and dedupes", () => {
	const result = mapModelResponse({
		choices: [{ message: { content: "" } }],
		search_results: [
			{ url: "https://a.test", title: "A", content: "s1", date: "2026-02-03" },
			{ link: "https://b.test", name: "B", description: "s2" },
			{ url: "https://a.test", title: "dupe" }
		]
	}, plainErrors);
	assert.deepEqual(result.sources, [
		{ url: "https://a.test", title: "A", snippet: "s1", publishedAt: "2026-02-03" },
		{ url: "https://b.test", title: "B", snippet: "s2" }
	]);
	assert.equal(result.content, undefined);
});

test("mapModelResponse rejects payloads without structured citations", () => {
	assert.throws(() => mapModelResponse(null, plainErrors), { code: "WEB_PROVIDER_ERROR" });
	assert.throws(
		() => mapModelResponse({ choices: [{ message: { content: "prose with https://only.text" } }] }, plainErrors),
		{ code: "WEB_PROVIDER_ERROR" }
	);
});

test("searchModel posts to chat/completions with both auth headers", async () => {
	const calls = [];
	const fetch = async (url, init) => {
		calls.push({ url, init });
		return response(200, { choices: [{ message: { content: "c", annotations: [{ url_citation: { url: "https://a.test" } }] } }] });
	};
	const result = await searchModel(
		{ apiKey: "k", baseURL: "https://api.xiaomimimo.com/v1", modelId: "mimo-v2.6-flash" },
		{ query: "q", maxResults: 2 },
		undefined,
		deps(fetch)
	);
	assert.equal(result.sources[0].url, "https://a.test");
	assert.equal(calls[0].url, "https://api.xiaomimimo.com/v1/chat/completions");
	assert.equal(calls[0].init.headers.authorization, "Bearer k");
	assert.equal(calls[0].init.headers["api-key"], "k");
	assert.equal(JSON.parse(calls[0].init.body).tools[0].force_search, true);
});

test("searchModel maps status failures and missing keys", async () => {
	await assert.rejects(
		searchModel({ baseURL: "https://x.test/v1", modelId: "m" }, { query: "q" }, undefined, deps(async () => {
			throw new Error("must not dispatch");
		})),
		{ code: "WEB_PROVIDER_CREDENTIAL_MISSING" }
	);
	await assert.rejects(
		searchModel({ apiKey: "k", baseURL: "https://x.test/v1", modelId: "m" }, { query: "q" }, undefined, deps(async () => response(403, { error: { message: "plugin off" } }))),
		(error) => error.code === "WEB_PROVIDER_CREDENTIAL_MISSING" && /plugin off/.test(error.message)
	);
	await assert.rejects(
		searchModel({ apiKey: "k", baseURL: "https://x.test/v1", modelId: "m" }, { query: "q" }, undefined, deps(async () => response(500, {}))),
		{ code: "WEB_PROVIDER_ERROR" }
	);
	const controller = new AbortController();
	controller.abort("caller");
	await assert.rejects(
		searchModel({ apiKey: "k", baseURL: "https://x.test/v1", modelId: "m" }, { query: "q" }, controller.signal, deps(async () => {
			throw new Error("must not dispatch");
		})),
		{ code: "WEB_ABORTED" }
	);
});
