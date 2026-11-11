/**
 * The small part of a pnpm lockfile the version watch needs: the resolved
 * dependency strings of the profile's root importer. Each Git-installed
 * dependency's string carries the exact commit pnpm unpacked, which is the
 * only local record of what actually runs.
 */

/**
 * Parse the root importer's dependency map from pnpm-lock.yaml text.
 *
 * Only `importers:` and the `.` importer are read, so registry hashes or
 * package metadata elsewhere in the file cannot be mistaken for a version.
 * @param {string} text - lockfile contents.
 * @returns {Map<string, { specifier: string | null, version: string | null }>}
 */
export function parseImporterDependencies(text) {
	const lines = String(text ?? "").split(/\r?\n/);
	const start = lines.findIndex((line) => /^importers:\s*$/.test(line));
	if (start < 0) return new Map();
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trim() === "" || line.trim().startsWith("#")) continue;
		if (!/^\s/.test(line)) {
			end = index;
			break;
		}
	}

	const dependencies = new Map();
	let root = false;
	let section = false;
	let pendingKey = null;

	const unquote = (value) => value.trim().replace(/^['"]|['"]$/g, "");
	const header = (line) => {
		const match = line.match(/^(\s*)(.+?):\s*$/);
		return match === null ? null : { indent: match[1].length, key: unquote(match[2]) };
	};
	const value = (line) => {
		const match = line.match(/^(\s*)(.+?):\s+(.*)$/);
		return match === null ? null : { indent: match[1].length, key: unquote(match[2]), value: unquote(match[3]) };
	};

	for (let index = start + 1; index < end; index += 1) {
		const line = lines[index];
		if (line.trim() === "" || line.trim().startsWith("#")) continue;
		const pair = value(line);
		const head = pair === null ? header(line) : null;
		const indent = pair === null ? head?.indent : pair.indent;
		if (indent === undefined) continue;

		if (indent === 2) {
			root = false;
			section = false;
			pendingKey = null;
			root = (pair?.key ?? head?.key) === ".";
			continue;
		}
		if (!root) continue;

		if (!section && indent === 4 && /^(?:dev|optional)?dependencies$/.test(pair?.key ?? head?.key ?? "")) {
			section = true;
			continue;
		}
		if (!section) continue;

		if (indent === 6) {
			// A dependency row may carry an inline value (`name: version`) or a nested map.
			if (pair !== null) {
				dependencies.set(pair.key, { specifier: pair.value, version: null });
				} else {
				pendingKey = head.key;
					dependencies.set(pendingKey, { specifier: null, version: null });
			}
			continue;
		}

		if (indent === 8) {
			const key = pair?.key ?? head?.key;
			const entry = pendingKey === null ? null : dependencies.get(pendingKey);
			if (entry === null || entry === undefined) continue;
			if (key === "specifier" && pair !== null) entry.specifier = pair.value;
			if (key === "version" && pair !== null) entry.version = pair.value;
		}
	}
	return dependencies;
}

/**
 * Extract the exact Git commit a resolved dependency string names, if any.
 * @param {string | null | undefined} resolution - the importer's `version:` value.
 * @returns {string | null}
 */
export function commitFromResolution(resolution) {
	if (typeof resolution !== "string") return null;
	const match = resolution.match(/(?:^|[/#&])([0-9a-f]{40})(?:[&#]|$)/i);
	return match === null ? null : match[1].toLowerCase();
}

