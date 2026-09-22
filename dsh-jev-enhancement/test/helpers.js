/**
 * Minimal in-memory session double implementing the surface-replace protocol
 * the plugin commits through (append-only log, `compaction/prune` shadow price
 * followed by one `user/message` replacement covering every shadowed node).
 */

/** Create one empty fake session. */
export function createFakeSession() {
	const log = [];
	let nodes = [];
	const listeners = [];
	const session = {
		id: "session-under-test",
		get surface() {
			return { nodes: [...nodes], replaceGeneration: session.replaceGeneration };
		},
		replaceGeneration: 0,
		eventAt(seq) {
			return log[seq];
		},
		snapshotEvents() {
			return [...log];
		},
		append(type, data, opts) {
			const event = { type, seq: log.length, time: 1, data, ...(opts ?? {}) };
			if (opts?.surfaceOp?.op === "replace") {
				const { startSeq, endSeq } = opts.surfaceOp;
				const startIndex = nodes.indexOf(startSeq);
				const endIndex = nodes.indexOf(endSeq);
				if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) {
					throw new Error("fake session: replacement range is not on the surface");
				}
				const shadowed = nodes.slice(startIndex, endIndex + 1);
				const cited = new Set(opts.sourceEventSeqs ?? []);
				for (const seq of shadowed) {
					if (!cited.has(seq)) throw new Error("fake session: sourceEventSeqs must cite every shadowed node");
				}
				nodes = [...nodes.slice(0, startIndex), event.seq, ...nodes.slice(endIndex + 1)];
				session.replaceGeneration += 1;
			} else if (opts?.surfaceOp === "append" || opts?.surfaceOp === undefined) {
				if (type === "user/message" || type === "assistant/message" || type === "tool/result" || type === "system/message") {
					nodes.push(event.seq);
				}
			}
			log.push(event);
			for (const listener of listeners) listener(event);
			return event;
		},
		subscribe(listener) {
			listeners.push(listener);
			return () => {};
		}
	};
	return session;
}

/**
 * Append one plain user message node.
 * @param {object} session - the fake session.
 * @param {string} text - message text.
 * @param {object} [source] - optional message source.
 * @returns {object} the appended event.
 */
export function addUserMessage(session, text, source = { kind: "user" }) {
	return session.append("user/message", {
		id: "m" + session.surface.nodes.length,
		role: "user",
		content: [{ type: "text", text }],
		source
	}, { surfaceOp: "append" });
}

/**
 * Append one assistant message node.
 * @param {object} session - the fake session.
 * @param {object[]} blocks - content blocks.
 * @returns {object} the appended event.
 */
export function addAssistantMessage(session, blocks) {
	return session.append("assistant/message", {
		turn: 1,
		step: 1,
		message: {
			id: "a" + session.surface.nodes.length,
			role: "assistant",
			content: blocks,
			source: { kind: "model", provider: "p", model: "m", attemptId: "attempt" }
		}
	}, { surfaceOp: "append" });
}

/**
 * Append one tool result node.
 * @param {object} session - the fake session.
 * @param {string} callId - the correlated tool call id.
 * @param {string} text - result text.
 * @param {object} [options] - `isError`, `toolName` for the recorded call.
 * @returns {object} the appended event.
 */
export function addToolResult(session, callId, text, options = {}) {
	return session.append("tool/result", {
		turn: 1,
		step: 1,
		message: {
			id: "t" + session.surface.nodes.length,
			role: "user",
			content: [{
				type: "tool-result",
				toolCallId: callId,
				content: [{ type: "text", text }],
				...(options.isError === true ? { isError: true } : {})
			}],
			source: { kind: "tool", callId }
		},
		...(options.isError === true ? { error: { name: "Error", code: "TOOL_FAILED" } } : {})
	}, { surfaceOp: "append" });
}

/**
 * Append one system message node.
 * @param {object} session - the fake session.
 * @param {string} text - system prompt text.
 * @returns {object} the appended event.
 */
export function addSystemMessage(session, text) {
	return session.append("system/message", {
		turn: 1,
		step: 1,
		message: {
			id: "s" + session.surface.nodes.length,
			role: "system",
			content: [{ type: "text", text }],
			source: { kind: "plugin", plugin: "test" }
		}
	}, { surfaceOp: "append" });
}

/**
 * Build surface nodes in the shape the planner consumes.
 * @param {object} session - the fake session.
 * @param {number} [tokens] - per-node token price.
 * @returns {object[]} nodes with `seq`, `event`, `tokens`, `heuristicTokens`.
 */
export function surfaceNodes(session, tokens = 100) {
	return session.surface.nodes.map((seq) => ({
		seq,
		event: session.eventAt(seq),
		tokens,
		heuristicTokens: tokens
	}));
}
