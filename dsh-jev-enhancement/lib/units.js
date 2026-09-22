/**
 * Atomic context units and the default hard-protection rules (plan §5.2, §6).
 *
 * The unit layer turns a surface snapshot into indivisible groups — a tool
 * call and its results are never split — and marks what may NOT be removed
 * without asking anyone. Protection is deliberately conservative: "the tool
 * could be run again" is not reproducibility (plan §6.2), so only verifiable
 * re-readable tool outputs may even become candidates, and everything whose
 * loss cannot be proven safe stays protected.
 *
 * Pure module (no imports) so `node --test` can run it standalone.
 */

/** Tool names whose output is a verifiable re-read of local state. */
const RERUNNABLE_READ_TOOLS = ["read", "read_file", "grep", "glob", "ls", "list", "list_dir"];

/** Mutating tools whose not-yet-landed results are never reproducible. */
const MUTATING_TOOL_HINTS = ["write", "edit", "patch", "replace", "delete", "remove", "move", "rename", "mkdir", "create", "apply_diff", "str_replace"];

/** User-visible markers that pin content into the context. */
const PIN_MARKERS = ["保留此内容", "不要删除", "不要移除", "keep this", "do not remove", "do not delete", "@pin"];

/** Markers of a human approval / authorization boundary. */
const APPROVAL_MARKERS = ["已批准", "审批", "授权", "已授权", "approved", "authorized", "authorization", "permission granted"];

/** Stable reasons a unit is protected from removal. */
const PROTECTION_REASONS = [
	"system-prompt",
	"incomplete-tool-pair",
	"attachment",
	"unlanded-edit",
	"one-shot-output",
	"error-site",
	"external-state",
	"user-goal",
	"user-pinned",
	"approval-boundary",
	"referenced",
	"recent"
];

/** Minimum quote length considered a distinctive reference to earlier content. */
const REFERENCE_QUOTE_CHARS = 48;

function isObject(value) {
	return typeof value === "object" && value !== null;
}

/**
 * Extract the model-visible text of one content block list.
 * @param {unknown[]} blocks - content blocks.
 * @param {object} sink - accumulator with `text`, `callIds`, `toolNames`, `arguments`.
 * @returns {void} fills the sink.
 */
function collectBlocks(blocks, sink) {
	if (!Array.isArray(blocks)) return;
	for (const block of blocks) {
		if (!isObject(block)) continue;
		if (block.type === "text" || block.type === "reasoning") {
			if (typeof block.text === "string") sink.text.push(block.text);
			continue;
		}
		if (block.type === "tool-call") {
			if (typeof block.id === "string") sink.callIds.push(block.id);
			if (typeof block.name === "string") sink.toolNames.push(block.name);
			if (typeof block.arguments === "string") sink.text.push(block.arguments);
			continue;
		}
		if (block.type === "tool-result") {
			if (typeof block.toolCallId === "string") sink.callIds.push(block.toolCallId);
			if (block.isError === true) sink.isError = true;
			collectBlocks(block.content, sink);
			continue;
		}
		/* Any richer block (image, file, unknown extensions) marks the unit. */
		sink.hasAttachments = true;
	}
}

/**
 * Build indivisible units from one surface snapshot, in surface order.
 *
 * An assistant message carrying tool calls opens a group that absorbs the
 * matching `tool/result` nodes; a group missing a result is incomplete and can
 * never be removed. Everything else is a single-message unit.
 * @param {Array<{ seq: number, event: object, tokens: number }>} nodes - surface nodes head to tail.
 * @returns {object[]} detached units with `protection` left unset.
 */
function buildUnits(nodes) {
	const units = [];
	let open = null;

	const close = () => {
		if (open === undefined || open === null) return;
		open.complete = open.pending.size === 0;
		units.push(open);
		open = null;
	};

	for (const node of nodes) {
		const event = node.event;
		const type = event?.type;
		const payload = type === "user/message" ? event.data : event?.data?.message;
		const sink = { text: [], callIds: [], toolNames: [], isError: false, hasAttachments: false };
		collectBlocks(payload?.content, sink);
		const role = type === "assistant/message" ? "assistant" : type === "tool/result" ? "tool" : type === "system/message" ? "system" : "user";
		const piece = {
			seq: node.seq,
			type,
			role,
			tokens: Number.isFinite(node.tokens) ? node.tokens : 0,
			text: sink.text.join("\n"),
			callIds: sink.callIds,
			toolNames: sink.toolNames,
			isError: sink.isError,
			hasAttachments: sink.hasAttachments,
			toolCallId: type === "tool/result" && isObject(payload?.content?.[0]) ? payload.content[0].toolCallId : undefined
		};
		if (type === "system/message") {
			close();
			units.push({
				kind: "system",
				startSeq: node.seq,
				endSeq: node.seq,
				seqs: [node.seq],
				tokens: piece.tokens,
				roles: ["system"],
				pieces: [piece],
				text: piece.text,
				callIds: [],
				toolNames: [],
				isError: false,
				hasAttachments: false,
				complete: true
			});
			continue;
		}
		const toolCallIds = sink.callIds.filter((id, index) => sink.callIds.indexOf(id) === index);
		if (type === "assistant/message" && toolCallIds.length > 0) {
			close();
			open = {
				kind: "tool-group",
				startSeq: node.seq,
				endSeq: node.seq,
				seqs: [node.seq],
				tokens: piece.tokens,
				roles: ["assistant"],
				pieces: [piece],
				text: piece.text,
				callIds: toolCallIds,
				toolNames: [...sink.toolNames],
				isError: sink.isError,
				hasAttachments: sink.hasAttachments,
				pending: new Set(toolCallIds),
				complete: false
			};
			continue;
		}
		if (type === "tool/result") {
			const callId = piece.toolCallId;
			if (open !== null && callId !== undefined && open.pending.has(callId)) {
				open.pending.delete(callId);
				open.seqs.push(node.seq);
				open.endSeq = node.seq;
				open.tokens += piece.tokens;
				open.roles.push("tool");
				open.pieces.push(piece);
				open.text += "\n" + piece.text;
				open.isError = open.isError || piece.isError;
				open.hasAttachments = open.hasAttachments || piece.hasAttachments;
				if (open.pending.size === 0) close();
				continue;
			}
			close();
			/* An orphan tool result cannot stand alone safely: incomplete pairing. */
			const orphan = {
				kind: "tool-group",
				startSeq: node.seq,
				endSeq: node.seq,
				seqs: [node.seq],
				tokens: piece.tokens,
				roles: ["tool"],
				pieces: [piece],
				text: piece.text,
				callIds: callId === undefined ? [] : [callId],
				toolNames: [],
				isError: piece.isError,
				hasAttachments: piece.hasAttachments,
				pending: new Set(),
				complete: false
			};
			units.push(orphan);
			continue;
		}
		if (open !== null) close();
		units.push({
			kind: "message",
			startSeq: node.seq,
			endSeq: node.seq,
			seqs: [node.seq],
			tokens: piece.tokens,
			types: [type],
			roles: [role],
			pieces: [piece],
			text: piece.text,
			callIds: [],
			toolNames: [],
			isError: piece.isError,
			hasAttachments: piece.hasAttachments,
			complete: true
		});
	}
	close();
	for (const unit of units) {
		unit.id = "u" + unit.startSeq;
		unit.messageCount = unit.seqs.length;
		delete unit.pending;
	}
	return units;
}

/**
 * Whether one tool output is a verifiable re-read: produced by an allow-listed
 * read-only tool, not an error, and naming its source arguments.
 * @param {object} unit - one tool-group unit.
 * @returns {boolean} whether the output is re-derivable without side effects.
 */
function isVerifiableReread(unit) {
	if (unit.kind !== "tool-group") return false;
	if (!unit.complete || unit.isError || unit.hasAttachments) return false;
	if (unit.toolNames.length === 0) return false;
	if (!unit.toolNames.every((name) => RERUNNABLE_READ_TOOLS.includes(name))) return false;
	/* The recorded call arguments are the source identity that makes a re-read verifiable. */
	return unit.pieces.some((piece) => piece.text.length > 0);
}

/**
 * Mark default hard protection on every unit (plan §6.1).
 *
 * `keepRecentMessages` is a floor counted in surface messages from the tail and
 * expanded forward to whole units, so a tool pair is never cut in half.
 * @param {object[]} units - units from {@link buildUnits}.
 * @param {object} options - `keepRecentMessages`, optional `pinMarkers`, `goalText`.
 * @returns {object[]} the same units with `protection: { protected, reason }`.
 */
function classifyProtection(units, options = {}) {
	const keepRecent = Number.isInteger(options.keepRecentMessages) && options.keepRecentMessages > 0 ? options.keepRecentMessages : 0;
	const pinMarkers = options.pinMarkers ?? PIN_MARKERS;
	const approvalMarkers = options.approvalMarkers ?? APPROVAL_MARKERS;

	/* Goal: the first user message of the session is the standing objective. */
	let goalSeen = false;

	/* Referenced-later pass: call ids and distinctive quotes of earlier text. */
	const laterTexts = new Array(units.length);
	let accumulated = "";
	for (let index = units.length - 1; index >= 0; index -= 1) {
		laterTexts[index] = accumulated;
		accumulated += "\n" + units[index].text;
	}
	const referenced = new Set();
	for (let index = 0; index < units.length; index += 1) {
		const unit = units[index];
		const later = laterTexts[index];
		if (unit.callIds.some((callId) => later.includes(callId))) referenced.add(unit.id);
		const quote = unit.text.length > REFERENCE_QUOTE_CHARS ? unit.text.slice(0, REFERENCE_QUOTE_CHARS) : "";
		if (quote !== "" && later.includes(quote)) referenced.add(unit.id);
	}

	/* Recent floor: whole units covering the tail's message count. */
	const recentSeqs = new Set();
	let kept = 0;
	for (let index = units.length - 1; index >= 0 && kept < keepRecent; index -= 1) {
		const unit = units[index];
		kept += unit.messageCount;
		recentSeqs.add(unit.id);
	}

	for (const unit of units) {
		let reason = "";
		if (unit.kind === "system") reason = "system-prompt";
		else if (!unit.complete) reason = "incomplete-tool-pair";
		else if (unit.hasAttachments) reason = "attachment";
		else if (recentSeqs.has(unit.id)) reason = "recent";
		else if (unit.kind === "tool-group") {
			if (unit.toolNames.some((name) => MUTATING_TOOL_HINTS.some((hint) => name.includes(hint)))) reason = "unlanded-edit";
			else if (unit.isError) reason = "error-site";
			else if (!isVerifiableReread(unit)) reason = "one-shot-output";
		} else if (unit.isError) reason = "error-site";
		if (reason === "") {
			const text = unit.text;
			if (!goalSeen && unit.roles.includes("user")) {
				goalSeen = true;
				reason = "user-goal";
			} else if (pinMarkers.some((marker) => text.includes(marker))) reason = "user-pinned";
			else if (approvalMarkers.some((marker) => text.includes(marker))) reason = "approval-boundary";
			else if (referenced.has(unit.id)) reason = "referenced";
		}
		unit.protection = { protected: reason !== "", reason };
	}
	return units;
}

/**
 * Verify that a span of complete units never splits a tool pair. Units are
 * indivisible by construction, so any whole-unit span is balanced; this guard
 * exists for callers that assemble spans across unit boundaries.
 * @param {object[]} units - classified units.
 * @param {number} startIndex - first unit index of the span.
 * @param {number} endIndex - last unit index of the span (inclusive).
 * @returns {boolean} whether the span is safe to shadow in one replacement.
 */
function spanBalanced(units, startIndex, endIndex) {
	for (let index = startIndex; index <= endIndex; index += 1) {
		const unit = units[index];
		if (unit === undefined || !unit.complete || unit.kind === "system") return false;
	}
	return true;
}

/**
 * Verbatim restoration text for one removed span (plan §6.3 / undo).
 *
 * Original bytes are preserved; role and tool identity are kept as labels
 * because one surface replacement can only carry one message (see
 * `docs/jev-stage1-extension-map.md` for the minimal core extension that would
 * remove even this labeling step).
 * @param {object[]} originals - the shadowed events, in surface order.
 * @returns {string} the restoration body.
 */
function renderOriginals(originals) {
	const parts = [];
	for (const event of originals) {
		const payload = event.type === "user/message" ? event.data : event.data?.message;
		const label = "[" + event.type + " seq=" + event.seq + (payload?.source?.callId ? " call=" + payload.source.callId : "") + "]";
		const sink = { text: [], callIds: [], toolNames: [], isError: false, hasAttachments: false };
		collectBlocks(payload?.content, sink);
		parts.push(label + "\n" + sink.text.join("\n"));
	}
	return parts.join("\n\n");
}

export {
	APPROVAL_MARKERS,
	MUTATING_TOOL_HINTS,
	PIN_MARKERS,
	PROTECTION_REASONS,
	REFERENCE_QUOTE_CHARS,
	RERUNNABLE_READ_TOOLS,
	buildUnits,
	classifyProtection,
	collectBlocks,
	isVerifiableReread,
	renderOriginals,
	spanBalanced
};
