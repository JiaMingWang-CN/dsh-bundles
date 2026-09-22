import test from "node:test";
import assert from "node:assert/strict";
import {
	ENDPOINT,
	JevError,
	MAX_QUESTIONS_PER_CALL,
	boundState,
	createTypeSafeClient,
	mapStatus,
	normalizeAnswer,
	validateResponse
} from "../lib/typesafe.js";
import { faultQuestions, removalQuestions, riskQuestions } from "../lib/questions.js";

function response(status, payload) {
	return { status, json: async () => payload };
}

function clientWith(fetchImpl, resolveKey = async () => "key") {
	const usage = [];
	const client = createTypeSafeClient({
		fetchImpl,
		resolveKey,
		timeoutMs: 100,
		onUsage: (value) => usage.push(value)
	});
	return { client, usage };
}

test("the request carries exactly the documented contract fields", async () => {
	let captured;
	const { client } = clientWith(async (url, init) => {
		captured = { url, init };
		return response(200, { model: "jev-1.13.0", answers: { is_urgent: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 2 } });
	});
	const result = await client.evaluate({
		state: "help",
		model: "jev-latest",
		questions: { is_urgent: { type: "noul", instructions: "urgent?" } }
	});
	assert.equal(captured.url, ENDPOINT);
	assert.equal(captured.init.method, "POST");
	assert.equal(captured.init.headers.authorization, "Bearer key");
	assert.equal(captured.init.headers["content-type"], "application/json");
	const body = JSON.parse(captured.init.body);
	assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
	assert.equal(body.model, "jev-latest");
	assert.equal(result.answers.is_urgent.noul, 0.9);
});

test("a missing credential never reaches the network", async () => {
	const { client } = clientWith(async () => {
		throw new Error("network must not be touched");
	}, async () => undefined);
	await assert.rejects(
		() => client.evaluate({ state: "s", model: "jev-latest", questions: { q: { type: "noul", instructions: "?" } } }),
		(error) => error instanceof JevError && error.code === "credential-missing"
	);
});

test("HTTP statuses map onto stable failure classes with retryability", () => {
	assert.equal(mapStatus(401), "auth");
	assert.equal(mapStatus(422), "contract");
	assert.equal(mapStatus(429), "rate-limit");
	assert.equal(mapStatus(529), "overloaded");
	assert.equal(mapStatus(500), "unavailable");
	const retryable = [429, 529, 500].map((status) => {
		const code = mapStatus(status);
		return code === "rate-limit" || code === "overloaded" || code === "unavailable";
	});
	assert.deepEqual(retryable, [true, true, true]);
});

test("a contract failure is terminal: no field guessing and no reshaped retry", async () => {
	let calls = 0;
	const { client } = clientWith(async () => {
		calls += 1;
		return response(422, { detail: "unknown field" });
	});
	await assert.rejects(
		() => client.evaluate({ state: "s", model: "jev-latest", questions: { q: { type: "noul", instructions: "?" } } }),
		(error) => error.code === "contract"
	);
	assert.equal(calls, 1);
});

test("missing and malformed answers degrade to per-question unknown", () => {
	const questions = {
		a: { type: "choice", instructions: "?", criteria: { x: null, y: null } },
		b: { type: "noul", instructions: "?" },
		c: { type: "noul", instructions: "?" }
	};
	const result = validateResponse({
		model: "jev-1.13.0",
		answers: {
			a: { type: "choice", choice: "x", confidence: 0.5, probabilities: { x: 0.5, y: 0.5 } },
			c: { type: "noul", noul: 2 }
		},
		usage: { input_tokens: 3, output_tokens: 4 }
	}, questions);
	assert.equal(result.answers.a.unknown, undefined);
	assert.equal(result.answers.a.choice, "x");
	assert.equal(result.answers.b.unknown, true);
	assert.equal(result.answers.c.unknown, true);
	assert.equal(result.usage.inputTokens, 3);
});

test("unknown response fields are ignored and answer types are never mixed", () => {
	const result = validateResponse({
		model: "jev-1.13.0",
		unexpected: { anything: true },
		answers: {
			n: { type: "noul", noul: 0.4, confidence: 0.9, extra: "ignored" },
			s: { type: "score", score: 1.2, confidence: 0.8, legend: {}, probabilities: { "0": 0.2, "1": 0.8 } }
		},
		usage: { input_tokens: 1, output_tokens: 1 }
	}, {
		n: { type: "noul", instructions: "?" },
		s: { type: "score", instructions: "?", criteria: ["a", "b"] }
	});
	assert.equal(result.answers.n.noul, 0.4);
	assert.equal(result.answers.n.confidence, undefined, "Noul answers carry no confidence");
	assert.equal(result.answers.s.score, 1.2);
	assert.equal(result.answers.s.confidence, 0.8);
	assert.equal(result.answers.n.unknown, undefined);
});

test("normalizeAnswer rejects out-of-range values instead of clamping", () => {
	assert.equal(normalizeAnswer("noul", { type: "noul", noul: 1.5 }).unknown, true);
	assert.equal(normalizeAnswer("choice", { type: "choice", choice: "x", confidence: 0.5, probabilities: { x: 2 } }).unknown, true);
	assert.equal(normalizeAnswer("choice", { type: "choice", choice: "z", confidence: 0.5, probabilities: { x: 1 } }).unknown, true);
});

test("state is bounded and never silently reinterpreted", () => {
	const bounded = boundState("x".repeat(50000));
	assert.equal(bounded.truncated, true);
	assert.ok(bounded.state.length <= 50000);
	assert.deepEqual(boundState({ a: 1 }), { state: { a: 1 }, truncated: false });
});

test("question batches beyond the call budget are refused", async () => {
	const questions = {};
	for (let index = 0; index <= MAX_QUESTIONS_PER_CALL; index += 1) {
		questions["q" + index] = { type: "noul", instructions: "?" };
	}
	const { client } = clientWith(async () => response(200, {}));
	await assert.rejects(
		() => client.evaluate({ state: "s", model: "jev-latest", questions }),
		(error) => error.code === "budget"
	);
});

test("question builders emit only closed-set typed questions", () => {
	assert.deepEqual(Object.keys(removalQuestions("u1")).sort(), ["removal_safe_u1", "removal_u1"]);
	assert.equal(removalQuestions("u1").removal_u1.type, "choice");
	assert.equal(removalQuestions("u1").removal_safe_u1.type, "noul");
	assert.equal(faultQuestions().fault_category.type, "choice");
	const risks = riskQuestions();
	assert.deepEqual(Object.keys(risks).sort(), ["risk_destructive", "risk_external", "risk_irreversible", "risk_write"]);
	for (const question of Object.values(risks)) assert.equal(question.type, "noul");
});

test("a cancelled request settles as cancelled", async () => {
	const controller = new AbortController();
	controller.abort();
	const { client } = clientWith(async () => response(200, {}));
	await assert.rejects(
		() => client.evaluate({ state: "s", model: "jev-latest", questions: { q: { type: "noul", instructions: "?" } }, signal: controller.signal }),
		(error) => error.code === "cancelled"
	);
});
