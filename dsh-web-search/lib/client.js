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
		/** Slots mount the row's config page; configForms and the credentials
		 *  remote back it, and the `web` form carries the provider selection. */
		const inject = ["slots", "configForms", "remote", "remote.credentials"];
		/** Provider id this bundle registers; also the "on" marker in `web`. */
		const WEB_SEARCH_ID = "web-search";
		/** Built-in provider groups the master switch can fall back to. */
		const BUILTIN_GROUPS = {
			messages: { searchProvider: "deepseek-official", fetchProvider: "http" },
			api: { searchProvider: "deepseek-search-api", fetchProvider: "deepseek-fetch-api" }
		};
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
			'.dsh-ws-body{max-width:720px;display:flex;flex-direction:column;gap:0;padding-bottom:8px}' +
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
			'.dsh-ws-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}' +
			'.dsh-ws-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}' +
			'.dsh-ws-seg{display:flex;gap:8px;flex-wrap:wrap}' +
			'.dsh-ws-segbtn{appearance:none;font:inherit;box-sizing:border-box;padding:3px 12px;border-radius:14px;font-size:12px;line-height:1.6;cursor:pointer;background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary);transition:background .15s,border-color .15s,color .15s}' +
			'.dsh-ws-segbtn:hover{border-color:var(--dsw-alias-label-dimmed)}' +
			'.dsh-ws-segbtn.on{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}' +
			'.dsh-ws-segbtn:disabled{opacity:.4;cursor:default}' +
			'.dsh-ws-switch{position:relative;box-sizing:border-box;width:40px;height:22px;border-radius:11px;padding:0;cursor:pointer;flex:none;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);transition:background .15s,border-color .15s}' +
			'.dsh-ws-switch.on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}' +
			'.dsh-ws-switch:disabled{opacity:.4;cursor:default}' +
			'.dsh-ws-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}' +
			'.dsh-ws-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-overlay,#fff);box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s}' +
			'.dsh-ws-switch.on .dsh-ws-knob{transform:translateX(18px)}';
		/** Third-party engines in display order, with their short labels. */
		const ENGINE_OPTIONS = [
			{ id: "tavily", label: "Tavily（免费）" },
			{ id: "model", label: "模型自带联网" }
		];
		/** Per-engine copy: what it is and what it costs (selector hint). */
		const ENGINE_INFO = {
			tavily: "Tavily 免费档：每月 1000 次搜索、零运维。在 app.tavily.com 注册并创建 API Key。",
			model: "模型自带联网搜索（MiMo 服务端 web_search，需在 MiMo 控制台开通「Web Search 插件」）。按次计费约 ¥16/千次 + token 费；已固定单次 1 个关键词以控制费用。"
		};
		/** Credential reference field per engine, with its default. */
		const KEY_ENV_FIELDS = {
			tavily: { field: "tavilyApiKeyEnv", fallback: "TAVILY_API_KEY" },
			model: { field: "modelApiKeyEnv", fallback: "MIMO1_API_KEY" }
		};
		/** Non-secret fields edited by each engine's form, with copy. */
		const VALUE_FIELDS = {
			tavily: [
				{ field: "tavilySearchDepth", label: "搜索深度", hint: "advanced 相关性更高，但每次按 2 个额度计费。" }
			],
			model: [
				{ field: "modelBaseUrl", label: "接口地址", hint: "openai 兼容接口的 /v1 基址；留空则使用默认地址。" },
				{ field: "modelId", label: "模型", hint: "用于检索摘要的模型；留空则使用默认模型。" }
			]
		};
		/** Row summary and introductory copy. */
		const DESCRIPTION = "\u4E3A web_search \u589E\u52A0 Tavily / MiMo \u540E\u7AEF\uFF1B\u5173\u95ED\u5F00\u5173\u5373\u4EA4\u56DE DSH \u5185\u7F6E\u641C\u7D22\u3002";
		/** Small copy used across the form. */
		const COPY = {
			thirdParty: "\u4F7F\u7528\u7B2C\u4E09\u65B9\u641C\u7D22",
			on: "\u5DF2\u5F00\u542F",
			off: "\u5DF2\u5173\u95ED",
			onHint: "web_search \u8D70\u6240\u9009\u7B2C\u4E09\u65B9\u540E\u7AEF\uFF1B\u5173\u95ED\u540E\u6539\u7528 DSH \u5185\u7F6E\u641C\u7D22\u3002",
			offHint: "\u5F53\u524D\u4F7F\u7528 DSH \u5185\u7F6E\u641C\u7D22\uFF1B\u5F00\u542F\u540E web_search \u8D70\u6240\u9009\u7B2C\u4E09\u65B9\u540E\u7AEF\u3002",
			needKey: "\u5148\u4FDD\u5B58\u5F53\u524D\u540E\u7AEF\u7684 API Key\uFF0C\u518D\u5F00\u542F\u7B2C\u4E09\u65B9\u641C\u7D22\u3002",
			missingOnHint: "\u5F53\u524D\u540E\u7AEF\u8FD8\u672A\u914D\u7F6E API Key\uFF0C\u641C\u7D22\u4F1A\u62A5\u9519\uFF1B\u8BF7\u5728\u4E0B\u65B9\u4FDD\u5B58 Key\uFF0C\u6216\u5173\u95ED\u5F00\u5173\u6539\u7528\u5185\u7F6E\u3002",
			switchFailed: "\u5207\u6362\u6CA1\u6709\u751F\u6548\uFF0C\u8BF7\u91CD\u8BD5\uFF1B\u8BBE\u7F6E\u53EF\u80FD\u88AB\u66F4\u9AD8\u4F18\u5148\u7EA7\u7684\u914D\u7F6E\u56FA\u5B9A\u3002",
			builtinNote: "\u5F00\u542F\u671F\u95F4\u5185\u7F6E\u9875\u53EF\u80FD\u663E\u793A\u4E3A Messages \u641C\u7D22\uFF0C\u5B9E\u9645\u540E\u7AEF\u4EE5\u672C\u5F00\u5173\u4E3A\u51C6\u3002",
			engine: "\u7B2C\u4E09\u65B9\u540E\u7AEF",
			apiKey: "API Key",
			keyHint: "\u4E0D\u5199\u5165\u8BBE\u7F6E\u6587\u4EF6\u3002\u7559\u7A7A\u8868\u793A\u4FDD\u6301\u5F53\u524D\u5BC6\u94A5\u3002",
			keySet: "\u5DF2\u914D\u7F6E\u5BC6\u94A5",
			keyUnset: "\u672A\u914D\u7F6E\u5BC6\u94A5",
			discard: "\u653E\u5F03\u4FEE\u6539",
			save: "\u4FDD\u5B58",
			saving: "\u4FDD\u5B58\u4E2D\u2026",
			saveFailed: "\u672C\u90E8\u7F72\u6CA1\u6709\u63A5\u53D7\u8FD9\u4E9B\u503C\uFF0C\u5DF2\u4FDD\u7559\u4F9B\u4F60\u4FEE\u6539\u3002",
			readOnly: "\u672C\u90E8\u7F72\u7684\u8BBE\u7F6E\u4E3A\u53EA\u8BFB\u3002",
			unsaved: "\u672A\u4FDD\u5B58"
		};
		/** Maximum time to wait for the settings mirror to publish a completed write. */
		const SETTINGS_SETTLE_MS = 250;
		/** The value a field should reach after one write operation. */
		function expectedValue(form, op) {
			if (op.op === "set") return op.value;
			const base = form.getSnapshot().base ?? {};
			return op.path.reduce((node, key) => node == null ? undefined : node[key], base);
		}
		/** Whether every requested setting is visible in the scope snapshot. */
		function settingsApplied(form, expected) {
			const stored = form.getSnapshot().value ?? {};
			return expected.every((item) => Object.is(item.path.reduce((node, key) => node == null ? undefined : node[key], stored), item.value));
		}
		/** Wait for an asynchronously published settings snapshot, or reject a silent refusal. */
		function waitForSettings(form, ops) {
			const expected = ops.map((op) => ({ path: op.path, value: expectedValue(form, op) }));
			if (settingsApplied(form, expected)) return Promise.resolve();
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
					if (settingsApplied(form, expected)) finish();
				};
				dispose = form.subscribe(check);
				if (settled) {
					dispose();
					return;
				}
				timer = setTimeout(() => finish(new Error("settings write was not published")), SETTINGS_SETTLE_MS);
				check();
			});
		}
		/**
		 * The third-party search configuration page the bundle's row opens
		 * (`plugins.row.config`) and the Settings sidebar page. It owns the
		 * master switch over `web` (the DSH provider selection) plus the
		 * engine/key form over this bundle's `web-search` namespace.
		 *
		 * Turning the switch on writes both `web` fields as `unset`, which the
		 * DSH settings service resolves to the inherited bundle-patch values and
		 * then prunes from the user layer. Turning it off writes the remembered
		 * built-in group, so the plugin id never has to live in user settings.
		 */
		function WebSearchCard(props) {
			const host = props.host;
			const webHost = props.webHost;
			const remote = props.remote;
			const writable = host.getSnapshot().writable !== false;
			const [section, setSection] = React.useState(() => host.getSnapshot().value ?? {});
			const [draft, setDraft] = React.useState(() => ({ ...(host.getSnapshot().value ?? {}) }));
			const [dirty, setDirty] = React.useState(false);
			const [saving, setSaving] = React.useState(false);
			const [failed, setFailed] = React.useState(false);
			const [keyDraft, setKeyDraft] = React.useState("");
			const [configured, setConfigured] = React.useState(false);
			const [webState, setWebState] = React.useState(() => webHost.getSnapshot());
			const [switching, setSwitching] = React.useState(false);
			const [switchFailed, setSwitchFailed] = React.useState(false);
			const thirdParty = webState.value?.searchProvider === WEB_SEARCH_ID;
			const webWritable = webState.writable !== false;
			const engine = ENGINE_OPTIONS.some((option) => option.id === draft.engine) ? draft.engine : "tavily";
			const refOf = (id) => {
				const spec = KEY_ENV_FIELDS[id];
				const declared = section[spec.field];
				return typeof declared === "string" && declared.length > 0 ? declared : spec.fallback;
			};
			React.useEffect(() => host.subscribe(() => {
				const value = host.getSnapshot().value ?? {};
				setSection(value);
				if (!dirty && !saving) setDraft({ ...value });
			}), [host, dirty, saving]);
			React.useEffect(() => webHost.subscribe(() => setWebState(webHost.getSnapshot())), [webHost]);
			const credentialRef = refOf(engine);
			/* Re-read only when the reference changes; a reply for a reference the
			 * card has since left (engine switch) is dropped, not shown. */
			React.useEffect(() => {
				let current = true;
				remote.credentials.describe([credentialRef]).then((response) => {
					if (current && response.ok) setConfigured(response.value[credentialRef]?.configured === true);
				}).catch(() => {});
				return () => { current = false; };
			}, [remote, credentialRef]);
			const switchEngine = (id) => {
				setDraft((prev) => ({ ...prev, engine: id }));
				setKeyDraft("");
				setDirty(true);
			};
			const edit = (field, value) => {
				setDraft((prev) => ({ ...prev, [field]: value }));
				setDirty(true);
			};
			/** Remember which built-in group is active before taking over. */
			const captureBuiltin = async () => {
				const current = webHost.getSnapshot().value?.searchProvider;
				const next = current === "deepseek-search-api" ? "api" : current === "deepseek-official" ? "messages" : undefined;
				if (next === undefined) return;
				if (host.getSnapshot().value?.builtin === next) return;
				const ops = [{ op: "set", path: ["builtin"], value: next }];
				await host.mutate(ops);
				await waitForSettings(host, ops);
			};
			/** Enable third-party search: drop the user-layer `web` override. */
			const enableThirdParty = async () => {
				if (!webWritable || switching) return;
				setSwitching(true);
				setSwitchFailed(false);
				try {
					await captureBuiltin();
					const ops = [
						{ op: "unset", path: ["searchProvider"] },
						{ op: "unset", path: ["fetchProvider"] }
					];
					await webHost.mutate(ops);
					await waitForSettings(webHost, ops);
				} catch {
					setSwitchFailed(true);
				} finally {
					setSwitching(false);
				}
			};
			/** Disable third-party search: restore the remembered built-in group. */
			const disableThirdParty = async () => {
				if (!webWritable || switching) return;
				const builtin = host.getSnapshot().value?.builtin === "api" ? "api" : "messages";
				const group = BUILTIN_GROUPS[builtin];
				setSwitching(true);
				setSwitchFailed(false);
				try {
					const ops = [
						{ op: "set", path: ["searchProvider"], value: group.searchProvider },
						{ op: "set", path: ["fetchProvider"], value: group.fetchProvider }
					];
					await webHost.mutate(ops);
					await waitForSettings(webHost, ops);
				} catch {
					setSwitchFailed(true);
				} finally {
					setSwitching(false);
				}
			};
			const toggleThirdParty = () => thirdParty ? disableThirdParty() : enableThirdParty();
			const switchDisabled = !webWritable || switching || saving || (!thirdParty && (!configured || !writable));
			const blocked = !writable || !dirty || saving || switching;
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
						if (Object.is(raw, section[spec.field])) continue;
						ops.push({ op: "set", path: [spec.field], value: raw });
					}
					if (ops.length > 0) {
						await host.mutate(ops);
						await waitForSettings(host, ops);
					}
					if (keyDraft.length > 0) {
						const response = await remote.credentials.set(credentialRef, keyDraft);
						if (!response.ok) throw new Error(response.error.message);
						setKeyDraft("");
						setConfigured(true);
					}
					setDirty(false);
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
				return React.createElement("div", { className: "dsh-ws-field", key: spec.field },
					React.createElement("div", { className: "dsh-ws-head" },
						React.createElement("span", { className: "dsh-ws-label" }, spec.label),
					),
					React.createElement("input", {
						className: "dsh-ws-input",
						type: "text",
						disabled: !writable || !thirdParty,
						value,
						onChange: (event) => edit(spec.field, event.target.value),
					}),
					React.createElement("p", { className: "dsh-ws-hint" }, spec.hint),
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
					React.createElement("span", { className: "dsh-ws-label" }, VALUE_FIELDS.tavily[0].label),
					React.createElement("span", { className: "dsh-ws-seg" },
						[{ id: "basic", label: "basic" }, { id: "advanced", label: "advanced" }].map((option) => React.createElement("button", {
							key: option.id,
							type: "button",
							disabled: !writable || !thirdParty,
							className: "dsh-ws-segbtn" + ((draft.tavilySearchDepth ?? "basic") === option.id ? " on" : ""),
							onClick: () => edit("tavilySearchDepth", option.id),
						}, option.label)),
					),
				),
				React.createElement("p", { className: "dsh-ws-hint" }, VALUE_FIELDS.tavily[0].hint),
			) : null;
			const masterField = React.createElement("div", { className: "dsh-ws-field", key: "thirdParty" },
				React.createElement("div", { className: "dsh-ws-head" },
					React.createElement("span", { className: "dsh-ws-label" }, COPY.thirdParty),
					React.createElement("span", { className: "dsh-ws-badges" },
						React.createElement("span", { className: "dsh-ws-badge" + (thirdParty ? " dsh-ws-badgeOn" : "") }, thirdParty ? COPY.on : COPY.off),
						React.createElement("button", {
							type: "button",
							role: "switch",
							"aria-checked": thirdParty ? "true" : "false",
							"aria-label": COPY.thirdParty,
							className: "dsh-ws-switch" + (thirdParty ? " on" : ""),
							disabled: switchDisabled,
							onClick: toggleThirdParty,
						}, React.createElement("span", { className: "dsh-ws-knob" })),
					),
				),
				React.createElement("p", { className: "dsh-ws-hint" }, thirdParty ? COPY.onHint : COPY.offHint),
				!thirdParty && !configured ? React.createElement("p", { className: "dsh-ws-invalid" }, COPY.needKey) : null,
				thirdParty && !configured ? React.createElement("p", { className: "dsh-ws-invalid" }, COPY.missingOnHint) : null,
				switchFailed ? React.createElement("p", { className: "dsh-ws-failed", role: "status" }, COPY.switchFailed) : null,
				thirdParty ? React.createElement("p", { className: "dsh-ws-hint" }, COPY.builtinNote) : null,
			);
			const bodyFields = engine === "tavily"
				? [keyField, depthField]
				: [keyField, ...VALUE_FIELDS[engine].map(valueField)];
			/* The page's heading chrome belongs to the plugins page owner. */
			return React.createElement("div", { className: "dsh-ws-body" },
				!writable || !webWritable ? React.createElement("p", { className: "dsh-ws-readOnly", role: "status" }, COPY.readOnly) : null,
				masterField,
				engineField,
				bodyFields,
				React.createElement("div", { className: "dsh-ws-footer" },
					dirty ? React.createElement("span", { className: "dsh-ws-pending" }, COPY.unsaved) : null,
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
			);
		}
		/**
		 * Client plugin body: the stylesheet plus the configuration page for the
		 * bundle's `web-search` row, keyed `<package>#<row id>` as the
		 * `plugins.row.config` slot contract spells it, AND a `settings.section`
		 * page so the Settings sidebar lists 第三方搜索 beside the sibling bundle
		 * pages. Both render the same form over the `web-search` settings
		 * namespace and the `web` provider selection.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const host = ctx.configForms.get(name);
			const webHost = ctx.configForms.get("web");
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.textContent = CSS;
				document.head.append(tag);
				return () => tag.remove();
			}, "web-search: styles");
			ctx.effect(() => ctx.configForms.whileServed([name], () => {
				const offRow = ctx.slots.inject("plugins.row.config", () => ctx.slots.register(
					{ name: "plugins.row.config", key: "dsh-web-search#web-search" },
					/* `summary` is the row's static one-liner: no form, no credential lookup. */
					(props) => props.view === "summary" ? DESCRIPTION : React.createElement(WebSearchCard, { ...props, host, webHost, remote: ctx.remote }),
				));
				const offSection = ctx.slots.inject("settings.section", () => ctx.slots.register(
					{ name: "settings.section", id: "web-search", order: 32, label: "第三方搜索" },
					() => React.createElement(WebSearchCard, { view: "page", host, webHost, remote: ctx.remote }),
				));
				return () => {
					offRow();
					offSection();
				};
			}), "web-search: config page");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
