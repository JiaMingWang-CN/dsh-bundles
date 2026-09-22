import test from "node:test";
import assert from "node:assert/strict";
import { CIRCUIT_THRESHOLD, createBudgetTracker } from "../lib/budget.js";

test("per-step and per-task budgets bound every Jev call", () => {
	const tracker = createBudgetTracker();
	const budget = { perStep: 1, perTask: 3 };
	assert.equal(tracker.trySpend("task", "step-1", budget), true);
	assert.equal(tracker.trySpend("task", "step-1", budget), false, "the step budget is spent");
	assert.equal(tracker.trySpend("task", "step-2", budget), true);
	assert.equal(tracker.trySpend("task", "step-3", budget), true);
	assert.equal(tracker.trySpend("task", "step-4", budget), false, "the task budget is spent");
	assert.equal(tracker.canSpend("task", "step-5", budget), false);
	assert.equal(tracker.trySpend("other-task", "step-1", budget), true, "budgets are per task");
});

test("consecutive failures open a cooldown circuit that routes everything native", () => {
	let now = 1000;
	const tracker = createBudgetTracker({ now: () => now });
	const budget = { perStep: 4, perTask: 4 };
	for (let index = 0; index < CIRCUIT_THRESHOLD - 1; index += 1) tracker.recordFailure();
	assert.equal(tracker.circuitOpen(), false);
	assert.equal(tracker.trySpend("task", "step", budget), true);
	tracker.recordFailure();
	assert.equal(tracker.circuitOpen(), true);
	assert.equal(tracker.trySpend("task", "step-2", budget), false, "an open circuit spends nothing");
	assert.ok(tracker.circuitRemainingMs() > 0);
	now += 6 * 60 * 1000;
	assert.equal(tracker.circuitOpen(), false, "the cooldown closes the circuit");
	tracker.recordFailure();
	tracker.recordSuccess();
	assert.equal(tracker.circuitOpen(), false, "a success closes the circuit at once");
});

test("compaction spacing honours minIntervalSteps per task", () => {
	const tracker = createBudgetTracker();
	assert.equal(tracker.compactionReady("task", 4, 4), true);
	tracker.markCompaction("task", 4);
	assert.equal(tracker.compactionReady("task", 7, 4), false);
	assert.equal(tracker.compactionReady("task", 8, 4), true);
	assert.equal(tracker.compactionReady("other", 5, 4), true);
});

test("a finished task releases its counters", () => {
	const tracker = createBudgetTracker();
	const budget = { perStep: 1, perTask: 1 };
	assert.equal(tracker.trySpend("task", "step", budget), true);
	assert.equal(tracker.trySpend("task", "step", budget), false);
	tracker.resetTask("task");
	assert.equal(tracker.trySpend("task", "step-2", budget), true);
});
