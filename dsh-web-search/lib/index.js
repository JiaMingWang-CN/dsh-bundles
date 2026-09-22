/**
 * dsh-web-search — host half.
 *
 * Registers ONE switchable search provider (`web-search`) into the `ctx.web`
 * seam and the durable `web-search` settings section behind it. The engine
 * (Tavily free tier / model-native web search / DeepSeek official) is re-read
 * from the live settings source at every search entry, so switching in
 * Settings > Plugins > Web search takes effect without a restart.
 *
 * Runtime imports explicitly include the public web and launch-environment
 * contracts as bundle-local dependencies, so a `link:` installation resolves
 * the same APIs without reaching through the Host's private dependency tree.
 * Errors are real `WebError`/`HarnessError` instances for routing on `code`.
 */
import z from "@deepseek-ai/schemastery";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { webErrors as errors } from "./errors.js";
import { DispatchProvider, WEB_SEARCH_PROVIDER_ID } from "./dispatch.js";
import { searchTavily } from "./engines/tavily.js";
import { searchModel } from "./engines/model-native.js";
import { searchDeepseek } from "./engines/deepseek.js";
import { normalizeSection, DEFAULTS } from "./options.js";

/** Stable Cordis plugin name; also the provider id and settings namespace. */
const name = "web-search";

/** The web seam this provider registers into. */
const inject = ["web"];

/** Settings namespace owned by this plugin (key of its settings card). */
const WEB_SEARCH_SETTINGS_NAMESPACE = "web-search";

/** Default credential references per engine (environment-variable names). */
const DEFAULT_KEY_REFS = {
	tavily: "TAVILY_API_KEY",
	model: "MIMO1_API_KEY",
	deepseek: "DEEPSEEK_API_KEY"
};

/** Durable settings schema: engine selection plus per-engine options. */
const Config = z.object({
	engine: z.union(["tavily", "model", "deepseek"]).default(DEFAULTS.engine),
	tavilyApiKey: z.string().role("secret"),
	tavilyApiKeyEnv: z.string().role("credential-ref").default(DEFAULT_KEY_REFS.tavily),
	tavilySearchDepth: z.union(["basic", "advanced"]).default(DEFAULTS.tavilySearchDepth),
	modelApiKey: z.string().role("secret"),
	modelApiKeyEnv: z.string().role("credential-ref").default(DEFAULT_KEY_REFS.model),
	modelBaseUrl: z.string().default(DEFAULTS.modelBaseUrl),
	modelId: z.string().default(DEFAULTS.modelId),
	deepseekApiKey: z.string().role("secret"),
	deepseekApiKeyEnv: z.string().role("credential-ref").default(DEFAULT_KEY_REFS.deepseek),
	deepseekBaseUrl: z.string().default(DEFAULTS.deepseekBaseUrl),
	deepseekMaxUses: z.number().step(1).min(1).default(DEFAULTS.deepseekMaxUses)
});

/**
 * Build one engine's credential resolver: the credentials service first (the
 * reference is the plain environment-variable name — `credentialRef` brands at
 * type level only), the launching environment second.
 * @param {object} ctx - plugin context supplying the credential plane.
 * @param {() => string} envName - the credential reference for the next operation.
 * @returns {() => Promise<string | undefined>} the resolver.
 */
function makeKeyResolver(ctx, envName) {
	return async () => {
		const ref = envName();
		const credentials = ctx.get("credentials");
		if (credentials !== undefined) return (await credentials.resolve(ref))?.value;
		const ambient = launchEnvironmentOf(ctx).get(ref);
		return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined;
	};
}

/**
 * Mount the switchable search provider and its settings section.
 * @param {object} ctx - Host plugin context.
 * @param {object} config - the resolved composition entry (the section's base layer).
 */
function apply(ctx, config) {
	let current = () => config;
	const resolveKeys = {
		tavily: makeKeyResolver(ctx, () => current().tavilyApiKeyEnv ?? DEFAULT_KEY_REFS.tavily),
		model: makeKeyResolver(ctx, () => current().modelApiKeyEnv ?? DEFAULT_KEY_REFS.model),
		deepseek: makeKeyResolver(ctx, () => current().deepseekApiKeyEnv ?? DEFAULT_KEY_REFS.deepseek)
	};
	const options = () => {
		const normalized = normalizeSection(current(), resolveKeys);
		normalized.deepseek.recordRequest = (request) => {
			ctx.get("agents")?.currentInitiator()?.session.append("web/deepseek-search-llm-request", request);
		};
		return normalized;
	};
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, WEB_SEARCH_SETTINGS_NAMESPACE, Config, config, {
			setSource: (source) => {
				current = source;
			},
			onChange: () => {}
		});
	});
	const engines = {
		tavily: searchTavily,
		model: searchModel,
		deepseek: searchDeepseek
	};
	ctx.web.registerSearchProvider(new DispatchProvider(options, engines, {
		fetch: (input, init) => globalThis.fetch(input, init),
		errors
	}));
}

export {
	apply,
	name,
	inject,
	Config,
	WEB_SEARCH_PROVIDER_ID,
	WEB_SEARCH_SETTINGS_NAMESPACE,
	DEFAULT_KEY_REFS
};
