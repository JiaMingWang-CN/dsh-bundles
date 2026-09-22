window.__ModuleLoader__.load({
	id: "dsh-web-search",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const React = react;
		//#region lib/client.js
		/** Stable Cordis plugin name. */
		const name = "web-search";
		/** Slots mount the card; the settings scope and credentials remote back it. */
		const inject = ["slots", "settingsScope", "remote", "remote.credentials"];
		/** Card chrome + fields stylesheet, mirroring the shipped PluginCard skin (alias tokens). */
		const CSS = '.dsh-ws-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}' +
			'.dsh-ws-card:hover{border-color:var(--dsw-alias-label-dimmed)}' +
			'.dsh-ws-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}' +
			'.dsh-ws-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}' +
			'.dsh-ws-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}' +
			'.dsh-ws-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}' +
			'.dsh-ws-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}' +
			'.dsh-ws-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}' +
			'.dsh-ws-pending{flex:none;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:1px 8px;font-size:11px;line-height:1.6;white-space:nowrap}' +
			'.dsh-ws-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s;display:inline-flex}' +
			'.dsh-ws-chevronOpen{transform:rotate(180deg)}' +
			'.dsh-ws-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}' +
			'.dsh-ws-readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}' +
			'.dsh-ws-footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}' +
			'.dsh-ws-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}' +
			'.dsh-ws-discard,.dsh-ws-save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}' +
			'.dsh-ws-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}' +
			'.dsh-ws-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}' +
			'.dsh-ws-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}' +
			'.dsh-ws-discard:disabled,.dsh-ws-save:disabled{opacity:.4;cursor:default}' +
			'.dsh-ws-discard:focus-visible,.dsh-ws-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}' +
			'.dsh-ws-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}' +
			'.dsh-ws-field+.dsh-ws-field{border-top:.5px solid var(--dsw-alias-border-l2)}' +
			'.dsh-ws-head{align-items:center;gap:8px;display:flex}' +
			'.dsh-ws-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}' +
			'.dsh-ws-badges{align-items:center;gap:8px;display:inline-flex}' +
			'.dsh-ws-badge{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;white-space:nowrap}' +
			'.dsh-ws-badgeOn{color:var(--dsw-alias-state-success-primary,#10b981)}' +
			'.dsh-ws-input{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}' +
			'.dsh-ws-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}' +
			'.dsh-ws-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}' +
			'.dsh-ws-inputInvalid{border-color:var(--dsw-alias-label-error)}' +
			'.dsh-ws-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}' +
			'.dsh-ws-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}' +
			'.dsh-ws-seg{display:flex;gap:8px;flex-wrap:wrap}' +
			'.dsh-ws-segbtn{appearance:none;font:inherit;box-sizing:border-box;padding:3px 12px;border-radius:14px;font-size:12px;line-height:1.6;cursor:pointer;background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary);transition:background .15s,border-color .15s,color .15s}' +
			'.dsh-ws-segbtn:hover{border-color:var(--dsw-alias-label-dimmed)}' +
			'.dsh-ws-segbtn.on{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}' +
			'.dsh-ws-segbtn:disabled{opacity:.4;cursor:default}';
		/** Engine options in display order, with their short labels. */
		const ENGINE_OPTIONS = [
			{ id: "tavily", label: "Tavily（免费）" },
			{ id: "model", label: "模型自带联网" },
			{ id: "deepseek", label: "DeepSeek 官方" }
		];
		/** Per-engine copy: what it is and what it costs (selector hint). */
		const ENGINE_INFO = {
			tavily: "Tavily 免费档：每月 1000 次搜索、零运维。在 app.tavily.com 注册并创建 API Key。",
			model: "模型自带联网搜索（MiMo 服务端 web_search，需在 MiMo 控制台开通「Web Search 插件」）。按次计费约 ¥16/千次 + token 费；已固定单次 1 个关键词以控制费用。",
			deepseek: "DeepSeek 官方搜索（原内置方案）：调用 DeepSeek 服务端搜索，消耗 DeepSeek 余额。"
		};
		/** Credential reference field per engine, with its default. */
		const KEY_ENV_FIELDS = {
			tavily: { field: "tavilyApiKeyEnv", fallback: "TAVILY_API_KEY" },
			model: { field: "modelApiKeyEnv", fallback: "MIMO1_API_KEY" },
			deepseek: { field: "deepseekApiKeyEnv", fallback: "DEEPSEEK_API_KEY" }
		};
		/** Non-secret fields edited by each engine's form, with copy. */
		const VALUE_FIELDS = {
			tavily: [
				{ field: "tavilySearchDepth", label: "搜索深度", hint: "advanced 相关性更高，但每次按 2 个额度计费。" }
			],
			model: [
				{ field: "modelBaseUrl", label: "接口地址", hint: "openai 兼容接口的 /v1 基址；留空则使用默认地址。" },
				{ field: "modelId", label: "模型", hint: "用于检索摘要的模型；留空则使用默认模型。" }
			],
			deepseek: [
				{ field: "deepseekBaseUrl", label: "接口地址", hint: "Anthropic 兼容 Messages API 基址；留空则使用默认地址。" },
				{ field: "deepseekMaxUses", label: "单次请求最多搜索次数", hint: "一次请求在必须作答前最多可以搜索多少次；留空使用默认值（5）。" }
			]
		};
		/** Numeric fields that reject non-whole numbers. */
		const NUMERIC_FIELDS = new Set(["deepseekMaxUses"]);
		/** Header copy. */
		const TITLE = "\u7F51\u9875\u641C\u7D22";
		const DESCRIPTION = "\u4E3A web_search \u5DE5\u5177\u9009\u62E9\u641C\u7D22\u540E\u7AEF\uFF1B\u5207\u6362\u5373\u65F6\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F\u3002";
		/** Small copy used across the form. */
		const COPY = {
			engine: "\u641C\u7D22\u5DE5\u5177",
			apiKey: "API Key",
			keyHint: "\u4E0D\u5199\u5165\u8BBE\u7F6E\u6587\u4EF6\u3002\u7559\u7A7A\u8868\u793A\u4FDD\u6301\u5F53\u524D\u5BC6\u94A5\u3002",
			keySet: "\u5DF2\u914D\u7F6E\u5BC6\u94A5",
			keyUnset: "\u672A\u914D\u7F6E\u5BC6\u94A5",
			discard: "\u653E\u5F03\u4FEE\u6539",
			save: "\u4FDD\u5B58",
			saving: "\u4FDD\u5B58\u4E2D\u2026",
			saveFailed: "\u672C\u90E8\u7F72\u6CA1\u6709\u63A5\u53D7\u8FD9\u4E9B\u503C\uFF0C\u5DF2\u4FDD\u7559\u4F9B\u4F60\u4FEE\u6539\u3002",
			invalidNumber: "\u8BF7\u586B\u6B63\u6574\u6570\uFF1B\u7559\u7A7A\u8868\u793A\u4F7F\u7528\u9ED8\u8BA4\u503C\u3002",
			readOnly: "\u672C\u90E8\u7F72\u7684\u8BBE\u7F6E\u4E3A\u53EA\u8BFB\u3002",
			unsaved: "\u672A\u4FDD\u5B58",
			expand: "\u5C55\u5F00\u8BBE\u7F6E",
			collapse: "\u6536\u8D77\u8BBE\u7F6E"
		};
		/** Disclosure chevron, styled like the shell's 14px chevron icon. */
		function Chevron(props) {
			return React.createElement("svg", {
				className: props.className,
				width: 14,
				height: 14,
				viewBox: "0 0 14 14",
				"aria-hidden": "true",
				fill: "none"
			}, React.createElement("path", {
				d: "M3.5 5.25 7 8.75l3.5-3.5",
				stroke: "currentColor",
				strokeWidth: 1.3,
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}));
		}
		/** Maximum time to wait for the settings mirror to publish a completed write. */
		const SETTINGS_SETTLE_MS = 250;
		/** Whether every requested scalar setting is visible in the scope snapshot. */
		function settingsApplied(host, ops) {
			const stored = host.getSnapshot().value ?? {};
			return ops.every((op) => Object.is(stored[op.path[0]], op.value));
		}
		/** Wait for an asynchronously published settings snapshot, or reject a silent refusal. */
		function waitForSettings(host, ops) {
			if (settingsApplied(host, ops)) return Promise.resolve();
			return new Promise((resolve, reject) => {
				let settled = false;
				let timer;
				let dispose = () => {};
				const finish = (error) => {
					if (settled) return;
					settled = true;
					if (timer !== undefined) clearTimeout(timer);
					dispose();
					if (error === undefined) resolve();
					else reject(error);
				};
				const check = () => {
					if (settingsApplied(host, ops)) finish();
				};
				dispose = host.subscribe(check);
				if (settled) {
					dispose();
					return;
				}
				timer = setTimeout(() => finish(new Error("settings write was not published")), SETTINGS_SETTLE_MS);
				check();
			});
		}
		/**
		 * The web-search card: the shipped PluginCard skin (collapsible card,
		 * unsaved tag, save/discard footer) around the engine switcher and the
		 * selected engine's form. Non-secret fields save through the settings
		 * scope; API keys never ride the settings document and are written through
		 * the credentials domain.
		 */
		function WebSearchCard(props) {
			const host = props.host;
			const remote = props.remote;
			const writable = host.getSnapshot().writable !== false;
			const [open, setOpen] = React.useState(false);
			const [section, setSection] = React.useState(() => host.getSnapshot().value ?? {});
			const [draft, setDraft] = React.useState(() => ({ ...(host.getSnapshot().value ?? {}) }));
			const [dirty, setDirty] = React.useState(false);
			const [saving, setSaving] = React.useState(false);
			const [failed, setFailed] = React.useState(false);
			const [keyDraft, setKeyDraft] = React.useState("");
			const [configured, setConfigured] = React.useState(false);
			const engine = ENGINE_OPTIONS.some((option) => option.id === draft.engine) ? draft.engine : "tavily";
			const refOf = (id) => {
				const spec = KEY_ENV_FIELDS[id];
				const declared = section[spec.field];
				return typeof declared === "string" && declared.length > 0 ? declared : spec.fallback;
			};
			const readCredential = React.useCallback((id) => {
				const ref = refOf(id);
				remote.credentials.describe([ref]).then((response) => {
					if (!response.ok) return;
					setConfigured(response.value[ref]?.configured === true);
				}).catch(() => {});
			}, [remote, section]);
			React.useEffect(() => host.subscribe(() => {
				const value = host.getSnapshot().value ?? {};
				setSection(value);
				if (!dirty && !saving) setDraft({ ...value });
			}), [host, dirty, saving]);
			React.useEffect(() => { readCredential(engine); }, [engine, readCredential]);
			const switchEngine = (id) => {
				setDraft((prev) => ({ ...prev, engine: id }));
				setKeyDraft("");
				setDirty(true);
			};
			const edit = (field, value) => {
				setDraft((prev) => ({ ...prev, [field]: value }));
				setDirty(true);
			};
			const invalidNumber = VALUE_FIELDS[engine].some((spec) => {
				if (!NUMERIC_FIELDS.has(spec.field)) return false;
				const value = draft[spec.field];
				if (value === undefined || value === "") return false;
				return !Number.isInteger(Number(value)) || Number(value) < 1;
			});
			const blocked = !writable || !dirty || invalidNumber || saving;
			const save = async () => {
				if (blocked) return;
				setSaving(true);
				setFailed(false);
				try {
					const fields = [{ field: "engine" }, ...Object.values(VALUE_FIELDS).flat()];
					const ops = [];
					for (const spec of fields) {
						const raw = spec.field === "engine" ? engine : draft[spec.field];
						if (raw === undefined || raw === "") continue;
						const value = NUMERIC_FIELDS.has(spec.field) ? Number(raw) : raw;
						if (Object.is(value, section[spec.field])) continue;
						ops.push({ op: "set", path: [spec.field], value });
					}
					if (ops.length > 0) {
						await host.mutate(ops);
						await waitForSettings(host, ops);
					}
					if (keyDraft.length > 0) {
						const response = await remote.credentials.set(refOf(engine), keyDraft);
						if (!response.ok) throw new Error(response.error.message);
						setKeyDraft("");
						setConfigured(true);
					}
					setDirty(false);
					setOpen(false);
				} catch {
					setFailed(true);
				} finally {
					setSaving(false);
				}
			};
			const discard = () => {
				setDraft({ ...section });
				setKeyDraft("");
				setDirty(false);
				setFailed(false);
			};
			const valueField = (spec) => {
				const value = draft[spec.field] ?? "";
				const invalid = NUMERIC_FIELDS.has(spec.field) && value !== "" && (!Number.isInteger(Number(value)) || Number(value) < 1);
				return React.createElement("div", { className: "dsh-ws-field", key: spec.field },
					React.createElement("div", { className: "dsh-ws-head" },
						React.createElement("span", { className: "dsh-ws-label" }, spec.label),
					),
					React.createElement("input", {
						className: "dsh-ws-input" + (invalid ? " dsh-ws-inputInvalid" : ""),
						type: "text",
						inputMode: NUMERIC_FIELDS.has(spec.field) ? "numeric" : "text",
						disabled: !writable,
						value,
						onChange: (event) => edit(spec.field, event.target.value),
					}),
					React.createElement("p", { className: invalid ? "dsh-ws-invalid" : "dsh-ws-hint" }, invalid ? COPY.invalidNumber : spec.hint),
				);
			};
			const keyField = React.createElement("div", { className: "dsh-ws-field", key: "apiKey" },
				React.createElement("div", { className: "dsh-ws-head" },
					React.createElement("span", { className: "dsh-ws-label" }, COPY.apiKey),
					React.createElement("span", { className: "dsh-ws-badges" },
						React.createElement("span", { className: "dsh-ws-badge" + (configured ? " dsh-ws-badgeOn" : "") },
							configured ? COPY.keySet : COPY.keyUnset),
					),
				),
				React.createElement("input", {
					className: "dsh-ws-input",
					type: "password",
					disabled: !writable,
					placeholder: "\u7559\u7A7A\u4FDD\u6301\u5F53\u524D\u5BC6\u94A5",
					value: keyDraft,
					onChange: (event) => {
						setKeyDraft(event.target.value);
						setDirty(true);
					},
				}),
				React.createElement("p", { className: "dsh-ws-hint" }, COPY.keyHint),
			);
			const engineField = React.createElement("div", { className: "dsh-ws-field", key: "engine" },
				React.createElement("div", { className: "dsh-ws-head" },
					React.createElement("span", { className: "dsh-ws-label" }, COPY.engine),
					React.createElement("span", { className: "dsh-ws-seg" },
						ENGINE_OPTIONS.map((option) => React.createElement("button", {
							key: option.id,
							type: "button",
							disabled: !writable,
							className: "dsh-ws-segbtn" + (engine === option.id ? " on" : ""),
							onClick: () => switchEngine(option.id),
						}, option.label)),
					),
				),
				React.createElement("p", { className: "dsh-ws-hint" }, ENGINE_INFO[engine]),
			);
			const depthField = engine === "tavily" ? React.createElement("div", { className: "dsh-ws-field", key: "depth" },
				React.createElement("div", { className: "dsh-ws-head" },
					React.createElement("span", { className: "dsh-ws-label" }, "\u641C\u7D22\u6DF1\u5EA6"),
					React.createElement("span", { className: "dsh-ws-seg" },
						[{ id: "basic", label: "basic" }, { id: "advanced", label: "advanced" }].map((option) => React.createElement("button", {
							key: option.id,
							type: "button",
							disabled: !writable,
							className: "dsh-ws-segbtn" + ((draft.tavilySearchDepth ?? "basic") === option.id ? " on" : ""),
							onClick: () => edit("tavilySearchDepth", option.id),
						}, option.label)),
					),
				),
				React.createElement("p", { className: "dsh-ws-hint" }, VALUE_FIELDS.tavily[0].hint),
			) : null;
			const bodyFields = engine === "tavily"
				? [keyField, depthField]
				: engine === "model"
					? [keyField, ...VALUE_FIELDS.model.map(valueField)]
					: [keyField, ...VALUE_FIELDS.deepseek.map(valueField)];
			return React.createElement("li", { className: "dsh-ws-card" + (open ? " dsh-ws-cardOpen" : "") },
				React.createElement("button", {
					type: "button",
					className: "dsh-ws-header",
					"aria-expanded": open,
					"aria-label": (open ? COPY.collapse : COPY.expand) + ": " + TITLE,
					onClick: () => setOpen(!open),
				},
					React.createElement("span", { className: "dsh-ws-headText" },
						React.createElement("span", { className: "dsh-ws-name" }, TITLE),
						React.createElement("span", { className: "dsh-ws-description" }, DESCRIPTION),
					),
					dirty ? React.createElement("span", { className: "dsh-ws-pending" }, COPY.unsaved) : null,
					React.createElement(Chevron, { className: "dsh-ws-chevron" + (open ? " dsh-ws-chevronOpen" : "") }),
				),
				open ? React.createElement("div", { className: "dsh-ws-body" },
					!writable ? React.createElement("p", { className: "dsh-ws-readOnly", role: "status" }, COPY.readOnly) : null,
					engineField,
					bodyFields,
					React.createElement("div", { className: "dsh-ws-footer" },
						failed ? React.createElement("p", { className: "dsh-ws-failed", role: "status" }, COPY.saveFailed) : null,
						React.createElement("button", {
							type: "button",
							className: "dsh-ws-discard",
							disabled: blocked,
							onClick: discard,
						}, COPY.discard),
						React.createElement("button", {
							type: "button",
							className: "dsh-ws-save",
							disabled: blocked,
							onClick: save,
						}, saving ? COPY.saving : COPY.save),
					),
				) : null,
			);
		}
		/**
		 * Client plugin body: the stylesheet plus the settings card keyed on the
		 * `web-search` settings namespace, so the plugins tab pairs the two.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const host = ctx.settingsScope.bind({ namespace: name });
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.textContent = CSS;
				document.head.append(tag);
				return () => tag.remove();
			}, "web-search: styles");
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register(
				{ name: "settings.plugin.item", key: name },
				() => React.createElement(WebSearchCard, { host, remote: ctx.remote }),
			));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
