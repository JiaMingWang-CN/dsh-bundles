import test from "node:test";
import assert from "node:assert/strict";
import { installDreamCommand, formatReport } from "../lib/command.js";

const CWD = "C:\\Programs\\demo";

function setup({ report = { ok: true, runs: [] }, enabled = true } = {}) {
	let definition;
	const calls = [];
	const ctx = { commands: { register: (def) => { definition = def; return () => {}; } } };
	installDreamCommand(ctx, {
		config: { enabled: { get: () => enabled } },
		runner: { runManual: async (scope) => { calls.push(["run", scope]); return report; } },
		reconcile: async (scope) => { calls.push(["reconcile", scope]); return []; }
	});
	const invoke = (header) => definition.handler({ agent: { session: { header: { id: "me", ...header } } }, rawInput: "" });
	return { definition, calls, invoke };
}

test("registers a global dream command", () => {
	const { definition } = setup();
	assert.equal(definition.name, "dream");
	assert.match(definition.description, /记忆/);
});

test("dream reconciles then runs manual for the invoking session's project, excluding itself", async () => {
	const { calls, invoke } = setup();
	const result = await invoke({ cwd: CWD });
	assert.deepEqual(calls, [["reconcile", { cwd: CWD, excludeSessionId: "me" }], ["run", { cwd: CWD, excludeSessionId: "me" }]]);
	assert.deepEqual(result, { kind: "success", text: "没有需要整理的会话。" });
});

test("dream returns error result when session has no cwd or memory is off", async () => {
	assert.equal((await setup().invoke({})).kind, "error");
	assert.match((await setup({ enabled: false }).invoke({ cwd: CWD })).text, /已关闭/);
});

test("dream summary lists per-run changes or error", async () => {
	const runs = [
		{ cwd: CWD, sessionIds: ["a", "b"], ok: true, changes: { created: 1, modified: 2, deleted: 0 } },
		{ cwd: "C:\\other", sessionIds: ["c"], ok: false, error: "401 Unauthorized" }
	];
	const result = await setup({ report: { ok: false, runs } }).invoke({ cwd: CWD });
	assert.equal(result.kind, "error");
	assert.match(result.text, /demo · 会话 2 个 · 新增 1 \/ 修改 2 \/ 删除 0/);
	assert.match(result.text, /other · 会话 1 个 · 失败：401 Unauthorized/);
	assert.match(result.text, /暂停/);
	assert.equal(formatReport({ ok: true, runs: runs.slice(0, 1) }).startsWith("✔"), true);
});

test("formatReport marks runs with issues, lists them, and names the cross-project run", () => {
	const text = formatReport({ ok: true, runs: [
		{ cwd: CWD, sessionIds: ["s1"], ok: true, changes: { created: 0, modified: 1, deleted: 0 }, issues: ["tool error: session not found"] },
		{ scope: "cross", sessionIds: [], ok: true, changes: { created: 1, modified: 0, deleted: 2 }, issues: [] }
	] });
	assert.equal(text, "⚠ demo · 会话 1 个 · 新增 0 / 修改 1 / 删除 0 · 有 1 个问题\n  - tool error: session not found\n✔ 跨项目 · 新增 1 / 修改 0 / 删除 2");
});
