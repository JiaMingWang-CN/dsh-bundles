/**
 * dsh-memory — host half.
 *
 * Cross-session memory for DSH agents: notes the agent keeps in a per-project
 * and a per-user partition, an INDEX snapshot injected into each session, and
 * "dreaming" — a hidden background agent that corrects, merges and compacts
 * the notes against session transcripts after a session ends.
 *
 * Settings channel (plan Task 0, choice B): every field is volatile. The
 * client edits the user-facing fields and writes `dreamRequest`; only the
 * host writes `status`, through `ctx.settings.update()`.
 *
 * Design: docs/specs/2026-11-08-agent-memory-design.md
 */
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name; also the settings namespace. */
const name = "memory";

/** Status snapshot shown on the settings page before the first run. */
const EMPTY_STATUS = { paused: null, running: null, pendingCount: 0, log: [] };

/**
 * Durable settings schema. All fields are volatile so settings writes reach
 * the running plugin without a remount.
 */
const Config = z.object({
	enabled: z.boolean().default(true).volatile(),
	autoDream: z.boolean().default(true).volatile(),
	idleMinutes: z.natural().min(1).default(10).volatile(),
	indexMaxBytes: z.natural().min(512).default(4096).volatile(),
	dreamProvider: z.string().default("").volatile(),
	dreamModel: z.string().default("").volatile(),
	status: z.any().default(EMPTY_STATUS).volatile(),
	dreamRequest: z.string().default("").volatile()
});

/**
 * Wire the memory feature into the host.
 * @param ctx - host plugin context.
 * @param config - live volatile config reference.
 */
function apply(ctx, config) {
	void ctx;
	void config;
}

export { apply, name, Config, EMPTY_STATUS };
