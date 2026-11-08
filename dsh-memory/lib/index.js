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
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { resolveMemoryRoot } from "./paths.js";
import { MemoryStore } from "./store.js";
import { installMemoryTools } from "./tools.js";
import { installIndexInjection } from "./inject.js";
import { DreamState } from "./state.js";
import { installTrigger } from "./trigger.js";
import { runDream } from "./dream.js";
import { DreamRunner, reconcile, pruneDreamSessions } from "./runner.js";
import { installDreamCommand } from "./command.js";
import { createStatusPublisher } from "./status.js";

/** Stable Cordis plugin name; also the settings namespace. */
const name = "memory";

/** Host services this plugin needs. */
const inject = ["tools", "systemPrompt", "agents", "sessionQuery"];

/** Delay before the startup scan for sessions that ended unnoticed. */
const RECONCILE_DELAY_MS = 30_000;

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
async function apply(ctx, config) {
	const root = resolveMemoryRoot();
	const store = new MemoryStore(root);
	installMemoryTools(ctx, store, config);
	installIndexInjection(ctx, store, config);

	const state = new DreamState(root);
	await state.load();

	/* Settings channel: the host publishes `status` (retrying writes made before the plugin is active). */
	const status = createStatusPublisher({ name, root, warn: (message) => ctx.logger.warn(message) });
	ctx.effect(() => () => status.detach());
	const runner = new DreamRunner({
		state,
		config,
		onStatus: (snapshot) => status.publish(snapshot),
		runDream: (job) => runDream(ctx, { ...job, store }),
		resolveSelection: () => {
			const provider = config.dreamProvider.get();
			const model = config.dreamModel.get();
			if (provider !== "" && model !== "") return { provider, model };
			return ctx.get("agentDefaultModel")?.currentSelection();
		},
		afterRun: () => pruneDreamSessions(state, join(resolveDshHome(), "sessions"))
	});
	ctx.effect(() => () => runner.stop());
	installTrigger(ctx, {
		idleMs: () => config.idleMinutes.get() * 60_000,
		onEnded: (info) => {
			runner.onSessionEnded(info).catch((error) => ctx.logger.warn("memory: could not queue session %s: %s", info.sessionId, error?.message));
		}
	});
	ctx.inject(["settings"], (child) => {
		child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
		runner.emit();
		status.attach(child.settings);
		child.effect(() => () => status.detach());
	});
	/* A changed `dreamRequest` nonce from the settings page asks for a manual run over every project. */
	let lastRequest = config.dreamRequest.get();
	ctx.on("loader/volatile-update", () => {
		const request = config.dreamRequest.get();
		if (request === lastRequest) return;
		lastRequest = request;
		if (request !== "" && config.enabled.get()) runner.runManual({}).catch((error) => ctx.logger.warn("memory: manual dreaming failed: %s", error?.message));
	});
	ctx.inject(["commands"], (child) => {
		installDreamCommand(child, { config, runner, reconcile: (scope) => reconcile(ctx.sessionQuery, state, scope) });
	});
	const timer = setTimeout(() => {
		if (!config.enabled.get()) return;
		reconcile(ctx.sessionQuery, state).then(() => runner.emit(), (error) => ctx.logger.warn("memory: startup scan failed: %s", error?.message));
	}, RECONCILE_DELAY_MS);
	ctx.effect(() => () => clearTimeout(timer));
}

export { apply, inject, name, Config, EMPTY_STATUS };
