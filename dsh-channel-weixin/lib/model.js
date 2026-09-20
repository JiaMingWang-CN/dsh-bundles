/**
 * Per-session model selection.
 *
 * The harness has two halves to a model switch, and both are needed for the
 * change to be real rather than cosmetic:
 *
 * - the durable intent — a `model/selection` session event, which is what a
 *   restart replays and what the `modelSelection` projection exposes;
 * - the live override — a listener on the agent's own `agent/request` waterfall,
 *   which is how the running loop actually picks up the new route.
 *
 * `@deepseek-ai/dsh-agent` exports a helper that installs exactly that listener,
 * but a third-party bundle resolves no harness dependency, so the same mechanism
 * is implemented here against the public `agent.ctx.on` API. The switch applies
 * to this session only: the deployment default and every other session are left
 * untouched, and a running turn is never interrupted (the override is read at
 * request-assembly time, so it takes effect from the next task).
 */

/** Separator accepted between provider and model in `/model`. */
const PROVIDER_SEPARATOR = '/';

/** Reason code used when no provider serves the requested model. */
const UNAVAILABLE = 'model-unavailable';

/** Reason code used when the session's agent is not live. */
const NOT_LIVE = 'session-not-live';

/**
 * Every configured model, grouped by provider.
 *
 * A provider that fails to enumerate its models is reported as an isolated
 * failure instead of failing the whole listing: one broken route must not hide
 * the models the user can actually pick.
 * @param options - the `llm` service and an optional default-model service.
 * @returns `{ providers, failures, default }`.
 */
async function listModels({ llm, agentDefaultModel }) {
	const providers = [];
	const failures = [];
	let routes = [];
	if (llm !== undefined && typeof llm.listProviders === 'function') {
		try {
			routes = llm.listProviders();
		} catch (error) {
			return { providers: [], failures: [{ provider: '*', reason: String(error?.message ?? error) }], default: defaultSelection(agentDefaultModel) };
		}
	}
	for (const route of Array.isArray(routes) ? routes : []) {
		const id = typeof route?.id === 'string' ? route.id : '';
		if (id === '') continue;
		try {
			const models = typeof llm.listModels === 'function' ? await llm.listModels(id) : [];
			providers.push({
				id,
				name: typeof route.name === 'string' && route.name !== '' ? route.name : id,
				models: (Array.isArray(models) ? models : []).map((model) => (typeof model?.id === 'string' ? model.id : String(model))).filter((model) => model !== ''),
			});
		} catch (error) {
			failures.push({ provider: id, reason: String(error?.message ?? error) });
		}
	}
	return { providers, failures, default: defaultSelection(agentDefaultModel) };
}

/** The deployment's own default route, when that service is present. */
function defaultSelection(agentDefaultModel) {
	if (agentDefaultModel === undefined || typeof agentDefaultModel.currentSelection !== 'function') return undefined;
	try {
		const selection = agentDefaultModel.currentSelection();
		if (selection === undefined || typeof selection.provider !== 'string') return undefined;
		return { provider: selection.provider, model: selection.model };
	} catch {
		return undefined;
	}
}

/**
 * The session's current selection, preferring the pending intent over the last
 * used route (the same order the `modelSelection` projection publishes).
 * @param options - the projections registry and the session.
 * @returns `{ provider, model, reasoningEffort? }` or undefined.
 */
function currentSelection({ sessionProjections, session }) {
	if (sessionProjections === undefined || typeof sessionProjections.stateOf !== 'function' || session === undefined) return undefined;
	try {
		const state = sessionProjections.stateOf(session, 'modelSelection');
		if (state === undefined || state === null) return undefined;
		return state.pending ?? state.lastUsed ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve one user-typed model reference against the catalogue.
 * @param providers - the catalogue from {@link listModels}.
 * @param token - `model`, `provider/model`, or a provider name.
 * @returns `{ ok: true, selection }` or `{ ok: false, reason, candidates? }`.
 */
function resolveModelToken(providers, token) {
	const wanted = typeof token === 'string' ? token.trim() : '';
	if (wanted === '') return { ok: false, reason: 'model-missing' };
	const [head, ...tail] = wanted.split(PROVIDER_SEPARATOR);
	if (tail.length > 0) {
		const provider = head;
		const model = tail.join(PROVIDER_SEPARATOR);
		const route = providers.find((entry) => entry.id === provider);
		if (route === undefined) return { ok: false, reason: 'provider-unknown', candidates: providers.map((entry) => entry.id) };
		if (!route.models.includes(model)) return { ok: false, reason: UNAVAILABLE, candidates: route.models };
		return { ok: true, selection: { provider, model } };
	}
	const matches = [];
	for (const route of providers) {
		if (route.models.includes(wanted)) matches.push({ provider: route.id, model: wanted });
	}
	if (matches.length === 1) return { ok: true, selection: matches[0] };
	if (matches.length > 1) {
		return { ok: false, reason: 'ambiguous', candidates: matches.map((match) => `${match.provider}${PROVIDER_SEPARATOR}${match.model}`) };
	}
	return { ok: false, reason: UNAVAILABLE, candidates: providers.flatMap((route) => route.models.map((model) => `${route.id}${PROVIDER_SEPARATOR}${model}`)) };
}

/**
 * Install one live model override on an agent's scoped context.
 *
 * The listener resolves the request normally and then replaces the route, so it
 * composes with whatever other contributors exist; it is registered on the
 * agent's own scope, so disposing the plugin removes it with the fiber.
 *
 * An inherited reasoning effort is dropped unless this selection names one: the
 * effort belonged to the previous model and may not be legal for the new one, and
 * the harness's own selection behaves the same way. Keeping it would fail the
 * next request on a model that does not offer that effort.
 * @param agentCtx - the agent's scoped context.
 * @param selection - the selection to enforce.
 * @returns a disposer for the listener.
 */
function installModelOverride(agentCtx, selection) {
	let assembled;
	const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
		const rendered = await next();
		assembled = selection;
		return {
			...rendered,
			variables: {
				...rendered.variables,
				provider: selection.provider,
				model: selection.model,
			},
		};
	});
	const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
		const resolved = await next();
		const active = assembled ?? selection;
		const { reasoningEffort: _inherited, ...withoutInheritedEffort } = resolved;
		return {
			...withoutInheritedEffort,
			provider: active.provider,
			model: active.model,
			...(active.reasoningEffort === undefined ? {} : { reasoningEffort: active.reasoningEffort }),
		};
	});
	return () => {
		disposeAssembly();
		disposeRequest();
	};
}

/**
 * Switch one live session's model.
 *
 * Records the durable intent first, then installs the live override — so a
 * failure to record leaves the running route untouched rather than silently
 * diverging from what a restart would replay.
 * @param options - services, the live agent, and the validated selection.
 * @returns `{ ok: true, selection }` or `{ ok: false, reason, detail }`.
 */
function selectModel({ agent, selection }) {
	if (agent === undefined || agent.session === undefined) return { ok: false, reason: NOT_LIVE };
	try {
		agent.session.append('model/selection', selection);
	} catch (error) {
		return { ok: false, reason: 'record-failed', detail: String(error?.message ?? error) };
	}
	let dispose;
	try {
		dispose = installModelOverride(agent.ctx ?? agent.agentCtx ?? {}, selection);
	} catch (error) {
		return { ok: false, reason: 'override-failed', detail: String(error?.message ?? error) };
	}
	return { ok: true, selection, dispose };
}

export {
	NOT_LIVE, PROVIDER_SEPARATOR, UNAVAILABLE, currentSelection, defaultSelection,
	installModelOverride, listModels, resolveModelToken, selectModel,
};
