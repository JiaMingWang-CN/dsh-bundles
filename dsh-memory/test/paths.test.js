import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { encodeCwd, partitionDir, resolveEntry, sameProject, isIndexPath } from "../lib/paths.js";

test("encodeCwd matches DSH session directory names", () => {
	assert.equal(encodeCwd("C:\\Programs\\dsh-bundles"), "--C-Programs-dsh-bundles--");
	assert.equal(encodeCwd("C:\\Users\\wjm\\Downloads\\dataset"), "--C-Users-wjm-Downloads-dataset--");
	assert.equal(encodeCwd("/home/me/repo"), "--home-me-repo--");
});

test("encodeCwd normalizes drive case, separators and trailing separators", () => {
	const expected = "--C-Programs-dsh-bundles--";
	assert.equal(encodeCwd("c:/Programs/dsh-bundles"), expected);
	assert.equal(encodeCwd("C:\\Programs\\dsh-bundles\\"), expected);
});

test("encodeCwd escapes unsafe characters like DSH does", () => {
	assert.equal(encodeCwd("C:\\My Repo\\项目"), "--C-My~0020Repo-~9879~76EE--");
});

test("sameProject ignores case only on Windows", () => {
	assert.equal(sameProject("C:\\Programs\\x", "c:/programs/X\\", "win32"), true);
	assert.equal(sameProject("/home/me/Repo", "/home/me/repo", "linux"), false);
	assert.equal(sameProject("/home/me/repo/", "/home/me/repo", "linux"), true);
});

test("partitionDir separates user and per-project partitions", () => {
	assert.equal(partitionDir("/m", "user"), join("/m", "user"));
	assert.equal(partitionDir("/m", "project", "C:\\Programs\\x"), join("/m", "projects", "--C-Programs-x--"));
	assert.throws(() => partitionDir("/m", "project"), { code: "MEMORY_PATH_INVALID" });
	assert.throws(() => partitionDir("/m", "team", "C:\\x"), { code: "MEMORY_PATH_INVALID" });
});

test("resolveEntry rejects traversal, absolute paths, hidden/.state and non-.md files", () => {
	for (const bad of ["../x.md", "a/../../x.md", "/etc/x.md", "C:\\x.md", ".state/state.json", ".state/x.md", "notes.txt", "", "a//b.md", "a\\..\\b.md"]) {
		assert.throws(() => resolveEntry("/m/user", bad), { code: "MEMORY_PATH_INVALID" }, bad);
	}
});

test("resolveEntry accepts nested notes", () => {
	assert.equal(resolveEntry("/m/user", "gameplay/rules.md"), join("/m/user", "gameplay", "rules.md"));
	assert.equal(resolveEntry("/m/user", "INDEX.md"), join("/m/user", "INDEX.md"));
});

test("note paths with Windows-unsafe characters are refused", () => {
	const dir = join("C:\\", "memory", "user");
	for (const bad of ["ab:cd.md", "INDEX.md::$DATA", "a*.md", "a?.md", 'a"b.md', "a<b.md", "CON.md", "nul.md", "com1.md", "lpt9.txt.md", "dir./a.md", "dir /a.md", "LONGNA~1.md", "abc~2", "x\u0001.md"]) {
		assert.throws(() => resolveEntry(dir, bad), /MEMORY_PATH_INVALID|not allowed|invalid/i, bad);
	}
	for (const ok of ["a.md", "testing/db.md", "笔记/数据库.md", "my note (2).md", "console.md", "a-b_c.md", "notes~2024.md", "release~2.1-notes.md"]) assert.doesNotThrow(() => resolveEntry(dir, ok), ok);
});

test("isIndexPath is case-insensitive and accepts either separator style only for the root file", () => {
	assert.equal(isIndexPath("INDEX.md"), true);
	assert.equal(isIndexPath("index.md"), true);
	assert.equal(isIndexPath("Index.MD"), true);
	assert.equal(isIndexPath("sub/INDEX.md"), false);
});

test("resolveEntry gives the root index one spelling", () => {
	const dir = join("C:\\", "memory", "user");
	assert.equal(resolveEntry(dir, "index.md"), join(dir, "INDEX.md"));
	assert.equal(resolveEntry(dir, "sub/index.md"), join(dir, "sub", "index.md"), "only the partition's own index is canonical");
});
