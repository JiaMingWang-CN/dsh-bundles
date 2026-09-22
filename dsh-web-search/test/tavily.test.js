import test from "node:test";
import assert from "node:assert/strict";
import { plainErrors } from "../lib/errors.js";
import { mapTavilyResponse, searchTavily, TAVILY_ENDPOINT } from "../lib/engines/tavily.js";

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

test("mapTavilyResponse maps answer, results, and optional metadata", () => {
	const result = mapTavilyResponse({
		answer: "summary",
		results: [
			{ url: "https://a.test", title: "A", content: "snippet", published_date: "2026-01-02" },
			{ url: "https://b.test", title: "B" },
			{ title: "no url, dropped" }
		]
	}, plainErrors);
	assert.equal(result.content, "summary");
	assert.equal(result.truncated, false);
	assert.deepEqual(result.sources, [
		{ url: "https://a.test", title: "A", snippet: "snippet", publishedAt: "2026-01-02" },
		{ url: "https://b.test", title: "B" }
	]);
});

test("mapTavilyResponse tolerates empty results but rejects unrecognizable payloads", () => {
	const empty = mapTavilyResponse({ results: [] }, plainErrors);
	assert.deepEqual(empty.sources, []);
	assert.equal(empty.content, undefined);
	assert.throws(() => mapTavilyResponse(null, plainErrors), { code: "WEB_PROVIDER_ERROR" });
	assert.throws(() => mapTavilyResponse("text", plainErrors), { code: "WEB_PROVIDER_ERROR" });
	assert.throws(() => mapTavilyResponse({ unexpected: 1 }, plainErrors), { code: "WEB_PROVIDER_ERROR" });
});

test("searchTavily posts the documented body and forwards the signal", async () => {
	const calls = [];
	const fetch = async (url, init) => {
		calls.push({ url, init });
		return response(200, { answer: "ok", results: [{ url: "https://a.test" }] });
	};
	const result = await searchTavily(
		{ apiKey: "k", searchDepth: "advanced" },
		{ query: "hello", maxResults: 4 },
		undefined,
		deps(fetch)
	);
	assert.equal(result.content, "ok");
	assert.equal(calls[0].url, TAVILY_ENDPOINT);
	assert.equal(calls[0].init.method, "POST");
	assert.equal(calls[0].init.headers.authorization, "Bearer k");
	assert.deepEqual(JSON.parse(calls[0].init.body), {
		query: "hello",
		search_depth: "advanced",
		include_answer: true,
		max_results: 4
	});
	const signal = new AbortController().signal;
	await searchTavily({ resolveKey: async () => "k", searchDepth: "basic" }, { query: "q" }, signal, deps(async (_url, init) => {
		assert.equal(init.signal, signal);
		return response(200, { results: [] });
	}));
});

test("searchTavily fails with actionable codes", async () => {
	await assert.rejects(
		searchTavily({ searchDepth: "basic" }, { query: "q" }, undefined, deps(async () => {
			throw new Error("must not dispatch");
		})),
		{ code: "WEB_PROVIDER_CREDENTIAL_MISSING" }
	);
	await assert.rejects(
		searchTavily({ apiKey: "k", searchDepth: "basic" }, { query: "q" }, undefined, deps(async () => response(401, { detail: { error: "bad key" } }))),
		{ code: "WEB_PROVIDER_CREDENTIAL_MISSING" }
	);
	await assert.rejects(
		searchTavily({ apiKey: "k", searchDepth: "basic" }, { query: "q" }, undefined, deps(async () => response(432, { detail: { error: "plan limit" } }))),
		(error) => error.code === "WEB_PROVIDER_ERROR" && /1000 credits/.test(error.message)
	);
	await assert.rejects(
		searchTavily({ apiKey: "k", searchDepth: "basic" }, { query: "q" }, undefined, deps(async () => {
			throw new Error("ECONNRESET");
		})),
		(error) => error.code === "WEB_PROVIDER_ERROR" && /ECONNRESET/.test(error.message)
	);
});

test("searchTavily classifies aborts as WEB_ABORTED", async () => {
	const controller = new AbortController();
	controller.abort("caller");
	await assert.rejects(
		searchTavily({ apiKey: "k", searchDepth: "basic" }, { query: "q" }, controller.signal, deps(async () => {
			throw new Error("must not dispatch");
		})),
		{ code: "WEB_ABORTED" }
	);
	await assert.rejects(
		searchTavily({ apiKey: "k", searchDepth: "basic" }, { query: "q" }, undefined, deps(async () => {
			throw Object.assign(new Error("aborted"), { name: "AbortError" });
		})),
		{ code: "WEB_ABORTED" }
	);
});
