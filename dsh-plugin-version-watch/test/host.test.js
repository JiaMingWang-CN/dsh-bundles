import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { __test } from "../lib/index.js";

const exec = (command, args) =>
	new Promise((resolve, reject) => {
		execFile(command, args, { windowsHide: true }, (error, stdout) => (error === null ? resolve(String(stdout).trim()) : reject(error)));
	});

/** One Git repository with two commits, used as a local remote. */
async function createRepo() {
	const dir = await mkdtemp(join(tmpdir(), "vw-repo-"));
	await exec("git", ["init", "-q", dir]);
	await exec("git", ["-C", dir, "config", "user.email", "version-watch@example.com"]);
	await exec("git", ["-C", dir, "config", "user.name", "Version Watch"]);
	await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2));
	await exec("git", ["-C", dir, "add", "."]);
	await exec("git", ["-C", dir, "commit", "-qm", "one"]);
	const first = await exec("git", ["-C", dir, "rev-parse", "HEAD"]);
	await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo", version: "1.1.0" }, null, 2));
	await exec("git", ["-C", dir, "add", "."]);
	await exec("git", ["-C", dir, "commit", "-qm", "two"]);
	const second = await exec("git", ["-C", dir, "rev-parse", "HEAD"]);
	return { dir, url: pathToFileURL(dir).href, first, second };
}

/** A profile directory whose lockfile resolves one dependency to one Git commit. */
async function createProfile({ dependencies, lockVersion }) {
	const dir = await mkdtemp(join(tmpdir(), "vw-profile-"));
	await writeFile(join(dir, "package.json"), JSON.stringify({ name: "profile", dependencies }, null, 2));
	await writeFile(
		join(dir, "pnpm-lock.yaml"),
		[
			"lockfileVersion: '9.0'",
			"",
			"importers:",
			"",
			"  .:",
			"    dependencies:",
			"      demo:",
			"        specifier: github:owner/repo#path:demo",
			`        version: ${lockVersion}`,
			"",
		].join("\n"),
	);
	return dir;
}

const lockFromCommit = (commit) => `https://codeload.github.com/owner/repo/tar.gz/${commit}#path:demo`;

const demoBundle = {
	name: "demo",
	availability: "profile",
	installed: true,
	enabled: true,
	version: "1.1.0",
	official: false,
	source: "github:owner/repo#path:demo",
	meta: { title: { zh: "示例插件", en: "Demo plugin" } },
};

function context(dir, manager, hmr = true) {
	return {
		get(name) {
			if (name === "profileContext") return { dir };
			if (name === "hmr") return hmr ? {} : undefined;
			return undefined;
		},
		pluginManager: manager,
	};
}

test("resolveCheck compares the installed commit with the remote head", async () => {
	const repo = await createRepo();
	const info = { kind: "git", repoUrl: repo.url, ref: "HEAD", subdir: null, semver: null, pinned: null };
	const ctx = context(null, {});
	try {
		const older = await __test.resolveCheck(ctx, { name: "demo", info, installedCommit: repo.first, bundle: demoBundle });
		assert.equal(older.status, "available");
		assert.equal(older.remoteCommit, repo.second);
		assert.equal(older.installedCommit, repo.first);
		const same = await __test.resolveCheck(ctx, { name: "demo", info, installedCommit: repo.second, bundle: demoBundle });
		assert.equal(same.status, "current");
		const unknown = await __test.resolveCheck(ctx, { name: "demo", info, installedCommit: null, bundle: demoBundle });
		assert.equal(unknown.status, "unknown");
	} finally {
		await rm(repo.dir, { recursive: true, force: true });
	}
});

test("resolveCheck reports an unreachable repository as a failed check", async () => {
	const ctx = context(null, {});
	const info = { kind: "git", repoUrl: "file:///C:/definitely-not-a-repo", ref: "HEAD", subdir: null, semver: null, pinned: null };
	const check = await __test.resolveCheck(ctx, { name: "demo", info, installedCommit: null, bundle: demoBundle });
	assert.equal(check.status, "failed");
	assert.match(check.reason, /git|repository|not found|Repository/i);
});

test("a Git update removes the old version and installs the new commit", async () => {
	const repo = await createRepo();
	const dir = await createProfile({ dependencies: { demo: "github:owner/repo#path:demo" }, lockVersion: lockFromCommit(repo.first) });
	const calls = [];
	const manager = {
		async listBundles() {
			return [demoBundle];
		},
		async removeBundle(name) {
			calls.push(["remove", name]);
			return { changed: true, application: "applied", stage: "remove", target: name };
		},
		async installBundle(spec, options) {
			calls.push(["install", spec, options]);
			await writeFile(
				join(dir, "pnpm-lock.yaml"),
				["lockfileVersion: '9.0'", "", "importers:", "", "  .:", "    dependencies:", "      demo:", "        specifier: github:owner/repo#path:demo", `        version: ${lockFromCommit(repo.second)}`, ""].join("\n"),
			);
			return { changed: true, application: "applied", stage: "install", target: "demo", bundle: "demo", version: "1.1.0" };
		},
	};
	const ctx = context(dir, manager);
	try {
		const response = await __test.updateGitPlugin(ctx, {
			name: "demo",
			spec: "github:owner/repo#path:demo",
			info: { kind: "git", repoUrl: repo.url, ref: "HEAD", subdir: null, semver: null, pinned: null },
			bundle: demoBundle,
		});
		const answer = await response.json();
		assert.equal(response.status, 200);
		assert.equal(answer.ok, true);
		assert.equal(answer.status, "updated");
		assert.equal(answer.from.commit, repo.first);
		assert.equal(answer.to.commit, repo.second);
		assert.equal(answer.to.version, "1.1.0");
		assert.deepEqual(calls, [
			["remove", "demo"],
			["install", "github:owner/repo#path:demo", { enabled: true }],
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
		await rm(repo.dir, { recursive: true, force: true });
	}
});

test("an up-to-date Git plugin is left untouched", async () => {
	const repo = await createRepo();
	const dir = await createProfile({ dependencies: { demo: "github:owner/repo#path:demo" }, lockVersion: lockFromCommit(repo.second) });
	let mutated = false;
	const manager = {
		async listBundles() {
			return [demoBundle];
		},
		async removeBundle() {
			mutated = true;
			return { changed: true, application: "applied", stage: "remove", target: "demo" };
		},
		async installBundle() {
			mutated = true;
			return { changed: true, application: "applied", stage: "install", target: "demo" };
		},
	};
	const ctx = context(dir, manager);
	try {
		const response = await __test.updateGitPlugin(ctx, {
			name: "demo",
			spec: "github:owner/repo#path:demo",
			info: { kind: "git", repoUrl: repo.url, ref: "HEAD", subdir: null, semver: null, pinned: null },
			bundle: demoBundle,
		});
		const answer = await response.json();
		assert.equal(answer.status, "current");
		assert.equal(answer.from.commit, repo.second);
		assert.equal(mutated, false);
	} finally {
		await rm(dir, { recursive: true, force: true });
		await rm(repo.dir, { recursive: true, force: true });
	}
});

test("a failed removal keeps the plugin in place and says so", async () => {
	const dir = await createProfile({ dependencies: { demo: "github:owner/repo#path:demo" }, lockVersion: lockFromCommit("a".repeat(40)) });
	const manager = {
		async listBundles() {
			return [demoBundle];
		},
		async removeBundle() {
			return { changed: false, application: "failed", stage: "remove", target: "demo", error: { code: "stop-profile" } };
		},
	};
	const repo = await createRepo();
	const ctx = context(dir, manager);
	try {
		const response = await __test.updateGitPlugin(ctx, {
			name: "demo",
			spec: "github:owner/repo#path:demo",
			info: { kind: "git", repoUrl: repo.url, ref: "HEAD", subdir: null, semver: null, pinned: null },
			bundle: demoBundle,
		});
		const answer = await response.json();
		assert.equal(answer.ok, false);
		assert.equal(answer.step, "remove");
		assert.equal(answer.removed, false);
		assert.equal(answer.error.code, "removal-failed");
	} finally {
		await rm(dir, { recursive: true, force: true });
		await rm(repo.dir, { recursive: true, force: true });
	}
});

test("a failed reinstall reports the removed plugin and its redacted spec", async () => {
	const dir = await createProfile({ dependencies: { demo: "github:owner/repo#path:demo" }, lockVersion: lockFromCommit("a".repeat(40)) });
	const repo = await createRepo();
	const manager = {
		async listBundles() {
			return [demoBundle];
		},
		async removeBundle() {
			return { changed: true, application: "applied", stage: "remove", target: "demo" };
		},
		async installBundle() {
			return {
				changed: false,
				application: "failed",
				stage: "install",
				target: "demo",
				error: { code: "incompatible-version", diagnostic: "needs dsh >= 9" },
				packageResult: { exitCode: 1, output: "ERR", truncated: false, logPath: "x" },
			};
		},
	};
	const ctx = context(dir, manager);
	try {
		const response = await __test.updateGitPlugin(ctx, {
			name: "demo",
			spec: "https://user:secret@github.com/owner/repo.git#path:demo",
			info: { kind: "git", repoUrl: repo.url, ref: "HEAD", subdir: null, semver: null, pinned: null },
			bundle: demoBundle,
		});
		const answer = await response.json();
		assert.equal(answer.ok, false);
		assert.equal(answer.removed, true);
		assert.equal(answer.error.code, "install-failed");
		assert.match(answer.source, /^https:\/\/github\.com/);
		assert.match(answer.error.detail, /incompatible-version/);
	} finally {
		await rm(dir, { recursive: true, force: true });
		await rm(repo.dir, { recursive: true, force: true });
	}
});

test("a registry plugin updates through the plugin manager's own path", async () => {
	const dir = await mkdtemp(join(tmpdir(), "vw-profile-"));
	await writeFile(join(dir, "package.json"), JSON.stringify({ name: "profile", dependencies: { "@scope/pkg": "^1.0.0" } }, null, 2));
	await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
	const manager = {
		async listBundles() {
			return [
				{
					name: "@scope/pkg",
					availability: "profile",
					installed: true,
					enabled: true,
					version: "1.0.0",
					official: false,
					updatable: true,
					source: "https://registry.npmjs.org/",
				},
			];
		},
		async listVersions() {
			return {
				status: "listed",
				installed: "1.0.0",
				versions: [
					{ version: "1.2.0", bundle: false, prerelease: false, tags: [] },
					{ version: "1.1.0", bundle: true, prerelease: false, tags: ["latest"] },
				],
			};
		},
		async updateBundle(name, version, options) {
			assert.equal(name, "@scope/pkg");
			assert.equal(version, "1.1.0");
			assert.ok(options.requestId.startsWith("version-watch-"));
			return {
				from: "1.0.0",
				to: "1.1.0",
				step: "install",
				result: { changed: true, application: "applied", stage: "install", target: name, version: "1.1.0" },
			};
		},
	};
	const ctx = context(dir, manager);
	try {
		const response = await __test.updatePayload(ctx, "@scope/pkg");
		const answer = await response.json();
		assert.equal(answer.ok, true);
		assert.equal(answer.status, "updated");
		assert.equal(answer.kind, "registry");
		assert.equal(answer.to.version, "1.1.0");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a registry plugin without an installable newer version is already current", async () => {
	const dir = await mkdtemp(join(tmpdir(), "vw-profile-"));
	await writeFile(join(dir, "package.json"), JSON.stringify({ name: "profile", dependencies: { "@scope/pkg": "^1.0.0" } }, null, 2));
	const manager = {
		async listBundles() {
			return [
				{
					name: "@scope/pkg",
					availability: "profile",
					installed: true,
					enabled: true,
					version: "1.0.0",
					official: false,
					updatable: true,
					source: "https://registry.npmjs.org/",
				},
			];
		},
		async listVersions() {
			return { status: "listed", installed: "1.0.0", versions: [{ version: "1.1.0", bundle: true, prerelease: true, tags: [] }] };
		},
	};
	const ctx = context(dir, manager);
	try {
		const response = await __test.updatePayload(ctx, "@scope/pkg");
		const answer = await response.json();
		assert.equal(answer.status, "current");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("statusPayload lists profile plugins and local sources as unsupported", async () => {
	const dir = await mkdtemp(join(tmpdir(), "vw-profile-"));
	await writeFile(join(dir, "package.json"), JSON.stringify({ name: "profile", dependencies: { demo: "file:../demo" } }, null, 2));
	await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
	const localBundle = {
		name: "demo",
		availability: "profile",
		installed: true,
		enabled: false,
		version: "1.1.0",
		official: false,
		source: "file:../demo",
		meta: { title: { zh: "示例插件", en: "Demo plugin" } },
	};
	const manager = {
		async listBundles() {
			return [localBundle, { name: "official-extra", availability: "installation", installed: false, enabled: false }];
		},
	};
	const ctx = context(dir, manager, true);
	try {
		const payload = await __test.statusPayload(ctx, true);
		assert.equal(payload.profileKnown, true);
		assert.equal(payload.hmr, true);
		assert.deepEqual(payload.plugins.map((plugin) => plugin.name), ["demo"]);
		assert.equal(payload.plugins[0].kind, "local");
		assert.equal(payload.plugins[0].enabled, false);
		assert.equal(payload.plugins[0].check.status, "unsupported");
		assert.deepEqual(payload.plugins[0].title, { zh: "示例插件", en: "Demo plugin" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
