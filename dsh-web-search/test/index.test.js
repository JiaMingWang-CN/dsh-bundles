import test from "node:test";
import assert from "node:assert/strict";
import { createLaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";
import { apply } from "../lib/index.js";

function response(payload) {
	return { ok: true, status: 200, json: async () => payload };
}

function host(config, environment, agent) {
	let provider;
	const ctx = {
		web: {
			registerSearchProvider(value) {
				provider = value;
			}
		},
		inject() {},
		get(name) {
			if (name === "launchEnvironment") return environment;
			if (name === "agents" && agent !== undefined) return { currentInitiator: () => agent };
			return undefined;
		}
	};
	apply(ctx, config);
	return () => provider;
}

test("host resolves credentials from the launch-environment seam", async () => {
	const environment = createLaunchEnvironmentSnapshot([{
		source: "project-env",
		values: { TAVILY_API_KEY: "launch-key" }
	}]);
	const provider = host({ engine: "tavily" }, environment)();
	const originalFetch = globalThis.fetch;
	let authorization;
	globalThis.fetch = async (_url, init) => {
		authorization = init.headers.authorization;
		return response({ results: [] });
	};
	try {
		await provider.search({ query: "q" });
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.equal(authorization, "Bearer launch-key");
});

test("host appends the official DeepSeek request audit event", async () => {
	const environment = createLaunchEnvironmentSnapshot([{
		source: "user-env",
		values: { DEEPSEEK_API_KEY: "deepseek-key" }
	}]);
	const events = [];
	const agent = { session: { append: (type, payload) => events.push({ type, payload }) } };
	const provider = host({ engine: "deepseek" }, environment, agent)();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => response({
		content: [{ type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://a.test" }] }]
	});
	try {
		await provider.search({ query: "q" });
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.equal(events.length, 1);
	assert.equal(events[0].type, "web/deepseek-search-llm-request");
	assert.equal(events[0].payload.endpoint, "https://api.deepseek.com/anthropic/v1/messages");
	assert.equal(JSON.stringify(events[0]).includes("deepseek-key"), false);
});
