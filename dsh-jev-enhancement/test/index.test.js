import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";
import { apply, testing } from "../lib/index.js";
import {
	addAssistantMessage,
	addToolResult,
	addUserMessage,
	createFakeSession
} from "./helpers.js";

/* The plugin's audit log writes under DSH_HOME; point it at a scratch directory. */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "jev-home-"));

/** A section that enables everything for one exact model. */
function enabledSection(patch = {}) {
	return {
		enabled: true,
		credentialRef: "TYPESAFE_API_KEY",
		jevModel: "jev-latest",
		timeoutMs: 500,
		callBudgetPerStep: 2,
		callBudgetPerTask: 10,
		models: [{
			providerId: "deepseek",
			modelId: "chat",
			enabled: true,
			compaction: {
				enabled: true,
				mode: "active",
				triggerRatio: 0.5,
				targetRatio: 0.3,
				keepRecentMessages: 0,
				maxRemovalRatio: 0.9,
				minIntervalSteps: 0,
				removalAcceptance: { choice: 0.8, noul: 0.8 }
			},
			decision: {
				enabled: true,
				nodes: ["fault-classification", "route-selection", "risk-judgment"],
				acceptanceByNode: {
					faultClassification: { minConfidence: 0.75, maxExtraRetries: 1 },
					routeSelection: { minConfidence: 0.7, candidates: [{ provider: "openai", model: "gpt" }] },
					riskJudgment: { minNoul: 0.7 }
				}
			},
			...patch
		}]
	};
}

/** Mount the plugin against a scripted host double. */
function host(section, environment, services = {}) {
	const listeners = new Map();
	const routes = new Map();
	const disposers = [];
	let installed;
	const ctx = {
		logger: { info() {}, warn() {} },
		effect(fn, label) {
			disposers.push({ dispose: fn(), label });
		},
		inject(names, callback) {
			callback({
				settings: {
					installSection(owner, namespace, schema, entry, hooks) {
						installed = { namespace, schema, hooks };
						hooks.setSource(() => entry);
						hooks.onChange();
					}
				}
			});
		},
		get(name) {
			if (name === "launchEnvironment") return environment;
			return services[name];
		},
		on(name, listener) {
			listeners.set(name, listener);
			return () => listeners.delete(name);
		},
		webServer: {
			register(route) {
				routes.set(route.path, route);
				return () => routes.delete(route.path);
			}
		}
	};
	apply(ctx, section);
	return {
		listeners,
		routes,
		installed,
		replace(value) {
			installed.hooks.setSource(() => value);
			installed.hooks.onChange();
		}
	};
}

/** An agent double routed to `deepseek/chat` over a fake session. */
function agentFor(session, options = {}) {
	return {
		options: { provider: "deepseek", model: "chat", maxTokens: 1024, ...options },
		session: Object.assign(session, {
			requestHeader: () => ({ config: { provider: "deepseek", model: "chat" } })
		})
	};
}

/** A token meter double pricing every node at 100 tokens. */
function meterWith(totalTokens) {
	return {
		measure(session) {
			const seqs = session.surface.nodes;
			const per = Math.max(1, Math.floor(totalTokens / Math.max(1, seqs.length)));
			return {
				logRevision: seqs.length,
				totalTokens,
				surfaceTokens: totalTokens,
				baseline: { kind: "none", tokens: 0 },
				surfaceDeltaTokens: 0,
				nodes: seqs.map((seq) => ({ seq, tokens: per, heuristicTokens: per }))
			};
		},
		estimateMessage() {
			return 10;
		}
	};
}

function llmWith(contextWindow = 100000) {
	return {
		resolveModelInfo: async () => ({ context: { contextWindow } }),
		listProviders: () => [{ id: "deepseek", name: "DeepSeek" }, { id: "openai", name: "OpenAI" }]
	};
}

function credentialsWith(value) {
	return { resolve: async () => ({ value }) };
}

/** A long removable conversation: goal + several stale messages. */
function staleSession() {
	const session = createFakeSession();
	addUserMessage(session, "the standing goal");
	for (let index = 0; index < 4; index += 1) addUserMessage(session, "stale message " + index + " " + "z".repeat(60));
	return session;
}

test("disabled paths never touch the network, the credential, or the session", async () => {
	let fetches = 0;
	let keyReads = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		fetches += 1;
		throw new Error("network must not be touched");
	};
	try {
		const session = staleSession();
		const before = session.surface.nodes.length;
		const mounted = host(enabledSection({ enabled: false }), createLaunchEnvironmentSnapshot([]), {
			tokenMeter: meterWith(50000),
			llm: llmWith(),
			credentials: { resolve: async () => { keyReads += 1; return { value: "key" }; } }
		});
		const agent = agentFor(session);
		const decision = await mounted.listeners.get("agent/pre-step")({ agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: "enter" }));
		assert.deepEqual(decision, { kind: "enter" }, "the native pre-step decision passes through");
		assert.equal(session.surface.nodes.length, before, "the conversation is untouched");
		const callConfig = await mounted.listeners.get("agent/request")({ agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: "deepseek", model: "chat" }));
		assert.deepEqual(callConfig, { provider: "deepseek", model: "chat" });
		const toolDecision = await mounted.listeners.get("tools/pre-execute")(
			{ name: "bash", arguments: { command: "rm -rf /" }, agent, callId: "c1", signal: new AbortController().signal },
			async () => ({ kind: "allow" })
		);
		assert.deepEqual(toolDecision, { kind: "allow" }, "a disabled risk node never escalates");
		assert.equal(fetches, 0);
		assert.equal(keyReads, 0, "the disabled path never reads a credential");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("an enabled model without a credential falls back to the native path untouched", async () => {
	let fetches = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		fetches += 1;
		throw new Error("network must not be touched");
	};
	try {
		const session = staleSession();
		const before = session.snapshotEvents().length;
		const mounted = host(enabledSection(), createLaunchEnvironmentSnapshot([]), {
			tokenMeter: meterWith(50000),
			llm: llmWith()
		});
		await mounted.listeners.get("agent/pre-step")({ agent: agentFor(session), turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: "enter" }));
		assert.equal(session.snapshotEvents().length, before, "no partial compression is ever committed");
		assert.equal(fetches, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("observe mode plans with Jev but never rewrites the conversation", async () => {
	const session = staleSession();
	const before = session.snapshotEvents().length;
	let asked = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		asked += 1;
		return { status: 200, json: async () => ({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }) };
	};
	try {
		const section = enabledSection();
		section.models[0].compaction.mode = "observe";
		const mounted = host(section, createLaunchEnvironmentSnapshot([]), {
			tokenMeter: meterWith(50000),
			llm: llmWith(),
			credentials: credentialsWith("key")
		});
		await mounted.listeners.get("agent/pre-step")({ agent: agentFor(session), turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: "enter" }));
		assert.equal(asked > 0, true, "observation still consults Jev");
		assert.equal(session.snapshotEvents().length, before, "observe mode records advice only");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("active mode commits only validated spans through the model-free replacement protocol", async () => {
	const session = staleSession();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => ({
		status: 200,
		json: async () => ({
			model: "jev-1.13.0",
			answers: {
				removal_u1: { type: "choice", choice: "remove", confidence: 0.95, probabilities: { remove: 0.9, keep: 0.05, uncertain: 0.05 } },
				removal_safe_u1: { type: "noul", noul: 0.95 },
				removal_u2: { type: "choice", choice: "remove", confidence: 0.95, probabilities: { remove: 0.9, keep: 0.05, uncertain: 0.05 } },
				removal_safe_u2: { type: "noul", noul: 0.95 },
				removal_u3: { type: "choice", choice: "remove", confidence: 0.95, probabilities: { remove: 0.9, keep: 0.05, uncertain: 0.05 } },
				removal_safe_u3: { type: "noul", noul: 0.95 }
			},
			usage: { input_tokens: 1, output_tokens: 1 }
		})
	});
	try {
		const mounted = host(enabledSection(), createLaunchEnvironmentSnapshot([]), {
			tokenMeter: meterWith(50000),
			llm: llmWith(),
			credentials: credentialsWith("key")
		});
		await mounted.listeners.get("agent/pre-step")({ agent: agentFor(session), turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: "enter" }));
		const events = session.snapshotEvents();
		const prunes = events.filter((event) => event.type === "compaction/prune");
		const replacements = events.filter((event) => event.type === "user/message" && event.surfaceOp?.op === "replace");
		assert.equal(prunes.length > 0, true);
		assert.equal(prunes.length, replacements.length, "one shadow price per replacement");
		for (const replacement of replacements) {
			assert.equal(replacement.data.source.plugin, "jev-enhancement");
			assert.ok(replacement.sourceEventSeqs.length > 1, "every shadowed node is cited");
		}
		assert.equal(session.eventAt(0) !== undefined, true, "originals stay in the log");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("an active compaction with no net gain leaves the session unchanged", async () => {
	const session = staleSession();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const questions = JSON.parse(init.body).questions;
		return {
			status: 200,
			json: async () => ({
				model: "jev-1.13.0",
				answers: Object.fromEntries(Object.keys(questions).map((key) => [key, key.startsWith("removal_safe_")
					? { type: "noul", noul: 0.95 }
					: { type: "choice", choice: "remove", confidence: 0.95 }])),
				usage: { input_tokens: 1, output_tokens: 1 }
			})
		};
	};
	try {
		const meter = { ...meterWith(50000), estimateMessage: () => 100000 };
		const mounted = host(enabledSection(), createLaunchEnvironmentSnapshot([]), {
			tokenMeter: meter, llm: llmWith(), credentials: credentialsWith("key")
		});
		await mounted.listeners.get("agent/pre-step")({ agent: agentFor(session), turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: "enter" }));
		assert.equal(session.snapshotEvents().some((event) => event.type === "compaction/prune"), false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("disabling the model restores the originals from the log", async () => {
	const session = staleSession();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => ({
		status: 200,
		json: async () => ({
			model: "jev-1.13.0",
			answers: {
				removal_u1: { type: "choice", choice: "remove", confidence: 0.95, probabilities: { remove: 0.9, keep: 0.05, uncertain: 0.05 } },
				removal_safe_u1: { type: "noul", noul: 0.95 },
				removal_u2: { type: "choice", choice: "remove", confidence: 0.95, probabilities: { remove: 0.9, keep: 0.05, uncertain: 0.05 } },
				removal_safe_u2: { type: "noul", noul: 0.95 },
				removal_u3: { type: "choice", choice: "remove", confidence: 0.95, probabilities: { remove: 0.9, keep: 0.05, uncertain: 0.05 } },
				removal_safe_u3: { type: "noul", noul: 0.95 }
			},
			usage: { input_tokens: 1, output_tokens: 1 }
		})
	});
	try {
		const mounted = host(enabledSection(), createLaunchEnvironmentSnapshot([]), {
			tokenMeter: meterWith(50000),
			llm: llmWith(),
			credentials: credentialsWith("key")
		});
		const agent = agentFor(session);
		await mounted.listeners.get("agent/pre-step")({ agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: "enter" }));
		const filtered = session.snapshotEvents().filter((event) => event.type === "user/message" && event.surfaceOp?.op === "replace").length;
		assert.equal(filtered > 0, true);
		/* The user turns the model's enhancement off: the next request rebuilds. */
		mounted.replace({ ...enabledSection({ enabled: false }) });
		await mounted.listeners.get("agent/pre-step")({ agent, turn: 1, step: 2, signal: new AbortController().signal }, async () => ({ kind: "enter" }));
		const restores = session.snapshotEvents().filter((event) => event.type === "user/message" && event.data?.source?.plugin === "jev-enhancement#restore");
		assert.equal(restores.length, filtered, "every filtered span comes back");
		const body = restores.map((event) => event.data.content[0].text).join("\n");
		assert.ok(body.includes("stale message 0"), "verbatim originals are restored");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("the risk node escalates allow to ask but never loosens a denial", async () => {
	const mounted = host(enabledSection(), createLaunchEnvironmentSnapshot([]), {
		tokenMeter: meterWith(10),
		llm: llmWith(),
		credentials: credentialsWith("key")
	});
	const agent = agentFor(createFakeSession());
	const exec = { name: "bash", arguments: { command: "rm -rf build" }, agent, callId: "c1", signal: new AbortController().signal };
	const escalated = await mounted.listeners.get("tools/pre-execute")(exec, async () => ({ kind: "allow" }));
	assert.equal(escalated.kind, "ask");
	const denied = await mounted.listeners.get("tools/pre-execute")(exec, async () => ({ kind: "deny", reason: "sandbox" }));
	assert.deepEqual(denied, { kind: "deny", reason: "sandbox" }, "a native denial always stands");
	const asked = await mounted.listeners.get("tools/pre-execute")(exec, async () => ({ kind: "ask", reason: "permission" }));
	assert.deepEqual(asked, { kind: "ask", reason: "permission" });
	const safeTool = await mounted.listeners.get("tools/pre-execute")(
		{ name: "read", arguments: { path: "a.txt" }, agent, callId: "c2", signal: new AbortController().signal },
		async () => ({ kind: "allow" })
	);
	assert.deepEqual(safeTool, { kind: "allow" });
});

test("unknown registered tool names do not spend Jev budget", async () => {
	const mounted = host(enabledSection(), createLaunchEnvironmentSnapshot([]), {
		tools: { get: () => undefined }, credentials: credentialsWith("key")
	});
	const decision = await mounted.listeners.get("tools/pre-execute")({
		name: "powsh", arguments: {}, agent: agentFor(createFakeSession()), callId: "typo", signal: new AbortController().signal
	}, async () => ({ kind: "allow" }));
	assert.equal(decision.kind, "allow", "the registry still owns the final unknown-tool decision");
	const route = mounted.routes.get(testing.ROUTE_PREFIX);
	const response = { statusCode: 0, setHeader() {}, end(body) { this.body = body; } };
	await route.handler({ method: "GET", url: testing.STATUS_PATH }, response);
	assert.equal(JSON.parse(response.body).audit.counters.jevCalls, 0);
});

test("long ambiguous commands fall back without a false safe audit record", async () => {
	const mounted = host(enabledSection(), createLaunchEnvironmentSnapshot([]), { llm: llmWith(), credentials: credentialsWith("key") });
	const decision = await mounted.listeners.get("tools/pre-execute")({
		name: "pwsh", arguments: { command: "Write-Output '" + "x".repeat(500) + "'; Invoke-Unknown" },
		agent: agentFor(createFakeSession()), callId: "long", signal: new AbortController().signal
	}, async () => ({ kind: "allow" }));
	assert.equal(decision.kind, "allow");
	const route = mounted.routes.get(testing.ROUTE_PREFIX);
	const response = { statusCode: 0, setHeader() {}, end(body) { this.body = body; } };
	await route.handler({ method: "GET", url: testing.STATUS_PATH }, response);
	const audit = JSON.parse(response.body).audit;
	assert.equal(audit.counters.riskInsufficientEvidence, 1);
	assert.equal(audit.counters.riskDecisions, 0);
});

test("the settings schema fills defaults and rejects mistyped fields", () => {
	const value = testing.Config({ models: [{ providerId: "p", modelId: "m" }] });
	assert.equal(value.enabled, false, "the global switch defaults to off");
	assert.equal(value.models[0].compaction.mode, "observe", "filtering defaults to observation mode");
	assert.equal(value.models[0].enabled, false);
	assert.deepEqual(value.models[0].decision.nodes, []);
	assert.throws(() => testing.Config({ enabled: "yes" }), /expected boolean/);
});

test("the Jev audit log records activity and exports as one file", async () => {
	const session = staleSession();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => ({
		status: 200,
		json: async () => ({
			model: "jev-1.13.0",
			answers: {
				removal_u1: { type: "choice", choice: "remove", confidence: 0.95, probabilities: { remove: 0.9, keep: 0.05, uncertain: 0.05 } },
				removal_safe_u1: { type: "noul", noul: 0.95 },
				removal_u2: { type: "choice", choice: "remove", confidence: 0.95, probabilities: { remove: 0.9, keep: 0.05, uncertain: 0.05 } },
				removal_safe_u2: { type: "noul", noul: 0.95 },
				removal_u3: { type: "choice", choice: "remove", confidence: 0.95, probabilities: { remove: 0.9, keep: 0.05, uncertain: 0.05 } },
				removal_safe_u3: { type: "noul", noul: 0.95 }
			},
			usage: { input_tokens: 7, output_tokens: 3 }
		})
	});
	try {
		const section = enabledSection();
		section.models[0].compaction.mode = "observe";
		const mounted = host(section, createLaunchEnvironmentSnapshot([]), {
			tokenMeter: meterWith(50000),
			llm: llmWith(),
			credentials: credentialsWith("key")
		});
		await mounted.listeners.get("agent/pre-step")({ agent: agentFor(session), turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: "enter" }));
		const route = mounted.routes.get(testing.ROUTE_PREFIX);
		const response = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body; } };
		await route.handler({ method: "GET", url: testing.LOG_PATH, headers: { "x-jev-enhancement": "1", "sec-fetch-site": "same-origin" } }, response);
		assert.equal(response.statusCode, 200);
		assert.ok(response.headers["content-disposition"].includes("attachment"), "export downloads as one file");
		assert.ok(response.headers["content-type"].includes("x-ndjson"));
		assert.ok(response.body.includes('"kind":"compactionObserved"'), "Jev activity is in the dedicated log");
		const observed = response.body.split("\n").filter(Boolean).map(JSON.parse).find((entry) => entry.kind === "compactionObserved");
		assert.ok(Number.isFinite(observed.netRemovedTokens), "observe records estimated net saving after marker cost");
		assert.ok(observed.jevCalls > 0, "observe records the call cost");
		assert.ok(response.body.includes('"kind":"activated"'), "the log records which config went live");
		assert.ok(!response.body.includes("stale message"), "no conversation text ever reaches the log");
		/* The connectivity test is a Jev call too: it lands in the log and counters. */
		const tested = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body; } };
		await route.handler({ method: "POST", url: testing.TEST_PATH, headers: { "x-jev-enhancement": "1", "sec-fetch-site": "same-origin" } }, tested);
		assert.equal(JSON.parse(tested.body).ok, true);
		const after = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body; } };
		await route.handler({ method: "GET", url: testing.LOG_PATH, headers: { "x-jev-enhancement": "1", "sec-fetch-site": "same-origin" } }, after);
		assert.ok(after.body.includes('"kind":"jevCalls"'), "test-connection is audited as a Jev call");
		const refused = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body; } };
		await route.handler({ method: "GET", url: testing.LOG_PATH, headers: { origin: "https://evil.example" } }, refused);
		assert.equal(refused.statusCode, 403, "a foreign page may not read the audit log");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("empty runs and budget exhaustion are counted, never spammed as judgments", async () => {
	const readStatus = async (mounted) => {
		const route = mounted.routes.get(testing.ROUTE_PREFIX);
		const response = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body; } };
		await route.handler({ method: "GET", url: testing.STATUS_PATH }, response);
		return JSON.parse(response.body);
	};
	/* Route node armed but nothing failed: the empty run is a skip, not a Jev judgment. */
	const mounted = host(enabledSection(), createLaunchEnvironmentSnapshot([]), { tokenMeter: meterWith(10), llm: llmWith(), credentials: credentialsWith("key") });
	const callConfig = { provider: "deepseek", model: "chat" };
	const returned = await mounted.listeners.get("agent/request")(
		{ agent: agentFor(createFakeSession()), turn: 1, step: 1, signal: new AbortController().signal },
		async () => callConfig
	);
	assert.equal(returned, callConfig);
	let status = await readStatus(mounted);
	assert.equal(status.audit.counters.routeDecisions, 0, "an empty run is not a judgment");
	assert.equal(status.audit.counters.routeSkips, 1);
	assert.equal(status.audit.recent.filter((record) => record.node === "route-selection").length, 0, "no judgment record for a skip");
	/* Budget exhausted across three tool calls: one fallback record, three counted. */
	const section = enabledSection();
	section.callBudgetPerStep = 0;
	section.callBudgetPerTask = 0;
	const tight = host(section, createLaunchEnvironmentSnapshot([]), { tokenMeter: meterWith(10), llm: llmWith(), credentials: credentialsWith("key") });
	for (let index = 0; index < 3; index += 1) {
		const decision = await tight.listeners.get("tools/pre-execute")(
			{ name: "mystery_tool", arguments: { payload: "x" }, agent: agentFor(createFakeSession()), callId: "c" + index, signal: new AbortController().signal },
			async () => ({ kind: "allow" })
		);
		assert.equal(decision.kind, "allow");
	}
	status = await readStatus(tight);
	assert.equal(status.audit.counters.budgetFallbacks, 3, "every exhausted attempt is counted");
	assert.equal(status.audit.counters.nativeFallbacks, 1, "one budget episode, one record");
});

test("current-session approval switch authenticates, preserves sandbox and rejects invalid input", async () => {
	const session = createFakeSession();
	const agent = agentFor(session);
	let authenticated = false;
	const mounted = host(enabledSection(), createLaunchEnvironmentSnapshot([]), {
		agents: { get: (id) => id === session.id ? agent : undefined },
		connection: { requestRejection: () => authenticated ? undefined : 401 },
		approval: {
			config: { policy: "never" },
			overrideOf: (value) => value.snapshotEvents().filter((event) => event.type === "approval/policy").at(-1)?.data.policy,
			setPolicy: (value, policy) => value.session.append("approval/policy", { policy })
		}
	});
	const route = mounted.routes.get(testing.ROUTE_PREFIX);
	const send = async (body, headers = { "x-jev-enhancement": "1" }) => {
		const response = { statusCode: 0, setHeader() {}, end(payload) { this.body = JSON.parse(payload); } };
		await route.handler({ method: "POST", url: testing.APPROVAL_PATH, headers, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } }, response);
		return response;
	};
	assert.equal((await send({ sessionId: session.id, policy: "ask" })).statusCode, 401);
	assert.equal((await send({ sessionId: session.id, policy: "ask" }, {})).statusCode, 403);
	authenticated = true;
	assert.equal((await send({ sessionId: session.id, policy: "invalid" })).statusCode, 400);
	assert.equal((await send({ sessionId: "another", policy: "ask" })).statusCode, 404);
	assert.deepEqual(session.snapshotEvents(), []);
	const changed = await send({ sessionId: session.id, policy: "ask" });
	assert.equal(changed.statusCode, 200);
	assert.deepEqual(changed.body, { ok: true, sessionId: session.id, policy: "ask" });
	assert.deepEqual(session.snapshotEvents().map((event) => event.type), ["approval/policy"], "the sandbox is untouched");
	assert.equal((await send({ sessionId: session.id })).body.policy, "ask");
	assert.equal((await send({ sessionId: session.id, policy: "never" })).body.policy, "never");
	assert.deepEqual(session.snapshotEvents().map((event) => event.type), ["approval/policy", "approval/policy"]);
});

test("the approval control fails closed without the browser auth service", async () => {
	const session = createFakeSession();
	const mounted = host(enabledSection(), createLaunchEnvironmentSnapshot([]), {
		agents: { get: () => agentFor(session) }, approval: { setPolicy() { throw new Error("should not run"); } }
	});
	const response = { statusCode: 0, setHeader() {}, end(payload) { this.body = JSON.parse(payload); } };
	await mounted.routes.get(testing.ROUTE_PREFIX).handler({
		method: "POST", url: testing.APPROVAL_PATH, headers: { "x-jev-enhancement": "1" },
		async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: session.id, policy: "ask" })); }
	}, response);
	assert.equal(response.statusCode, 503);
	assert.deepEqual(session.snapshotEvents(), []);
});

test("the status surface is a whitelist and controls refuse foreign callers", async () => {
	const mounted = host(enabledSection(), createLaunchEnvironmentSnapshot([]), {
		tokenMeter: meterWith(10),
		llm: llmWith(),
		credentials: credentialsWith("sk-secret-value")
	});
	const route = mounted.routes.get(testing.ROUTE_PREFIX);
	assert.ok(route !== undefined);
	const response = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body; } };
	await route.handler({ method: "GET", url: testing.STATUS_PATH }, response);
	const status = JSON.parse(response.body);
	assert.equal(status.ok, true);
	assert.equal(status.enabled, true);
	assert.equal(status.audit.counters.jevCalls, 0);
	assert.equal(response.body.includes("sk-secret-value"), false, "no secret material is published");
	const forbidden = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body; } };
	await route.handler({ method: "POST", url: testing.STATUS_PATH }, forbidden);
	assert.equal(forbidden.statusCode, 405);
	const refused = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body; } };
	await route.handler({ method: "POST", url: testing.TEST_PATH, headers: { origin: "https://evil.example" } }, refused);
	assert.equal(refused.statusCode, 403, "a foreign origin may not spend Jev budget");
});
