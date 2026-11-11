/**
 * dsh-plugin-version-watch — Host half.
 *
 * Two authenticated Fetch routes serve the Settings page:
 *
 *   GET  /api/version-watch/status  — installed profile bundles with their
 *        version, source, and update check (Git commit or registry version).
 *   POST /api/version-watch/update  — update one plugin in place: a Git
 *        source is removed and reinstalled at its recorded spec (so pnpm
 *        resolves the newest commit), a registry source uses the plugin
 *        manager's own update path.
 *
 * The plugin manager owns every mutation, so HMR applies the result to the
 * running process: a successful update is live and needs no restart. A Git
 * reinstallation that fails leaves the plugin uninstalled; the response says
 * so and carries the redacted spec.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { commitFromResolution, parseImporterDependencies } from "./lockfile.js";
import { githubRawManifestUrl, parseDependencySpec, redactSource } from "./spec.js";

/** Authenticated Host route answering the Settings page's reads. */
const STATUS_ROUTE = "/api/version-watch/status";
/** Authenticated Host route performing one update. */
const UPDATE_ROUTE = "/api/version-watch/update";
/** Bound on one `git ls-remote` run. */
const GIT_TIMEOUT_MS = 25_000;
/** Bound on one remote `package.json` read. */
const MANIFEST_TIMEOUT_MS = 15_000;
/** How long a successful check is reused before the remote is asked again. */
const CHECK_TTL_MS = 5 * 60 * 1000;
/** Console/diagnostic text kept short; the failure stays recognizable. */
const MAX_DETAIL = 400;
/** Parallel remote checks while listing plugins. */
const CHECK_CONCURRENCY = 4;

/** Successful checks, keyed by package name. */
const checkCache = new Map();
/** One update at a time: a second removal/installation must not overlap. */
let updateRunning = false;

/** Cordis plugin name. */
export const name = "version-watch";

/** Services this plugin cannot work without. */
export const inject = ["connection", "pluginManager"];

/**
 * JSON response for one route call.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 * @returns {Response}
 */
function reply(status, body) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
}

/**
 * Keep failure text bounded.
 * @param {string} text - diagnostic.
 * @returns {string}
 */
function truncate(text) {
	const value = String(text ?? "");
	return value.length > MAX_DETAIL ? `${value.slice(0, MAX_DETAIL)}…` : value;
}

/**
 * Flatten a ChangeResult's error into one readable detail.
 * @param {{ code?: string, diagnostic?: string } | undefined} error - manager error.
 * @returns {string}
 */
function errorDetail(error) {
	return truncate([error?.code, error?.diagnostic].filter((part) => typeof part === "string" && part !== "").join(": "));
}

/**
 * Flatten an installation result's diagnostics, keeping pnpm's own words.
 * @param {unknown} result - ChangeResult.
 * @returns {string}
 */
function installDetail(result) {
	const candidate = result;
	const parts = [
		candidate?.error?.code,
		candidate?.error?.diagnostic,
		candidate?.packageResult?.kind,
		candidate?.packageResult?.output,
	].filter((part) => typeof part === "string" && part !== "");
	return truncate(parts.join("\n"));
}

/**
 * The current profile directory, when the Host exposes it.
 * @param {import("cordis").Context} ctx - Host context.
 * @returns {string | null}
 */
function profileDirOf(ctx) {
	const profile = ctx.get("profileContext");
	if (profile !== undefined && typeof profile.dir === "string" && profile.dir !== "") return profile.dir;
	const fromEnv = process.env.DSH_PROFILE_DIR;
	return typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : null;
}

/**
 * Read a UTF-8 file, treating absence as no content.
 * @param {string} path - absolute path.
 * @returns {Promise<string | null>}
 */
async function readText(path) {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Read the profile manifest, its lockfile importer versions, and its directory.
 * @param {import("cordis").Context} ctx - Host context.
 * @returns {Promise<{ dir: string | null, manifest: Record<string, any> | null, lock: Map<string, { specifier: string | null, version: string | null }> }>}
 */
async function profileState(ctx) {
	const dir = profileDirOf(ctx);
	let manifest = null;
	let lock = new Map();
	if (dir !== null) {
		const manifestText = await readText(join(dir, "package.json"));
		if (manifestText !== null) {
			try {
				manifest = JSON.parse(manifestText);
			} catch {
				manifest = null;
			}
		}
		const lockText = await readText(join(dir, "pnpm-lock.yaml"));
		if (lockText !== null) lock = parseImporterDependencies(lockText);
	}
	return { dir, manifest, lock };
}

/**
 * Run one `git ls-remote` without credentials helpers or terminal prompts.
 * @param {string} repoUrl - repository URL.
 * @param {string} ref - `HEAD`, a branch, a tag, or a commit.
 * @returns {Promise<string>}
 */
function gitLsRemote(repoUrl, ref) {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["-c", "credential.helper=", "ls-remote", "--quiet", repoUrl, ref],
			{
				timeout: GIT_TIMEOUT_MS,
				windowsHide: true,
				maxBuffer: 4 * 1024 * 1024,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			},
			(error, stdout) => (error === null ? resolve(stdout) : reject(error)),
		);
	});
}

/**
 * Resolve the newest commit the repository's branch/tag/commit names.
 * @param {{ repoUrl?: string | null, ref?: string | null, pinned?: string | null }} info - parsed spec.
 * @returns {Promise<string>}
 */
async function latestCommit(info) {
	if (typeof info.pinned === "string" && info.pinned !== "") return info.pinned;
	if (typeof info.repoUrl !== "string" || info.repoUrl === "") throw new Error("repository URL could not be parsed");
	const target = info.ref ?? "HEAD";
	const stdout = await gitLsRemote(info.repoUrl, target);
	const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
	if (lines.length === 0) throw new Error(`git ls-remote returned nothing for ${target}`);
	const wanted = target === "HEAD" ? ["HEAD"] : [`refs/heads/${target}`, `refs/tags/${target}`];
	const match = lines.find((line) => wanted.some((name) => line.endsWith(`\t${name}`)));
	const sha = (match ?? lines[0]).split(/\s+/)[0];
	if (!/^[0-9a-f]{40}/i.test(sha)) throw new Error("remote commit could not be parsed");
	return sha.toLowerCase();
}

/**
 * Read the version a package declares at one remote commit, on GitHub.
 * @param {{ repoUrl?: string | null, subdir?: string | null }} info - parsed spec.
 * @param {string} commit - remote commit.
 * @returns {Promise<string | null>}
 */
async function remoteVersion(info, commit) {
	const url = githubRawManifestUrl(info.repoUrl ?? null, commit, info.subdir ?? null);
	if (url === null) return null;
	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
			headers: { "user-agent": "dsh-plugin-version-watch" },
		});
		if (!response.ok) return null;
		const text = await response.text();
		if (text.length > 512 * 1024) return null;
		const manifest = JSON.parse(text);
		return typeof manifest.version === "string" ? manifest.version : null;
	} catch {
		return null;
	}
}

/**
 * Resolve one plugin's update check.
 * @param {import("cordis").Context} ctx - Host context.
 * @param {{ name: string, info: ReturnType<typeof parseDependencySpec>, installedCommit: string | null, bundle: any }} plugin - facts.
 * @returns {Promise<{ status: string, installedCommit: string | null, remoteCommit: string | null, remoteVersion: string | null, latestVersion: string | null, reason: string | null }>}
 */
async function resolveCheck(ctx, { name, info, installedCommit, bundle }) {
	if (info.kind === "git") {
		if (info.semver !== null) {
			return { status: "unsupported", installedCommit, remoteCommit: null, remoteVersion: null, latestVersion: null, reason: "semver-range" };
		}
		let remoteCommit;
		try {
			remoteCommit = await latestCommit(info);
		} catch (error) {
			return { status: "failed", installedCommit, remoteCommit: null, remoteVersion: null, latestVersion: null, reason: truncate(String(error?.message ?? error)) };
		}
		const version = await remoteVersion(info, remoteCommit);
		if (installedCommit === null) {
			return { status: "unknown", installedCommit: null, remoteCommit, remoteVersion: version, latestVersion: null, reason: "no-installed-commit" };
		}
		if (remoteCommit === installedCommit) {
			return { status: "current", installedCommit, remoteCommit, remoteVersion: version, latestVersion: null, reason: null };
		}
		return { status: "available", installedCommit, remoteCommit, remoteVersion: version, latestVersion: version, reason: null };
	}

	if (info.kind === "registry") {
		if (bundle !== undefined && bundle.updatable !== true) {
			return { status: "unsupported", installedCommit: null, remoteCommit: null, remoteVersion: null, latestVersion: null, reason: "not-updatable" };
		}
		let answer;
		try {
			answer = await ctx.pluginManager.listVersions(name);
		} catch (error) {
			return { status: "failed", installedCommit: null, remoteCommit: null, remoteVersion: null, latestVersion: null, reason: truncate(String(error?.message ?? error)) };
		}
		if (answer?.status !== "listed") {
			return { status: "failed", installedCommit: null, remoteCommit: null, remoteVersion: null, latestVersion: null, reason: truncate(answer?.reason ?? answer?.problem ?? "") };
		}
		const installable = answer.versions.find(
			(version) => version.bundle === true && version.prerelease !== true && version.deprecated === undefined && version.incompatible === undefined,
		);
		return {
			status: installable === undefined ? "current" : "available",
			installedCommit: null,
			remoteCommit: null,
			remoteVersion: null,
			latestVersion: installable?.version ?? null,
			reason: null,
		};
	}

	return { status: "unsupported", installedCommit: null, remoteCommit: null, remoteVersion: null, latestVersion: null, reason: info.kind };
}

/**
 * Read one installed package's manifest from the profile's `node_modules`.
 * Used as a fallback while the plugin manager is recomposing, so a plugin
 * does not vanish from the page just because its bundle metadata is briefly
 * unavailable.
 * @param {string | null} dir - profile directory.
 * @param {string} name - package name.
 * @returns {Promise<Record<string, any> | null>}
 */
async function readInstalledManifest(dir, name) {
	if (dir === null) return null;
	const text = await readText(join(dir, "node_modules", name, "package.json"));
	if (text === null) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Build the response entry for one recorded dependency.
 * @param {import("cordis").Context} ctx - Host context.
 * @param {{ name: string, spec: string, bundle: any, lock: Map<string, any>, force: boolean, dir: string | null }} input - facts.
 * @returns {Promise<object | null>}
 */
async function checkPlugin(ctx, { name, spec, bundle, lock, force, dir }) {
	const installed = await readInstalledManifest(dir, name);
	if (bundle === undefined && installed?.dsh?.bundle === undefined) return null;
	if (bundle !== undefined && bundle.availability === "installation") return null;
	const info = parseDependencySpec(spec);
	const installedCommit = commitFromResolution(lock.get(name)?.version);
	const cached = checkCache.get(name);
	let check;
	if (!force && cached !== undefined && cached.installedCommit === installedCommit && Date.now() - cached.at < CHECK_TTL_MS) {
		check = cached.check;
	} else {
		check = await resolveCheck(ctx, { name, info, installedCommit, bundle });
		checkCache.set(name, { at: Date.now(), installedCommit, check });
	}
	// A bundle the manager cannot read right now (for example between a removal
	// and its reinstallation) keeps its row, but offers no update action until
	// the next read sees it again.
	if ((bundle === undefined || bundle.availability !== "profile") && check.status !== "unsupported") {
		check = { ...check, status: "unknown", reason: "unavailable" };
	}
	return {
		name,
		title: bundle?.meta?.title ?? null,
		description: bundle?.meta?.description ?? null,
		version: bundle?.version ?? installed?.version ?? null,
		enabled: typeof bundle?.enabled === "boolean" ? bundle.enabled : null,
		official: bundle?.official === true,
		source: redactSource(bundle?.source ?? spec),
		kind: info.kind,
		check,
	};
}

/**
 * Run one worker per item with a bounded number of concurrent workers.
 * @template T, R
 * @param {readonly T[]} items - work items.
 * @param {number} limit - concurrency bound.
 * @param {(item: T) => Promise<R>} worker - per-item work.
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, worker) {
	const results = new Array(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= items.length) return;
			results[index] = await worker(items[index]);
		}
	});
	await Promise.all(runners);
	return results;
}

/**
 * Serve the installed-plugin list and its update checks.
 * @param {import("cordis").Context} ctx - Host context.
 * @param {boolean} force - bypass the short check cache.
 * @returns {Promise<object>}
 */
async function statusPayload(ctx, force) {
	const state = await profileState(ctx);
	const bundles = (await ctx.pluginManager.listBundles().catch(() => [])) ?? [];
	const byName = new Map(bundles.map((bundle) => [bundle.name, bundle]));
	const specs = new Map();
	if (state.manifest?.dependencies !== null && typeof state.manifest?.dependencies === "object") {
		for (const [name, spec] of Object.entries(state.manifest.dependencies)) {
			if (typeof spec === "string") specs.set(name, spec);
		}
	} else {
		for (const bundle of bundles) {
			if (bundle.installed === true && bundle.availability === "profile" && typeof bundle.source === "string") specs.set(bundle.name, bundle.source);
		}
	}
	const names = [...specs.keys()];
	const entries = await mapLimit(names, CHECK_CONCURRENCY, (name) =>
		checkPlugin(ctx, { name, spec: specs.get(name), bundle: byName.get(name), lock: state.lock, force, dir: state.dir }),
	);
	return {
		checkedAt: Date.now(),
		hmr: ctx.get("hmr") !== undefined,
		profileKnown: state.dir !== null,
		plugins: entries.filter((entry) => entry !== null),
	};
}

/**
 * Update one plugin, mutating the profile through the plugin manager.
 * @param {import("cordis").Context} ctx - Host context.
 * @param {string} name - installed package name.
 * @returns {Promise<Response>}
 */
async function updatePayload(ctx, name) {
	const state = await profileState(ctx);
	const spec = state.manifest?.dependencies?.[name];
	if (typeof spec !== "string") {
		return reply(404, { ok: false, status: "failed", error: { code: "no-dependency", detail: name } });
	}
	const bundles = (await ctx.pluginManager.listBundles().catch(() => [])) ?? [];
	const bundle = bundles.find((candidate) => candidate.name === name && candidate.availability === "profile");
	if (bundle === undefined) {
		return reply(404, { ok: false, status: "failed", error: { code: "no-bundle", detail: name } });
	}
	const info = parseDependencySpec(spec);
	if (info.kind === "git") return updateGitPlugin(ctx, { name, spec, info, bundle });
	if (info.kind === "registry") return updateRegistryPlugin(ctx, { name, bundle });
	return reply(422, {
		ok: false,
		status: "unsupported",
		kind: info.kind,
		source: redactSource(spec),
		error: { code: "unsupported-source", detail: info.kind },
	});
}

/**
 * Remove and reinstall a Git-sourced plugin, resolving the newest commit.
 * @param {import("cordis").Context} ctx - Host context.
 * @param {{ name: string, spec: string, info: ReturnType<typeof parseDependencySpec>, bundle: any }} input - facts.
 * @returns {Promise<Response>}
 */
async function updateGitPlugin(ctx, { name, spec, info, bundle }) {
	if (info.semver !== null) {
		return reply(422, { ok: false, status: "unsupported", kind: "git", source: redactSource(spec), error: { code: "semver-range", detail: info.semver } });
	}
	let remoteCommit;
	try {
		remoteCommit = await latestCommit(info);
	} catch (error) {
		return reply(502, {
			ok: false,
			status: "failed",
			kind: "git",
			step: "check",
			source: redactSource(spec),
			error: { code: "remote-unreachable", detail: truncate(String(error?.message ?? error)) },
		});
	}
	const before = await profileState(ctx);
	const installedCommit = commitFromResolution(before.lock.get(name)?.version);
	if (installedCommit !== null && installedCommit === remoteCommit) {
		checkCache.delete(name);
		return reply(200, {
			ok: true,
			status: "current",
			kind: "git",
			from: { version: bundle.version ?? null, commit: installedCommit },
			to: { version: await remoteVersion(info, remoteCommit), commit: remoteCommit },
		});
	}

	let removal;
	try {
		removal = await ctx.pluginManager.removeBundle(name);
	} catch (error) {
		return reply(502, {
			ok: false,
			status: "failed",
			kind: "git",
			step: "remove",
			removed: false,
			source: redactSource(spec),
			error: { code: "removal-failed", detail: truncate(String(error?.message ?? error)) },
		});
	}
	if (removal === null || removal === undefined || removal.application !== "applied" || removal.error !== undefined) {
		return reply(502, {
			ok: false,
			status: "failed",
			kind: "git",
			step: "remove",
			removed: false,
			source: redactSource(spec),
			error: { code: "removal-failed", detail: errorDetail(removal?.error) },
		});
	}

	checkCache.delete(name);
	let installation;
	try {
		installation = await ctx.pluginManager.installBundle(spec, { enabled: bundle.enabled === true });
	} catch (error) {
		return reply(502, {
			ok: false,
			status: "failed",
			kind: "git",
			step: "install",
			removed: true,
			source: redactSource(spec),
			to: { version: null, commit: remoteCommit },
			error: { code: "install-failed", detail: truncate(String(error?.message ?? error)) },
		});
	}
	const fresh = await profileState(ctx);
	const freshBundles = (await ctx.pluginManager.listBundles().catch(() => [])) ?? [];
	const freshBundle = freshBundles.find((candidate) => candidate.name === name);
	const to = { version: freshBundle?.version ?? null, commit: commitFromResolution(fresh.lock.get(name)?.version) ?? remoteCommit };
	const application = installation?.application;
	if (application === "failed" || application === "cancelled") {
		return reply(502, {
			ok: false,
			status: "failed",
			kind: "git",
			step: "install",
			removed: true,
			source: redactSource(spec),
			to,
			application,
			error: { code: "install-failed", detail: installDetail(installation) },
		});
	}
	return reply(200, {
		ok: true,
		status: application === "restart-required" ? "restart-required" : "updated",
		kind: "git",
		from: { version: bundle.version ?? null, commit: installedCommit },
		to,
		application,
		restartReason: installation?.restartReason ?? null,
	});
}

/**
 * Update a registry-installed plugin through the plugin manager's own path.
 * @param {import("cordis").Context} ctx - Host context.
 * @param {{ name: string, bundle: any }} input - facts.
 * @returns {Promise<Response>}
 */
async function updateRegistryPlugin(ctx, { name, bundle }) {
	let answer;
	try {
		answer = await ctx.pluginManager.listVersions(name);
	} catch (error) {
		return reply(502, { ok: false, status: "failed", kind: "registry", error: { code: "version-check-failed", detail: truncate(String(error?.message ?? error)) } });
	}
	if (answer?.status !== "listed") {
		return reply(502, {
			ok: false,
			status: "failed",
			kind: "registry",
			error: { code: "version-check-failed", detail: truncate(answer?.reason ?? answer?.problem ?? "") },
		});
	}
	const target = answer.versions.find(
		(version) => version.bundle === true && version.prerelease !== true && version.deprecated === undefined && version.incompatible === undefined,
	);
	if (target === undefined) {
		return reply(200, { ok: true, status: "current", kind: "registry", from: { version: bundle.version ?? null, commit: null }, to: { version: null, commit: null } });
	}
	let result;
	try {
		result = await ctx.pluginManager.updateBundle(name, target.version, { requestId: `version-watch-${Date.now().toString(36)}` });
	} catch (error) {
		return reply(502, { ok: false, status: "failed", kind: "registry", error: { code: "update-failed", detail: truncate(String(error?.message ?? error)) } });
	}
	const application = result?.result?.application;
	if (application === "failed" || application === "cancelled") {
		return reply(502, {
			ok: false,
			status: "failed",
			kind: "registry",
			step: result?.step ?? "install",
			to: { version: target.version, commit: null },
			application,
			error: { code: "install-failed", detail: installDetail(result?.result) },
		});
	}
	return reply(200, {
		ok: true,
		status: application === "restart-required" ? "restart-required" : "updated",
		kind: "registry",
		from: { version: bundle.version ?? null, commit: null },
		to: { version: target.version, commit: null },
		application,
		restartReason: result?.result?.restartReason ?? null,
	});
}

/**
 * Register the two routes while the services they need exist.
 * @param {import("cordis").Context} ctx - Host plugin context.
 */
export function apply(ctx) {	ctx.inject(["connection", "pluginManager"], (scope) => {
		scope.effect(
			() =>
				scope.connection.fetch.register({
					path: STATUS_ROUTE,
					methods: ["GET"],
					requestBody: "buffered",
					fetch: async (request) => {
						const force = new URL(request.url).searchParams.get("refresh") === "1";
						try {
							return reply(200, await statusPayload(scope, force));
						} catch (error) {
							return reply(500, { plugins: [], error: { code: "status-failed", detail: truncate(String(error?.message ?? error)) } });
						}
					},
				}),
			"version-watch: status route",
		);
		scope.effect(
			() =>
				scope.connection.fetch.register({
					path: UPDATE_ROUTE,
					methods: ["POST"],
					requestBody: "buffered",
					fetch: async (request) => {
						if (updateRunning) {
							return reply(409, { ok: false, status: "failed", error: { code: "busy", detail: "another update is running" } });
						}
						const body = await request.json().catch(() => null);
						const target = body?.name;
						if (typeof target !== "string" || target.trim() === "") {
							return reply(400, { ok: false, status: "failed", error: { code: "invalid-name", detail: "" } });
						}
						updateRunning = true;
						try {
							return await updatePayload(scope, target.trim());
						} catch (error) {
							return reply(500, { ok: false, status: "failed", error: { code: "update-failed", detail: truncate(String(error?.message ?? error)) } });
						} finally {
							updateRunning = false;
						}
					},
				}),
			"version-watch: update route",
		);
	});
}

/** Internals exercised by the host tests; not part of the plugin contract. */
export const __test = { latestCommit, resolveCheck, statusPayload, updatePayload, updateGitPlugin };
