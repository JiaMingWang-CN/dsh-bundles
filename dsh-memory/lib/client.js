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
		 * manual run by writing a fresh `dreamRequest` nonce. Styling follows
		 * DSH's own settings pages (alias tokens, settings-card surfaces).
		 */
		const CSS = [
			".dsh-mem{max-width:720px;display:flex;flex-direction:column;gap:20px;color:var(--dsw-alias-label-primary)}",
			".dsh-mem-head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}",
			".dsh-mem-h1{margin:0;font-size:16px;font-weight:500;line-height:24px}",
			".dsh-mem-intro{margin:4px 0 0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-mem-section{display:flex;flex-direction:column;gap:8px}",
			".dsh-mem-h2{margin:0;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-secondary)}",
			".dsh-mem-card{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);padding:4px 14px;display:flex;flex-direction:column}",
			".dsh-mem-card.off{opacity:.5;pointer-events:none}",
			".dsh-mem-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:12px 0}",
			".dsh-mem-row+.dsh-mem-row{border-top:.5px solid var(--dsw-alias-border-l2)}",
			".dsh-mem-label{min-width:0}",
			".dsh-mem-title{font-size:14px;font-weight:500;line-height:22px}",
			".dsh-mem-desc{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-mem-switch{position:relative;box-sizing:border-box;width:36px;height:20px;border-radius:10px;padding:0;cursor:pointer;flex:none;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));border:.5px solid var(--dsw-alias-border-l3);transition:background .15s,border-color .15s}",
			".dsh-mem-switch.on{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent}",
			".dsh-mem-knob{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}",
			".dsh-mem-switch.on .dsh-mem-knob{transform:translateX(16px)}",
			".dsh-mem-field{box-sizing:border-box;height:32px;padding:0 10px;border-radius:var(--dsw-radius-md);font:inherit;font-size:13px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);outline:none;transition:border-color .15s}",
			".dsh-mem-field:focus{border-color:var(--dsw-alias-brand-primary)}",
			".dsh-mem-field:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
			"select.dsh-mem-field{width:260px;cursor:pointer}",
			".dsh-mem-number{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-mem-number .dsh-mem-field{width:64px;text-align:center}",
			".dsh-mem-status{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0}",
			".dsh-mem-status-main{display:flex;align-items:center;gap:10px;min-width:0}",
			".dsh-mem-pill{display:inline-flex;align-items:center;gap:6px;flex:none;padding:2px 8px;border-radius:var(--dsw-radius-sm);font-size:12px;line-height:18px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}",
			".dsh-mem-pill.running{color:var(--dsw-alias-state-business-primary)}",
			".dsh-mem-pill.paused{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}",
			".dsh-mem-dot{width:7px;height:7px;border-radius:50%;flex:none;background:currentColor}",
			".dsh-mem-pill.idle .dsh-mem-dot{background:var(--dsw-alias-state-success-primary)}",
			".dsh-mem-meta{font-size:13px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsh-mem-btn{box-sizing:border-box;height:32px;padding:0 14px;border-radius:var(--dsw-radius-md);font:inherit;font-size:13px;cursor:pointer;flex:none;display:inline-flex;align-items:center;border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);transition:background .15s}",
			".dsh-mem-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-mem-btn.primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}",
			".dsh-mem-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill))}",
			".dsh-mem-btn.small{height:26px;padding:0 10px;font-size:12px;border-radius:var(--dsw-radius-sm)}",
			".dsh-mem-btn:disabled{opacity:.45;cursor:default}",
			".dsh-mem-banner{margin:0 0 12px;padding:8px 12px;border-radius:var(--dsw-radius-md);font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary));background:var(--dsw-alias-state-warn-tertiary,transparent);border:.5px solid var(--dsw-alias-state-warn-secondary,var(--dsw-alias-border-l3))}",
			".dsh-mem-log{display:flex;align-items:center;gap:10px;padding:10px 0;font-size:13px;line-height:20px}",
			".dsh-mem-log+.dsh-mem-log{border-top:.5px solid var(--dsw-alias-border-l2)}",
			".dsh-mem-log .dsh-mem-dot.ok{background:var(--dsw-alias-state-success-primary)}",
			".dsh-mem-log .dsh-mem-dot.fail{background:var(--dsw-alias-state-error-primary)}",
			".dsh-mem-time{flex:none;width:84px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}",
			".dsh-mem-project{flex:none;max-width:160px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsh-mem-count{flex:none;color:var(--dsw-alias-label-tertiary)}",
			".dsh-mem-result{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsh-mem-result.fail{color:var(--dsw-alias-state-error-primary)}",
			".dsh-mem-empty{padding:14px 0;font-size:13px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-mem-path{flex:1;min-width:0;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}",
			".dsh-mem-pathlabel{flex:none;width:64px;font-size:13px}"
		].join("");
		/** Stable Cordis plugin name; also the settings namespace. */
		const name = "memory";
		const inject = ["slots", "configForms", "remote", "remote.session"];

		/** Stable select value for one provider/model route ("" is the default model). */
		function modelKey(provider, model) {
			return provider === "" && model === "" ? "" : JSON.stringify([provider, model]);
		}
		/**
		 * Model select options: the default model first, then every catalog
		 * model, plus the saved route when the catalog no longer offers it.
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
		/**
		 * Reasoning-effort options for the chosen model, from the catalog's
		 * `reasoning: { efforts, defaultEffort? }`. Disabled when the default
		 * model is used (DSH's default effort applies) or the model has none.
		 * @returns {{ disabled: boolean, options: Array<{ value: string, label: string }> }}
		 */
		function effortOptions(groups, provider, model, effort) {
			if (provider === "" || model === "") return { disabled: true, options: [{ value: "", label: "跟随默认模型" }] };
			const reasoning = groups.find((group) => group.id === provider)?.models.find((entry) => entry.id === model)?.reasoning;
			const options = reasoning === undefined
				? [{ value: "", label: "该模型不支持调节" }]
				: [
					{ value: "", label: reasoning.defaultEffort === undefined ? "模型默认" : `模型默认（${reasoning.efforts.find((level) => level.id === reasoning.defaultEffort)?.name ?? reasoning.defaultEffort}）` },
					...reasoning.efforts.map((level) => ({ value: level.id, label: level.name || level.id }))
				];
			if (effort !== "" && !options.some((option) => option.value === effort)) options.push({ value: effort, label: `不可用：${effort}` });
			return { disabled: reasoning === undefined && effort === "", options };
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
		const h = React.createElement;

		function Switch(props) {
			return h("button", {
				type: "button",
				className: "dsh-mem-switch" + (props.on ? " on" : ""),
				role: "switch",
				"aria-checked": props.on ? "true" : "false",
				"aria-label": props.label,
				onClick: props.onToggle
			}, h("span", { className: "dsh-mem-knob" }));
		}
		function Row(props) {
			return h("div", { className: "dsh-mem-row" },
				h("div", { className: "dsh-mem-label" },
					h("div", { className: "dsh-mem-title" }, props.title),
					props.desc ? h("div", { className: "dsh-mem-desc" }, props.desc) : null),
				props.control);
		}
		function Select(props) {
			return h("select", { className: "dsh-mem-field", "aria-label": props.label, value: props.value, disabled: props.disabled, onChange: props.onChange },
				props.options.map((option) => h("option", { key: option.value, value: option.value }, option.label)));
		}
		function LogRow(props) {
			const run = props.run;
			return h("div", { className: "dsh-mem-log" },
				h("span", { className: "dsh-mem-dot " + (run.ok ? "ok" : "fail") }),
				h("span", { className: "dsh-mem-time" }, formatTime(run.at)),
				h("span", { className: "dsh-mem-project", title: run.cwd }, projectName(run.cwd)),
				h("span", { className: "dsh-mem-count" }, `会话 ${run.sessionIds.length} 个`),
				run.ok
					? h("span", { className: "dsh-mem-result" }, `新增 ${run.changes?.created ?? 0} / 修改 ${run.changes?.modified ?? 0} / 删除 ${run.changes?.deleted ?? 0}`)
					: h("span", { className: "dsh-mem-result fail", title: run.error }, `失败：${run.error ?? "未知错误"}`),
				run.ok ? null : h("button", { type: "button", className: "dsh-mem-btn small", disabled: props.busy, onClick: props.onRetry }, "重试"));
		}
		function PathRow(props) {
			const copy = () => { try { navigator.clipboard.writeText(props.path); } catch { /* clipboard unavailable */ } };
			return h("div", { className: "dsh-mem-log" },
				h("span", { className: "dsh-mem-pathlabel" }, props.label),
				h("span", { className: "dsh-mem-path" }, props.path),
				h("button", { type: "button", className: "dsh-mem-btn small", onClick: copy }, "复制"));
		}
		function StatusCard(props) {
			const status = props.status;
			const running = status.running != null;
			const paused = status.paused != null;
			const pill = running
				? h("span", { className: "dsh-mem-pill running" }, h("span", { className: "dsh-mem-dot" }), "整理中")
				: paused
					? h("span", { className: "dsh-mem-pill paused" }, h("span", { className: "dsh-mem-dot" }), "已暂停")
					: h("span", { className: "dsh-mem-pill idle" }, h("span", { className: "dsh-mem-dot" }), "空闲");
			return h("div", { className: "dsh-mem-card" },
				h("div", { className: "dsh-mem-status" },
					h("div", { className: "dsh-mem-status-main" },
						pill,
						h("span", { className: "dsh-mem-meta" }, running ? `正在整理：${projectName(status.running.cwd)}` : `待处理：${status.pendingCount ?? 0} 个会话`)),
					h("button", { type: "button", className: "dsh-mem-btn primary", disabled: running, onClick: props.onDream }, "立即 dream")),
				paused ? h("div", { className: "dsh-mem-banner" }, `自动 dreaming 已暂停（${formatTime(status.paused.since)}）：${status.paused.reason}。修好模型后点「立即 dream」补跑，成功后自动恢复。`) : null);
		}

		/**
		 * The 记忆 settings page. Displayed values follow the settings form;
		 * writes go through the form, never a local echo.
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

			const enabled = value.enabled !== false;
			const status = value.status ?? {};
			const busy = status.running != null;
			const provider = value.dreamProvider ?? "";
			const model = value.dreamModel ?? "";
			const effort = value.dreamEffort ?? "";
			const efforts = effortOptions(groups, provider, model, effort);
			const log = [...(status.log ?? [])].reverse();

			const requestDream = () => host.set("dreamRequest", String(Date.now()));
			const setIdle = (event) => {
				const minutes = Number(event.target.value);
				if (Number.isInteger(minutes) && minutes >= 1) host.set("idleMinutes", minutes);
			};
			/* A model change resets the effort: levels differ between models. */
			const chooseModel = (event) => {
				const [nextProvider, nextModel] = event.target.value === "" ? ["", ""] : JSON.parse(event.target.value);
				host.mutate([
					{ op: "set", path: ["dreamProvider"], value: nextProvider },
					{ op: "set", path: ["dreamModel"], value: nextModel },
					{ op: "set", path: ["dreamEffort"], value: "" }
				]);
			};

			return h("div", { className: "dsh-mem" },
				h("div", { className: "dsh-mem-head" },
					h("div", null,
						h("h2", { className: "dsh-mem-h1" }, "记忆"),
						h("p", { className: "dsh-mem-intro" }, "让 agent 跨会话记住教训、做法与验证过的规则。关闭后不再注入记忆，也不提供记忆工具。")),
					h(Switch, { label: "记忆", on: enabled, onToggle: () => host.set("enabled", !enabled) })),

				h("div", { className: "dsh-mem-section" },
					h("h3", { className: "dsh-mem-h2" }, "自动整理（dreaming）"),
					h("div", { className: "dsh-mem-card" + (enabled ? "" : " off") },
						h(Row, {
							title: "自动 dreaming",
							desc: "会话结束后，对照会话记录自动纠错、合并、精简记忆；会消耗模型 token。",
							control: h(Switch, { label: "自动 dreaming", on: value.autoDream !== false, onToggle: () => host.set("autoDream", value.autoDream === false) })
						}),
						h(Row, {
							title: "空闲阈值",
							desc: "会话最后一轮结束后空闲这么久，或会话被关闭，视为会话结束。",
							control: h("span", { className: "dsh-mem-number" },
								h("input", { type: "number", min: 1, className: "dsh-mem-field", "aria-label": "空闲阈值（分钟）", defaultValue: value.idleMinutes ?? 10, onChange: setIdle }),
								"分钟")
						}),
						h(Row, {
							title: "整理模型",
							desc: "可选更便宜的模型以节省 token。",
							control: h(Select, { label: "dreaming 模型", value: modelKey(provider, model), options: modelOptions(groups, provider, model), onChange: chooseModel })
						}),
						h(Row, {
							title: "思考强度",
							desc: "整理需要对照证据做判断，强度越高越仔细，也越费 token。",
							control: h(Select, { label: "思考强度", value: effort, disabled: efforts.disabled, options: efforts.options, onChange: (event) => host.set("dreamEffort", event.target.value) })
						}))),

				h("div", { className: "dsh-mem-section" },
					h("h3", { className: "dsh-mem-h2" }, "状态"),
					h(StatusCard, { status, onDream: requestDream })),

				h("div", { className: "dsh-mem-section" },
					h("h3", { className: "dsh-mem-h2" }, "最近运行"),
					h("div", { className: "dsh-mem-card" },
						log.length === 0
							? h("div", { className: "dsh-mem-empty" }, "还没有运行记录。会话结束后会在这里看到每次整理的结果。")
							: log.map((run, index) => h(LogRow, { key: `${run.at}-${index}`, run, busy, onRetry: requestDream })))),

				status.root ? h("div", { className: "dsh-mem-section" },
					h("h3", { className: "dsh-mem-h2" }, "记忆文件"),
					h("div", { className: "dsh-mem-card" },
						h(PathRow, { label: "项目记忆", path: joinPath(status.root, "projects") }),
						h(PathRow, { label: "用户记忆", path: joinPath(status.root, "user") }))) : null);
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
				() => h(SettingsPage, { host, loadCatalog: () => ctx.remote.session.modelCatalog() })
			));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		exports.SettingsPage = SettingsPage;
		exports.modelOptions = modelOptions;
		exports.modelKey = modelKey;
		exports.effortOptions = effortOptions;
		return module.exports;
	}
});
