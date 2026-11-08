/**
 * Which model and reasoning effort a dreaming run uses.
 * A chosen provider/model may carry a chosen effort (empty = the model's own
 * default); the default model follows DSH's default selection as a whole.
 * @param config - live config references (`dreamProvider`, `dreamModel`, `dreamEffort`).
 * @param [agentDefaultModel] - `ctx.agentDefaultModel`, when mounted.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined}
 */
export function resolveSelection(config, agentDefaultModel) {
	const provider = config.dreamProvider.get();
	const model = config.dreamModel.get();
	if (provider === "" || model === "") return agentDefaultModel?.currentSelection();
	const effort = config.dreamEffort.get();
	return effort === "" ? { provider, model } : { provider, model, reasoningEffort: effort };
}
