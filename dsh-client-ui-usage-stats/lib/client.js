window.__ModuleLoader__.load({
	id: "dsh-client-ui-usage-stats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const React = react;
		//#region lib/client.js
		/** Panel stylesheet, themed entirely through the shell's alias tokens. */
		const CSS = '.dsh-usage-page{max-width:720px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}' +
			'.dsh-usage-head{display:flex;align-items:center;justify-content:space-between;gap:16px}' +
			'.dsh-usage-title{font-size:15px;font-weight:600}' +
			'.dsh-usage-btn{box-sizing:border-box;padding:4px 10px;border-radius:10px;font-size:12px;cursor:pointer;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);transition:background .15s,border-color .15s,color .15s}' +
			'.dsh-usage-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}' +
			'.dsh-usage-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px}' +
			'.dsh-usage-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:10px 16px;margin-top:10px}' +
			'.dsh-usage-metric{display:flex;flex-direction:column;gap:2px}' +
			'.dsh-usage-metric-label{font-size:11px;color:var(--dsw-alias-label-tertiary)}' +
			'.dsh-usage-metric-value{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}' +
			'.dsh-usage-hero{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.2}' +
			'.dsh-usage-seg{display:inline-flex;gap:6px}' +
			'.dsh-usage-segbtn{padding:4px 12px;border-radius:14px;font-size:12px;cursor:pointer;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);transition:background .15s,border-color .15s,color .15s}' +
			'.dsh-usage-segbtn.on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-overlay,#fff)}' +
			'.dsh-usage-provcard{border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden}' +
			'.dsh-usage-provhead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:10px 14px;background:var(--dsw-alias-bg-layer-2)}' +
			'.dsh-usage-provname{font-size:13px;font-weight:600}' +
			'.dsh-usage-provmeta{font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}' +
			'.dsh-usage-provtotal{margin-left:auto;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}' +
			'.dsh-usage-table{width:100%;border-collapse:collapse;font-size:12.5px}' +
			'.dsh-usage-table th{text-align:left;font-weight:500;font-size:11px;color:var(--dsw-alias-label-tertiary);padding:7px 14px 5px;border-bottom:.5px solid var(--dsw-alias-border-l2)}' +
			'.dsh-usage-table td{padding:7px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1);vertical-align:top}' +
			'.dsh-usage-table tr:last-child td{border-bottom:none}' +
			'.dsh-usage-num{font-variant-numeric:tabular-nums}' +
			'.dsh-usage-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px}' +
			'.dsh-usage-model{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px}' +
			'.dsh-usage-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px}' +
			'.dsh-usage-chip{font-size:10.5px;line-height:16px;padding:0 6px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}' +
			'.dsh-usage-bar{display:flex;align-items:center;gap:8px}' +
			'.dsh-usage-bartrack{flex:1;height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;min-width:56px}' +
			'.dsh-usage-barfill{height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary)}' +
			'.dsh-usage-note{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}' +
			'.dsh-usage-warn{font-size:12px;color:var(--dsw-alias-state-warn-primary)}' +
			'.dsh-usage-error{display:flex;align-items:center;gap:10px;font-size:12.5px;color:var(--dsw-alias-state-error-primary)}' +
			'.dsh-usage-loading{font-size:12.5px;color:var(--dsw-alias-label-tertiary)}';
		/** Stable Cordis plugin name. */
		const name = "ui-usage-stats";
		/** The settings seat is the only client service this half needs, declared as a
		 *  hard dependency exactly like the shipped settings sections do. */
		const inject = ["slots"];
		/** Panel modes. */
		const MODE_PROVIDERS = "providers";
		const MODE_MODELS = "models";
		const MODE_SESSIONS = "sessions";
		/** Host route serving the folded corpus (see lib/index.js). */
		const SUMMARY_PATH = "/plugins/ui-usage-stats/summary";
		/** Last successful payload, so a reopened panel has something to paint. */
		let lastPayload = null;

		/** One labelled metric cell. */
		function metric(label, value) {
			return React.createElement("div", { className: "dsh-usage-metric" },
				React.createElement("span", { className: "dsh-usage-metric-label" }, label),
				React.createElement("span", { className: "dsh-usage-metric-value" }, value),
			);
		}

		/** One proportional bar plus its percentage label. */
		function shareBar(share) {
			return React.createElement("div", { className: "dsh-usage-bar" },
				React.createElement("div", { className: "dsh-usage-bartrack" },
					React.createElement("div", { className: "dsh-usage-barfill", style: { width: Math.min(100, Math.max(0, share)) + "%" } }),
				),
				React.createElement("span", { className: "dsh-usage-num" }, share + "%"),
			);
		}

		/** Input/cache/output breakdown line for one row. */
		function breakdown(text) {
			const parts = ["输入 " + text.input, "缓存读 " + text.cacheRead];
			if (text.cacheWrite !== "0") parts.push("缓存写 " + text.cacheWrite);
			parts.push("输出 " + text.output);
			return React.createElement("div", { className: "dsh-usage-sub" }, parts.join(" · "));
		}

		/** Token-total cell: the headline number plus its breakdown line. */
		function totalCell(row) {
			return React.createElement("td", { className: "dsh-usage-num" },
				React.createElement("div", null, row.text.total),
				breakdown(row.text),
			);
		}

		/** Summary card: corpus totals and the four accounting buckets. */
		function TotalsCard(props) {
			const totals = props.totals;
			return React.createElement("div", { className: "dsh-usage-card" },
				React.createElement("div", null,
					React.createElement("div", { className: "dsh-usage-metric-label" }, "总用量（token）"),
					React.createElement("div", { className: "dsh-usage-hero" }, totals.text.total),
				),
				React.createElement("div", { className: "dsh-usage-metrics" },
					metric("输入", totals.text.input),
					metric("缓存读", totals.text.cacheRead),
					metric("缓存写", totals.text.cacheWrite),
					metric("输出", totals.text.output),
					metric("推理（含于输出）", totals.text.reasoning),
					metric("请求数", totals.text.requests),
					metric("会话数", totals.text.sessions),
				),
			);
		}

		/** Provider-first view: one card per provider, one row per model. */
		function ProvidersView(props) {
			return React.createElement("div", { className: "dsh-usage-list", style: { display: "flex", flexDirection: "column", gap: "10px" } },
				props.data.providers.map((provider) => React.createElement("div", { className: "dsh-usage-provcard", key: provider.provider },
					React.createElement("div", { className: "dsh-usage-provhead" },
						React.createElement("div", { className: "dsh-usage-provname" }, provider.provider),
						React.createElement("div", { className: "dsh-usage-provmeta" }, "模型 " + provider.models.length + " · 会话 " + provider.text.sessions + " · 请求 " + provider.text.requests),
						React.createElement("div", { className: "dsh-usage-provtotal" }, provider.text.total),
					),
					React.createElement("table", { className: "dsh-usage-table" },
						React.createElement("thead", null,
							React.createElement("tr", null,
								React.createElement("th", null, "模型"),
								React.createElement("th", null, "请求"),
								React.createElement("th", null, "Token"),
								React.createElement("th", null, "占比"),
							),
						),
						React.createElement("tbody", null,
							provider.models.map((model) => React.createElement("tr", { key: model.model },
								React.createElement("td", null, React.createElement("span", { className: "dsh-usage-model" }, model.model)),
								React.createElement("td", { className: "dsh-usage-num" }, model.text.requests),
								totalCell(model),
								React.createElement("td", null, shareBar(model.share)),
							)),
						),
					),
				)),
			);
		}

		/** Model-first view: identical model ids merged across providers, listed. */
		function ModelsView(props) {
			return React.createElement("div", { className: "dsh-usage-provcard" },
				React.createElement("table", { className: "dsh-usage-table" },
					React.createElement("thead", null,
						React.createElement("tr", null,
							React.createElement("th", null, "模型"),
							React.createElement("th", null, "请求"),
							React.createElement("th", null, "Token"),
							React.createElement("th", null, "占比"),
						),
					),
					React.createElement("tbody", null,
						props.data.models.map((model) => React.createElement("tr", { key: model.model },
							React.createElement("td", { style: { minWidth: "140px" } },
								React.createElement("div", { className: "dsh-usage-model" }, model.model),
								React.createElement("div", { className: "dsh-usage-chips" },
									model.providers.map((provider) => React.createElement("span", { className: "dsh-usage-chip", key: provider }, provider)),
								),
							),
							React.createElement("td", { className: "dsh-usage-num" },
								React.createElement("div", null, model.text.requests),
								React.createElement("div", { className: "dsh-usage-sub" }, "会话 " + model.text.sessions),
							),
							totalCell(model),
							React.createElement("td", null, shareBar(model.share)),
						)),
					),
				),
			);
		}

		/** Per-session index, sorted by token total. */
		function SessionsView(props) {
			return React.createElement("div", { className: "dsh-usage-provcard" },
				React.createElement("table", { className: "dsh-usage-table" },
					React.createElement("thead", null,
						React.createElement("tr", null,
							React.createElement("th", null, "会话"),
							React.createElement("th", null, "创建时间"),
							React.createElement("th", null, "请求"),
							React.createElement("th", null, "Token"),
						),
					),
					React.createElement("tbody", null,
						props.data.sessionsList.map((session) => React.createElement("tr", { key: session.id },
							React.createElement("td", null,
								React.createElement("div", { className: "dsh-usage-model" }, session.shortId),
								React.createElement("div", { className: "dsh-usage-chips" },
									React.createElement("span", { className: "dsh-usage-chip" }, session.subagent ? "子 Agent" : "主会话"),
									session.agentPreset === "" ? null : React.createElement("span", { className: "dsh-usage-chip", key: "preset" }, session.agentPreset),
									session.workspace === "" ? null : React.createElement("span", { className: "dsh-usage-chip", key: "workspace" }, session.workspace),
								),
							),
							React.createElement("td", { className: "dsh-usage-num dsh-usage-sub", style: { paddingTop: "10px" } }, session.createdAtText),
							React.createElement("td", { className: "dsh-usage-num" }, session.requestsText),
							React.createElement("td", { className: "dsh-usage-num" }, session.totalText),
						)),
					),
				),
			);
		}

		/**
		 * The settings page: corpus totals, a provider/model and a model
		 * breakdown, and a per-session index. Data arrives from the host half on
		 * mount; every displayed number is pre-formatted there.
		 */
		function UsageStatsSection() {
			/* Last successful payload, kept across panel open/close: reopening paints it
			 * at once and refreshes silently, so the page never shows an empty wait. */
			const [state, setState] = React.useState(() => (
				lastPayload === null
					? { phase: "loading", data: null, error: "" }
					: { phase: "ready", data: lastPayload, error: "" }
			));
			const [mode, setMode] = React.useState(MODE_PROVIDERS);
			/* Subagent sessions are always part of the corpus; the host half decides. */
			const load = () => {
				setState((current) => ({ ...current, phase: current.data === null ? "loading" : current.phase }));
				fetch(SUMMARY_PATH, { headers: { accept: "application/json" }, cache: "no-store" })
					.then((response) => (response.ok ? response.json() : Promise.reject(new Error("HTTP " + response.status))))
					.then((value) => {
						if (value === null || value.ok !== true) {
							setState({ phase: "error", data: null, error: String((value && value.reason) || "unknown") });
							return;
						}
						lastPayload = value;
						setState({ phase: "ready", data: value, error: "" });
					})
					.catch((error) => setState({ phase: "error", data: null, error: String((error && error.message) || error) }));
			};
			React.useEffect(() => { load(); }, []);
			const data = state.data;
			const header = React.createElement("div", { className: "dsh-usage-head" },
				React.createElement("div", { className: "dsh-usage-title" }, "用量统计"),
			);
			if (state.phase === "error" && data === null) {
				return React.createElement("div", { className: "dsh-usage-page" }, header,
					React.createElement("div", { className: "dsh-usage-error" }, "统计失败：" + state.error),
					React.createElement("button", { type: "button", className: "dsh-usage-btn", onClick: load }, "重试"),
				);
			}
			if (data === null) {
				return React.createElement("div", { className: "dsh-usage-page" }, header,
					React.createElement("div", { className: "dsh-usage-loading" }, "正在统计各提供商与模型的用量…"),
				);
			}
			const notes = [
				"用量来自各提供商在会话日志中上报的 token 计数，非估算值；推理 token 已包含在输出中，不重复计入总量。",
				"同名模型由多个提供商提供服务时按提供商分别统计，「按模型」视图会合并并列出全部提供商。",
				"统计范围包含子 Agent 会话；仅统计 token，不折算费用，fork 继承的事件已排除，不会重复计数。",
				"为提高速度，重复打开面板会复用上一次结果；会话日志有新内容时自动重新折叠。",
			];
			if (data.sessions.skipped > 0) notes.push("有 " + data.sessions.skipped + " 个会话日志无法读取，未计入统计。");
			if (data.totals.sessions === 0) notes.push("没有可统计的会话记录。");
			return React.createElement("div", { className: "dsh-usage-page" },
				header,
				React.createElement(TotalsCard, { totals: data.totals }),
				React.createElement("div", { className: "dsh-usage-seg" },
					React.createElement("button", {
						type: "button",
						className: "dsh-usage-segbtn" + (mode === MODE_PROVIDERS ? " on" : ""),
						"aria-pressed": mode === MODE_PROVIDERS ? "true" : "false",
						onClick: () => setMode(MODE_PROVIDERS),
					}, "按提供商"),
					React.createElement("button", {
						type: "button",
						className: "dsh-usage-segbtn" + (mode === MODE_MODELS ? " on" : ""),
						"aria-pressed": mode === MODE_MODELS ? "true" : "false",
						onClick: () => setMode(MODE_MODELS),
					}, "按模型"),
					React.createElement("button", {
						type: "button",
						className: "dsh-usage-segbtn" + (mode === MODE_SESSIONS ? " on" : ""),
						"aria-pressed": mode === MODE_SESSIONS ? "true" : "false",
						onClick: () => setMode(MODE_SESSIONS),
					}, "按会话"),
				),
				mode === MODE_PROVIDERS ? React.createElement(ProvidersView, { data }) : null,
				mode === MODE_MODELS ? React.createElement(ModelsView, { data }) : null,
				mode === MODE_SESSIONS ? React.createElement(SessionsView, { data }) : null,
				React.createElement("div", { className: "dsh-usage-note" }, notes.join(" ")),
			);
		}

		/**
		 * Client plugin body: the 用量统计 settings section.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.textContent = CSS;
				document.head.append(tag);
				return () => tag.remove();
			}, "ui-usage-stats: styles");
			/* `inject` guarantees the seat, and the registration goes through it inside
			 * its own callback — the pattern the shipped settings sections use. */
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "usage-stats", order: 30, label: "用量统计" },
				() => React.createElement(UsageStatsSection),
			));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	},
});
