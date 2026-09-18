/**
 * dsh-client-ui-task-notify — host half.
 *
 * The notification feature lives in the browser half (`lib/client.js`);
 * this half registers the durable settings namespace that the client
 * toggle reads and writes through `ctx.settingsScope`, so the switch
 * state persists with the DSH configuration (`settings.yaml`) instead
 * of browser-local storage.
 */
import z from "@deepseek-ai/schemastery";

const name = "ui-task-notify";

/** Settings namespace owned by this plugin (same id as the Cordis plugin name). */
const NOTIFY_SETTINGS_NAMESPACE = name;
/** Field carrying the persisted toggle state. */
const NOTIFY_ENABLED_FIELD = "enabled";
/** Field carrying the persisted completion-sound selection. */
const NOTIFY_SOUND_FIELD = "sound";
/** Accepted completion-sound ids; `system` defers to the OS notification sound. */
const NOTIFY_SOUNDS = ["system", "ding", "chime", "rise", "silent"];
/** Durable toggle schema; the default keeps the feature off until the user opts in. */
const NotifySettingsSchema = z.object({
	[NOTIFY_ENABLED_FIELD]: z.boolean().default(false),
	[NOTIFY_SOUND_FIELD]: z.union([...NOTIFY_SOUNDS]).default("system")
});

/**
 * Register the durable toggle section when the optional settings service
 * is composed.
 * @param ctx - Host context that may acquire the settings service.
 */
function apply(ctx) {
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.register(NOTIFY_SETTINGS_NAMESPACE, NotifySettingsSchema);
	});
}

export { apply, name };
