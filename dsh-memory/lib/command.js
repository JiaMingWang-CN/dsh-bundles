/**
 * `/dream`: consolidate the current project's memory now.
 *
 * Scope (design §5.5): the project's queued sessions plus ended sessions not
 * consolidated yet, never the session typing the command. The handler waits
 * for the run and returns its summary. While auto dreaming is paused, a
 * successful run also drains every other project's queue and resumes auto.
 */
import { basename } from "node:path";

const projectName = (cwd) => basename(cwd.replace(/[\\/]+$/, "")) || cwd;

/**
 * User-facing summary of a manual run.
 * @param {import("./runner.js").RunReport} report
 * @returns {string}
 */
export function formatReport(report) {
	if (report.runs.length === 0) return "没有需要整理的会话。";
	const lines = report.runs.flatMap((run) => {
		const issues = run.ok ? run.issues ?? [] : [];
		const target = run.scope === "cross" ? "跨项目" : `${projectName(run.cwd)} · 会话 ${run.sessionIds.length} 个`;
		const head = `${!run.ok ? "✖" : issues.length > 0 ? "⚠" : "✔"} ${target} · `;
		if (!run.ok) return [`${head}失败：${run.error}`];
		return [`${head}新增 ${run.changes.created} / 修改 ${run.changes.modified} / 删除 ${run.changes.deleted}${issues.length > 0 ? ` · 有 ${issues.length} 个问题` : ""}`, ...issues.map((issue) => `  - ${issue}`)];
	});
	/* A batch that was set aside is a failed run too, but it does not pause anything. */
	if (!report.ok && report.runs.some((run) => !run.ok && !run.skipped)) lines.push("自动 dreaming 已暂停。排查原因（模型、密钥或网络）后再运行 /dream 补跑。");
	return lines.join("\n");
}

/**
 * @param ctx - host plugin context (`commands`).
 * @param {{ config: object, runner: { runManual: Function }, reconcile: (scope: { cwd: string, excludeSessionId: string }) => Promise<unknown> }} deps
 */
export function installDreamCommand(ctx, { config, runner, reconcile }) {
	ctx.commands.register({
		name: "dream",
		description: "整理当前项目的记忆（对照会话记录纠错、合并、瘦身）",
		async handler({ agent }) {
			if (!config.enabled.get()) return { kind: "error", text: "记忆功能已关闭，可在设置的「记忆」页打开。" };
			const header = agent?.session?.header;
			if (typeof header?.cwd !== "string") return { kind: "error", text: "当前会话没有工作目录，无法确定要整理哪个项目的记忆。" };
			const scope = { cwd: header.cwd, excludeSessionId: header.id };
			await reconcile(scope);
			const report = await runner.runManual(scope);
			return { kind: report.ok ? "success" : "error", text: formatReport(report) };
		}
	});
}
