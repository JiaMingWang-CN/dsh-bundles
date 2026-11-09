/**
 * Decide when a session has "ended" for dreaming purposes.
 *
 * DSH has no explicit end-of-session event, so a session counts as ended when
 * it stays idle for `idleMs` after a `turn/end`, or when it is disposed —
 * whichever comes first. It is reported only when the work since it was last
 * reported is worth consolidating (see `isSubstantive`): a greeting, an
 * aborted turn or an untouched session queues nothing, and their activity
 * carries over until the session does real work.
 */

/**
 * Sessions that dreaming learns from: top-level user sessions bound to a
 * project directory. Subagent children and cwd-less sessions (including the
 * hidden dreaming agent itself) are excluded.
 * @param {{ cwd?: string, origin?: string, parentSession?: string }} header
 */
export function isEligible(header) {
	return typeof header?.cwd === "string" && header.cwd.length > 0 && header.origin !== "subagent" && header.parentSession === undefined;
}

/** @typedef {{ completedTurns: number, toolCalls: number }} Activity */

/** @returns {Activity} */
export const emptyActivity = () => ({ completedTurns: 0, toolCalls: 0 });

/**
 * Fold one session event into its activity: turns that completed (not
 * aborted or failed) and tool calls other than the memory tools.
 * @param {Activity} activity
 * @param {{ type: string, data?: any }} event
 * @returns {Activity}
 */
export function accumulate(activity, event) {
	if (event.type === "turn/end" && event.data?.reason?.kind === "completed") return { ...activity, completedTurns: activity.completedTurns + 1 };
	if (event.type === "assistant/message") {
		const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
		const calls = content.filter((block) => block?.type === "tool-call" && !String(block.name ?? "").startsWith("memory_")).length;
		if (calls > 0) return { ...activity, toolCalls: activity.toolCalls + calls };
	}
	return activity;
}

/**
 * Worth a dreaming run: at least two completed turns, or one completed turn
 * that used a tool.
 * @param {Activity} activity
 */
export function isSubstantive(activity) {
	return activity.completedTurns >= 2 || (activity.completedTurns >= 1 && activity.toolCalls >= 1);
}

/**
 * @param ctx - host plugin context (`on`, `effect`).
 * @param {{ idleMs: () => number, onEnded: (info: { sessionId: string, cwd: string, endedAt: number, seq: number }) => void, now?: () => number }} options
 */
export function installTrigger(ctx, { idleMs, onEnded, now = Date.now }) {
	const timers = new Map();
	/** Activity since the session was last reported. */
	const activity = new Map();

	const cancel = (id) => {
		clearTimeout(timers.get(id));
		timers.delete(id);
	};
	const fire = (session) => {
		const id = session.header.id;
		cancel(id);
		if (!isSubstantive(activity.get(id) ?? emptyActivity())) return;
		activity.delete(id);
		onEnded({ sessionId: id, cwd: session.header.cwd, endedAt: now(), seq: session.seq });
	};

	ctx.on("session/event", (session, event) => {
		if (!isEligible(session.header)) return;
		const id = session.header.id;
		activity.set(id, accumulate(activity.get(id) ?? emptyActivity(), event));
		if (event.type === "turn/start") cancel(id);
		else if (event.type === "turn/end") {
			cancel(id);
			timers.set(id, setTimeout(() => fire(session), idleMs()));
		}
	});
	ctx.on("session/disposed", (session) => {
		if (!isEligible(session.header)) return;
		fire(session);
		activity.delete(session.header.id);
	});
	ctx.effect(() => () => {
		for (const id of [...timers.keys()]) cancel(id);
	});
}
