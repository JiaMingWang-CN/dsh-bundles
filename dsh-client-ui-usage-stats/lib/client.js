window.__ModuleLoader__.load({
	id: "dsh-client-ui-usage-stats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const React = react;
		//#region lib/client.js
		/** Data-first dashboard styled exclusively with the shell's theme tokens. */
		const CSS = '.dsh-usage-page{--dsh-usage-input:#3b82f6;--dsh-usage-cache-read:#8b5cf6;--dsh-usage-cache-write:#f59e0b;--dsh-usage-output:#10b981;box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:24px;color:var(--dsw-alias-label-primary)}' +
			'.dsh-usage-btn{align-self:flex-start;box-sizing:border-box;padding:6px 13px;border-radius:8px;font-size:12px;cursor:pointer;background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}' +
			'.dsh-usage-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}' +
			'.dsh-usage-overview{padding:26px 28px 22px;border:1px solid var(--dsw-alias-border-l2);border-radius:18px;background:transparent}' +
			'.dsh-usage-overview-main{display:grid;grid-template-columns:minmax(190px,.72fr) minmax(0,1.6fr);align-items:stretch}' +
			'.dsh-usage-hero{display:flex;flex-direction:column;justify-content:center;min-width:0;padding-right:28px;border-right:1px solid var(--dsw-alias-border-l1)}' +
			'.dsh-usage-eyebrow,.dsh-usage-metric-label{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary)}' +
			'.dsh-usage-hero-value{margin-top:7px;font-size:32px;font-weight:650;line-height:1.08;letter-spacing:-.7px;font-variant-numeric:tabular-nums}' +
			'.dsh-usage-hero-meta{margin-top:9px;font-size:11.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}' +
			'.dsh-usage-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px 24px;padding-left:28px}' +
			'.dsh-usage-metric{min-width:0;display:flex;flex-direction:column;gap:5px}' +
			'.dsh-usage-metric-value{overflow:hidden;text-overflow:ellipsis;font-size:15px;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums;white-space:nowrap}' +
			'.dsh-usage-composition{margin-top:23px;padding-top:18px;border-top:1px solid var(--dsw-alias-border-l1)}' +
			'.dsh-usage-composition-bar{display:flex;width:100%;height:7px;overflow:hidden;border-radius:4px;background:var(--dsw-alias-bg-layer-2)}' +
			'.dsh-usage-composition-piece{height:100%}' +
			'.dsh-usage-composition-legend{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:11px}' +
			'.dsh-usage-legend-item{min-width:0;display:flex;align-items:center;gap:7px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}' +
			'.dsh-usage-legend-dot{width:7px;height:7px;flex:none;border-radius:50%}' +
			'.dsh-usage-legend-value{margin-left:auto;color:var(--dsw-alias-label-primary);font-weight:550;font-variant-numeric:tabular-nums;white-space:nowrap}' +
			'.dsh-usage-sectionbar{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:2px}' +
			'.dsh-usage-sectiontitle{margin:0;font-size:16px;font-weight:650;letter-spacing:-.1px}' +
			'.dsh-usage-seg{display:inline-flex;align-items:center;gap:24px}' +
			'.dsh-usage-segbtn{position:relative;width:48px;padding:5px 0 7px;border:0;font:inherit;font-size:12.5px;text-align:center;cursor:pointer;background:transparent;color:var(--dsw-alias-label-tertiary);transition:color .15s}' +
			'.dsh-usage-segbtn:hover,.dsh-usage-segbtn.on{color:var(--dsw-alias-label-primary)}' +
			'.dsh-usage-segbtn.on{font-weight:600}' +
			'.dsh-usage-segbtn.on:after{content:"";position:absolute;left:50%;bottom:0;width:12px;height:2px;border-radius:1px;background:var(--dsw-alias-brand-primary);transform:translateX(-50%)}' +
			'.dsh-usage-list{display:flex;flex-direction:column;gap:14px}' +
			'.dsh-usage-panel{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:15px;background:transparent}' +
			'.dsh-usage-provider-head{display:grid;grid-template-columns:28px minmax(0,1fr) auto;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--dsw-alias-border-l1)}' +
			'.dsh-usage-rank{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}' +
			'.dsh-usage-provider-name{overflow:hidden;text-overflow:ellipsis;font-size:14px;font-weight:650;white-space:nowrap}' +
			'.dsh-usage-provider-meta{margin-top:4px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}' +
			'.dsh-usage-provider-total{text-align:right;font-variant-numeric:tabular-nums}' +
			'.dsh-usage-provider-value{font-size:17px;font-weight:650;white-space:nowrap}' +
			'.dsh-usage-provider-share{margin-top:3px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}' +
			'.dsh-usage-row{display:grid;grid-template-columns:minmax(0,1.15fr) 58px minmax(170px,1.25fr) minmax(90px,.65fr);grid-template-areas:"main requests token share";align-items:center;gap:16px;padding:13px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);transition:background .12s}' +
			'.dsh-usage-row:last-child{border-bottom:0}' +
			'.dsh-usage-row:hover{background:var(--dsw-alias-interactive-bg-hover)}' +
			'.dsh-usage-row-main{grid-area:main;min-width:0}' +
			'.dsh-usage-row-requests{grid-area:requests;font-size:12px;font-variant-numeric:tabular-nums}' +
			'.dsh-usage-row-token{grid-area:token;min-width:0;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}' +
			'.dsh-usage-row-share{grid-area:share;min-width:0}' +
			'.dsh-usage-mini-label{display:block;margin-top:3px;font-size:9.5px;font-weight:400;color:var(--dsw-alias-label-tertiary)}' +
			'.dsh-usage-model{display:block;overflow:hidden;text-overflow:ellipsis;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;white-space:nowrap}' +
			'.dsh-usage-sub{overflow:hidden;text-overflow:ellipsis;margin-top:4px;font-size:10px;font-weight:400;line-height:1.4;color:var(--dsw-alias-label-tertiary);white-space:nowrap}' +
			'.dsh-usage-chips{display:flex;overflow:hidden;gap:5px;margin-top:5px}' +
			'.dsh-usage-chip{max-width:120px;overflow:hidden;text-overflow:ellipsis;font-size:9.5px;line-height:17px;padding:0 7px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}' +
			'.dsh-usage-bar{display:flex;align-items:center;gap:8px}' +
			'.dsh-usage-bartrack{flex:1;height:5px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}' +
			'.dsh-usage-barfill{height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary)}' +
			'.dsh-usage-share-value{width:38px;text-align:right;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}' +
			'.dsh-usage-session-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:20px;padding:15px 20px;border-bottom:1px solid var(--dsw-alias-border-l1)}' +
			'.dsh-usage-session-row:last-child{border-bottom:0}' +
			'.dsh-usage-session-side{text-align:right;font-variant-numeric:tabular-nums}' +
			'.dsh-usage-session-total{margin-top:5px;font-size:14px;font-weight:600}' +
			'.dsh-usage-num{font-variant-numeric:tabular-nums}' +
			'.dsh-usage-status{margin-top:-12px;font-size:11px;color:var(--dsw-alias-label-tertiary)}' +
			'.dsh-usage-warn{color:var(--dsw-alias-state-warn-primary)}' +
			'.dsh-usage-error{font-size:12.5px;color:var(--dsw-alias-state-error-primary)}' +
			'.dsh-usage-loading{font-size:12.5px;color:var(--dsw-alias-label-tertiary)}' +
			'@media(max-width:720px){.dsh-usage-overview{padding:22px}.dsh-usage-overview-main{grid-template-columns:1fr}.dsh-usage-hero{padding:0 0 20px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsh-usage-metrics{padding:20px 0 0}.dsh-usage-row{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"main token" "requests share";gap:10px 16px}.dsh-usage-row-token,.dsh-usage-row-share{text-align:right}.dsh-usage-bar{justify-content:flex-end}.dsh-usage-bartrack{max-width:84px}.dsh-usage-row-requests .dsh-usage-mini-label{display:inline;margin-left:4px}}' +
			'@media(max-width:500px){.dsh-usage-page{gap:20px}.dsh-usage-overview{padding:20px 18px}.dsh-usage-hero-value{font-size:28px}.dsh-usage-metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:17px 20px}.dsh-usage-composition-legend{grid-template-columns:repeat(2,minmax(0,1fr))}.dsh-usage-sectionbar{align-items:flex-start;flex-direction:column;gap:9px}.dsh-usage-seg{width:100%;justify-content:space-between}.dsh-usage-provider-head{grid-template-columns:minmax(0,1fr) auto;padding:14px 16px}.dsh-usage-rank{display:none}.dsh-usage-row,.dsh-usage-session-row{padding-left:16px;padding-right:16px}.dsh-usage-provider-value{font-size:15px}.dsh-usage-session-row{align-items:flex-start;grid-template-columns:1fr}.dsh-usage-session-side{text-align:left}}';
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

		/** One compact secondary metric. */
		function metric(label, value) {
			return React.createElement("div", { className: "dsh-usage-metric" },
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
				React.createElement("span", { className: "dsh-usage-share-value" }, share + "%"),
			);
		}

		/** Input/cache/output breakdown line for one row. */
		function breakdown(text) {
			const parts = ["输入 " + text.input, "缓存读 " + text.cacheRead];
			if (text.cacheWrite !== "0") parts.push("缓存写 " + text.cacheWrite);
			parts.push("输出 " + text.output);
			return React.createElement("div", { className: "dsh-usage-sub", title: parts.join(" · ") }, parts.join(" · "));
		}

		/** Token total and its compact accounting breakdown. */
		function tokenBlock(row) {
			return React.createElement("div", { className: "dsh-usage-row-token" },
				React.createElement("div", null, row.text.total),
				breakdown(row.text),
			);
		}

		/** One model row shared by provider-first and model-first views. */
		function modelRow(model, providers) {
			return React.createElement("div", { className: "dsh-usage-row", key: model.model },
				React.createElement("div", { className: "dsh-usage-row-main" },
					React.createElement("span", { className: "dsh-usage-model", title: model.model }, model.model),
					providers === undefined ? null : React.createElement("div", { className: "dsh-usage-chips" },
						providers.map((provider) => React.createElement("span", { className: "dsh-usage-chip", key: provider, title: provider }, provider)),
					),
				),
				React.createElement("div", { className: "dsh-usage-row-requests" }, model.text.requests,
					React.createElement("span", { className: "dsh-usage-mini-label" }, providers === undefined ? "请求" : "请求 · " + model.text.sessions + " 会话"),
				),
				tokenBlock(model),
				React.createElement("div", { className: "dsh-usage-row-share" }, shareBar(model.share)),
			);
		}

		/** Overview: one dominant total, compact counters, and the true token mix. */
		function TotalsCard(props) {
			const totals = props.totals;
			const composition = totals.composition ?? [];
			const colors = {
				input: "var(--dsh-usage-input)",
				cacheRead: "var(--dsh-usage-cache-read)",
				cacheWrite: "var(--dsh-usage-cache-write)",
				output: "var(--dsh-usage-output)",
			};
			return React.createElement("div", { className: "dsh-usage-overview" },
				React.createElement("div", { className: "dsh-usage-overview-main" },
					React.createElement("div", { className: "dsh-usage-hero" },
						React.createElement("div", { className: "dsh-usage-eyebrow" }, "累计 Token"),
						React.createElement("div", { className: "dsh-usage-hero-value" }, totals.text.total),
						React.createElement("div", { className: "dsh-usage-hero-meta" }, totals.text.requests + " 次请求 · " + totals.text.sessions + " 个会话"),
					),
					React.createElement("div", { className: "dsh-usage-metrics" },
						metric("输入", totals.text.input),
						metric("缓存读取", totals.text.cacheRead),
						metric("缓存写入", totals.text.cacheWrite),
						metric("输出", totals.text.output),
						metric("推理", totals.text.reasoning),
					),
				),
				composition.length === 0 ? null : React.createElement("div", { className: "dsh-usage-composition" },
					React.createElement("div", { className: "dsh-usage-composition-bar", "aria-label": "Token 构成" },
						composition.map((part) => React.createElement("span", {
							className: "dsh-usage-composition-piece",
							key: part.id,
							style: { width: part.share + "%", background: colors[part.id] },
						})),
					),
					React.createElement("div", { className: "dsh-usage-composition-legend" },
						composition.map((part) => React.createElement("div", { className: "dsh-usage-legend-item", key: part.id },
							React.createElement("span", { className: "dsh-usage-legend-dot", style: { background: colors[part.id] } }),
							React.createElement("span", null, part.label),
							React.createElement("span", { className: "dsh-usage-legend-value" }, part.text),
						)),
					),
				),
			);
		}

		/** Provider-first ranking, with one compact row per model. */
		function ProvidersView(props) {
			return React.createElement("div", { className: "dsh-usage-list" },
				props.data.providers.map((provider, index) => React.createElement("div", { className: "dsh-usage-panel", key: provider.provider },
					React.createElement("div", { className: "dsh-usage-provider-head" },
						React.createElement("div", { className: "dsh-usage-rank" }, String(index + 1).padStart(2, "0")),
						React.createElement("div", { style: { minWidth: 0 } },
							React.createElement("div", { className: "dsh-usage-provider-name", title: provider.provider }, provider.provider),
							React.createElement("div", { className: "dsh-usage-provider-meta" }, provider.models.length + " 个模型 · " + provider.text.sessions + " 个会话 · " + provider.text.requests + " 次请求"),
						),
						React.createElement("div", { className: "dsh-usage-provider-total" },
							React.createElement("div", { className: "dsh-usage-provider-value" }, provider.text.total),
							React.createElement("div", { className: "dsh-usage-provider-share" }, provider.share + "%"),
						),
					),
					provider.models.map((model) => modelRow(model)),
				)),
			);
		}

		/** Model-first ranking, merging identical model ids across providers. */
		function ModelsView(props) {
			return React.createElement("div", { className: "dsh-usage-panel" },
				props.data.models.map((model) => modelRow(model, model.providers)),
			);
		}

		/** Per-session index with metadata separated from accounting totals. */
		function SessionsView(props) {
			return React.createElement("div", { className: "dsh-usage-panel" },
				props.data.sessionsList.map((session) => React.createElement("div", { className: "dsh-usage-session-row", key: session.id },
					React.createElement("div", { style: { minWidth: 0 } },
						React.createElement("span", { className: "dsh-usage-model", title: session.id }, session.shortId),
						React.createElement("div", { className: "dsh-usage-chips" },
							React.createElement("span", { className: "dsh-usage-chip" }, session.subagent ? "子 Agent" : "主会话"),
							session.agentPreset === "" ? null : React.createElement("span", { className: "dsh-usage-chip", key: "preset", title: session.agentPreset }, session.agentPreset),
							session.workspace === "" ? null : React.createElement("span", { className: "dsh-usage-chip", key: "workspace", title: session.workspace }, session.workspace),
						),
					),
					React.createElement("div", { className: "dsh-usage-session-side" },
						React.createElement("div", { className: "dsh-usage-sub" }, session.createdAtText),
						React.createElement("div", { className: "dsh-usage-session-total" }, session.totalText + " Token"),
						React.createElement("div", { className: "dsh-usage-mini-label" }, session.requestsText + " 次请求"),
					),
				)),
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
			const pageRef = React.useRef(null);
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
			/* Keep the settings scrollport width stable when views have different heights. */
			React.useEffect(() => {
				let scrollport = pageRef.current?.parentElement ?? null;
				while (scrollport !== null && !/(auto|scroll|overlay)/.test(getComputedStyle(scrollport).overflowY)) {
					scrollport = scrollport.parentElement;
				}
				if (scrollport === null) return undefined;
				const previous = scrollport.style.scrollbarGutter;
				scrollport.style.scrollbarGutter = "stable";
				return () => { scrollport.style.scrollbarGutter = previous; };
			}, []);
			const data = state.data;
			if (state.phase === "error" && data === null) {
				return React.createElement("div", { className: "dsh-usage-page", ref: pageRef },
					React.createElement("div", { className: "dsh-usage-error" }, "统计失败：" + state.error),
					React.createElement("button", { type: "button", className: "dsh-usage-btn", onClick: load }, "重试"),
				);
			}
			if (data === null) {
				return React.createElement("div", { className: "dsh-usage-page", ref: pageRef },
					React.createElement("div", { className: "dsh-usage-loading" }, "正在统计各提供商与模型的用量…"),
				);
			}
			const status = data.sessions.skipped > 0
				? React.createElement("div", { className: "dsh-usage-status dsh-usage-warn" }, data.sessions.skipped + " 个会话日志未计入")
				: data.totals.sessions === 0
					? React.createElement("div", { className: "dsh-usage-status" }, "暂无可统计的会话")
					: null;
			return React.createElement("div", { className: "dsh-usage-page", ref: pageRef },
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
