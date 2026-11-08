window.__ModuleLoader__.load({
	id: "dsh-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const React = react;
		//#region lib/client.js
		/**
		 * dsh-memory — client half: the 记忆 settings page.
		 *
		 * Every value lives in the `memory` settings form (all fields volatile).
		 * The page edits the user-facing fields, shows the host-written
		 * `status` (pause, running project, queue, recent runs) and asks for a
		 * manual run by writing a fresh `dreamRequest` nonce.
		 */
		const CSS = ".dsh-mem-page{max-width:720px;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary)}" +
			".dsh-mem-row{display:flex;align-items:center;justify-content:space-between;gap:24px}" +
			".dsh-mem-title{font-weight:600;font-size:14px}" +
			".dsh-mem-desc{margin-top:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}" +
			".dsh-mem-switch{position:relative;box-sizing:border-box;width:40px;height:22px;border-radius:11px;padding:0;cursor:pointer;flex:none;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);transition:background .15s,border-color .15s}" +
			".dsh-mem-switch.on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}" +
			".dsh-mem-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-overlay,#fff);box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s}" +
			".dsh-mem-switch.on .dsh-mem-knob{transform:translateX(18px)}" +
			".dsh-mem-input{box-sizing:border-box;width:180px;padding:4px 8px;border-radius:6px;font-size:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}" +
			".dsh-mem-input.narrow{width:72px}" +
			".dsh-mem-input.wide{width:280px;cursor:pointer}" +
			".dsh-mem-btn{box-sizing:border-box;padding:4px 12px;border-radius:14px;font-size:12px;cursor:pointer;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}" +
			".dsh-mem-btn:disabled{opacity:.5;cursor:default}" +
			".dsh-mem-warn{font-size:12px;color:var(--dsw-alias-state-warn-primary)}" +
			".dsh-mem-log{display:flex;flex-direction:column;gap:6px;font-size:12px}" +
			".dsh-mem-logrow{display:flex;align-items:center;gap:8px}" +
			".dsh-mem-muted{color:var(--dsw-alias-label-secondary)}" +
			".dsh-mem-path{font-family:var(--dsw-font-mono,monospace);font-size:12px;word-break:break-all}";
		/** Stable Cordis plugin name; also the settings namespace. */
		const name = "memory";
		const inject = ["slots", "configForms", "remote", "remote.session"];

		/** Stable select value for one provider/model route ("" is the default model). */
		function modelKey(provider, model) {
			return provider === "" && model === "" ? "" : JSON.stringify([provider, model]);
		}
		/**
		 * Select options: the default model first, then every catalog model,
		 * plus the saved route when the catalog no longer offers it.
		 * @param {Array<{ id: string, name: string, models: Array<{ id: string, name: string }> }>} groups - `session.modelCatalog` groups.
		 */
		function modelOptions(groups, provider, model) {
			const options = [{ value: "", label: "默认模型（跟随 DSH 默认设置）" }];
			for (const group of groups) {
				for (const entry of group.models) options.push({ value: modelKey(group.id, entry.id), label: `${group.name || group.id} · ${entry.name || entry.id}` });
			}
			const saved = modelKey(provider, model);
			if (saved !== "" && !options.some((option) => option.value === saved)) options.push({ value: saved, label: `不可用：${provider} / ${model}` });
			return options;
		}

		const pad = (n) => String(n).padStart(2, "0");
		/** `MM-DD HH:mm` in local time. */
		function formatTime(ms) {
			const d = new Date(ms);
			return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		}
		/** Last path segment of a project directory. */
		function projectName(cwd) {
			const trimmed = String(cwd).replace(/[\\/]+$/, "");
			return trimmed.split(/[\\/]/).pop() || trimmed;
		}
		const joinPath = (root, leaf) => `${root}${root.includes("\\") ? "\\" : "/"}${leaf}`;

		function Switch(props) {
			return React.createElement("button", {
				type: "button",
				className: "dsh-mem-switch" + (props.on ? " on" : ""),
				role: "switch",
				"aria-checked": props.on ? "true" : "false",
				"aria-label": props.label,
				onClick: props.onToggle
			}, React.createElement("span", { className: "dsh-mem-knob" }));
		}
		function Row(props) {
			return React.createElement("div", { className: "dsh-mem-row" },
				React.createElement("div", null,
					React.createElement("div", { className: "dsh-mem-title" }, props.title),
					props.desc ? React.createElement("div", { className: "dsh-mem-desc" }, props.desc) : null),
				props.control);
		}
		function LogRow(props) {
			const run = props.run;
			const summary = run.ok
				? `新增 ${run.changes?.created ?? 0} / 修改 ${run.changes?.modified ?? 0} / 删除 ${run.changes?.deleted ?? 0}`
				: `失败：${run.error ?? "未知错误"}`;
			return React.createElement("div", { className: "dsh-mem-logrow" },
				React.createElement("span", null, run.ok ? "✔" : "✖"),
				React.createElement("span", { className: "dsh-mem-muted" }, formatTime(run.at)),
				React.createElement("span", null, projectName(run.cwd)),
				React.createElement("span", { className: "dsh-mem-muted" }, `会话 ${run.sessionIds.length} 个`),
				React.createElement("span", run.ok ? null : { className: "dsh-mem-warn" }, summary),
				run.ok ? null : React.createElement("button", { type: "button", className: "dsh-mem-btn", disabled: props.busy, onClick: props.onRetry }, "重试"));
		}
		function PathRow(props) {
			const copy = () => { try { navigator.clipboard.writeText(props.path); } catch { /* clipboard unavailable */ } };
			return React.createElement("div", { className: "dsh-mem-logrow" },
				React.createElement("span", { className: "dsh-mem-muted" }, props.label),
				React.createElement("span", { className: "dsh-mem-path" }, props.path),
				React.createElement("button", { type: "button", className: "dsh-mem-btn", onClick: copy }, "复制"));
		}

		/**
		 * The 记忆 settings page. Displayed values follow the settings form;
		 * writes go through `host.set`, never a local echo.
		 */
		function SettingsPage(props) {
			const host = props.host;
			const read = () => host.getSnapshot().value ?? {};
			const [value, setValue] = React.useState(read);
			React.useEffect(() => host.subscribe(() => setValue(read())), [host]);
			const [groups, setGroups] = React.useState([]);
			React.useEffect(() => {
				let live = true;
				Promise.resolve(props.loadCatalog?.()).then((response) => {
					if (live && response?.ok) setGroups(response.value.groups);
				}, () => {});
				return () => { live = false; };
			}, [props.loadCatalog]);
			const provider = value.dreamProvider ?? "";
			const model = value.dreamModel ?? "";
			const chooseModel = (event) => {
				const [nextProvider, nextModel] = event.target.value === "" ? ["", ""] : JSON.parse(event.target.value);
				host.mutate([
					{ op: "set", path: ["dreamProvider"], value: nextProvider },
					{ op: "set", path: ["dreamModel"], value: nextModel }
				]);
			};
			const status = value.status ?? {};
			const busy = status.running != null;
			const requestDream = () => host.set("dreamRequest", String(Date.now()));
			const setIdle = (event) => {
				const minutes = Number(event.target.value);
				if (Number.isInteger(minutes) && minutes >= 1) host.set("idleMinutes", minutes);
			};
			const log = [...(status.log ?? [])].reverse();
			return React.createElement("div", { className: "dsh-mem-page" },
				React.createElement(Row, {
					title: "记忆",
					desc: "让 agent 跨会话记住教训、做法与验证过的规则；关闭后不再注入记忆，也不提供记忆工具。",
					control: React.createElement(Switch, { label: "记忆", on: value.enabled !== false, onToggle: () => host.set("enabled", value.enabled === false) })
				}),
				React.createElement(Row, {
					title: "自动 dreaming",
					desc: "会话结束后，对照会话记录自动纠错、合并、精简记忆；会消耗模型 token。",
					control: React.createElement(Switch, { label: "自动 dreaming", on: value.autoDream !== false, onToggle: () => host.set("autoDream", value.autoDream === false) })
				}),
				React.createElement(Row, {
					title: "空闲阈值（分钟）",
					desc: "会话最后一轮结束后空闲这么久，或会话关闭时，视为会话结束。",
					control: React.createElement("input", { type: "number", min: 1, className: "dsh-mem-input narrow", "aria-label": "空闲阈值（分钟）", defaultValue: value.idleMinutes ?? 10, onChange: setIdle })
				}),
				React.createElement(Row, {
					title: "dreaming 模型",
					desc: "整理记忆时使用的模型；可选更便宜的模型以节省 token。",
					control: React.createElement("select", { className: "dsh-mem-input wide", "aria-label": "dreaming 模型", value: modelKey(provider, model), onChange: chooseModel },
						modelOptions(groups, provider, model).map((option) => React.createElement("option", { key: option.value, value: option.value }, option.label)))
				}),
				status.paused ? React.createElement("div", { className: "dsh-mem-warn" }, `自动 dreaming 已暂停（${formatTime(status.paused.since)}）：${status.paused.reason}。修好模型后点「立即 dream」补跑，成功后自动恢复。`) : null,
				React.createElement("div", { className: "dsh-mem-row" },
					React.createElement("div", { className: "dsh-mem-muted" },
						busy ? `正在整理：${projectName(status.running.cwd)}` : `待处理：${status.pendingCount ?? 0} 个会话`),
					React.createElement("button", { type: "button", className: "dsh-mem-btn", disabled: busy, onClick: requestDream }, "立即 dream")),
				React.createElement("div", { className: "dsh-mem-title" }, "最近运行"),
				React.createElement("div", { className: "dsh-mem-log" },
					log.length === 0 ? React.createElement("div", { className: "dsh-mem-muted" }, "还没有运行记录。") : log.map((run, index) => React.createElement(LogRow, { key: `${run.at}-${index}`, run, busy, onRetry: requestDream }))),
				status.root ? React.createElement("div", { className: "dsh-mem-log" },
					React.createElement("div", { className: "dsh-mem-title" }, "记忆文件"),
					React.createElement(PathRow, { label: "项目记忆", path: joinPath(status.root, "projects") }),
					React.createElement(PathRow, { label: "用户记忆", path: joinPath(status.root, "user") })) : null);
		}

		/**
		 * Client plugin body: stylesheet plus the settings.section page.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const host = ctx.configForms.get(name);
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.textContent = CSS;
				document.head.append(tag);
				return () => tag.remove();
			}, "memory: styles");
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "memory", order: 26, label: "记忆" },
				() => React.createElement(SettingsPage, { host, loadCatalog: () => ctx.remote.session.modelCatalog() })
			));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		exports.SettingsPage = SettingsPage;
		exports.modelOptions = modelOptions;
		exports.modelKey = modelKey;
		return module.exports;
	}
});
