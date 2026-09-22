/**
 * dsh-jev-enhancement — host half.
 *
 * Registers ONE settings section (`jev-enhancement`) plus four official DSH
 * extension points: `agent/pre-step` (Context Compaction, ahead of the native
 * compaction backend's pressure check), `agent/request-error` (fault
 * classification), `agent/request` (route selection) and `tools/pre-execute`
 * (risk judgment). Everything runs behind the enablement gate in `rules.js`:
 * the disabled path reads no key, builds no Jev client, serializes no context,
 * and leaves every request, event and decision exactly native.
 *
 * Integration boundaries (verified against dsh 0.1.5-rc.2, see
 * `docs/jev-stage1-extension-map.md`):
 * - compaction commits through the session's model-free replacement protocol
 *   (`compaction/prune` + one `user/message` surface replacement), so originals
 *   stay in the append-only log and undo is a replacement of our own marker;
 * - the decision nodes compose as waterfalls that adopt the native decision
 *   first and can only add a bounded retry, a whitelisted route switch, or an
 *   `allow` -> `ask` escalation. They can never loosen a denial or bypass an
 *   approval.
 */
import z from "@deepseek-ai/schemastery";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import rules from "./rules.js";
import { createAudit } from "./audit.js";
import { createBudgetTracker } from "./budget.js";
import { createJevLog } from "./log.js";
import { JevError, createTypeSafeClient } from "./typesafe.js";
import { buildUnits, classifyProtection } from "./units.js";
import { commitPlan, findJevMarkers, planCompaction, restoreMarker } from "./compaction.js";
import { faultDecision, riskDecision, routeDecision } from "./decision.js";

/** Stable Cordis plugin name; also the settings namespace and route prefix owner. */
const name = rules.NAMESPACE;

/** The web server backs the read-only status surface and the guarded controls. */
const inject = ["webServer"];

/** Plugin version reported by the status surface. */
const PLUGIN_VERSION = "0.1.0";

/** Largest accepted JSON control body. */
const MAX_BODY_BYTES = 4096;

/** Output reserve held back from the model context when sizing the input budget. */
const DEFAULT_OUTPUT_RESERVE = 8192;

/** Protocol and framing overhead held back alongside the output reserve. */
const PROTOCOL_OVERHEAD = 4096;

/** Route paths owned by this plugin. */
const STATUS_PATH = rules.ROUTE_PREFIX + "/status";
const TEST_PATH = rules.ROUTE_PREFIX + "/test";
const RESTORE_PATH = rules.ROUTE_PREFIX + "/restore";
const LOG_PATH = rules.ROUTE_PREFIX + "/log";

const acceptance = z.object({
	choice: z.number().min(0).max(1).default(rules.DEFAULTS.compaction.removalAcceptance.choice),
	noul: z.number().min(0).max(1).default(rules.DEFAULTS.compaction.removalAcceptance.noul)
}).default({});

const compactionConfig = z.object({
	enabled: z.boolean().default(rules.DEFAULTS.compaction.enabled),
	mode: z.union(["observe", "active"]).default(rules.DEFAULTS.compaction.mode),
	triggerRatio: z.number().min(0.05).max(0.95).default(rules.DEFAULTS.compaction.triggerRatio),
	targetRatio: z.number().min(0.05).max(0.9).default(rules.DEFAULTS.compaction.targetRatio),
	keepRecentMessages: z.number().step(1).min(0).default(rules.DEFAULTS.compaction.keepRecentMessages),
	maxRemovalRatio: z.number().min(0.05).max(1).default(rules.DEFAULTS.compaction.maxRemovalRatio),
	minIntervalSteps: z.number().step(1).min(0).default(rules.DEFAULTS.compaction.minIntervalSteps),
	removalAcceptance: acceptance
}).default({});

const decisionConfig = z.object({
	enabled: z.boolean().default(rules.DEFAULTS.decision.enabled),
	nodes: z.array(z.union(rules.DECISION_NODES)).default([]),
	acceptanceByNode: z.object({
		faultClassification: z.object({
			minConfidence: z.number().min(0).max(1).default(rules.DEFAULTS.decision.faultClassification.minConfidence),
			maxExtraRetries: z.number().step(1).min(0).max(3).default(rules.DEFAULTS.decision.faultClassification.maxExtraRetries)
		}).default({}),
		routeSelection: z.object({
			minConfidence: z.number().min(0).max(1).default(rules.DEFAULTS.decision.routeSelection.minConfidence),
			candidates: z.array(z.object({
				provider: z.string(),
				model: z.string()
			})).default([])
		}).default({}),
		riskJudgment: z.object({
			minNoul: z.number().min(0).max(1).default(rules.DEFAULTS.decision.riskJudgment.minNoul)
		}).default({})
	}).default({})
}).default({});

const modelConfig = z.object({
	providerId: z.string(),
	modelId: z.string(),
	enabled: z.boolean().default(false),
	compaction: compactionConfig,
	decision: decisionConfig
});

/** Durable settings schema: the global gate plus exact provider/model policies. */
const Config = z.object({
	enabled: z.boolean().default(rules.DEFAULTS.enabled),
	credentialRef: z.string().role("credential-ref").default(rules.DEFAULTS.credentialRef),
	jevModel: z.string().default(rules.DEFAULTS.jevModel),
	timeoutMs: z.number().step(1).min(100).max(120000).default(rules.DEFAULTS.timeoutMs),
	callBudgetPerStep: z.number().step(1).min(0).max(32).default(rules.DEFAULTS.callBudgetPerStep),
	callBudgetPerTask: z.number().step(1).min(0).max(512).default(rules.DEFAULTS.callBudgetPerTask),
	models: z.array(modelConfig).default([])
});

/** JSON response; `no-store` keeps live state out of every cache. */
function sendJson(response, status, payload) {
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.setHeader("cache-control", "no-store");
	response.end(JSON.stringify(payload));
}

/** Loopback host names an Origin may carry for a same-machine page request. */
function isLoopbackHost(host) {
	return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * Whether one request may trigger work that spends money or rewrites context.
 *
 * Plugin-owned routes sit outside the harness' browser-cookie fence, so this
 * guard keeps a stray local caller from spending Jev budget or rewriting a
 * session: the plugin's own header (which a cross-site form cannot set without
 * a CORS preflight), a same-origin/none fetch site, and a loopback Origin.
 * @param {object} request - incoming HTTP request.
 * @returns {boolean} whether the request may run the control.
 */
function isTrustedPageRequest(request) {
	const headers = request.headers ?? {};
	if (headers["x-jev-enhancement"] !== "1") return false;
	const site = headers["sec-fetch-site"];
	if (typeof site === "string" && site !== "same-origin" && site !== "none") return false;
	const origin = headers.origin;
	if (typeof origin === "string" && origin !== "") {
		try {
			if (!isLoopbackHost(new URL(origin).hostname)) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * Read a bounded JSON body.
 * @param {object} request - incoming HTTP request.
 * @returns {Promise<object | undefined>} parsed body, or undefined when unusable.
 */
async function readJsonBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) return undefined;
		chunks.push(chunk);
	}
	if (size === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Host half body: the settings section, the gated Jev pipeline, and the status
 * surface. Everything mutable is fiber-owned so a reload never shares state.
 * @param {object} ctx - Host plugin context.
 * @param {object} config - resolved composition entry (the section's base layer).
 */
function apply(ctx, config) {
	let current = () => config ?? {};
	/* The plugin's own durable audit log: metadata only, owner-only permissions. */
	const jevLog = createJevLog();
	const audit = createAudit({
		logger: ctx.logger,
		onRecord: (entry) => jevLog.append({ ...entry, at: new Date(entry.at).toISOString() })
	});
	const tracker = createBudgetTracker();
	/** Per-session step failure counts, for the fault node's bounded retry. */
	const stepFailures = new Map();
	/** Extra retries already granted per step identity. */
	const stepExtraRetries = new Map();
	/** Sessions with a recent request failure, arming the route node. */
	const routeNeed = new Set();
	/** Lazily built adapter: never constructed on the disabled path. */
	let client = null;
	/** Set on an auth/contract failure; disables the enhancement until config changes. */
	let contractDisabledAt = 0;
	let configVersionSeen = rules.configVersion(current());

	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, rules.NAMESPACE, Config, config ?? {}, {
			setSource: (source) => {
				current = source;
			},
			onChange: () => {
				const version = rules.configVersion(current());
				if (version !== configVersionSeen) {
					configVersionSeen = version;
					/* A configuration change invalidates everything in flight. */
					contractDisabledAt = 0;
					budgetNoted.clear();
					stepFailures.clear();
					stepExtraRetries.clear();
				}
			}
		});
	});

	/** Resolve the Jev credential: credentials seam first, launch environment second. */
	const resolveKey = async () => {
		const ref = rules.normalizeSection(current()).global.credentialRef;
		const credentials = ctx.get("credentials");
		if (credentials !== undefined) {
			const stored = await credentials.resolve(ref);
			if (typeof stored?.value === "string" && stored.value.length > 0) return stored.value;
		}
		const ambient = launchEnvironmentOf(ctx).get(ref);
		return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined;
	};

	/** Build the adapter on first gated use only. */
	const getClient = () => {
		if (client === null) {
			const global = rules.normalizeSection(current()).global;
			client = createTypeSafeClient({
				fetchImpl: (input, init) => fetch(input, init),
				resolveKey,
				timeoutMs: global.timeoutMs,
				onUsage: (usage) => {
					audit.add("jevInputTokens", usage?.inputTokens ?? 0);
					audit.add("jevOutputTokens", usage?.outputTokens ?? 0);
				}
			});
		}
		return client;
	};

	/** The exact provider/model durably routed for the latest request. */
	const routedTarget = (agent) => {
		const header = agent.session?.requestHeader?.()?.config;
		if (typeof header?.provider === "string" && header.provider !== "" && typeof header?.model === "string" && header.model !== "") {
			return { provider: header.provider, model: header.model };
		}
		if (typeof agent.options?.provider === "string" && typeof agent.options?.model === "string") {
			return { provider: agent.options.provider, model: agent.options.model };
		}
		return undefined;
	};

	/**
	 * The gate for one agent's actual routed model. Runs before ANY Jev work.
	 * @param {object} agent - the live agent.
	 * @param {string} feature - `compaction` or `decision`.
	 * @param {string} [node] - decision node for the `decision` feature.
	 * @returns {object} the gate verdict from `rules.gate`.
	 */
	const gateFor = (agent, feature, node) => {
		const target = routedTarget(agent);
		if (target === undefined) return rules.gate(current(), "", "", feature, node);
		return rules.gate(current(), target.provider, target.model, feature, node);
	};

	/**
	 * One gated Jev call. Budget, circuit breaker, audit, and the auth/contract
	 * shutdown all live here so no call site can bypass them.
	 * @param {object} request - `state`, `questions`, `signal`, plus `taskKey`/`stepKey`.
	 * @returns {Promise<object>} normalized typed answers.
	 */
	const ask = async (request) => {
		const global = rules.normalizeSection(current()).global;
		const budget = { perStep: global.callBudgetPerStep, perTask: global.callBudgetPerTask };
		if (!tracker.trySpend(request.taskKey, request.stepKey, budget)) {
			throw new JevError("budget", "Jev call budget exhausted for this step or task");
		}
		const started = Date.now();
		try {
			const result = await getClient().evaluate({
				state: request.state,
				questions: request.questions,
				model: global.jevModel,
				signal: request.signal
			});
			tracker.recordSuccess();
			budgetNoted.clear();
			audit.count("jevCalls", { latencyMs: Date.now() - started });
			return result;
		} catch (error) {
			tracker.recordFailure();
			audit.count("jevCallFailures", { code: error?.code ?? "unknown" });
			if (error?.code === "auth" || error?.code === "contract") {
				/* Contract rule: never guess fields; disable and fall back instead. */
				contractDisabledAt = Date.now();
				audit.log("warn", "jev-enhancement: " + error.code + " failure; enhancement disabled until configuration changes");
			}
			throw error;
		}
	};

	/** Budget exhaustion is a state, not an event: record it once per episode. */
	const budgetNoted = new Set();
	const noteFallback = (reason, code) => {
		if (code === "budget") {
			audit.count("budgetFallbacks");
			if (budgetNoted.has(reason)) return;
			budgetNoted.add(reason);
		}
		audit.fallback(reason, { code });
	};

	/** Availability overlay for the gate verdicts the status surface publishes. */
	const unavailableReasons = () => {
		const reasons = [];
		if (contractDisabledAt > 0) reasons.push("auth-or-contract-failure");
		if (tracker.circuitOpen()) reasons.push("circuit-open");
		return reasons;
	};

	/**
	 * Context Compaction for one step (plan §5.2). Observe mode plans and logs
	 * without touching the surface; active mode commits through the model-free
	 * replacement protocol. Every failure keeps the conversation unchanged.
	 * @param {object} payload - the `agent/pre-step` payload.
	 * @returns {Promise<void>} nothing.
	 */
	const compactStep = async ({ agent, turn, step, signal }) => {
		if (contractDisabledAt > 0 || unavailableReasons().length > 0) return;
		const gate = gateFor(agent, "compaction");
		if (!gate.allowed) return;
		const policy = gate.policy;
		const session = agent.session;
		const taskKey = String(session.id ?? "session");
		const stepIndex = Number.isInteger(step) ? step : 0;
		const budget = {
			perStep: rules.normalizeSection(current()).global.callBudgetPerStep,
			perTask: rules.normalizeSection(current()).global.callBudgetPerTask
		};
		if (!tracker.canSpend(taskKey, taskKey + ":" + turn + ":" + step, budget)) return;
		if (!tracker.compactionReady(taskKey, stepIndex, policy.compaction.minIntervalSteps)) return;

		const meter = ctx.get("tokenMeter");
		const llm = ctx.get("llm");
		if (meter === undefined || llm === undefined) return;
		const target = routedTarget(agent);
		if (target === undefined) return;
		const context = (await llm.resolveModelInfo(target.provider, target.model, signal))?.context;
		/* No reliable token budget means no automatic compaction (plan §4.2). */
		if (!Number.isInteger(context?.contextWindow) || context.contextWindow <= 0) return;
		const outputReserve = Number.isInteger(agent.options?.maxTokens) ? agent.options.maxTokens : DEFAULT_OUTPUT_RESERVE;
		const budgetTokens = context.contextWindow - outputReserve - PROTOCOL_OVERHEAD;
		if (budgetTokens <= 0) return;

		const measurement = meter.measure(session);
		if (measurement.totalTokens < policy.compaction.triggerRatio * budgetTokens) return;

		const nodes = measurement.nodes.map((node) => ({
			seq: node.seq,
			event: session.eventAt(node.seq),
			tokens: node.tokens,
			heuristicTokens: node.heuristicTokens
		}));
		const units = classifyProtection(buildUnits(nodes), {
			keepRecentMessages: policy.compaction.keepRecentMessages
		});
		const goalUnit = units.find((unit) => unit.protection.reason === "user-goal");
		const goal = goalUnit === undefined ? "" : goalUnit.text.slice(0, 2000);
		const constraints = units
			.filter((unit) => unit.protection.reason === "user-pinned" || unit.protection.reason === "approval-boundary")
			.map((unit) => unit.text.slice(0, 500))
			.join("\n")
			.slice(0, 2000);

		/* Snapshot for the stale-result check at commit time. */
		const snapshot = {
			generation: session.surface.replaceGeneration,
			configVersion: configVersionSeen,
			target,
			model: rules.normalizeSection(current()).global.jevModel
		};
		tracker.markCompaction(taskKey, stepIndex);
		const plan = await planCompaction({
			units,
			policy,
			budgetTokens,
			totalTokens: measurement.totalTokens,
			goal,
			constraints,
			signal,
			ask: (request) => ask({ ...request, taskKey, stepKey: taskKey + ":" + turn + ":" + step })
		});
		audit.add("unitsProtected", plan.protectedCount);
		if (plan.spans.length === 0) {
			audit.count("compactionAborted", { reason: plan.reason });
			return;
		}

		if (policy.compaction.mode === "observe") {
			/* Observation mode: advice only, the conversation is untouched. */
			audit.count("compactionObserved", {
				reason: "observe",
				spans: plan.spans.length,
				removedTokens: plan.removedTokens,
				target: snapshot.target.provider + "/" + snapshot.target.model
			});
			audit.log("info", "jev-enhancement: observe pass would remove " + plan.spans.length + " span(s), ~" + plan.removedTokens + " tokens");
			return;
		}

		/* Commit-time revalidation: gate, configuration, model, surface and cancellation. */
		const fresh = gateFor(agent, "compaction");
		const unchangedTarget = JSON.stringify(routedTarget(agent)) === JSON.stringify(snapshot.target);
		const spansIntact = plan.spans.every((span) => span.seqs.every((seq) => session.surface.nodes.includes(seq)));
		const freshConfig = rules.configVersion(current()) === snapshot.configVersion;
		if (
			signal.aborted ||
			!fresh.allowed ||
			!freshConfig ||
			!unchangedTarget ||
			!spansIntact ||
			session.surface.replaceGeneration !== snapshot.generation
		) {
			audit.count("compactionAborted", { reason: "stale-result" });
			return;
		}
		try {
			const { committed } = commitPlan({ session, plan });
			audit.count("compactionCommitted", {
				spans: committed.length,
				removedTokens: plan.removedTokens,
				target: snapshot.target.provider + "/" + snapshot.target.model
			});
			audit.add("unitsRemoved", committed.reduce((sum, span) => sum + span.unitIds.length, 0));
			audit.add("tokensRemoved", plan.removedTokens);
			audit.log("info", "jev-enhancement: committed " + committed.length + " span(s), ~" + plan.removedTokens + " tokens filtered");
		} catch (error) {
			audit.count("compactionAborted", { reason: "commit-failed" });
			audit.log("warn", "jev-enhancement: commit failed: " + (error instanceof Error ? error.message : String(error)));
		}
	};

	/**
	 * Undo every landed Jev marker of one session, restoring the verbatim
	 * originals (plan §8: disable and model switches rebuild from the original
	 * session material).
	 * @param {object} session - the live session.
	 * @returns {number} how many markers were restored.
	 */
	const restoreSession = (session) => {
		const markers = findJevMarkers(session);
		for (const marker of markers.reverse()) {
			try {
				restoreMarker({ session, marker, estimate: (message) => ctx.get("tokenMeter")?.estimateMessage(message) ?? 0 });
				audit.add("unitsRestored", marker.shadowedSeqs.length);
			} catch (error) {
				audit.log("warn", "jev-enhancement: restore failed: " + (error instanceof Error ? error.message : String(error)));
			}
		}
		if (markers.length > 0) audit.log("info", "jev-enhancement: restored " + markers.length + " filtered span(s) from the session log");
		return markers.length;
	};

	ctx.effect(() => ctx.on("agent/pre-step", async (payload, next) => {
		const { agent, turn, step, signal } = payload;
		try {
			/* Disable / unselected model path: never keep using a Jev-derived view. */
			const gate = gateFor(agent, "compaction");
			const restoreReasons = ["global-disabled", "model-not-enabled", "feature-disabled"];
			if (restoreReasons.includes(gate.reason) && findJevMarkers(agent.session).length > 0) {
				restoreSession(agent.session);
			} else if (!signal.aborted) {
				await compactStep({ agent, turn, step, signal });
			}
		} catch (error) {
			noteFallback("compaction-error", error?.code);
			audit.log("warn", "jev-enhancement: compaction pass failed: " + (error instanceof Error ? error.message : String(error)));
		}
		return next();
	}), "jev-enhancement: context compaction");

	ctx.effect(() => ctx.on("agent/request-error", async ({ agent, turn, step, failure, retryPolicy, signal }, next) => {
		const action = await next();
		const stepKey = String(agent.session?.id ?? "session") + ":" + turn + ":" + step;
		stepFailures.set(stepKey, (stepFailures.get(stepKey) ?? 0) + 1);
		routeNeed.add(String(agent.session?.id ?? "session"));
		try {
			const gate = gateFor(agent, "decision", "fault-classification");
			if (!gate.allowed) return action;
			if (contractDisabledAt > 0 || action?.kind === "retry" || signal.aborted) return action;
			const advice = await faultDecision({
				failure,
				retryPolicy,
				failuresSeen: stepFailures.get(stepKey) ?? 1,
				extraRetriesUsed: stepExtraRetries.get(stepKey) ?? 0,
				policy: gate.policy,
				signal,
				ask: (request) => ask({ ...request, taskKey: String(agent.session?.id ?? "session"), stepKey })
			});
			audit.count("faultDecisions", { node: "fault-classification", code: failure?.code, target: gate.policy.key });
			audit.decision({ node: "fault-classification", decision: advice.category, accepted: advice.action === "retry", source: advice.source });
			if (advice.action === "retry") {
				stepExtraRetries.set(stepKey, (stepExtraRetries.get(stepKey) ?? 0) + 1);
				audit.count("faultRetries");
				return { kind: "retry" };
			}
			return action;
		} catch (error) {
			noteFallback("fault-classification-failed", error?.code);
			return action;
		}
	}), "jev-enhancement: fault classification");

	ctx.effect(() => ctx.on("agent/request", async ({ agent, turn, step, signal }, next) => {
		const callConfig = await next();
		try {
			const gate = gateFor(agent, "decision", "route-selection");
			if (!gate.allowed) return callConfig;
			if (contractDisabledAt > 0 || signal.aborted) return callConfig;
			const taskKey = String(agent.session?.id ?? "session");
			const stepKey = taskKey + ":" + turn + ":" + step;
			const registered = (ctx.get("llm")?.listProviders() ?? []).map((provider) => provider.id);
			const advice = await routeDecision({
				current: { provider: callConfig.provider, model: callConfig.model },
				/* Candidates DSH can actually serve: a registered adapter owns the provider route. */
				available: gate.policy.decision.acceptanceByNode.routeSelection.candidates.filter((candidate) => registered.includes(candidate.provider)),
				triggered: routeNeed.has(taskKey),
				task: "",
				recentFailures: [],
				policy: gate.policy,
				signal,
				ask: (request) => ask({ ...request, taskKey, stepKey })
			});
			if (advice.kind === "skip") {
				/* Empty run: nothing to judge. Aggregate counter only — never a judgment record. */
				audit.count("routeSkips");
				return callConfig;
			}
			audit.count("routeDecisions", { node: "route-selection", target: gate.policy.key });
			if (advice.kind === "keep") {
				audit.decision({ node: "route-selection", decision: "keep_current", accepted: false, source: "jev" });
				return callConfig;
			}
			/* The whitelist was already intersected with registered routes. */
			if (!registered.includes(advice.provider)) return callConfig;
			routeNeed.delete(taskKey);
			audit.count("routeSwitches");
			audit.decision({ node: "route-selection", decision: advice.key, accepted: true, source: "jev" });
			/* The next gate runs on the ACTUAL target; the old model's policy is never reused. */
			return { ...callConfig, provider: advice.provider, model: advice.model };
		} catch (error) {
			noteFallback("route-selection-failed", error?.code);
			return callConfig;
		}
	}), "jev-enhancement: route selection");

	ctx.effect(() => ctx.on("tools/pre-execute", async (exec, next) => {
		const decision = await next();
		try {
			if (decision?.kind !== "allow" || exec.agent === undefined) return decision;
			const gate = gateFor(exec.agent, "decision", "risk-judgment");
			if (!gate.allowed) return decision;
			if (contractDisabledAt > 0 || exec.signal?.aborted === true) return decision;
			const stepKey = String(exec.agent.session?.id ?? "session") + ":tool:" + String(exec.callId);
			const advice = await riskDecision({
				name: exec.name,
				args: exec.arguments,
				policy: gate.policy,
				signal: exec.signal,
				ask: (request) => ask({ ...request, taskKey: String(exec.agent.session?.id ?? "session"), stepKey })
			});
			audit.count("riskDecisions", { node: "risk-judgment" });
			audit.decision({ node: "risk-judgment", decision: advice.risks.join("+") || "safe", accepted: advice.escalate, source: advice.source });
			/* Escalation only: a denial or approval requirement is never loosened. */
			if (!advice.escalate) return decision;
			audit.count("riskEscalations");
			return { kind: "ask", reason: "Jev 风险判断提示 " + advice.risks.join("、") + " 风险，请确认后继续" };
		} catch (error) {
			noteFallback("risk-judgment-failed", error?.code);
			return decision;
		}
	}), "jev-enhancement: risk judgment");

	ctx.effect(() => ctx.on("agent/assistant-stream", ({ agent, frame }) => {
		if (frame.type === "end" && frame.outcome.kind === "committed") {
			/* A committed assistant message clears this session's routing trigger. */
			const taskKey = String(agent.session?.id ?? "session");
			routeNeed.delete(taskKey);
			for (const key of [...stepFailures.keys()]) if (key.startsWith(taskKey + ":")) stepFailures.delete(key);
			for (const key of [...stepExtraRetries.keys()]) if (key.startsWith(taskKey + ":")) stepExtraRetries.delete(key);
		}
	}), "jev-enhancement: route trigger reset");

	/** The published status: explicit field whitelist only (plan §9). */
	const publicStatus = () => {
		const normalized = rules.normalizeSection(current());
		const problems = rules.validateSection(current());
		return {
			ok: true,
			version: PLUGIN_VERSION,
			enabled: normalized.global.enabled,
			jevModel: normalized.global.jevModel,
			credentialRef: normalized.global.credentialRef,
			models: normalized.models.map((model) => ({
				key: model.key,
				enabled: model.enabled,
				compaction: model.compaction.enabled ? model.compaction.mode : "off",
				decision: model.decision.enabled ? model.decision.nodes : [],
				valid: model.problems.length === 0
			})),
			problems,
			unavailable: unavailableReasons(),
			circuit: { open: tracker.circuitOpen(), remainingMs: tracker.circuitRemainingMs() },
			audit: audit.snapshot()
		};
	};

	/** One route dispatch over the plugin's prefix. */
	const dispatch = async (request, response, pathname) => {
		if (pathname === STATUS_PATH) {
			if (request.method !== "GET" && request.method !== "HEAD") {
				sendJson(response, 405, { ok: false, reason: "method-not-allowed" });
				return;
			}
			sendJson(response, 200, publicStatus());
			return;
		}
		if (pathname === TEST_PATH) {
			if (request.method !== "POST") {
				sendJson(response, 405, { ok: false, reason: "method-not-allowed" });
				return;
			}
			if (!isTrustedPageRequest(request)) {
				sendJson(response, 403, { ok: false, reason: "forbidden" });
				return;
			}
			const global = rules.normalizeSection(current()).global;
			const started = Date.now();
			try {
				const result = await getClient().evaluate({
					state: "connectivity check",
					model: global.jevModel,
					questions: {
						ping: {
							type: "noul",
							instructions: "The state is the literal text 'connectivity check'."
						}
					}
				});
				audit.count("jevCalls", { latencyMs: Date.now() - started, target: global.jevModel });
				sendJson(response, 200, { ok: true, model: result.model, latencyMs: Date.now() - started });
			} catch (error) {
				audit.count("jevCallFailures", { code: error?.code ?? "unavailable", target: global.jevModel });
				sendJson(response, 200, {
					ok: false,
					latencyMs: Date.now() - started,
					error: { code: error?.code ?? "unavailable" }
				});
			}
			return;
		}
		if (pathname === RESTORE_PATH) {
			if (request.method !== "POST") {
				sendJson(response, 405, { ok: false, reason: "method-not-allowed" });
				return;
			}
			if (!isTrustedPageRequest(request)) {
				sendJson(response, 403, { ok: false, reason: "forbidden" });
				return;
			}
			const body = (await readJsonBody(request)) ?? {};
			const agents = ctx.get("agents");
			const agent = typeof agents?.get === "function" && typeof body.sessionId === "string" ? agents.get(body.sessionId) : undefined;
			if (agent === undefined) {
				sendJson(response, 404, { ok: false, reason: "session-not-found" });
				return;
			}
			const restored = restoreSession(agent.session);
			sendJson(response, 200, { ok: true, restored });
			return;
		}
		if (pathname === LOG_PATH) {
			if (request.method !== "GET" && request.method !== "HEAD") {
				sendJson(response, 405, { ok: false, reason: "method-not-allowed" });
				return;
			}
			if (!isTrustedPageRequest(request)) {
				sendJson(response, 403, { ok: false, reason: "forbidden" });
				return;
			}
			/* Export body: rotated predecessor first, then the live file (JSONL). */
			response.statusCode = 200;
			response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
			response.setHeader("cache-control", "no-store");
			response.setHeader("content-disposition", 'attachment; filename="jev-enhancement-audit-' + new Date().toISOString().slice(0, 10) + ".jsonl");
			response.end(jevLog.read());
			return;
		}
		sendJson(response, 404, { ok: false, reason: "not-found" });
	};

	/* One activation record: the durable log proves which config went live when. */
	audit.count("activated", {
		reason: rules.normalizeSection(current()).global.enabled ? "enabled" : "disabled",
		target: rules.normalizeSection(current()).global.jevModel
	});

	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: rules.ROUTE_PREFIX,
		handler: (request, response) => {
			const url = new URL(request.url ?? "/", "http://localhost");
			return dispatch(request, response, url.pathname).catch(() => {
				sendJson(response, 500, { ok: false, reason: "internal-error" });
			});
		}
	}), "jev-enhancement: " + rules.ROUTE_PREFIX);
}

/** Pure helpers exercised by the unit tests. */
const testing = {
	Config,
	DEFAULT_OUTPUT_RESERVE,
	LOG_PATH,
	MAX_BODY_BYTES,
	PLUGIN_VERSION,
	PROTOCOL_OVERHEAD,
	RESTORE_PATH,
	ROUTE_PREFIX: rules.ROUTE_PREFIX,
	STATUS_PATH,
	TEST_PATH,
	isTrustedPageRequest,
	readJsonBody,
	sendJson
};

export { Config, apply, inject, name, testing };
