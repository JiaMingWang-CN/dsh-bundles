import test from "node:test";
import assert from "node:assert/strict";
import { plainErrors } from "../lib/errors.js";
import { buildDeepseekRequest, mapDeepseekResponse, searchDeepseek, DEEPSEEK_MODEL, DEEPSEEK_API_VERSION } from "../lib/engines/deepseek.js";

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

test("buildDeepseekRequest forces one native web search round", () => {
	const { endpoint, body } = buildDeepseekRequest({ baseURL: "https://api.deepseek.com/anthropic/v1", maxUses: 5 }, "query");
	assert.equal(endpoint, "https://api.deepseek.com/anthropic/v1/messages");
	assert.equal(body.model, DEEPSEEK_MODEL);
	assert.deepEqual(body.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
	assert.equal(body.messages[0].content[0].text, "Perform a web search for the query: query");
});

test("mapDeepseekResponse joins result blocks with citation snippets", () => {
	const result = mapDeepseekResponse({
		content: [
			{
				type: "web_search_tool_result",
				content: [
					{ type: "web_search_result", url: "https://a.test", title: "A", page_age: "2026-01-01" },
					{ type: "web_search_result", url: "https://a.test", title: "dupe" },
					{ type: "web_search_result", url: "https://b.test", title: "B" }
				]
			},
			{ type: "text", text: "…", citations: [{ url: "https://a.test", cited_text: "excerpt" }] }
		]
	}, plainErrors);
	assert.deepEqual(result.sources, [
		{ url: "https://a.test", title: "A", snippet: "excerpt", publishedAt: "2026-01-01" },
		{ url: "https://b.test", title: "B" }
	]);
	assert.equal(result.truncated, false);
});

test("mapDeepseekResponse rejects responses without structured search blocks", () => {
	assert.throws(() => mapDeepseekResponse({ content: [{ type: "text", text: "prose https://a.test" }] }, plainErrors), { code: "WEB_PROVIDER_ERROR" });
	assert.throws(() => mapDeepseekResponse(null, plainErrors), { code: "WEB_PROVIDER_ERROR" });
});

test("searchDeepseek posts, records a secret-free request, and maps failures", async () => {
	const calls = [];
	const records = [];
	const result = await searchDeepseek(
		{ apiKey: "k", baseURL: "https://api.deepseek.com/anthropic/v1", maxUses: 2, recordRequest: (request) => records.push(request) },
		{ query: "q" },
		undefined,
		deps(async (url, init) => {
			calls.push({ url, init });
			return response(200, { content: [{ type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://a.test" }] }] });
		})
	);
	assert.equal(result.sources[0].url, "https://a.test");
	assert.equal(calls[0].url, "https://api.deepseek.com/anthropic/v1/messages");
	assert.equal(calls[0].init.headers["x-api-key"], "k");
	assert.equal(calls[0].init.headers["anthropic-version"], DEEPSEEK_API_VERSION);
	assert.deepEqual(records, [{
		endpoint: "https://api.deepseek.com/anthropic/v1/messages",
		apiVersion: DEEPSEEK_API_VERSION,
		body: calls[0].init.body === undefined ? undefined : JSON.parse(calls[0].init.body)
	}]);
	assert.equal(JSON.stringify(records).includes("\"k\""), false);
	await assert.rejects(
		searchDeepseek({ baseURL: "https://x.test", maxUses: 1 }, { query: "q" }, undefined, deps(async () => {
			throw new Error("must not dispatch");
		})),
		{ code: "WEB_PROVIDER_CREDENTIAL_MISSING" }
	);
	await assert.rejects(
		searchDeepseek({ resolveKey: async () => "k", baseURL: "https://x.test", maxUses: 1 }, { query: "q" }, undefined, deps(async () => response(402, { error: "Insufficient Balance" }))),
		(error) => error.code === "WEB_PROVIDER_ERROR" && /Insufficient Balance/.test(error.message) && /Endpoint/.test(error.message)
	);
	const controller = new AbortController();
	controller.abort("caller");
	await assert.rejects(
		searchDeepseek({ apiKey: "k", baseURL: "https://x.test", maxUses: 1 }, { query: "q" }, controller.signal, deps(async () => {
			throw new Error("must not dispatch");
		})),
		{ code: "WEB_ABORTED" }
	);
});

test("searchDeepseek cancels while credential resolution is pending", async () => {
	const controller = new AbortController();
	let started = false;
	const pending = searchDeepseek({
		resolveKey: async () => {
			started = true;
			return await new Promise(() => {});
		},
		baseURL: "https://x.test",
		maxUses: 1
	}, { query: "q" }, controller.signal, deps(async () => {
		throw new Error("must not dispatch");
	}));
	await Promise.resolve();
	assert.equal(started, true);
	controller.abort("caller");
	await assert.rejects(pending, { code: "WEB_ABORTED" });
});
