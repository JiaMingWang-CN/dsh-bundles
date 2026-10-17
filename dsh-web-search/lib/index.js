/**
 * dsh-web-search — host half.
 *
 * Registers ONE switchable third-party search provider (`web-search`) into the
 * `ctx.web` seam and the durable `web-search` settings form behind it. Engines
 * are Tavily (free tier) and model-native web search (MiMo); DSH's own
 * DeepSeek search stays in charge whenever the plugin's master switch is off.
 *
 * The bundle patch layer makes the provider the default; the client switch
 * either clears that user-layer override (on) or writes a built-in DeepSeek
 * provider group back (off), so the plugin id never has to persist in user
 * settings. See `patch.yml` and `lib/client.js`.
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
	model: "MIMO1_API_KEY"
};

/**
 * Durable settings schema: engine selection, per-engine options, and the
 * remembered built-in group the client restores when the master switch is
 * turned off. Every field is volatile: the settings form only edits volatile
 * fields, and each read goes through the live reference, so a saved switch
 * reaches the running provider without a remount.
 *
 * `deepseek` stays in the engine union as a deprecated value: dropping it would
 * make a saved `engine: deepseek` fail schema validation and prevent the plugin
 * from loading, leaving no UI to turn the switch off. Normalization maps it to
 * Tavily.
 */
const Config = z.object({
	engine: z.union(["tavily", "model", "deepseek"]).default(DEFAULTS.engine).volatile(),
	tavilyApiKey: z.string().role("secret").volatile(),
	tavilyApiKeyEnv: z.string().role("credential-ref").default(DEFAULT_KEY_REFS.tavily).volatile(),
	tavilySearchDepth: z.union(["basic", "advanced"]).default(DEFAULTS.tavilySearchDepth).volatile(),
	modelApiKey: z.string().role("secret").volatile(),
	modelApiKeyEnv: z.string().role("credential-ref").default(DEFAULT_KEY_REFS.model).volatile(),
	modelBaseUrl: z.string().default(DEFAULTS.modelBaseUrl).volatile(),
	modelId: z.string().default(DEFAULTS.modelId).volatile(),
	builtin: z.union(["messages", "api"]).default("messages").volatile()
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
 * Mount the switchable search provider and its settings form.
 * @param {object} ctx - Host plugin context.
 * @param {object} config - the resolved composition entry; volatile fields are
 * live references, so `current()` snapshots the section per operation.
 */
function apply(ctx, config) {
	/* Volatile Config fields arrive as readonly references (`Ref.get()`); the
	 * loader commits a settings write into them without remounting this plugin,
	 * which is what keeps the engine switch restart-free. */
	const current = () => Object.fromEntries(Object.keys(Config.dict).map((field) => [field, config[field].get()]));
	const resolveKeys = {
		tavily: makeKeyResolver(ctx, () => config.tavilyApiKeyEnv.get() ?? DEFAULT_KEY_REFS.tavily),
		model: makeKeyResolver(ctx, () => config.modelApiKeyEnv.get() ?? DEFAULT_KEY_REFS.model)
	};
	const options = () => normalizeSection(current(), resolveKeys);
	/* The bundle renders its own configuration page (plugins.row.config), so the
	 * automatically generated config page for this entry is suppressed. */
	ctx.inject(["settings"], (child) => {
		child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
	});
	const engines = {
		tavily: searchTavily,
		model: searchModel
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
