window.__ModuleLoader__.load({
	id: "dsh-client-ui-usage-stats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const React = react;
		//#region lib/client.js
		/** Quiet, data-first panel styled only with the shell's theme tokens. */
		const CSS = '.dsh-usage-page{box-sizing:border-box;width:100%;max-width:980px;display:flex;flex-direction:column;gap:22px;color:var(--dsw-alias-label-primary)}' +
			'.dsh-usage-btn{box-sizing:border-box;padding:6px 13px;border-radius:8px;font-size:12px;cursor:pointer;background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);transition:background .15s,color .15s}' +
			'.dsh-usage-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}' +
			'.dsh-usage-card{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));padding:18px 0;border:1px solid var(--dsw-alias-border-l2);border-radius:18px;background:transparent}' +
			'.dsh-usage-metric{min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:2px 12px;text-align:center;border-left:1px solid var(--dsw-alias-border-l1)}' +
			'.dsh-usage-metric:first-child{border-left:none}' +
			'.dsh-usage-metric-label{font-size:11.5px;font-weight:500;color:var(--dsw-alias-label-tertiary);white-space:nowrap}' +
			'.dsh-usage-metric-value{max-width:100%;overflow:hidden;text-overflow:ellipsis;font-size:17px;font-weight:600;line-height:1.25;font-variant-numeric:tabular-nums;white-space:nowrap}' +
			'.dsh-usage-metric.featured .dsh-usage-metric-value{font-size:21px}' +
			'.dsh-usage-sectionbar{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:6px}' +
			'.dsh-usage-sectiontitle{margin:0;font-size:15px;font-weight:600}' +
			'.dsh-usage-seg{display:inline-flex;align-items:center;gap:20px}' +
			'.dsh-usage-segbtn{position:relative;padding:5px 0;border:0;font:inherit;font-size:12.5px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-tertiary);transition:color .15s}' +
			'.dsh-usage-segbtn:hover,.dsh-usage-segbtn.on{color:var(--dsw-alias-label-primary)}' +
			'.dsh-usage-segbtn.on{font-weight:600}' +
			'.dsh-usage-list{display:flex;flex-direction:column;gap:14px}' +
			'.dsh-usage-provcard{border:1px solid var(--dsw-alias-border-l2);border-radius:14px;overflow:auto;background:transparent}' +
			'.dsh-usage-provhead{min-width:570px;display:flex;align-items:center;gap:14px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l2)}' +
			'.dsh-usage-provname{font-size:13.5px;font-weight:600}' +
			'.dsh-usage-provmeta{font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}' +
			'.dsh-usage-provtotal{margin-left:auto;font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}' +
			'.dsh-usage-table{width:100%;min-width:570px;border-collapse:collapse;font-size:12.5px}' +
			'.dsh-usage-table th{text-align:left;font-weight:500;font-size:11px;color:var(--dsw-alias-label-tertiary);padding:10px 18px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}' +
			'.dsh-usage-table td{padding:11px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle}' +
			'.dsh-usage-table tbody tr{transition:background .12s}' +
			'.dsh-usage-table tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover)}' +
			'.dsh-usage-table tr:last-child td{border-bottom:none}' +
			'.dsh-usage-num{font-variant-numeric:tabular-nums}' +
			'.dsh-usage-sub{font-size:10.5px;line-height:1.45;color:var(--dsw-alias-label-tertiary);margin-top:3px;white-space:nowrap}' +
			'.dsh-usage-model{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px}' +
			'.dsh-usage-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}' +
			'.dsh-usage-chip{font-size:10px;line-height:17px;padding:0 7px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}' +
			'.dsh-usage-bar{display:flex;align-items:center;gap:9px}' +
			'.dsh-usage-bartrack{flex:1;height:5px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;min-width:64px}' +
			'.dsh-usage-barfill{height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary)}' +
			'.dsh-usage-status{margin-top:-10px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}' +
			'.dsh-usage-warn{color:var(--dsw-alias-state-warn-primary)}' +
			'.dsh-usage-error{display:flex;align-items:center;gap:10px;font-size:12.5px;color:var(--dsw-alias-state-error-primary)}' +
			'.dsh-usage-loading{font-size:12.5px;color:var(--dsw-alias-label-tertiary)}' +
			'@media(max-width:760px){.dsh-usage-page{gap:18px}.dsh-usage-card{grid-template-columns:repeat(4,minmax(0,1fr));padding:8px 0}.dsh-usage-metric{margin:8px 0}.dsh-usage-metric:nth-child(4n+1){border-left:none}.dsh-usage-sectionbar{align-items:flex-end}.dsh-usage-seg{gap:14px}}' +
			'@media(max-width:480px){.dsh-usage-card{grid-template-columns:repeat(2,minmax(0,1fr))}.dsh-usage-metric:nth-child(odd){border-left:none}.dsh-usage-sectionbar{align-items:flex-start;flex-direction:column;gap:8px}.dsh-usage-seg{width:100%;justify-content:space-between}}';
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

		/** One value-first metric cell, matching the shell's compact dashboard language. */
		function metric(label, value, featured = false) {
			return React.createElement("div", { className: "dsh-usage-metric" + (featured ? " featured" : "") },
				React.createElement("span", { className: "dsh-usage-metric-value", title: value }, value),
				React.createElement("span", { className: "dsh-usage-metric-label" }, label),
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

		/** Summary strip: all corpus counters in one quiet, divided surface. */
		function TotalsCard(props) {
			const totals = props.totals;
			return React.createElement("div", { className: "dsh-usage-card" },
				metric("累计 Token", totals.text.total, true),
				metric("输入", totals.text.input),
				metric("输出", totals.text.output),
				metric("推理", totals.text.reasoning),
				metric("缓存读 / 写", totals.text.cacheRead + " / " + totals.text.cacheWrite),
				metric("请求数", totals.text.requests),
				metric("会话数", totals.text.sessions),
			);
		}

		/** Provider-first view: one card per provider, one row per model. */
		function ProvidersView(props) {
			return React.createElement("div", { className: "dsh-usage-list" },
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
			if (state.phase === "error" && data === null) {
				return React.createElement("div", { className: "dsh-usage-page" },
					React.createElement("div", { className: "dsh-usage-error" }, "统计失败：" + state.error),
					React.createElement("button", { type: "button", className: "dsh-usage-btn", onClick: load }, "重试"),
				);
			}
			if (data === null) {
				return React.createElement("div", { className: "dsh-usage-page" },
					React.createElement("div", { className: "dsh-usage-loading" }, "正在统计各提供商与模型的用量…"),
				);
			}
			const status = data.sessions.skipped > 0
				? React.createElement("div", { className: "dsh-usage-status dsh-usage-warn" }, data.sessions.skipped + " 个会话日志未计入")
				: data.totals.sessions === 0
					? React.createElement("div", { className: "dsh-usage-status" }, "暂无可统计的会话")
					: null;
			return React.createElement("div", { className: "dsh-usage-page" },
				React.createElement(TotalsCard, { totals: data.totals }),
				status,
				React.createElement("div", { className: "dsh-usage-sectionbar" },
					React.createElement("h2", { className: "dsh-usage-sectiontitle" }, "用量明细"),
					React.createElement("div", { className: "dsh-usage-seg" },
						React.createElement("button", {
							type: "button",
							className: "dsh-usage-segbtn" + (mode === MODE_PROVIDERS ? " on" : ""),
							"aria-pressed": mode === MODE_PROVIDERS ? "true" : "false",
							onClick: () => setMode(MODE_PROVIDERS),
						}, "提供商"),
						React.createElement("button", {
							type: "button",
							className: "dsh-usage-segbtn" + (mode === MODE_MODELS ? " on" : ""),
							"aria-pressed": mode === MODE_MODELS ? "true" : "false",
							onClick: () => setMode(MODE_MODELS),
						}, "模型"),
						React.createElement("button", {
							type: "button",
							className: "dsh-usage-segbtn" + (mode === MODE_SESSIONS ? " on" : ""),
							"aria-pressed": mode === MODE_SESSIONS ? "true" : "false",
							onClick: () => setMode(MODE_SESSIONS),
						}, "会话"),
					),
				),
				mode === MODE_PROVIDERS ? React.createElement(ProvidersView, { data }) : null,
				mode === MODE_MODELS ? React.createElement(ModelsView, { data }) : null,
				mode === MODE_SESSIONS ? React.createElement(SessionsView, { data }) : null,
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
