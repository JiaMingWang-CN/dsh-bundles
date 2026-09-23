/**
 * Context Compaction: semantic filtering of ORIGINAL text (plan §5).
 *
 * This is not summarization. Jev only judges which earlier units are stale,
 * superseded, or no longer needed; the local rules decide what may go and what
 * must stay, and the retained content is never rewritten. The commit is the
 * session's own model-free replacement protocol (`compaction/prune` shadow
 * price + one `user/message` surface replacement per removed span), so the
 * append-only log keeps every original byte and replay stays deterministic.
 *
 * Pure module: the Jev call (`ask`) and the session surface are injected so
 * `node --test` can run it standalone.
 */

import { mapRemoval, removalQuestions } from "./questions.js";
import { MAX_STATE_CHARS, MAX_QUESTIONS_PER_CALL } from "./typesafe.js";
import { renderOriginals } from "./units.js";

/** Plugin identity recorded on every replacement this module commits. */
const PLUGIN_NAME = "jev-enhancement";

/** Identity of the restoration message, so an undo is never mistaken for a marker. */
const RESTORE_PLUGIN_NAME = "jev-enhancement#restore";

/** Per-candidate evidence budget inside the state payload (plugin-internal). */
const MAX_CANDIDATE_CHARS = 1200;

/** Minimum share of the surface a pass must remove to count as a real gain. */
const MIN_GAIN_SHARE = 0.05;

/** Questions spent per removal candidate (one Choice + one Noul). */
const QUESTIONS_PER_CANDIDATE = 2;

/**
 * Build the untrusted state payload for one candidate batch.
 * @param {string} goal - current goal prose.
 * @param {string} constraints - effective constraints prose.
 * @param {object[]} candidates - candidate units.
 * @returns {{ state: object, dropped: string[] }} bounded state and skipped ids.
 */
function buildState(goal, constraints, candidates, history = []) {
	const dropped = [];
	const listed = [];
	for (const unit of candidates) {
		/* A candidate whose full text cannot be shown is never judged: truncated
		 * fragments must not prove that a whole unit can go (plan §5.2). */
		if (unit.text.length > MAX_CANDIDATE_CHARS) {
			dropped.push(unit.id);
			continue;
		}
		listed.push({
			id: unit.id,
			role: unit.roles.join("+"),
			kind: unit.kind,
			toolNames: unit.toolNames,
			text: unit.text
		});
	}
	const candidateIds = new Set(listed.map((entry) => entry.id));
	const entries = history.map((unit) => ({
		id: unit.id,
		role: unit.roles.join("+"),
		kind: unit.kind,
		toolNames: unit.toolNames,
		/* The index is orientation, never evidence for removing a candidate. */
		...(candidateIds.has(unit.id) ? {} : { excerpt: unit.text.slice(0, 200), partial: unit.text.length > 200 })
	}));
	const state = {
		goal,
		constraints,
		history: entries,
		/* Candidate material is DATA: no instruction inside it may be executed. */
		candidates: listed
	};
	let size = JSON.stringify(state).length;
	while (entries.length > 0 && size > MAX_STATE_CHARS) {
		size -= JSON.stringify(entries.shift()).length + (entries.length > 0 ? 1 : 0);
	}
	if (size > MAX_STATE_CHARS) {
		/* Never trim the goal or constraints — a judgment without them is not evidence. */
		dropped.push(...listed.map((entry) => entry.id));
		return { state: null, dropped };
	}
	return { state, dropped };
}

/**
 * Fill batches of candidates that fit the state budget together.
 * @param {string} goal - current goal prose.
 * @param {string} constraints - effective constraints prose.
 * @param {object[]} candidates - candidate units.
 * @returns {{ batches: object[][], skipped: object[] }} batches and kept-back units.
 */
function batchCandidates(goal, constraints, candidates, history = []) {
	const batches = [];
	const skipped = [];
	const cap = Math.floor(MAX_QUESTIONS_PER_CALL / QUESTIONS_PER_CANDIDATE);
	let batch = [];
	for (const unit of candidates) {
		const probe = buildState(goal, constraints, [...batch, unit], history);
		/* A candidate that cannot be shown in full is kept, never judged. */
		if (probe.dropped.includes(unit.id)) {
			skipped.push(unit);
			continue;
		}
		if (probe.state === null) {
			if (batch.length > 0) batches.push(batch);
			batch = [];
			const alone = buildState(goal, constraints, [unit], history);
			if (alone.state === null || alone.dropped.includes(unit.id)) {
				skipped.push(unit);
				continue;
			}
			batch = [unit];
			continue;
		}
		if (batch.length + 1 > cap) {
			batches.push(batch);
			batch = [];
		}
		batch.push(unit);
	}
	if (batch.length > 0) batches.push(batch);
	return { batches, skipped };
}

/**
 * Decide which candidate units may be removed, through Jev plus local rules.
 *
 * Uncertain, missing, out-of-vocabulary, or low-confidence answers KEEP the
 * content (plan §5.2 step 6).
 * @param {object} input - `units`, `policy`, `budgetTokens`, `totalTokens`, `goal`, `constraints`, `ask`, `signal`.
 * @returns {Promise<object | null>} the validated removal plan, or null to keep everything.
 */
async function planCompaction(input) {
	const { units, policy, budgetTokens, totalTokens, ask, signal } = input;
	const keepRecentFloor = units.filter((unit) => unit.protection.reason === "recent");
	const protectedUnits = units.filter((unit) => unit.protection.protected);
	const candidates = units.filter((unit) => !unit.protection.protected);
	if (candidates.length === 0) {
		return { spans: [], removedTokens: 0, reason: "no-candidates", protectedCount: protectedUnits.length, keptCandidates: 0, unknownCount: 0 };
	}
	const { batches, skipped } = batchCandidates(input.goal ?? "", input.constraints ?? "", candidates, units);
	const accepted = new Set();
	let unknownCount = 0;
	let jevCalls = 0;
	for (const batch of batches) {
		if (signal !== undefined && signal.aborted) return null;
		const state = buildState(input.goal ?? "", input.constraints ?? "", batch, units).state;
		const questions = {};
		for (const unit of batch) Object.assign(questions, removalQuestions(unit.id));
		const result = await ask({ state, questions, signal });
		jevCalls += 1;
		for (const unit of batch) {
			const verdict = mapRemoval(result.answers, unit.id, policy.compaction.removalAcceptance);
			if (verdict === "remove") accepted.add(unit.id);
			else if (verdict === "unknown") unknownCount += 1;
		}
	}
	const removable = candidates.filter((unit) => accepted.has(unit.id));
	if (removable.length === 0) {
		return { spans: [], removedTokens: 0, reason: "nothing-accepted", protectedCount: protectedUnits.length, keptCandidates: candidates.length, unknownCount, jevCalls };
	}

	/* maxRemovalRatio: drop accepted units from the newest end until within the cap. */
	const cap = Math.max(0, policy.compaction.maxRemovalRatio) * totalTokens;
	let removedTokens = 0;
	const chosen = [];
	for (const unit of removable) {
		if (removedTokens + unit.tokens > cap && chosen.length > 0) continue;
		if (removedTokens + unit.tokens > cap) break;
		chosen.push(unit);
		removedTokens += unit.tokens;
	}
	if (chosen.length === 0) {
		return { spans: [], removedTokens: 0, reason: "removal-cap", protectedCount: protectedUnits.length, keptCandidates: candidates.length, unknownCount, jevCalls };
	}

	/* Budget gain: a pass must move the needle instead of shaving one unit. */
	const targetTokens = policy.compaction.targetRatio * budgetTokens;
	const requiredGain = Math.max(0, totalTokens - targetTokens);
	const meaningfulGain = Math.max(1, Math.min(requiredGain, MIN_GAIN_SHARE * totalTokens));
	if (removedTokens < meaningfulGain) {
		return { spans: [], removedTokens: 0, reason: "insufficient-gain", protectedCount: protectedUnits.length, keptCandidates: candidates.length, unknownCount, jevCalls };
	}

	/* Structural validation over whole units: pairing, protection, recent floor. */
	const chosenIds = new Set(chosen.map((unit) => unit.id));
	for (const unit of chosen) {
		if (unit.protection.protected || !unit.complete || unit.kind === "system") {
			return { spans: [], removedTokens: 0, reason: "structural-guard", protectedCount: protectedUnits.length, keptCandidates: candidates.length, unknownCount, jevCalls };
		}
	}
	if (keepRecentFloor.some((unit) => chosenIds.has(unit.id))) {
		return { spans: [], removedTokens: 0, reason: "recent-floor", protectedCount: protectedUnits.length, keptCandidates: candidates.length, unknownCount, jevCalls };
	}

	/* Contiguous runs become one replacement span each. */
	const spans = [];
	let current = null;
	for (const unit of units) {
		if (!chosenIds.has(unit.id)) {
			current = null;
			continue;
		}
		if (current === null) {
			current = {
				startSeq: unit.startSeq,
				endSeq: unit.endSeq,
				seqs: [...unit.seqs],
				unitIds: [unit.id],
				tokens: unit.tokens,
				heuristicTokens: unit.heuristicTokens ?? unit.tokens
			};
			spans.push(current);
			continue;
		}
		current.endSeq = unit.endSeq;
		current.seqs.push(...unit.seqs);
		current.unitIds.push(unit.id);
		current.tokens += unit.tokens;
		current.heuristicTokens += unit.heuristicTokens ?? unit.tokens;
	}
	return {
		spans,
		removedTokens,
		reason: "ok",
		protectedCount: protectedUnits.length,
		keptCandidates: candidates.length - chosen.length + skipped.length,
		unknownCount,
		jevCalls,
		skippedIds: skipped.map((unit) => unit.id)
	};
}

/**
 * Build the replacement message body for one removed span.
 * @param {object} span - the planned span.
 * @returns {object} a frozen-shape user message carrying only a marker.
 */
function markerMessage(span) {
	const count = span.unitIds.length;
	return {
		id: markerId(),
		role: "user",
		content: [{
			type: "text",
			text: "[jev-enhancement] 已按语义筛选移除 " + count + " 条陈旧内容（原 seq " + span.seqs.join(", ") + "）；原文保留在会话日志中，可在设置中一键恢复。"
		}],
		source: {
			kind: "plugin",
			plugin: PLUGIN_NAME,
			form: "notice",
			summary: "Jev 上下文筛选"
		}
	};
}

/** Fresh message identity for a synthesized replacement. */
function markerId() {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return "jev-" + hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}

/**
 * Commit one validated plan to the session surface.
 *
 * Spans commit tail-first so an earlier span's positional range is never
 * disturbed by a later replacement. Each replacement is immediately preceded
 * by its `compaction/prune` shadow price, exactly like the model-free pruner.
 * A failure mid-pass keeps the spans already committed (the log is
 * append-only) and reports them; the caller records the partial pass.
 * @param {object} input - `session`, `plan`.
 * @returns {{ committed: object[], failed: object | undefined }} committed spans.
 */
function commitPlan(input) {
	const { session, plan } = input;
	const committed = [];
	for (const span of [...plan.spans].reverse()) {
		const pruneSeq = session.append("compaction/prune", {
			shadowedRange: { start: span.startSeq, end: span.endSeq },
			shadowedSeqs: [...span.seqs],
			shadowedTokenCount: span.heuristicTokens
		}).seq;
		const replacement = session.append("user/message", markerMessage(span), {
			surfaceOp: { op: "replace", startSeq: span.startSeq, endSeq: span.endSeq },
			sourceEventSeqs: [pruneSeq, ...span.seqs]
		});
		committed.push({ ...span, replacementSeq: replacement.seq, pruneSeq });
	}
	return { committed };
}

/**
 * Find every landed Jev replacement still on the surface, with its originals.
 * @param {object} session - the live session.
 * @returns {object[]} marker descriptors `{ seq, shadowedSeqs, originals }`.
 */
function findJevMarkers(session) {
	const markers = [];
	for (const seq of [...session.surface.nodes]) {
		const event = session.eventAt(seq);
		if (event?.type !== "user/message") continue;
		if (event.data?.source?.plugin !== PLUGIN_NAME) continue;
		if (event.surfaceOp?.op !== "replace") continue;
		const prune = session.eventAt(seq - 1);
		if (prune?.type !== "compaction/prune") continue;
		const shadowedSeqs = Array.isArray(prune.data?.shadowedSeqs) ? prune.data.shadowedSeqs : [];
		const originals = [];
		for (const shadowed of shadowedSeqs) {
			const source = session.eventAt(shadowed);
			if (source !== undefined) originals.push(source);
		}
		markers.push({ seq, shadowedSeqs, originals, pruneSeq: prune.seq });
	}
	return markers;
}

/**
 * Restore one Jev marker to its verbatim originals (plan §8 undo / disable path).
 * @param {object} input - `session`, `marker`, optional `estimate`.
 * @returns {object} the replacement record.
 */
function restoreMarker(input) {
	const { session, marker } = input;
	const body = renderOriginals(marker.originals);
	const estimate = input.estimate ?? (() => 0);
	const restoreMessage = {
		id: markerId(),
		role: "user",
		content: [{ type: "text", text: body }],
		source: {
			kind: "plugin",
			plugin: RESTORE_PLUGIN_NAME,
			form: "notice",
			summary: "Jev 筛选撤销（原文恢复）"
		}
	};
	const pruneSeq = session.append("compaction/prune", {
		shadowedRange: { start: marker.seq, end: marker.seq },
		shadowedSeqs: [marker.seq],
		shadowedTokenCount: estimate(restoreMessage) || 0
	}).seq;
	const replacement = session.append("user/message", restoreMessage, {
		surfaceOp: { op: "replace", startSeq: marker.seq, endSeq: marker.seq },
		sourceEventSeqs: [pruneSeq, marker.seq]
	});
	return { restoredSeq: replacement.seq, shadowedSeqs: [...marker.shadowedSeqs] };
}

export {
	MIN_GAIN_SHARE,
	MAX_CANDIDATE_CHARS,
	PLUGIN_NAME,
	QUESTIONS_PER_CANDIDATE,
	RESTORE_PLUGIN_NAME,
	batchCandidates,
	buildState,
	commitPlan,
	findJevMarkers,
	markerId,
	markerMessage,
	planCompaction,
	restoreMarker
};
