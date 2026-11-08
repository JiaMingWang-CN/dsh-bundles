/**
 * Decide when a session has "ended" for dreaming purposes.
 *
 * DSH has no explicit end-of-session event, so a session counts as ended when
 * it stays idle for `idleMs` after a `turn/end`, or when it is disposed —
 * whichever comes first. Only sessions that finished at least one turn since
 * they last fired are reported, so opening and closing an untouched session
 * queues nothing.
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

/**
 * @param ctx - host plugin context (`on`, `effect`).
 * @param {{ idleMs: () => number, onEnded: (info: { sessionId: string, cwd: string, endedAt: number, seq: number }) => void, now?: () => number }} options
 */
export function installTrigger(ctx, { idleMs, onEnded, now = Date.now }) {
	const timers = new Map();
	const dirty = new Set();

	const cancel = (id) => {
		clearTimeout(timers.get(id));
		timers.delete(id);
	};
	const fire = (session) => {
		const id = session.header.id;
		cancel(id);
		if (!dirty.delete(id)) return;
		onEnded({ sessionId: id, cwd: session.header.cwd, endedAt: now(), seq: session.seq });
	};

	ctx.on("session/event", (session, event) => {
		if (!isEligible(session.header)) return;
		const id = session.header.id;
		if (event.type === "turn/start") cancel(id);
		else if (event.type === "turn/end") {
			dirty.add(id);
			cancel(id);
			timers.set(id, setTimeout(() => fire(session), idleMs()));
		}
	});
	ctx.on("session/disposed", (session) => {
		if (isEligible(session.header)) fire(session);
	});
	ctx.effect(() => () => {
		for (const id of [...timers.keys()]) cancel(id);
	});
}
