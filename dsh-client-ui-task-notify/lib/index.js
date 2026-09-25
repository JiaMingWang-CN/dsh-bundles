/**
 * dsh-client-ui-task-notify — host half.
 *
 * The notification feature lives in the browser half (`lib/client.js`);
 * this half owns the durable settings schema: the `Config` export is the
 * `ui-task-notify` profile entry's form, which dsh projects into the shared
 * settings document. The client toggle reads and writes it through
 * `ctx.configForms.get(...)`, so the switch state persists with the DSH
 * configuration instead of browser-local storage.
 */
import z from "@deepseek-ai/schemastery";

const name = "ui-task-notify";

/** Field carrying the persisted toggle state. */
const NOTIFY_ENABLED_FIELD = "enabled";
/** Field carrying the persisted completion-sound selection. */
const NOTIFY_SOUND_FIELD = "sound";
/** Accepted completion-sound ids; `system` defers to the OS notification sound. */
const NOTIFY_SOUNDS = ["system", "ding", "chime", "rise", "silent"];
/**
 * Durable toggle schema; the default keeps the feature off until the user opts
 * in. Every field is volatile: the settings form only edits volatile fields,
 * and a volatile-only write lands in the running plugin without a remount.
 */
const Config = z.object({
	[NOTIFY_ENABLED_FIELD]: z.boolean().default(false).volatile(),
	[NOTIFY_SOUND_FIELD]: z.union([...NOTIFY_SOUNDS]).default("system").volatile()
});

/**
 * The host half owns no behavior beyond its settings schema: the automatic
 * config page is suppressed because the feature renders its own
 * `settings.section` page from the browser half.
 * @param ctx - Host plugin context.
 */
function apply(ctx) {
	ctx.inject(["settings"], (child) => {
		child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
	});
}

export { apply, name, Config };
