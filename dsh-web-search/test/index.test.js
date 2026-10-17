import test from "node:test";
import assert from "node:assert/strict";
import { createLaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";
import { apply, Config } from "../lib/index.js";

function response(payload) {
	return { ok: true, status: 200, json: async () => payload };
}

/** Every Config field of the host plugin is volatile: a readonly `Ref.get()`. */
const CONFIG_FIELDS = [
	"engine", "tavilyApiKey", "tavilyApiKeyEnv", "tavilySearchDepth",
	"modelApiKey", "modelApiKeyEnv", "modelBaseUrl", "modelId", "builtin"
];

/** Wrap a plain section the way the loader hands volatile fields to `apply`. */
function volatileConfig(section) {
	return Object.fromEntries(CONFIG_FIELDS.map((field) => [field, { get: () => section[field] }]));
}

function host(config, environment) {
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
			return undefined;
		}
	};
	apply(ctx, volatileConfig(config));
	return () => provider;
}

test("Config keeps the deprecated deepseek engine loadable and defaults builtin", () => {
	const config = Config({ engine: "deepseek", builtin: "api" });
	assert.equal(config.engine.get(), "deepseek");
	assert.equal(config.builtin.get(), "api");
	const defaults = Config({});
	assert.equal(defaults.engine.get(), "tavily");
	assert.equal(defaults.builtin.get(), "messages");
});

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

test("host maps the deprecated deepseek engine to Tavily at dispatch", async () => {
	const environment = createLaunchEnvironmentSnapshot([{
		source: "project-env",
		values: { TAVILY_API_KEY: "launch-key" }
	}]);
	const provider = host({ engine: "deepseek" }, environment)();
	const originalFetch = globalThis.fetch;
	let called;
	globalThis.fetch = async (url) => {
		called = String(url);
		return response({ results: [] });
	};
	try {
		await provider.search({ query: "q" });
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.equal(called, "https://api.tavily.com/search");
});
