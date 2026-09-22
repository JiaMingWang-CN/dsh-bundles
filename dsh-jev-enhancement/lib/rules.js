/**
 * Shared configuration rules for dsh-jev-enhancement.
 *
 * Pure module (no imports) so `node --test` can run it standalone. The exact
 * same `rules` initializer is embedded in `lib/client.js` (see the
 * `//#region rules.js` block) so the settings page and the runtime gate can
 * never disagree; `test/rules-parity.test.js` fails if the two copies drift.
 */

//#region rules.js
const rules = (function () {
	/** Settings namespace owned by this plugin (key of its settings section). */
	const NAMESPACE = "jev-enhancement";

	/** Route prefix owned by this plugin; no shell route is shadowed. */
	const ROUTE_PREFIX = "/plugins/jev-enhancement";

	/** Feature keys that can be switched on per model. */
	const FEATURES = ["compaction", "decision"];

	/** Decision nodes this build knows how to serve. */
	const DECISION_NODES = ["fault-classification", "route-selection", "risk-judgment"];

	/** Question-type acceptance thresholds keyed by TypeSafe question type. */
	const QUESTION_TYPES = ["choice", "noul"];

	/** Schema defaults, mirrored here so gating also holds outside the seam. */
	const DEFAULTS = {
		enabled: false,
		credentialRef: "TYPESAFE_API_KEY",
		jevModel: "jev-latest",
		timeoutMs: 10000,
		callBudgetPerStep: 1,
		callBudgetPerTask: 20,
		compaction: {
			enabled: false,
			mode: "observe",
			triggerRatio: 0.7,
			targetRatio: 0.5,
			keepRecentMessages: 6,
			maxRemovalRatio: 0.5,
			minIntervalSteps: 4,
			removalAcceptance: { choice: 0.8, noul: 0.8 }
		},
		decision: {
			enabled: false,
			nodes: [],
			faultClassification: { minConfidence: 0.75, maxExtraRetries: 1 },
			routeSelection: { minConfidence: 0.7, candidates: [] },
			riskJudgment: { minNoul: 0.7 }
		}
	};

	/** Copy shared by the settings page and status reporting. */
	const REASONS = {
		"global-disabled": "Jev 总开关已关闭，全部增强不生效",
		"model-not-enabled": "该模型未启用 Jev，走原生流程",
		"model-unknown": "未配置的模型不启用 Jev，走原生流程",
		"feature-disabled": "该功能对该模型已关闭",
		"node-disabled": "该决策节点未启用",
		"config-invalid": "配置无效，该模型的增强不生效"
	};

	function isPlainObject(value) {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	function isRatio(value, allowOne) {
		return typeof value === "number" && Number.isFinite(value) && value > 0 && (allowOne ? value <= 1 : value < 1);
	}

	function isCount(value, min) {
		return Number.isInteger(value) && value >= min;
	}

	function isThreshold(value) {
		return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
	}

	function text(value, fallback) {
		return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
	}

	function numberOr(value, fallback) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
		return fallback;
	}

	function integerOr(value, fallback) {
		const parsed = numberOr(value, undefined);
		return Number.isInteger(parsed) ? parsed : fallback;
	}

	function boolOr(value, fallback) {
		return typeof value === "boolean" ? value : fallback;
	}

	function pickMode(value) {
		return value === "active" ? "active" : "observe";
	}

	function pickNodes(value) {
		if (!Array.isArray(value)) return [];
		const seen = [];
		for (const node of value) {
			if (DECISION_NODES.includes(node) && !seen.includes(node)) seen.push(node);
		}
		return seen;
	}

	function pickCandidates(value) {
		if (!Array.isArray(value)) return [];
		const seen = [];
		for (const entry of value) {
			if (!isPlainObject(entry)) continue;
			const provider = text(entry.provider, "");
			const model = text(entry.model, "");
			if (provider === "" || model === "") continue;
			const key = routeKey(provider, model);
			if (seen.some((candidate) => candidate.key === key)) continue;
			seen.push({ key, provider, model });
		}
		return seen;
	}

	/** Stable identity of one exact provider/model route. */
	function routeKey(provider, model) {
		return provider + "/" + model;
	}

	/** Normalize one raw model entry; every missing field falls back to its default. */
	function normalizeModel(raw) {
		const model = isPlainObject(raw) ? raw : {};
		const compaction = isPlainObject(model.compaction) ? model.compaction : {};
		const decision = isPlainObject(model.decision) ? model.decision : {};
		const acceptance = isPlainObject(compaction.removalAcceptance) ? compaction.removalAcceptance : {};
		const byNode = isPlainObject(decision.acceptanceByNode) ? decision.acceptanceByNode : {};
		const fault = isPlainObject(byNode.faultClassification) ? byNode.faultClassification : {};
		const route = isPlainObject(byNode.routeSelection) ? byNode.routeSelection : {};
		const risk = isPlainObject(byNode.riskJudgment) ? byNode.riskJudgment : {};
		const providerId = text(model.providerId, "");
		const modelId = text(model.modelId, "");
		return {
			providerId,
			modelId,
			key: routeKey(providerId, modelId),
			enabled: boolOr(model.enabled, false),
			compaction: {
				enabled: boolOr(compaction.enabled, DEFAULTS.compaction.enabled),
				mode: pickMode(compaction.mode ?? DEFAULTS.compaction.mode),
				triggerRatio: numberOr(compaction.triggerRatio, DEFAULTS.compaction.triggerRatio),
				targetRatio: numberOr(compaction.targetRatio, DEFAULTS.compaction.targetRatio),
				keepRecentMessages: integerOr(compaction.keepRecentMessages, DEFAULTS.compaction.keepRecentMessages),
				maxRemovalRatio: numberOr(compaction.maxRemovalRatio, DEFAULTS.compaction.maxRemovalRatio),
				minIntervalSteps: integerOr(compaction.minIntervalSteps, DEFAULTS.compaction.minIntervalSteps),
				removalAcceptance: {
					choice: numberOr(acceptance.choice, DEFAULTS.compaction.removalAcceptance.choice),
					noul: numberOr(acceptance.noul, DEFAULTS.compaction.removalAcceptance.noul)
				}
			},
			decision: {
				enabled: boolOr(decision.enabled, DEFAULTS.decision.enabled),
				nodes: pickNodes(decision.nodes),
				acceptanceByNode: {
					faultClassification: {
						minConfidence: numberOr(fault.minConfidence, DEFAULTS.decision.faultClassification.minConfidence),
						maxExtraRetries: integerOr(fault.maxExtraRetries, DEFAULTS.decision.faultClassification.maxExtraRetries)
					},
					routeSelection: {
						minConfidence: numberOr(route.minConfidence, DEFAULTS.decision.routeSelection.minConfidence),
						candidates: pickCandidates(route.candidates)
					},
					riskJudgment: {
						minNoul: numberOr(risk.minNoul, DEFAULTS.decision.riskJudgment.minNoul)
					}
				}
			}
		};
	}

	/** Parse one raw numeric field; undefined when it is not a finite number. */
	function parseNumber(value) {
		return numberOr(value, undefined);
	}

	/**
	 * Validate one raw model entry, isolated to that model. Numeric fields are
	 * checked as written (no silent defaulting), so the settings page can show
	 * the exact problem and refuse to save it.
	 * @param {object} model - raw model entry as configured.
	 * @returns {string[]} human-readable problems; empty means usable.
	 */
	function validateModel(model) {
		const problems = [];
		const compaction = isPlainObject(model.compaction) ? model.compaction : {};
		const decision = isPlainObject(model.decision) ? model.decision : {};
		const acceptance = isPlainObject(compaction.removalAcceptance) ? compaction.removalAcceptance : {};
		const byNode = isPlainObject(decision.acceptanceByNode) ? decision.acceptanceByNode : {};
		const fault = isPlainObject(byNode.faultClassification) ? byNode.faultClassification : {};
		const route = isPlainObject(byNode.routeSelection) ? byNode.routeSelection : {};
		const risk = isPlainObject(byNode.riskJudgment) ? byNode.riskJudgment : {};
		if (text(model.providerId, "") === "" || text(model.modelId, "") === "") problems.push("providerId 与 modelId 均为必填（精确匹配，不支持模糊名称）");
		const triggerRatio = parseNumber(compaction.triggerRatio ?? DEFAULTS.compaction.triggerRatio);
		const targetRatio = parseNumber(compaction.targetRatio ?? DEFAULTS.compaction.targetRatio);
		if (!isRatio(triggerRatio, true)) problems.push("compaction.triggerRatio 必须是 (0, 1] 内的数字");
		if (!isRatio(targetRatio, true)) problems.push("compaction.targetRatio 必须是 (0, 1] 内的数字");
		if (isRatio(triggerRatio, true) && isRatio(targetRatio, true) && targetRatio >= triggerRatio) {
			problems.push("compaction.targetRatio 必须小于 compaction.triggerRatio");
		}
		const keepRecent = parseNumber(compaction.keepRecentMessages ?? DEFAULTS.compaction.keepRecentMessages);
		if (!isCount(keepRecent, 0)) problems.push("compaction.keepRecentMessages 必须是 >= 0 的整数");
		if (!isRatio(parseNumber(compaction.maxRemovalRatio ?? DEFAULTS.compaction.maxRemovalRatio), true)) problems.push("compaction.maxRemovalRatio 必须是 (0, 1] 内的数字");
		const interval = parseNumber(compaction.minIntervalSteps ?? DEFAULTS.compaction.minIntervalSteps);
		if (!isCount(interval, 0)) problems.push("compaction.minIntervalSteps 必须是 >= 0 的整数");
		if (compaction.mode !== undefined && compaction.mode !== "observe" && compaction.mode !== "active") problems.push("compaction.mode 只能是 observe 或 active");
		for (const type of QUESTION_TYPES) {
			const threshold = parseNumber(acceptance[type] ?? DEFAULTS.compaction.removalAcceptance[type]);
			if (!isThreshold(threshold)) problems.push("compaction.removalAcceptance." + type + " 必须是 [0, 1] 内的数字");
		}
		if (!isThreshold(parseNumber(fault.minConfidence ?? DEFAULTS.decision.faultClassification.minConfidence))) problems.push("acceptanceByNode.faultClassification.minConfidence 必须是 [0, 1] 内的数字");
		const extraRetries = parseNumber(fault.maxExtraRetries ?? DEFAULTS.decision.faultClassification.maxExtraRetries);
		if (!isCount(extraRetries, 0)) problems.push("acceptanceByNode.faultClassification.maxExtraRetries 必须是 >= 0 的整数");
		if (!isThreshold(parseNumber(route.minConfidence ?? DEFAULTS.decision.routeSelection.minConfidence))) problems.push("acceptanceByNode.routeSelection.minConfidence 必须是 [0, 1] 内的数字");
		if (!isThreshold(parseNumber(risk.minNoul ?? DEFAULTS.decision.riskJudgment.minNoul))) problems.push("acceptanceByNode.riskJudgment.minNoul 必须是 [0, 1] 内的数字");
		if (Array.isArray(decision.nodes) && decision.nodes.some((node) => !DECISION_NODES.includes(node))) problems.push("decision.nodes 含未知节点");
		return problems;
	}

	/**
	 * Normalize one whole settings section: global fields plus the exact-route
	 * model table. Duplicate routes keep the first entry and report the rest.
	 * @param {object} [section] - the raw `jev-enhancement` settings section.
	 * @returns {{ global: object, models: object[] }} detached normalized view.
	 */
	function normalizeSection(section = {}) {
		const source = isPlainObject(section) ? section : {};
		const models = [];
		const seen = new Set();
		const raw = Array.isArray(source.models) ? source.models : [];
		for (const entry of raw) {
			const model = normalizeModel(entry);
			if (model.key !== "/" && seen.has(model.key)) {
				model.problems = ["重复的 providerId+modelId 条目，仅第一条生效"];
				model.duplicate = true;
			} else {
				seen.add(model.key);
				model.problems = validateModel(isPlainObject(entry) ? entry : {});
				model.duplicate = false;
			}
			models.push(model);
		}
		return {
			global: {
				enabled: boolOr(source.enabled, DEFAULTS.enabled),
				credentialRef: text(source.credentialRef, DEFAULTS.credentialRef),
				jevModel: text(source.jevModel, DEFAULTS.jevModel),
				timeoutMs: Math.max(100, Math.min(120000, integerOr(source.timeoutMs, DEFAULTS.timeoutMs))),
				callBudgetPerStep: Math.max(0, Math.min(32, integerOr(source.callBudgetPerStep, DEFAULTS.callBudgetPerStep))),
				callBudgetPerTask: Math.max(0, Math.min(512, integerOr(source.callBudgetPerTask, DEFAULTS.callBudgetPerTask)))
			},
			models
		};
	}

	/**
	 * Look up the exact provider/model policy table entry.
	 * @param {object} section - raw settings section.
	 * @param {string} provider - registered provider route key.
	 * @param {string} model - exact routed model id.
	 * @returns {object | undefined} the normalized entry, or undefined when unconfigured.
	 */
	function findModel(section, provider, model) {
		const key = routeKey(text(provider, ""), text(model, ""));
		return normalizeSection(section).models.find((entry) => entry.key === key && !entry.duplicate);
	}

	/**
	 * The enablement gate. Runs before ANY Jev work: no key read, no
	 * serialization, no network on the disabled path.
	 * @param {object} section - raw settings section.
	 * @param {string} provider - provider route of the request being considered.
	 * @param {string} model - exact routed model of the request being considered.
	 * @param {string} feature - `compaction` or `decision`.
	 * @param {string} [node] - decision node, when `feature` is `decision`.
	 * @returns {{ allowed: boolean, reason: string, policy: object | undefined }} the gate verdict.
	 */
	function gate(section, provider, model, feature, node) {
		const normalized = normalizeSection(section);
		const deny = (reason, policy) => ({ allowed: false, reason, reasonText: REASONS[reason] ?? reason, policy });
		if (!normalized.global.enabled) return deny("global-disabled");
		const entry = normalized.models.find((candidate) => candidate.key === routeKey(text(provider, ""), text(model, "")) && !candidate.duplicate);
		if (entry === undefined) return deny(text(provider, "") === "" && text(model, "") === "" ? "model-unknown" : "model-not-enabled");
		if (entry.problems.length > 0) return deny("config-invalid", entry);
		if (!entry.enabled) return deny("model-not-enabled", entry);
		if (!FEATURES.includes(feature) || !entry[feature].enabled) return deny("feature-disabled", entry);
		if (feature === "decision") {
			if (node !== undefined && !entry.decision.nodes.includes(node)) return deny("node-disabled", entry);
		}
		return { allowed: true, reason: "enabled", reasonText: "", policy: entry };
	}

	/**
	 * Configuration version stamp used to discard in-flight Jev results whose
	 * configuration changed underneath them.
	 * @param {object} section - raw settings section.
	 * @returns {string} a stable stamp of the effective configuration.
	 */
	function configVersion(section) {
		const normalized = normalizeSection(section);
		return JSON.stringify({ g: normalized.global, m: normalized.models.map((model) => ({ ...model, problems: undefined })) });
	}

	/**
	 * Every configuration problem, for the settings page's status area.
	 * @param {object} section - raw settings section.
	 * @returns {{ path: string, message: string }[]} detached problem list.
	 */
	function validateSection(section) {
		const source = isPlainObject(section) ? section : {};
		const normalized = normalizeSection(section);
		const problems = [];
		if (source.timeoutMs !== undefined && parseNumber(source.timeoutMs) === undefined) problems.push({ path: "timeoutMs", message: "timeoutMs 必须是数字（毫秒）" });
		if (source.callBudgetPerStep !== undefined && parseNumber(source.callBudgetPerStep) === undefined) problems.push({ path: "callBudgetPerStep", message: "callBudgetPerStep 必须是数字" });
		if (source.callBudgetPerTask !== undefined && parseNumber(source.callBudgetPerTask) === undefined) problems.push({ path: "callBudgetPerTask", message: "callBudgetPerTask 必须是数字" });
		for (const model of normalized.models) {
			for (const message of model.problems) problems.push({ path: model.key, message });
		}
		return problems;
	}

	return {
		NAMESPACE,
		ROUTE_PREFIX,
		FEATURES,
		DECISION_NODES,
		QUESTION_TYPES,
		DEFAULTS,
		REASONS,
		isPlainObject,
		isRatio,
		routeKey,
		normalizeModel,
		normalizeSection,
		validateModel,
		findModel,
		gate,
		configVersion,
		validateSection
	};
})();
//#endregion

export default rules;
