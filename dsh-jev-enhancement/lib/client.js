window.__ModuleLoader__.load({
	id: "dsh-jev-enhancement",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const React = react;
		const h = React.createElement;
		//#region lib/client.js
		/** Stable Cordis plugin name; also the settings namespace and route prefix. */
		const name = "jev-enhancement";
		/** Slots mount the settings section; every ctx service is declared here (cordis rejects undeclared access). */
		const inject = ["slots", "sessions", "settingsScope", "remote", "remote.credentials", "remote.session"];

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

		/** Page stylesheet (alias tokens, mirroring the shipped settings skins). */
		const CSS = '.dsh-jev-page{flex-direction:column;gap:16px;display:flex}' +
			'.dsh-jev-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:12px}' +
			'.dsh-jev-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4;margin:0}' +
			'.dsh-jev-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;margin:0}' +
			'.dsh-jev-warn{color:var(--dsw-alias-state-warning-primary,#d97706);font-size:12px;line-height:1.5;margin:0}' +
			'.dsh-jev-error{color:var(--dsw-alias-label-error);font-size:12px;line-height:1.5;margin:0}' +
			'.dsh-jev-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:0}' +
			'.dsh-jev-row{align-items:center;gap:8px;display:flex;flex-wrap:wrap}' +
			'.dsh-jev-label{min-width:max-content;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5;white-space:nowrap;word-break:keep-all}' +
			'.dsh-jev-badge{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;white-space:nowrap}' +
			'.dsh-jev-badgeOn{color:var(--dsw-alias-state-success-primary,#10b981)}' +
			'.dsh-jev-input{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:220px;box-sizing:border-box}' +
			'.dsh-jev-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}' +
			'.dsh-jev-field{flex-direction:column;gap:6px;display:flex}' +
			'.dsh-jev-textarea{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:13px;line-height:1.5;width:100%;min-height:72px;box-sizing:border-box;resize:vertical;font-family:monospace}' +
			'.dsh-jev-textarea:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}' +
			'.dsh-jev-textarea:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}' +
			'.dsh-jev-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:0 0}' +
			'.dsh-jev-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}' +
			'.dsh-jev-btnPrimary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:transparent}' +
			'.dsh-jev-btn:disabled{opacity:.4;cursor:default}' +
			'.dsh-jev-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}' +
			'.dsh-jev-seg{display:flex;gap:8px;flex-wrap:wrap}' +
			'.dsh-jev-segbtn{appearance:none;font:inherit;box-sizing:border-box;padding:3px 12px;border-radius:14px;font-size:12px;line-height:1.6;cursor:pointer;background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary)}' +
			'.dsh-jev-segbtn.on{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}' +
			'.dsh-jev-group{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:12px;display:flex;flex-direction:column;gap:8px}' +
			'.dsh-jev-modelRow{align-items:center;gap:8px;display:flex;flex-wrap:wrap;border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;padding:8px 12px}' +
			'.dsh-jev-modelRowActive{border-color:var(--dsw-alias-label-dimmed)}' +
			'.dsh-jev-modelList{flex-direction:column;gap:4px;display:flex}' +
			'.dsh-jev-providerHead{align-items:baseline;gap:8px;display:flex}' +
			'.dsh-jev-providerName{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.5}' +
			'.dsh-jev-providerId{color:var(--dsw-alias-label-tertiary);font-family:monospace;font-size:11px;line-height:1.5}' +
			'.dsh-jev-modelMain{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}' +
			'.dsh-jev-modelName{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}' +
			'.dsh-jev-modelId{color:var(--dsw-alias-label-tertiary);font-family:monospace;font-size:11px;line-height:1.5}' +
			'.dsh-jev-rowActions{align-items:center;gap:8px;margin-left:auto;display:inline-flex}' +
			'.dsh-jev-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px}' +
			'.dsh-jev-check{align-items:center;gap:6px;display:inline-flex;font-size:13px;color:var(--dsw-alias-label-primary)}';

		/** Privacy boundary shown next to the global switch (plan §9). */
		const PRIVACY_NOTICE = "启用即表示同意：为完成判断，必要的上下文片段会发送到 TypeSafe（api.typesafe.ai）。密钥、凭据与禁止外发的内容不会发送；不需要时请保持关闭。";
		const COPY = {
			globalTitle: "全局设置",
			globalDescription: "总开关默认关闭。关闭或未选择模型时，DSH 完全走原生流程，不发起任何 Jev 调用。",
			enabled: "Jev 总开关",
			credentialRef: "凭据引用",
			credentialHint: "指向宿主密钥存储或环境变量（如 TYPESAFE_API_KEY），不存明文密钥。",
			apiKey: "API Key",
			keyHint: "写入凭据域，不写入设置文件。留空表示保持当前密钥。",
			keySet: "已配置密钥",
			keyUnset: "未配置密钥",
			jevModel: "Jev 模型",
			jevModelHint: "与被增强的 DSH 模型分离；可填版本号（jev-1.13.0）以固定行为。",
			timeout: "Jev 超时（毫秒）",
			budgetStep: "每步调用预算",
			budgetTask: "每任务调用预算",
			modelsTitle: "模型列表",
			modelsDescription: "自动读取 DSH 已配置的模型（按 Provider 分组）；仅精确匹配 providerId+modelId 的模型会启用增强，未启用的模型走「原生流程」。",
			loading: "正在读取已配置模型…",
			catalogEmpty: "未检测到已配置模型；请先在「设置 → 模型」中配置模型。",
			catalogError: "模型目录读取失败，可点「刷新」重试；为避免误配，不支持手动添加模型。",
			staleGroup: "已保存但当前未检测到的模型",
			staleHint: "这些配置对应的模型已不在当前模型目录中，可保留或删除。",
			selectHint: "在上方选择一个模型，配置它的压缩与决策策略。",
			remove: "删除配置",
			edit: "配置策略",
			selected: "配置中",
			native: "原生流程",
			enabledBadge: "Jev 增强",
			policyTitle: "模型策略",
			policyDescription: "Context Compaction 与 Decision Assistance 互不依赖，可分别开启。",
			compaction: "Context Compaction（原文筛选）",
			compactionMode: "模式",
			observe: "观察（只记录建议）",
			active: "启用筛选",
			triggerRatio: "触发阈值 triggerRatio",
			targetRatio: "目标占用 targetRatio",
			keepRecent: "保留最近消息数 keepRecentMessages",
			maxRemoval: "单次最多移除比例 maxRemovalRatio",
			minInterval: "最小间隔步数 minIntervalSteps",
			acceptChoice: "删除采纳门槛（Choice 置信度）",
			acceptNoul: "删除采纳门槛（Noul 值）",
			decision: "Decision Assistance（结构化决策）",
			nodes: "允许介入的节点",
			fault: "故障分类",
			route: "路线选择",
			risk: "风险判断",
			faultConfidence: "故障分类采纳门槛",
			faultRetries: "额外重试上限",
			routeConfidence: "路线选择采纳门槛",
			routeCandidates: "候选路线（每行一条 provider/model）",
			routeCandidatesHint: "只接受白名单内的路线，且必须是 DSH 已注册适配器的 Provider；留空表示不切换路线。",
			riskNoul: "风险判断采纳门槛（Noul 值）",
			statusTitle: "状态反馈",
			statusDescription: "配置校验、增强不可用原因与回退状态；不显示密钥或敏感上下文。",
			test: "测试连接",
			testing: "测试中…",
			exportLog: "导出日志",
			save: "保存",
			discard: "放弃修改",
			saving: "保存中…",
			saved: "已保存",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			invalid: "配置校验未通过，请修正后再保存。",
			readOnly: "本部署的设置为只读。",
			unsaved: "未保存",
			globalOff: "全部增强均不生效（总开关关闭）",
			modelOff: "该模型已关闭，增强不生效"
		};

		/** Wait for the settings mirror to publish a completed write. */
		const SETTINGS_SETTLE_MS = 250;
		function settingsApplied(host, ops) {
			const stored = host.getSnapshot().value ?? {};
			return ops.every((op) => Object.is(JSON.stringify(stored[op.path[0]]), JSON.stringify(op.value)));
		}
		function waitForSettings(host, ops) {
			if (ops.length === 0 || settingsApplied(host, ops)) return Promise.resolve();
			return new Promise((resolve, reject) => {
				let settled = false;
				let timer;
				let dispose = () => {};
				const finish = (error) => {
					if (settled) return;
					settled = true;
					if (timer !== undefined) clearTimeout(timer);
					dispose();
					if (error === undefined) resolve();
					else reject(error);
				};
				dispose = host.subscribe(() => {
					if (settingsApplied(host, ops)) finish();
				});
				timer = setTimeout(() => finish(new Error("settings write was not published")), SETTINGS_SETTLE_MS);
			});
		}

		/** One labeled numeric/text field. */
		function Field(props) {
			return h("div", { className: "dsh-jev-row", key: props.label },
				h("span", { className: "dsh-jev-label" }, props.label),
				h("input", {
					className: "dsh-jev-input",
					type: "text",
					inputMode: props.numeric === true ? "decimal" : "text",
					disabled: props.disabled === true,
					value: String(props.value ?? ""),
					onChange: (event) => props.onChange(props.numeric === true ? event.target.value : event.target.value)
				}),
				props.hint === undefined ? null : h("p", { className: "dsh-jev-hint", style: { flexBasis: "100%" } }, props.hint)
			);
		}

		/** One on/off pill. */
		function Toggle(props) {
			return h("button", {
				type: "button",
				disabled: props.disabled === true,
				className: "dsh-jev-segbtn" + (props.value ? " on" : ""),
				onClick: () => props.onChange(!props.value)
			}, props.value ? "开" : "关");
		}

		/** One checkbox over the decision-node whitelist. */
		function Check(props) {
			return h("label", { className: "dsh-jev-check" },
				h("input", {
					type: "checkbox",
					disabled: props.disabled === true,
					checked: props.value,
					onChange: (event) => props.onChange(event.target.checked)
				}),
				props.label
			);
		}

		/** Model policy editor for one exact provider/model entry. */
		function ModelPolicy(props) {
			const model = props.model;
			const disabled = props.disabled === true;
			const editCompaction = (field, value) => props.onEdit({ compaction: { ...model.compaction, [field]: value } });
			const editAcceptance = (field, value) => props.onEdit({
				compaction: { ...model.compaction, removalAcceptance: { ...model.compaction.removalAcceptance, [field]: value } }
			});
			const editNode = (node, on) => {
				const nodes = on ? [...new Set([...model.decision.nodes, node])] : model.decision.nodes.filter((entry) => entry !== node);
				props.onEdit({ decision: { ...model.decision, nodes } });
			};
			const editByNode = (node, field, value) => props.onEdit({
				decision: {
					...model.decision,
					acceptanceByNode: {
						...model.decision.acceptanceByNode,
						[node]: { ...model.decision.acceptanceByNode[node], [field]: value }
					}
				}
			});
			const candidates = model.decision.acceptanceByNode.routeSelection.candidates
				.map((candidate) => candidate.provider + "/" + candidate.model)
				.join("\n");
			return h("div", { className: "dsh-jev-card" },
				h("h3", { className: "dsh-jev-title" }, COPY.policyTitle + " · " + model.providerId + "/" + model.modelId),
				h("p", { className: "dsh-jev-description" }, COPY.policyDescription),
				props.globalEnabled ? null : h("p", { className: "dsh-jev-warn" }, COPY.globalOff),
				model.enabled ? null : h("p", { className: "dsh-jev-warn" }, COPY.modelOff),
				h("div", { className: "dsh-jev-group" },
					h("div", { className: "dsh-jev-row" },
						h("span", { className: "dsh-jev-label" }, COPY.compaction),
						h(Toggle, { disabled, value: model.compaction.enabled, onChange: (value) => editCompaction("enabled", value) })
					),
					h("div", { className: "dsh-jev-row" },
						h("span", { className: "dsh-jev-label" }, COPY.compactionMode),
						h("span", { className: "dsh-jev-seg" },
							h("button", {
								type: "button", disabled: disabled || !model.compaction.enabled,
								className: "dsh-jev-segbtn" + (model.compaction.mode !== "active" ? " on" : ""),
								onClick: () => editCompaction("mode", "observe")
							}, COPY.observe),
							h("button", {
								type: "button", disabled: disabled || !model.compaction.enabled,
								className: "dsh-jev-segbtn" + (model.compaction.mode === "active" ? " on" : ""),
								onClick: () => editCompaction("mode", "active")
							}, COPY.active)
						)
					),
					h(Field, { label: COPY.triggerRatio, numeric: true, disabled: disabled || !model.compaction.enabled, value: model.compaction.triggerRatio, onChange: (value) => editCompaction("triggerRatio", value) }),
					h(Field, { label: COPY.targetRatio, numeric: true, disabled: disabled || !model.compaction.enabled, value: model.compaction.targetRatio, onChange: (value) => editCompaction("targetRatio", value) }),
					h(Field, { label: COPY.keepRecent, numeric: true, disabled: disabled || !model.compaction.enabled, value: model.compaction.keepRecentMessages, onChange: (value) => editCompaction("keepRecentMessages", value) }),
					h(Field, { label: COPY.maxRemoval, numeric: true, disabled: disabled || !model.compaction.enabled, value: model.compaction.maxRemovalRatio, onChange: (value) => editCompaction("maxRemovalRatio", value) }),
					h(Field, { label: COPY.minInterval, numeric: true, disabled: disabled || !model.compaction.enabled, value: model.compaction.minIntervalSteps, onChange: (value) => editCompaction("minIntervalSteps", value) }),
					h(Field, { label: COPY.acceptChoice, numeric: true, disabled: disabled || !model.compaction.enabled, value: model.compaction.removalAcceptance.choice, onChange: (value) => editAcceptance("choice", value) }),
					h(Field, { label: COPY.acceptNoul, numeric: true, disabled: disabled || !model.compaction.enabled, value: model.compaction.removalAcceptance.noul, onChange: (value) => editAcceptance("noul", value) })
				),
				h("div", { className: "dsh-jev-group" },
					h("div", { className: "dsh-jev-row" },
						h("span", { className: "dsh-jev-label" }, COPY.decision),
						h(Toggle, { disabled, value: model.decision.enabled, onChange: (value) => props.onEdit({ decision: { ...model.decision, enabled: value } }) })
					),
					h("div", { className: "dsh-jev-row" },
						h("span", { className: "dsh-jev-label" }, COPY.nodes),
						h(Check, { label: COPY.fault, disabled: disabled || !model.decision.enabled, value: model.decision.nodes.includes("fault-classification"), onChange: (on) => editNode("fault-classification", on) }),
						h(Check, { label: COPY.route, disabled: disabled || !model.decision.enabled, value: model.decision.nodes.includes("route-selection"), onChange: (on) => editNode("route-selection", on) }),
						h(Check, { label: COPY.risk, disabled: disabled || !model.decision.enabled, value: model.decision.nodes.includes("risk-judgment"), onChange: (on) => editNode("risk-judgment", on) })
					),
					h(Field, { label: COPY.faultConfidence, numeric: true, disabled: disabled || !model.decision.enabled, value: model.decision.acceptanceByNode.faultClassification.minConfidence, onChange: (value) => editByNode("faultClassification", "minConfidence", value) }),
					h(Field, { label: COPY.faultRetries, numeric: true, disabled: disabled || !model.decision.enabled, value: model.decision.acceptanceByNode.faultClassification.maxExtraRetries, onChange: (value) => editByNode("faultClassification", "maxExtraRetries", value) }),
					h(Field, { label: COPY.routeConfidence, numeric: true, disabled: disabled || !model.decision.enabled, value: model.decision.acceptanceByNode.routeSelection.minConfidence, onChange: (value) => editByNode("routeSelection", "minConfidence", value) }),
					h("div", { className: "dsh-jev-field" },
						h("span", { className: "dsh-jev-label" }, COPY.routeCandidates),
						h("textarea", {
							className: "dsh-jev-textarea",
							disabled: disabled || !model.decision.enabled,
							placeholder: "deepseek/deepseek-reasoner\nopenai/gpt-5",
							value: candidates,
							onChange: (event) => {
								const parsed = event.target.value.split("\n").map((line) => line.trim()).filter((line) => line.includes("/")).map((line) => {
									const index = line.indexOf("/");
									return { provider: line.slice(0, index), model: line.slice(index + 1) };
								});
								editByNode("routeSelection", "candidates", parsed);
							}
						}),
						h("p", { className: "dsh-jev-hint" }, COPY.routeCandidatesHint)
					),
					h(Field, { label: COPY.riskNoul, numeric: true, disabled: disabled || !model.decision.enabled, value: model.decision.acceptanceByNode.riskJudgment.minNoul, onChange: (value) => editByNode("riskJudgment", "minNoul", value) })
				)
			);
		}

		/**
		 * Merge the host model catalog with the saved policies: one row per
		 * configured model (grouped by provider), plus saved policies whose model
		 * is no longer configured — visible and removable, never added by hand.
		 * @param {object | null} catalog - the `remote.session.modelCatalog()` value.
		 * @param {object[]} models - normalized saved model policies.
		 * @returns {{ groups: object[], stale: object[] }} the roster to render.
		 */
		function rosterGroups(catalog, models) {
			const rowFor = (providerId, modelId, modelName, stale) => {
				const key = rules.routeKey(providerId, modelId);
				const policy = models.find((entry) => entry.key === key) ?? rules.normalizeModel({ providerId, modelId });
				return { key, providerId, modelId, modelName: modelName || modelId, policy, stale };
			};
			const groups = [];
			const seen = new Set();
			for (const group of catalog?.groups ?? []) {
				const list = [];
				for (const model of group.models ?? []) {
					const row = rowFor(group.id, model.id, model.name ?? "", false);
					seen.add(row.key);
					list.push(row);
				}
				if (list.length > 0) groups.push({ providerId: group.id, providerName: group.name || group.id, models: list });
			}
			const stale = models.filter((entry) => !seen.has(entry.key)).map((entry) => rowFor(entry.providerId, entry.modelId, "", true));
			return { groups, stale };
		}

		/**
		 * The Jev enhancement settings section: global settings, the exact-route
		 * model list, per-model policies, and the status feedback area.
		 */
		function SettingsPage(props) {
			const host = props.host;
			const remote = props.remote;
			const writable = host.getSnapshot().writable !== false;
			const [section, setSection] = React.useState(() => host.getSnapshot().value ?? {});
			const [draft, setDraft] = React.useState(() => rules.normalizeSection(host.getSnapshot().value ?? {}));
			const [dirty, setDirty] = React.useState(false);
			const [saving, setSaving] = React.useState(false);
			const [failed, setFailed] = React.useState(false);
			const [keyDraft, setKeyDraft] = React.useState("");
			const [keyConfigured, setKeyConfigured] = React.useState(false);
			const [selectedKey, setSelectedKey] = React.useState(null);
			const [status, setStatus] = React.useState(null);
			const [testState, setTestState] = React.useState(null);
			const [catalog, setCatalog] = React.useState(null);
			const [catalogError, setCatalogError] = React.useState(false);
			const problems = rules.validateSection(sectionShape(draft));
			const roster = rosterGroups(catalog, draft.models);
			const model = draft.models.find((entry) => entry.key === selectedKey);

			React.useEffect(() => host.subscribe(() => {
				const value = host.getSnapshot().value ?? {};
				setSection(value);
				if (!dirty && !saving) setDraft(rules.normalizeSection(value));
			}), [host, dirty, saving]);
			React.useEffect(() => {
				const ref = draft.global.credentialRef;
				remote.credentials.describe([ref]).then((response) => {
					if (response?.ok) setKeyConfigured(response.value?.[ref]?.configured === true);
				}).catch(() => {});
			}, [remote, draft.global.credentialRef]);
			const refreshStatus = React.useCallback(() => {
				fetch(rules.ROUTE_PREFIX + "/status", { cache: "no-store" }).then((response) => response.json()).then(setStatus).catch(() => setStatus(null));
				remote.session.modelCatalog().then((response) => {
					if (response?.ok) {
						setCatalog(response.value);
						setCatalogError(false);
					} else setCatalogError(true);
				}).catch(() => setCatalogError(true));
			}, [remote]);
			React.useEffect(() => { refreshStatus(); }, [refreshStatus]);

			const editGlobal = (field, value) => {
				setDraft((prev) => ({ ...prev, global: { ...prev.global, [field]: value } }));
				setDirty(true);
			};
			const editModel = (key, patch) => {
				setDraft((prev) => ({
					...prev,
					models: prev.models.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry))
				}));
				setDirty(true);
			};
			/** Enable or disable one catalog model; its policy survives being disabled (plan §4.1). */
			const toggleModel = (providerId, modelId, on) => {
				const key = rules.routeKey(providerId, modelId);
				setDraft((prev) => {
					const exists = prev.models.some((entry) => entry.key === key);
					const models = exists
						? prev.models.map((entry) => (entry.key === key ? { ...entry, enabled: on } : entry))
						: [...prev.models, rules.normalizeModel({ providerId, modelId, enabled: on })];
					return { ...prev, models };
				});
				if (on && selectedKey === null) setSelectedKey(key);
				setDirty(true);
			};
			const removeModel = (key) => {
				setDraft((prev) => ({ ...prev, models: prev.models.filter((entry) => entry.key !== key) }));
				if (selectedKey === key) setSelectedKey(null);
				setDirty(true);
			};
			const save = async () => {
				if (!writable || !dirty || problems.length > 0 || saving) return;
				setSaving(true);
				setFailed(false);
				try {
					const target = sectionShape(draft);
					const ops = [];
					for (const field of Object.keys(target)) {
						if (JSON.stringify(target[field]) === JSON.stringify(section[field])) continue;
						ops.push({ op: "set", path: [field], value: target[field] });
					}
					if (ops.length > 0) {
						await host.mutate(ops);
						await waitForSettings(host, ops);
					}
					if (keyDraft.length > 0) {
						const response = await remote.credentials.set(draft.global.credentialRef, keyDraft);
						if (!response.ok) throw new Error(response.error?.message ?? "credential write failed");
						setKeyDraft("");
						setKeyConfigured(true);
					}
					setDirty(false);
				} catch {
					setFailed(true);
				} finally {
					setSaving(false);
					refreshStatus();
				}
			};
			const runTest = async () => {
				setTestState("testing");
				try {
					const response = await fetch(rules.ROUTE_PREFIX + "/test", {
						method: "POST",
						headers: { "x-jev-enhancement": "1" }
					});
					const body = await response.json();
					setTestState(body);
				} catch {
					setTestState({ ok: false, error: { code: "transport" } });
				}
				refreshStatus();
			};
			const runRestore = async () => {
				try {
					/* Resolved at click time: the current session changes while the page is open. */
					const sessionId = props.sessions?.list?.getSnapshot?.().current;
					if (typeof sessionId !== "string" || sessionId === "") {
						refreshStatus();
						return;
					}
					await fetch(rules.ROUTE_PREFIX + "/restore", {
						method: "POST",
						headers: { "content-type": "application/json", "x-jev-enhancement": "1" },
						body: JSON.stringify({ sessionId })
					});
				} catch {
					/* the status surface reports the outcome */
				}
				refreshStatus();
			};
			const runExport = async () => {
				try {
					const response = await fetch(rules.ROUTE_PREFIX + "/log", { headers: { "x-jev-enhancement": "1" }, cache: "no-store" });
					if (!response.ok) return;
					const blob = await response.blob();
					const url = URL.createObjectURL(blob);
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = "jev-enhancement-audit-" + new Date().toISOString().slice(0, 10) + ".jsonl";
					anchor.click();
					URL.revokeObjectURL(url);
				} catch {
					/* exporting is best effort */
				}
			};
			const blocked = !writable || !dirty || problems.length > 0 || saving;

			/** Compact feature summary shown on an enabled row. */
			const featureSummary = (policy) => {
				const parts = [];
				if (policy.compaction.enabled) parts.push(policy.compaction.mode === "active" ? "筛选" : "观察");
				if (policy.decision.enabled) parts.push("决策" + (policy.decision.nodes.length > 0 ? "×" + policy.decision.nodes.length : ""));
				return COPY.enabledBadge + (parts.length > 0 ? "（" + parts.join(" · ") + "）" : "");
			};
			/** One model row: name + id, state badge, toggle, and policy entry. */
			const modelRow = (row) => h("div", { className: "dsh-jev-modelRow" + (row.key === selectedKey ? " dsh-jev-modelRowActive" : ""), key: row.key },
				h("div", { className: "dsh-jev-modelMain" },
					h("span", { className: "dsh-jev-modelName" }, row.modelName),
					h("span", { className: "dsh-jev-modelId" }, row.providerId + "/" + row.modelId)
				),
				h("span", { className: "dsh-jev-badge" + (row.policy.enabled ? " dsh-jev-badgeOn" : "") }, row.policy.enabled ? featureSummary(row.policy) : COPY.native),
				h("span", { className: "dsh-jev-rowActions" },
					h(Toggle, { disabled: !writable, value: row.policy.enabled === true, onChange: (value) => toggleModel(row.providerId, row.modelId, value) }),
					h("button", { type: "button", className: "dsh-jev-btn", onClick: () => setSelectedKey(row.key) }, row.key === selectedKey ? COPY.selected : COPY.edit),
					row.stale === true ? h("button", { type: "button", className: "dsh-jev-btn", disabled: !writable, onClick: () => removeModel(row.key) }, COPY.remove) : null
				)
			);

			return h("div", { className: "dsh-jev-page" },
				h("div", { className: "dsh-jev-card" },
					h("h3", { className: "dsh-jev-title" }, COPY.globalTitle),
					h("p", { className: "dsh-jev-description" }, COPY.globalDescription),
					h("p", { className: "dsh-jev-warn" }, PRIVACY_NOTICE),
					h("div", { className: "dsh-jev-row" },
						h("span", { className: "dsh-jev-label" }, COPY.enabled),
						h(Toggle, { disabled: !writable, value: draft.global.enabled, onChange: (value) => editGlobal("enabled", value) }),
						draft.global.enabled ? null : h("span", { className: "dsh-jev-badge" }, COPY.globalOff)
					),
					h(Field, { label: COPY.credentialRef, disabled: !writable, value: draft.global.credentialRef, hint: COPY.credentialHint, onChange: (value) => editGlobal("credentialRef", value) }),
					h("div", { className: "dsh-jev-row" },
						h("span", { className: "dsh-jev-label" }, COPY.apiKey),
						h("span", { className: "dsh-jev-badge" + (keyConfigured ? " dsh-jev-badgeOn" : "") }, keyConfigured ? COPY.keySet : COPY.keyUnset),
						h("input", {
							className: "dsh-jev-input", type: "password", disabled: !writable,
							placeholder: "留空保持当前密钥", value: keyDraft,
							onChange: (event) => { setKeyDraft(event.target.value); setDirty(true); }
						})
					),
					h("p", { className: "dsh-jev-hint" }, COPY.keyHint),
					h(Field, { label: COPY.jevModel, disabled: !writable, value: draft.global.jevModel, hint: COPY.jevModelHint, onChange: (value) => editGlobal("jevModel", value) }),
					h(Field, { label: COPY.timeout, numeric: true, disabled: !writable, value: draft.global.timeoutMs, onChange: (value) => editGlobal("timeoutMs", value) }),
					h(Field, { label: COPY.budgetStep, numeric: true, disabled: !writable, value: draft.global.callBudgetPerStep, onChange: (value) => editGlobal("callBudgetPerStep", value) }),
					h(Field, { label: COPY.budgetTask, numeric: true, disabled: !writable, value: draft.global.callBudgetPerTask, onChange: (value) => editGlobal("callBudgetPerTask", value) }),
					h("div", { className: "dsh-jev-row" },
						h("span", { className: "dsh-jev-label" }, dirty ? COPY.unsaved : ""),
						h("button", { type: "button", className: "dsh-jev-btn", disabled: blocked, onClick: () => { setDraft(rules.normalizeSection(section)); setKeyDraft(""); setDirty(false); setFailed(false); } }, COPY.discard),
						h("button", { type: "button", className: "dsh-jev-btn dsh-jev-btnPrimary", disabled: blocked, onClick: save }, saving ? COPY.saving : COPY.save),
						failed ? h("p", { className: "dsh-jev-error", role: "status" }, COPY.saveFailed) : null,
						problems.length > 0 ? h("p", { className: "dsh-jev-error", role: "status" }, COPY.invalid) : null
					)
				),
				h("div", { className: "dsh-jev-card" },
					h("h3", { className: "dsh-jev-title" }, COPY.modelsTitle),
					h("p", { className: "dsh-jev-description" }, COPY.modelsDescription),
					catalogError ? h("p", { className: "dsh-jev-warn", role: "status" }, COPY.catalogError) : null,
					catalog === null && !catalogError ? h("p", { className: "dsh-jev-hint" }, COPY.loading) : null,
					h("div", { className: "dsh-jev-modelList" },
						roster.groups.map((group) => h("div", { className: "dsh-jev-group", key: group.providerId },
							h("div", { className: "dsh-jev-providerHead" },
								h("span", { className: "dsh-jev-providerName" }, group.providerName),
								h("span", { className: "dsh-jev-providerId" }, group.providerId)
							),
							group.models.map(modelRow)
						)),
						roster.stale.length > 0 ? h("div", { className: "dsh-jev-group" },
							h("div", { className: "dsh-jev-providerHead" }, h("span", { className: "dsh-jev-providerName" }, COPY.staleGroup)),
							h("p", { className: "dsh-jev-hint" }, COPY.staleHint),
							roster.stale.map(modelRow)
						) : null,
						catalog !== null && roster.groups.length === 0 && roster.stale.length === 0
							? h("p", { className: "dsh-jev-hint" }, COPY.catalogEmpty)
							: null
					)
				),
				model === undefined
					? h("div", { className: "dsh-jev-card" },
						h("h3", { className: "dsh-jev-title" }, COPY.policyTitle),
						h("p", { className: "dsh-jev-hint" }, COPY.selectHint)
					)
					: h(ModelPolicy, {
						model,
						globalEnabled: draft.global.enabled,
						disabled: !writable,
						onEdit: (patch) => editModel(model.key, patch)
					}),
				h("div", { className: "dsh-jev-card" },
					h("h3", { className: "dsh-jev-title" }, COPY.statusTitle),
					h("p", { className: "dsh-jev-description" }, COPY.statusDescription),
					problems.map((problem) => h("p", { className: "dsh-jev-error", key: problem.path + problem.message }, problem.path + "：" + problem.message)),
					status === null ? h("p", { className: "dsh-jev-hint" }, "—") : h("div", null,
						h("p", { className: "dsh-jev-hint" },
							"版本 " + status.version + " · " + (status.enabled ? "总开关已开启" : "总开关已关闭") +
							(status.circuit?.open ? " · 熔断中（" + Math.ceil(status.circuit.remainingMs / 1000) + "s）" : "")),
						h("p", { className: status.unavailable?.length > 0 ? "dsh-jev-warn" : "dsh-jev-hint" },
							status.unavailable?.length > 0 ? "增强不可用：" + status.unavailable.join("、") : "增强可用（按模型与功能门控）"),
						h("p", { className: "dsh-jev-hint" },
							"Jev 调用 " + (status.audit?.counters?.jevCalls ?? 0) + " 次 · 失败 " + (status.audit?.counters?.jevCallFailures ?? 0) +
							" 次 · 回退原生 " + (status.audit?.counters?.nativeFallbacks ?? 0) + " 次 · 已筛选 ~" + (status.audit?.counters?.tokensRemoved ?? 0) + " tokens")
					),
					h("div", { className: "dsh-jev-row" },
						h("button", { type: "button", className: "dsh-jev-btn", onClick: runTest, disabled: testState === "testing" }, testState === "testing" ? COPY.testing : COPY.test),
						testState !== null && testState !== "testing"
							? h("span", { className: "dsh-jev-badge" + (testState.ok ? " dsh-jev-badgeOn" : "") },
								testState.ok ? "连接正常（" + (testState.model || "jev") + "，" + testState.latencyMs + "ms）" : "连接失败：" + (testState.error?.code ?? "unavailable"))
							: null,
						h("button", { type: "button", className: "dsh-jev-btn", onClick: runRestore }, "一键恢复当前会话"),
						h("button", { type: "button", className: "dsh-jev-btn", onClick: runExport }, COPY.exportLog),
						h("button", { type: "button", className: "dsh-jev-btn", onClick: refreshStatus }, "刷新")
					)
				)
			);
		}

		/** Rebuild the raw settings shape the schema stores from a normalized draft. */
		function sectionShape(draft) {
			return {
				enabled: draft.global.enabled,
				credentialRef: draft.global.credentialRef,
				jevModel: draft.global.jevModel,
				timeoutMs: Number(draft.global.timeoutMs),
				callBudgetPerStep: Number(draft.global.callBudgetPerStep),
				callBudgetPerTask: Number(draft.global.callBudgetPerTask),
				models: draft.models.map((model) => ({
					providerId: model.providerId,
					modelId: model.modelId,
					enabled: model.enabled,
					compaction: {
						enabled: model.compaction.enabled,
						mode: model.compaction.mode,
						triggerRatio: Number(model.compaction.triggerRatio),
						targetRatio: Number(model.compaction.targetRatio),
						keepRecentMessages: Number(model.compaction.keepRecentMessages),
						maxRemovalRatio: Number(model.compaction.maxRemovalRatio),
						minIntervalSteps: Number(model.compaction.minIntervalSteps),
						removalAcceptance: {
							choice: Number(model.compaction.removalAcceptance.choice),
							noul: Number(model.compaction.removalAcceptance.noul)
						}
					},
					decision: {
						enabled: model.decision.enabled,
						nodes: [...model.decision.nodes],
						acceptanceByNode: {
							faultClassification: {
								minConfidence: Number(model.decision.acceptanceByNode.faultClassification.minConfidence),
								maxExtraRetries: Number(model.decision.acceptanceByNode.faultClassification.maxExtraRetries)
							},
							routeSelection: {
								minConfidence: Number(model.decision.acceptanceByNode.routeSelection.minConfidence),
								candidates: model.decision.acceptanceByNode.routeSelection.candidates.map((candidate) => ({ provider: candidate.provider, model: candidate.model }))
							},
							riskJudgment: {
								minNoul: Number(model.decision.acceptanceByNode.riskJudgment.minNoul)
							}
						}
					}
				}))
			};
		}

		/**
		 * Client plugin body: the Jev 增强 settings section plus its stylesheet.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const host = ctx.settingsScope.bind({ namespace: name });
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.textContent = CSS;
				document.head.append(tag);
				return () => tag.remove();
			}, "jev-enhancement: styles");
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: name, order: 36, label: "Jev 增强" },
				() => h(SettingsPage, { host, remote: ctx.remote, sessions: ctx.sessions })
			));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		exports.testing = { ModelPolicy, SettingsPage, rosterGroups, sectionShape };
		return module.exports;
	}
});
