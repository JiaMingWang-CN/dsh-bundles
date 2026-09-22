/**
 * Call budgets, compaction spacing, and the failure circuit breaker (plan §4.2,
 * §8).
 *
 * The tracker is what keeps Jev from ever blocking or flooding the main loop:
 * a step gets `callBudgetPerStep` calls, a task gets `callBudgetPerTask`, two
 * compactions are at least `minIntervalSteps` apart, and consecutive API
 * failures open a cooldown circuit that simply routes everything back to the
 * native path.
 *
 * Pure module (no imports) so `node --test` can run it standalone.
 */

/** Consecutive adapter failures that open the circuit. */
const CIRCUIT_THRESHOLD = 3;

/** Default cooldown once the circuit is open. */
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Create one budget tracker.
 * @param {object} [options] - `now` clock override for tests.
 * @returns {object} the tracker.
 */
function createBudgetTracker(options = {}) {
	const now = options.now ?? (() => Date.now());
	const tasks = new Map();
	const steps = new Map();
	const spacing = new Map();
	let consecutiveFailures = 0;
	let circuitUntil = 0;

	function taskKeyOf(key) {
		return String(key);
	}

	return {
		/** Whether the failure circuit currently routes everything native. */
		circuitOpen() {
			return now() < circuitUntil;
		},
		/** Remaining cooldown in milliseconds (0 when closed). */
		circuitRemainingMs() {
			return Math.max(0, circuitUntil - now());
		},
		/** Record one successful Jev call, closing the circuit. */
		recordSuccess() {
			consecutiveFailures = 0;
			circuitUntil = 0;
		},
		/** Record one adapter failure; opens the circuit at the threshold. */
		recordFailure() {
			consecutiveFailures += 1;
			if (consecutiveFailures >= CIRCUIT_THRESHOLD) circuitUntil = now() + CIRCUIT_COOLDOWN_MS;
		},
		/** Consecutive failures so far (diagnostics). */
		consecutiveFailures() {
			return consecutiveFailures;
		},
		/**
		 * Try to spend one Jev call against the step and task budgets.
		 * @param {string} taskKey - stable per-task identity (e.g. session id).
		 * @param {string} stepKey - stable per-step identity (e.g. `turn:step`).
		 * @param {{ perStep: number, perTask: number }} budget - the effective budgets.
		 * @returns {boolean} whether the call may proceed.
		 */
		trySpend(taskKey, stepKey, budget) {
			if (this.circuitOpen()) return false;
			const task = taskKeyOf(taskKey);
			const step = task + "|" + String(stepKey);
			const usedTask = tasks.get(task) ?? 0;
			const usedStep = steps.get(step) ?? 0;
			if (usedStep >= budget.perStep || usedTask >= budget.perTask) return false;
			tasks.set(task, usedTask + 1);
			steps.set(step, usedStep + 1);
			return true;
		},
		/**
		 * Whether budget remains without spending it (gating before planning).
		 * @param {string} taskKey - stable per-task identity.
		 * @param {string} stepKey - stable per-step identity.
		 * @param {{ perStep: number, perTask: number }} budget - the effective budgets.
		 * @returns {boolean} whether a call could be spent now.
		 */
		canSpend(taskKey, stepKey, budget) {
			if (this.circuitOpen()) return false;
			const task = taskKeyOf(taskKey);
			const step = task + "|" + String(stepKey);
			return (steps.get(step) ?? 0) < budget.perStep && (tasks.get(task) ?? 0) < budget.perTask;
		},
		/**
		 * Whether the compaction spacing for this task has elapsed.
		 * @param {string} taskKey - stable per-task identity.
		 * @param {number} stepIndex - current step index.
		 * @param {number} minIntervalSteps - configured minimum spacing.
		 * @returns {boolean} whether compaction may run now.
		 */
		compactionReady(taskKey, stepIndex, minIntervalSteps) {
			const task = taskKeyOf(taskKey);
			const last = spacing.get(task);
			if (last !== undefined && stepIndex - last < minIntervalSteps) return false;
			return true;
		},
		/**
		 * Record a compaction attempt at this step index.
		 * @param {string} taskKey - stable per-task identity.
		 * @param {number} stepIndex - current step index.
		 * @returns {void} nothing.
		 */
		markCompaction(taskKey, stepIndex) {
			spacing.set(taskKeyOf(taskKey), stepIndex);
		},
		/** Reset one task's counters (task finished or restarted). */
		resetTask(taskKey) {
			const task = taskKeyOf(taskKey);
			tasks.delete(task);
			spacing.delete(task);
		}
	};
}

export { CIRCUIT_COOLDOWN_MS, CIRCUIT_THRESHOLD, createBudgetTracker };
