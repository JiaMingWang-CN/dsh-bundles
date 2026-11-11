/**
 * Dependency-spec interpretation for the plugin version watch.
 *
 * The profile's `package.json` records what `pnpm add` saved: a registry
 * name/range, a GitHub shortcut (`github:owner/repo#path:subdir`), a Git URL,
 * a tarball URL, or a local path. The version watch needs three things from
 * that spec: which check applies, which repository (if any) to ask for the
 * latest commit, and the package subdirectory whose `package.json` carries
 * the published version.
 */

/** A 40-character Git object name. */
const COMMIT = /^[0-9a-f]{40}$/i;

/** Hosts whose `https://host/owner/repo` form names a Git repository. */
const GIT_HOSTS = /(?:^|\.)(?:github|gitlab|bitbucket|gitee|codeberg)\.(?:com|org)$/i;

/**
 * Split the first `#` fragment off a spec.
 * @param {string} spec - raw saved spec.
 * @returns {{ base: string, fragment: string }}
 */
function takeFragment(spec) {
	const hash = spec.indexOf("#");
	return hash < 0 ? { base: spec, fragment: "" } : { base: spec.slice(0, hash), fragment: spec.slice(hash + 1) };
}

/**
 * Read the fragment parts pnpm understands.
 * @param {string} fragment - text after the first `#`, possibly `ref&path:x` or `ref#path:x`.
 * @returns {{ ref: string | null, subdir: string | null, semver: string | null, pinned: string | null }}
 */
function parseFragment(fragment) {
	let ref = null;
	let subdir = null;
	let semver = null;
	let pinned = null;
	for (const part of String(fragment).split(/[&#]/).filter(Boolean)) {
		const lower = part.toLowerCase();
		if (lower.startsWith("path:")) {
			subdir = part.slice(5).replace(/^\/+/, "").replace(/^\.\//, "").replace(/\/+$/, "");
			if (subdir === "") subdir = null;
		} else if (lower.startsWith("semver:")) {
			semver = part.slice(7);
		} else if (COMMIT.test(part)) {
			pinned = part.toLowerCase();
		} else if (ref === null) {
			ref = part;
		}
	}
	return { ref, subdir, semver, pinned };
}

/**
 * Classify one recorded dependency spec.
 * @param {string} raw - spec saved in the profile manifest.
 * @returns {{
 *   kind: "git" | "registry" | "local" | "tarball" | "unknown",
 *   repoUrl?: string | null,
 *   ref?: string | null,
 *   subdir?: string | null,
 *   semver?: string | null,
 *   pinned?: string | null,
 * }}
 */
export function parseDependencySpec(raw) {
	const spec = String(raw ?? "").trim();
	if (spec === "") return { kind: "unknown" };
	if (/^(?:file|link):/i.test(spec)) return { kind: "local" };
	if (/^(?:~|\.{1,2}\/|\/)/.test(spec) || /^[a-zA-Z]:[\\/]/.test(spec)) return { kind: "local" };

	if (/^github:/i.test(spec)) {
		const { base, fragment } = takeFragment(spec.slice(7));
		return gitShortcut(base, fragment);
	}
	if (!spec.startsWith("@") && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#|$)/.test(spec)) {
		const { base, fragment } = takeFragment(spec);
		return gitShortcut(base, fragment);
	}

	if (/^(?:git\+)?(?:ssh|https?|git):/i.test(spec) || /^git@/.test(spec)) {
		const { base, fragment } = takeFragment(spec);
		const url = base.replace(/^git\+/i, "");
		const known = /^git@/.test(url) || /^(?:ssh|git):/i.test(url) || /\.git$/i.test(url) || gitHostUrl(url);
		if (known) {
			return { kind: "git", repoUrl: url, ...parseFragment(fragment) };
		}
		return { kind: "tarball" };
	}

	return { kind: "registry" };
}

/**
 * `owner/repo` GitHub shorthand.
 * @param {string} base - repository part without the `github:` prefix or fragment.
 * @param {string} fragment - fragment text.
 * @returns {{ kind: "git", repoUrl: string | null, ref: string | null, subdir: string | null, semver: string | null, pinned: string | null }}
 */
function gitShortcut(base, fragment) {
	const match = base.match(/^([^/]+)\/([^/]+?)(?:\.git)?$/);
	return {
		kind: "git",
		repoUrl: match === null ? null : `https://github.com/${match[1]}/${match[2]}.git`,
		...parseFragment(fragment),
	};
}

/**
 * Whether an https URL points at a repository rather than a tarball.
 * @param {string} url - candidate URL.
 * @returns {boolean}
 */
function gitHostUrl(url) {
	try {
		const parsed = new URL(url);
		if (!/^https?:/.test(parsed.protocol)) return false;
		if (!GIT_HOSTS.test(parsed.hostname)) return false;
		const segments = parsed.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
		return segments.length === 2;
	} catch {
		return false;
	}
}

/**
 * Hide credentials a saved spec may carry in an http(s) URL.
 * @param {string} spec - recorded spec.
 * @returns {string}
 */
export function redactSource(spec) {
	return String(spec ?? "").replace(/^(\w+:\/\/)([^/@]+)@/, "$1");
}

/**
 * Shorten a 40-character commit for display.
 * @param {string | null | undefined} commit - object name.
 * @returns {string | null}
 */
export function shortCommit(commit) {
	return typeof commit === "string" && COMMIT.test(commit) ? commit.slice(0, 7) : (commit ?? null);
}

/**
 * The raw URL of a package's `package.json` at one commit, on GitHub.
 * @param {string | null} repoUrl - repository URL.
 * @param {string} commit - 40-character commit.
 * @param {string | null} subdir - package directory inside the repository.
 * @returns {string | null}
 */
export function githubRawManifestUrl(repoUrl, commit, subdir) {
	if (typeof repoUrl !== "string" || typeof commit !== "string" || !COMMIT.test(commit)) return null;
	let host;
	let pathname;
	const ssh = repoUrl.match(/^git@([^:]+):(.+)$/);
	if (ssh !== null) {
		host = ssh[1].toLowerCase();
		pathname = ssh[2];
	} else {
		try {
			const parsed = new URL(repoUrl);
			host = parsed.hostname.toLowerCase();
			pathname = parsed.pathname;
		} catch {
			return null;
		}
	}
	if (host !== "github.com") return null;
	const repoPath = pathname.replace(/^\/+/, "").replace(/\.git$/i, "");
	const [owner, name] = repoPath.split("/");
	if (owner === undefined || name === undefined || owner === "" || name === "") return null;
	const encode = (part) => part.split("/").filter(Boolean).map(encodeURIComponent).join("/");
	const directory = subdir ? `${encode(subdir)}/` : "";
	return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${encodeURIComponent(commit)}/${directory}package.json`;
}
