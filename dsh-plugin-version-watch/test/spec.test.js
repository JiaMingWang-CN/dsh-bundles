import test from "node:test";
import assert from "node:assert/strict";
import { githubRawManifestUrl, parseDependencySpec, redactSource } from "../lib/spec.js";
import { commitFromResolution, parseImporterDependencies } from "../lib/lockfile.js";

test("GitHub shortcuts carry the repository and the package subdirectory", () => {
	const spec = parseDependencySpec("github:JiaMingWang-CN/dsh-bundles#path:dsh-memory");
	assert.equal(spec.kind, "git");
	assert.equal(spec.repoUrl, "https://github.com/JiaMingWang-CN/dsh-bundles.git");
	assert.equal(spec.subdir, "dsh-memory");
	assert.equal(spec.ref, null);
	assert.equal(spec.pinned, null);
});

test("a branch, tag, or commit fragment is separated from the path fragment", () => {
	const branch = parseDependencySpec("github:owner/repo#main#path:plugins/search");
	assert.equal(branch.ref, "main");
	assert.equal(branch.subdir, "plugins/search");
	const tag = parseDependencySpec("owner/repo#v1.2.3");
	assert.equal(tag.kind, "git");
	assert.equal(tag.ref, "v1.2.3");
	assert.equal(tag.subdir, null);
});

test("full Git URLs keep their scheme and read the pnpm fragment parts", () => {
	const ssh = parseDependencySpec(
		"git+ssh://git@github.com/owner/repo.git#dc7cc3428831fbad50f2cc7df8b5fefa9f6a19cd&path:dsh-memory",
	);
	assert.equal(ssh.kind, "git");
	assert.equal(ssh.repoUrl, "ssh://git@github.com/owner/repo.git");
	assert.equal(ssh.pinned, "dc7cc3428831fbad50f2cc7df8b5fefa9f6a19cd");
	assert.equal(ssh.subdir, "dsh-memory");
	assert.equal(parseDependencySpec("https://github.com/owner/repo.git").kind, "git");
});

test("tarball, local, and registry specs are told apart", () => {
	assert.equal(parseDependencySpec("https://codeload.github.com/owner/repo/tar.gz/abc").kind, "tarball");
	assert.equal(parseDependencySpec("https://example.com/pkg.tgz").kind, "tarball");
	assert.equal(parseDependencySpec("file:../local-plugin").kind, "local");
	assert.equal(parseDependencySpec("link:./linked").kind, "local");
	assert.equal(parseDependencySpec("C:\\Programs\\plugin").kind, "local");
	assert.equal(parseDependencySpec("@scope/name@^1.2.3").kind, "registry");
	assert.equal(parseDependencySpec("plain-name").kind, "registry");
});

test("the raw manifest URL targets the package subdirectory", () => {
	const commit = "6253040adcf7ceea66f496e119a08acf76259fda";
	assert.equal(
		githubRawManifestUrl("https://github.com/owner/repo.git", commit, "dsh-memory"),
		`https://raw.githubusercontent.com/owner/repo/${commit}/dsh-memory/package.json`,
	);
	assert.equal(
		githubRawManifestUrl("https://github.com/owner/repo.git", commit, null),
		`https://raw.githubusercontent.com/owner/repo/${commit}/package.json`,
	);
	assert.equal(githubRawManifestUrl("ssh://git@gitlab.com/owner/repo.git", commit, null), null);
});

test("saved http sources lose their embedded credentials", () => {
	assert.equal(redactSource("https://user:secret@github.com/owner/repo.git"), "https://github.com/owner/repo.git");
	assert.equal(redactSource("github:owner/repo#path:sub"), "github:owner/repo#path:sub");
});

test("the root importer's resolved versions are read, and nothing else", () => {
	const text = [
		"lockfileVersion: '9.0'",
		"",
		"importers:",
		"",
		"  .:",
		"    dependencies:",
		"      dsh-memory:",
		"        specifier: github:owner/repo#path:dsh-memory",
		"        version: https://codeload.github.com/owner/repo/tar.gz/508da581e6119619eef1ebf3c5d9478c6917a0a2#path:dsh-memory",
		"      dsh-mcp:",
		"        specifier: github:owner/repo#path:dsh-mcp",
		"        version: git+ssh://git@github.com/owner/repo.git#dc7cc3428831fbad50f2cc7df8b5fefa9f6a19cd&path:dsh-mcp",
		"      '@scope/pkg':",
		"        specifier: ^1.2.3",
		"        version: 1.2.4",
		"",
		"packages:",
		"",
		"  dsh-other@https://codeload.github.com/owner/repo/tar.gz/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#path:dsh-other:",
		"    version: 9.9.9",
		"",
	].join("\n");
	const deps = parseImporterDependencies(text);
	assert.deepEqual([...deps.keys()].sort(), ["@scope/pkg", "dsh-mcp", "dsh-memory"]);
	assert.equal(deps.get("dsh-memory").version.startsWith("https://codeload"), true);
	assert.equal(deps.get("dsh-mcp").specifier, "github:owner/repo#path:dsh-mcp");
	assert.equal(deps.get("@scope/pkg").version, "1.2.4");
	assert.equal(deps.has("dsh-other"), false);
});

test("a resolved Git version yields its exact commit", () => {
	assert.equal(
		commitFromResolution("https://codeload.github.com/owner/repo/tar.gz/508da581e6119619eef1ebf3c5d9478c6917a0a2#path:dsh-memory"),
		"508da581e6119619eef1ebf3c5d9478c6917a0a2",
	);
	assert.equal(
		commitFromResolution("git+ssh://git@github.com/owner/repo.git#dc7cc3428831fbad50f2cc7df8b5fefa9f6a19cd&path:dsh-mcp"),
		"dc7cc3428831fbad50f2cc7df8b5fefa9f6a19cd",
	);
	assert.equal(commitFromResolution("1.2.4"), null);
	assert.equal(commitFromResolution(null), null);
});
