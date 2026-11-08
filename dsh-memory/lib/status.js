/**
 * Publishes the runner status into the plugin's own `status` settings field
 * (the host→client channel). The settings service only writes entries whose
 * plugin is already active, so a write attempted while the plugin is still
 * loading fails; a failed write is retried and is never remembered as
 * published, so the next identical status is not skipped.
 */

const RETRY_MS = 2000;

/**
 * @param {{ name: string, root: string, warn: (message: string) => void,
 *   setTimer?: (fn: () => void, ms: number) => unknown, clearTimer?: (handle: unknown) => void, retryMs?: number }} options
 */
export function createStatusPublisher({ name, root, warn, setTimer = setTimeout, clearTimer = clearTimeout, retryMs = RETRY_MS }) {
	let settings;
	let latest;
	let published;
	let retry;

	const flush = () => {
		if (settings === undefined || latest === undefined || latest === published) return;
		const next = latest;
		const target = settings;
		target.update(name, { status: JSON.parse(next) }).then(() => {
			published = next;
		}, (error) => {
			if (retry !== undefined || settings !== target) return;
			warn(`memory: could not publish status (will retry): ${error?.message}`);
			retry = setTimer(() => {
				retry = undefined;
				flush();
			}, retryMs);
		});
	};

	return {
		/** Start writing through the settings service. */
		attach(service) {
			settings = service;
			flush();
		},
		/** Stop writing (settings service gone or plugin unloading). */
		detach() {
			settings = undefined;
			if (retry !== undefined) clearTimer(retry);
			retry = undefined;
		},
		/** Record the newest status and write it when possible. */
		publish(status) {
			latest = JSON.stringify({ ...status, root });
			flush();
		}
	};
}
