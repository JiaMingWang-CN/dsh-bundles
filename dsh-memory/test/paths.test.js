import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { encodeCwd, partitionDir, resolveEntry } from "../lib/paths.js";

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
