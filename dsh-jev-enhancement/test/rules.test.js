import test from "node:test";
import assert from "node:assert/strict";
import rules from "../lib/rules.js";

const MODEL = {
	providerId: "deepseek",
	modelId: "deepseek-chat",
	enabled: true,
	compaction: {
		enabled: true,
		mode: "active",
		triggerRatio: 0.7,
		targetRatio: 0.5,
		keepRecentMessages: 4,
		maxRemovalRatio: 0.5,
		minIntervalSteps: 2,
		removalAcceptance: { choice: 0.8, noul: 0.8 }
	},
	decision: {
		enabled: true,
		nodes: ["fault-classification"],
		acceptanceByNode: {
			faultClassification: { minConfidence: 0.7, maxExtraRetries: 1 },
			routeSelection: { minConfidence: 0.7, candidates: [{ provider: "deepseek", model: "deepseek-reasoner" }] },
			riskJudgment: { minNoul: 0.7 }
		}
	}
};

function section(patch = {}) {
	return {
		enabled: true,
		models: [structuredClone(MODEL)],
		...patch
	};
}

test("global switch is off by default and gates everything", () => {
	const gate = rules.gate({}, "deepseek", "deepseek-chat", "compaction");
	assert.equal(gate.allowed, false);
	assert.equal(gate.reason, "global-disabled");
	assert.deepEqual(rules.normalizeSection({}).global.enabled, false);
});

test("switch matrix: global off wins over an enabled model and enabled features", () => {
	const gate = rules.gate({ ...section({ enabled: false }) }, "deepseek", "deepseek-chat", "compaction");
	assert.equal(gate.allowed, false);
	assert.equal(gate.reason, "global-disabled");
});

test("switch matrix: unconfigured and unselected models never enable", () => {
	const unconfigured = rules.gate(section(), "openai", "gpt-5", "compaction");
	assert.equal(unconfigured.allowed, false);
	assert.equal(unconfigured.reason, "model-not-enabled");
	const unselected = rules.gate(section({ models: [{ ...MODEL, enabled: false }] }), "deepseek", "deepseek-chat", "compaction");
	assert.equal(unselected.allowed, false);
	assert.equal(unselected.reason, "model-not-enabled");
});

test("same model id under another provider is a different key", () => {
	const gate = rules.gate(section(), "openai", "deepseek-chat", "compaction");
	assert.equal(gate.allowed, false);
	assert.equal(gate.reason, "model-not-enabled");
});

test("features are independent per model", () => {
	const compactionOnly = rules.gate(section({ models: [{ ...MODEL, decision: { ...MODEL.decision, enabled: false } }] }), "deepseek", "deepseek-chat", "compaction");
	assert.equal(compactionOnly.allowed, true);
	const decisionOff = rules.gate(section({ models: [{ ...MODEL, decision: { ...MODEL.decision, enabled: false } }] }), "deepseek", "deepseek-chat", "decision", "fault-classification");
	assert.equal(decisionOff.allowed, false);
	assert.equal(decisionOff.reason, "feature-disabled");
	const nodeOff = rules.gate(section(), "deepseek", "deepseek-chat", "decision", "route-selection");
	assert.equal(nodeOff.allowed, false);
	assert.equal(nodeOff.reason, "node-disabled");
	const nodeOn = rules.gate(section(), "deepseek", "deepseek-chat", "decision", "fault-classification");
	assert.equal(nodeOn.allowed, true);
});

test("config errors are isolated to the offending model", () => {
	const broken = { ...structuredClone(MODEL), compaction: { ...MODEL.compaction, targetRatio: 0.9, triggerRatio: 0.7 } };
	const healthy = { ...structuredClone(MODEL), providerId: "openai", modelId: "gpt-5" };
	const verdict = rules.gate({ enabled: true, models: [broken, healthy] }, "deepseek", "deepseek-chat", "compaction");
	assert.equal(verdict.allowed, false);
	assert.equal(verdict.reason, "config-invalid");
	assert.ok(verdict.policy.problems.some((problem) => problem.includes("targetRatio")));
	const other = rules.gate({ enabled: true, models: [broken, healthy] }, "openai", "gpt-5", "compaction");
	assert.equal(other.allowed, true);
});

test("defaults fill only what an enabled model omits", () => {
	const normalized = rules.normalizeSection({
		enabled: true,
		models: [{ providerId: "p", modelId: "m", enabled: true, compaction: { enabled: true }, decision: { enabled: true, nodes: ["risk-judgment"] } }]
	});
	const model = normalized.models[0];
	assert.equal(model.compaction.mode, "observe");
	assert.equal(model.compaction.triggerRatio, rules.DEFAULTS.compaction.triggerRatio);
	assert.equal(model.compaction.targetRatio, rules.DEFAULTS.compaction.targetRatio);
	assert.equal(model.decision.acceptanceByNode.riskJudgment.minNoul, rules.DEFAULTS.decision.riskJudgment.minNoul);
	assert.deepEqual(model.problems, []);
});

test("unconfigured models are never implicitly enabled by defaults", () => {
	const normalized = rules.normalizeSection({ enabled: true });
	assert.deepEqual(normalized.models, []);
	const gate = rules.gate({ enabled: true }, "p", "m", "compaction");
	assert.equal(gate.allowed, false);
});

test("duplicate routes keep the first entry and report the rest", () => {
	const normalized = rules.normalizeSection({
		enabled: true,
		models: [structuredClone(MODEL), { ...structuredClone(MODEL), compaction: { ...MODEL.compaction, enabled: false } }]
	});
	assert.equal(normalized.models.length, 2);
	assert.equal(normalized.models[0].compaction.enabled, true);
	assert.equal(normalized.models[1].duplicate, true);
	assert.ok(normalized.models[1].problems.length > 0);
});

test("invalid thresholds and counters are reported, numeric strings are accepted", () => {
	const problems = rules.validateSection({
		models: [{
			providerId: "p",
			modelId: "m",
			compaction: {
				triggerRatio: "0.7",
				targetRatio: "abc",
				keepRecentMessages: -1,
				maxRemovalRatio: 2,
				minIntervalSteps: 0.5
			}
		}]
	});
	const messages = problems.map((problem) => problem.message).join(" ");
	assert.ok(messages.includes("targetRatio"));
	assert.ok(messages.includes("keepRecentMessages"));
	assert.ok(messages.includes("maxRemovalRatio"));
	assert.ok(messages.includes("minIntervalSteps"));
	assert.equal(rules.validateSection({ models: [{ providerId: "p", modelId: "m", compaction: { triggerRatio: "0.7", targetRatio: "0.4" } }] }).length, 0);
});

test("configVersion changes with policy content and is stable otherwise", () => {
	const base = section();
	assert.equal(rules.configVersion(base), rules.configVersion(structuredClone(base)));
	const changed = section();
	changed.models[0].compaction.triggerRatio = 0.6;
	assert.notEqual(rules.configVersion(base), rules.configVersion(changed));
});

test("route keys are exact provider+model identities", () => {
	assert.equal(rules.routeKey("deepseek", "chat"), "deepseek/chat");
	assert.equal(rules.findModel(section(), "deepseek", "deepseek-chat").key, "deepseek/deepseek-chat");
	assert.equal(rules.findModel(section(), "deepseek", "other"), undefined);
});
