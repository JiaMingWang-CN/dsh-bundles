window.__ModuleLoader__.load({
	id: "dsh-plugin-version-watch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const React = react;

		/** Stable Cordis plugin name. */
		const name = "version-watch";
		/** The Settings seat and the locale service this page contributes to. */
		const inject = ["slots", "locale"];
		/** The Settings section this page occupies. */
		const SECTION_ID = "plugin-updates";
		/** Locale namespace of the page copy. */
		const NS = "pluginVersionWatch";
		/** How often an open page re-reads the Host check. */
		const AUTO_CHECK_MS = 15 * 60 * 1000;

		/** Host routes registered by this bundle's Host half. */
		const STATUS_ROUTE = "api/version-watch/status";
		const UPDATE_ROUTE = "api/version-watch/update";

		/**
		 * Page stylesheet, themed through the shell's alias tokens. The card and
		 * row geometry follows the Settings pages the shell ships.
		 */
		const CSS = [
			".dsh-vw-page{max-width:720px;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary)}",
			".dsh-vw-head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;flex-wrap:wrap}",
			".dsh-vw-actions{display:flex;align-items:center;gap:8px;flex:none}",
			".dsh-vw-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
			".dsh-vw-intro{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-vw-btn{box-sizing:border-box;height:32px;padding:0 14px;border-radius:8px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);transition:background .15s,border-color .15s;white-space:nowrap}",
			".dsh-vw-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}",
			".dsh-vw-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
			".dsh-vw-btn:disabled{opacity:.5;cursor:default}",
			".dsh-vw-btn.primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-overlay))}",
			".dsh-vw-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary)))}",
			".dsh-vw-meta{display:flex;flex-wrap:wrap;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-vw-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;overflow:hidden}",
			".dsh-vw-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:14px 16px}",
			".dsh-vw-row+.dsh-vw-row{border-top:.5px solid var(--dsw-alias-border-l1)}",
			".dsh-vw-info{min-width:0;display:flex;flex-direction:column;gap:4px}",
			".dsh-vw-rowtitle{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dsh-vw-name{font-size:14px;font-weight:500;line-height:22px;word-break:break-all}",
			".dsh-vw-version{font-size:12px;line-height:18px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-mono,ui-monospace,monospace)}",
			".dsh-vw-off{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-vw-detail{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-word}",
			".dsh-vw-source{color:var(--dsw-alias-label-tertiary)}",
			".dsh-vw-state{font-size:12px;line-height:18px}",
			".dsh-vw-state.available{color:var(--dsw-alias-state-warn-primary)}",
			".dsh-vw-state.current{color:var(--dsw-alias-state-success-primary)}",
			".dsh-vw-state.failed{color:var(--dsw-alias-state-error-primary)}",
			".dsh-vw-state.unsupported,.dsh-vw-state.unknown{color:var(--dsw-alias-label-tertiary)}",
			".dsh-vw-result{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}",
			".dsh-vw-result.ok{color:var(--dsw-alias-state-success-primary)}",
			".dsh-vw-result.error{color:var(--dsw-alias-state-error-primary)}",
			".dsh-vw-action{flex:none;display:flex;align-items:center;padding-top:1px}",
			".dsh-vw-empty{border:.5px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:24px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}",
			".dsh-vw-error{border:.5px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);word-break:break-word}",
			".dsh-vw-icon{display:block;flex:none}",
		].join("");

		/** Page copy in the two baseline locales. */
		const DICT = {
			zh: {
				navLabel: "插件更新",
				title: "插件更新",
				intro: "监控已安装插件的版本：Git 来源比较远端最新提交，npm 来源检查新版本；点击“更新”即热重载，通常无需重启。",
				refresh: "检查更新",
				refreshing: "检查中…",
				autoNote: "打开本页时自动检查，并每 15 分钟复查一次。",
				lastChecked: "上次检查",
				summaryLoading: "正在检查已安装插件…",
				summaryAvailable: "个插件有可用更新",
				summaryCurrent: "全部为最新",
				summaryFailed: "个检查失败",
				emptyTitle: "没有可监控的插件",
				emptyBody: "当前 profile 没有已安装的插件依赖。",
				notProfile: "未能读取 profile 目录，无法比较 Git 提交。",
				enabled: "已启用",
				disabled: "已停用",
				sourceRegistry: "npm 注册表",
				sourceGit: "Git 仓库",
				sourceLocal: "本地目录",
				sourceTarball: "压缩包",
				sourceUnknown: "未知来源",
				statusChecking: "检查中…",
				statusCurrent: "已是最新",
				statusAvailableGit: "有新提交",
				statusAvailableRegistry: "有新版本",
				statusUnknown: "无法确定已安装提交",
				statusFailed: "检查失败",
				statusUnsupported: "不支持自动更新",
				reasonNoCommit: "锁文件未记录提交",
				reasonSemver: "按版本范围安装",
				reasonNotUpdatable: "非注册表安装",
				installedLabel: "当前",
				latestLabel: "最新",
				commitLabel: "提交",
				update: "更新",
				updating: "更新中…",
				updatedLive: "已更新，新版本已实时生效，无需重启。",
				updatedRestart: "已更新，但需要重启 DSH 才能生效",
				upToDate: "已是最新，无需更新。",
				updateFailed: "更新失败",
				updateUnsupported: "该插件的来源不支持自动更新。",
				errInstallFailed: "旧版本已卸载，但重装失败；插件当前不可用，请到 Plugins 页面重新安装。",
				errRemovalFailed: "卸载旧版本失败，插件保持原状。",
				errRemote: "无法连接远端仓库，请检查网络后重试。",
				errMissing: "没有找到该插件的依赖记录。",
				errBusy: "已有更新正在进行，请稍后再试。",
				loadFailed: "读取插件列表失败",
				retry: "重试",
				forceCheck: "全部重新检查",
			},
			en: {
				navLabel: "Plugin updates",
				title: "Plugin updates",
				intro: "Monitors the versions of installed plugins: Git sources are compared with the newest remote commit, npm sources with published versions. Update reloads them live, usually without a restart.",
				refresh: "Check for updates",
				refreshing: "Checking…",
				autoNote: "Checks when this page opens and again every 15 minutes.",
				lastChecked: "Last check",
				summaryLoading: "Checking installed plugins…",
				summaryAvailable: "plugin(s) can be updated",
				summaryCurrent: "Everything is up to date",
				summaryFailed: "check(s) failed",
				emptyTitle: "No plugins to watch",
				emptyBody: "This profile has no installed plugin dependencies.",
				notProfile: "The profile directory could not be read, so Git commits cannot be compared.",
				enabled: "Enabled",
				disabled: "Disabled",
				sourceRegistry: "npm registry",
				sourceGit: "Git repository",
				sourceLocal: "Local directory",
				sourceTarball: "Tarball",
				sourceUnknown: "Unknown source",
				statusChecking: "Checking…",
				statusCurrent: "Up to date",
				statusAvailableGit: "New commits",
				statusAvailableRegistry: "New version",
				statusUnknown: "Installed commit unknown",
				statusFailed: "Check failed",
				statusUnsupported: "Not auto-updatable",
				reasonNoCommit: "the lockfile records no commit",
				reasonSemver: "installed from a version range",
				reasonNotUpdatable: "not installed from a registry",
				installedLabel: "Current",
				latestLabel: "Latest",
				commitLabel: "Commit",
				update: "Update",
				updating: "Updating…",
				updatedLive: "Updated and live — no restart needed.",
				updatedRestart: "Updated, but DSH must restart to apply it",
				upToDate: "Already up to date.",
				updateFailed: "Update failed",
				updateUnsupported: "This plugin's source cannot be updated automatically.",
				errInstallFailed: "The old version was removed but the reinstall failed; the plugin is unavailable now. Reinstall it from the Plugins page.",
				errRemovalFailed: "Removing the old version failed; the plugin was left as it was.",
				errRemote: "The remote repository could not be reached. Check the network and retry.",
				errMissing: "No dependency record was found for this plugin.",
				errBusy: "Another update is already running; try again shortly.",
				loadFailed: "Could not read the plugin list",
				retry: "Retry",
				forceCheck: "Re-check everything",
			},
		};

		/**
		 * Shorten a commit for display.
		 * @param {string | null | undefined} commit - object name.
		 * @returns {string}
		 */
		function shortCommit(commit) {
			return typeof commit === "string" && /^[0-9a-f]{40}/i.test(commit) ? commit.slice(0, 7) : (commit ?? "—");
		}

		/**
		 * The localized display title of one installed plugin.
		 * @param {object} plugin - Host row.
		 * @param {(text: unknown) => string} resolveText - locale text resolver.
		 * @returns {string}
		 */
		function pluginTitle(plugin, resolveText) {
			const title = plugin?.title;
			if (typeof title === "string" && title !== "") return title;
			if (title !== null && typeof title === "object") {
				const resolved = resolveText(title);
				if (typeof resolved === "string" && resolved !== "") return resolved;
			}
			return plugin?.name ?? "—";
		}

		/**
		 * The source label for one plugin.
		 * @param {object} plugin - Host row.
		 * @param {(key: string) => string} t - translate.
		 * @returns {string}
		 */
		function sourceLabel(plugin, t) {
			switch (plugin?.kind) {
				case "registry": return t("sourceRegistry");
				case "git": return t("sourceGit");
				case "local": return t("sourceLocal");
				case "tarball": return t("sourceTarball");
				default: return t("sourceUnknown");
			}
		}

		/**
		 * The check state line of one plugin.
		 * @param {object} plugin - Host row.
		 * @param {(key: string) => string} t - translate.
		 * @returns {string}
		 */
		function stateText(plugin, t) {
			const check = plugin?.check ?? {};
			if (check.status === "current") return t("statusCurrent");
			if (check.status === "available") return plugin?.kind === "registry" ? t("statusAvailableRegistry") : t("statusAvailableGit");
			if (check.status === "unknown") {
				const reason = check.reason === "no-installed-commit" ? t("reasonNoCommit") : "";
				return reason === "" ? t("statusUnknown") : `${t("statusUnknown")} · ${reason}`;
			}
			if (check.status === "failed") return check.reason ? `${t("statusFailed")} · ${check.reason}` : t("statusFailed");
			if (check.status === "unsupported") {
				const reason = check.reason === "semver-range" ? t("reasonSemver") : check.reason === "not-updatable" ? t("reasonNotUpdatable") : "";
				return reason === "" ? t("statusUnsupported") : `${t("statusUnsupported")} · ${reason}`;
			}
			return t("statusChecking");
		}

		/**
		 * The version/commit detail line of one plugin.
		 * @param {object} plugin - Host row.
		 * @param {(key: string) => string} t - translate.
		 * @returns {string}
		 */
		function detailText(plugin, t) {
			const check = plugin?.check ?? {};
			if (plugin?.kind === "registry") {
				const current = plugin?.version ?? "—";
				const latest = check.latestVersion ?? "—";
				return `${t("installedLabel")} ${current} · ${t("latestLabel")} ${latest}`;
			}
			const parts = [];
			if (check.installedCommit !== null && check.installedCommit !== undefined) {
				parts.push(`${t("commitLabel")} ${shortCommit(check.installedCommit)}`);
			}
			if (check.remoteCommit !== null && check.remoteCommit !== undefined && check.remoteCommit !== check.installedCommit) {
				parts.push(`→ ${shortCommit(check.remoteCommit)}`);
			}
			if (check.remoteVersion !== null && check.remoteVersion !== undefined && check.remoteVersion !== plugin?.version) {
				parts.push(`${t("latestLabel")} ${check.remoteVersion}`);
			}
			if (parts.length === 0) parts.push(sourceLabel(plugin, t));
			return parts.join(" · ");
		}

		/**
		 * One line summarizing the loaded page.
		 * @param {{ plugins?: object[] } | null} data - status response.
		 * @param {(key: string) => string} t - translate.
		 * @returns {string}
		 */
		function summaryOf(data, t) {
			const plugins = data?.plugins ?? [];
			const available = plugins.filter((plugin) => plugin?.check?.status === "available").length;
			const failed = plugins.filter((plugin) => plugin?.check?.status === "failed").length;
			const parts = [];
			if (plugins.length === 0) return t("summaryCurrent");
			if (available > 0) parts.push(`${available} ${t("summaryAvailable")}`);
			else parts.push(t("summaryCurrent"));
			if (failed > 0) parts.push(`${failed} ${t("summaryFailed")}`);
			return parts.join(" · ");
		}

		/**
		 * The inline outcome of one row's last update attempt.
		 * @param {{ phase: string, answer?: any, error?: string } | undefined} entry - result.
		 * @param {(key: string) => string} t - translate.
		 * @returns {{ text: string, tone: "ok" | "error" | null } | null}
		 */
		function resultText(entry, t) {
			if (entry === undefined || entry === null) return null;
			if (entry.phase === "updating") return { text: t("updating"), tone: null };
			if (entry.phase === "failed") return { text: `${t("updateFailed")} · ${entry.error ?? ""}`, tone: "error" };
			const answer = entry.answer;
			if (answer === null || typeof answer !== "object") return null;
			if (answer.ok === true) {
				if (answer.status === "updated") return { text: t("updatedLive"), tone: "ok" };
				if (answer.status === "restart-required") {
					const reason = typeof answer.restartReason === "string" && answer.restartReason !== "" ? ` (${answer.restartReason})` : "";
					return { text: `${t("updatedRestart")}${reason}.`, tone: "ok" };
				}
				return { text: t("upToDate"), tone: "ok" };
			}
			const code = answer.error?.code;
			const detail = typeof answer.error?.detail === "string" && answer.error.detail !== "" ? ` · ${answer.error.detail}` : "";
			if (code === "install-failed") {
				const spec = typeof answer.source === "string" && answer.source !== "" ? ` (${answer.source})` : "";
				return { text: `${t("errInstallFailed")}${spec}${detail}`, tone: "error" };
			}
			if (code === "removal-failed") return { text: `${t("errRemovalFailed")}${detail}`, tone: "error" };
			if (code === "remote-unreachable") return { text: `${t("errRemote")}${detail}`, tone: "error" };
			if (code === "no-dependency" || code === "no-bundle") return { text: t("errMissing"), tone: "error" };
			if (code === "busy") return { text: t("errBusy"), tone: "error" };
			if (code === "unsupported-source" || code === "semver-range") return { text: t("updateUnsupported"), tone: "error" };
			return { text: `${t("updateFailed")}${detail}`, tone: "error" };
		}

		/**
		 * Fire one JSON request to this bundle's Host routes.
		 * @param {string} path - route path relative to the application base.
		 * @param {RequestInit} [init] - fetch options.
		 * @returns {Promise<any>}
		 */
		async function requestJson(path, init) {
			const response = await fetch(new URL(path, document.baseURI), {
				cache: "no-store",
				credentials: "same-origin",
				...init,
			});
			const body = await response.json().catch(() => null);
			if (!response.ok) {
				const detail = body?.error?.detail ?? body?.error?.code ?? `HTTP ${response.status}`;
				throw new Error(String(detail));
			}
			return body;
		}

		/** Settings navigation glyph: a downward update arrow over a tray. */
		function WatchIcon(props) {
			const size = Number.isFinite(props?.size) && props.size > 0 ? props.size : 20;
			const active = props?.active === true;
			return React.createElement(
				"svg",
				{
					className: "dsh-vw-icon",
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					"aria-hidden": true,
					style: { color: active ? "var(--dsw-alias-brand-primary)" : "var(--dsw-alias-label-secondary)" },
				},
				React.createElement("path", {
					d: "M12 3.5v10.5",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 2,
					strokeLinecap: "round",
				}),
				React.createElement("path", {
					d: "M7.5 10.5 12 15l4.5-4.5",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 2,
					strokeLinecap: "round",
					strokeLinejoin: "round",
				}),
				React.createElement("path", {
					d: "M4.5 18.5v1a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-1",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 2,
					strokeLinecap: "round",
				}),
			);
		}

		/**
		 * Presentational page; the stateful wrapper below owns its data.
		 * @param {object} props - page props.
		 * @returns {object}
		 */
		function UpdatesView(props) {
			const t = props.t;
			const data = props.data;
			const plugins = data?.plugins ?? [];
			const checking = props.phase === "checking";
			const busy = props.busy ?? null;
			const rows = plugins.map((plugin) => {
				const check = plugin.check ?? {};
				const entry = props.results?.[plugin.name];
				const outcome = resultText(entry, t);
				const canUpdate = check.status === "available";
				const updating = entry?.phase === "updating" || busy === plugin.name;
				const target = plugin.kind === "registry"
					? check.latestVersion
					: typeof check.remoteVersion === "string" && check.remoteVersion !== plugin.version
						? check.remoteVersion
						: shortCommit(check.remoteCommit);
				const button = React.createElement(
					"button",
					{
						type: "button",
						className: canUpdate ? "dsh-vw-btn primary" : "dsh-vw-btn",
						disabled: !canUpdate || busy !== null || checking,
						onClick: canUpdate ? () => props.onUpdate?.(plugin) : undefined,
					},
					updating ? t("updating") : canUpdate ? (target ? `${t("update")} ${target}` : t("update")) : stateText(plugin, t),
				);
				return React.createElement(
					"div",
					{ className: "dsh-vw-row", key: plugin.name },
					React.createElement(
						"div",
						{ className: "dsh-vw-info" },
						React.createElement(
							"div",
							{ className: "dsh-vw-rowtitle" },
							React.createElement("span", { className: "dsh-vw-name" }, pluginTitle(plugin, props.resolveText ?? ((text) => text))),
							React.createElement("span", { className: "dsh-vw-version" }, plugin.version ?? "—"),
							React.createElement("span", { className: "dsh-vw-off" }, plugin.enabled ? t("enabled") : t("disabled")),
							React.createElement("span", { className: `dsh-vw-state ${check.status ?? "unknown"}` }, stateText(plugin, t)),
						),
						React.createElement(
							"div",
							{ className: "dsh-vw-detail" },
							React.createElement("span", { className: "dsh-vw-source" }, `${sourceLabel(plugin, t)} · ${plugin.source ?? plugin.name}`),
						),
						React.createElement("div", { className: "dsh-vw-detail" }, detailText(plugin, t)),
						outcome === null
							? null
							: React.createElement("div", { className: `dsh-vw-result ${outcome.tone ?? ""}` }, outcome.text),
					),
					React.createElement("div", { className: "dsh-vw-action" }, button),
				);
			});

			const body = props.phase === "failed" && data === null
				? React.createElement(
					"div",
					{ className: "dsh-vw-error" },
					`${t("loadFailed")}: ${props.error ?? ""}`,
				)
				: rows.length === 0
					? React.createElement(
						"div",
						{ className: "dsh-vw-empty" },
						React.createElement("div", { className: "dsh-vw-name" }, t("emptyTitle")),
						React.createElement("div", null, data === null ? t("summaryLoading") : t("emptyBody")),
					)
					: React.createElement("div", { className: "dsh-vw-card" }, rows);

			const meta = [];
			if (data === null) {
				if (checking) meta.push(t("summaryLoading"));
			} else {
				if (checking) meta.push(t("summaryLoading"));
				else meta.push(summaryOf(data, t));
			}
			if (data?.checkedAt) meta.push(`${t("lastChecked")} ${new Date(data.checkedAt).toLocaleTimeString()}`);
			if (data?.profileKnown === false) meta.push(t("notProfile"));
			meta.push(t("autoNote"));

			return React.createElement(
				"div",
				{ className: "dsh-vw-page" },
				React.createElement(
					"div",
					{ className: "dsh-vw-head" },
					React.createElement(
						"div",
						null,
						React.createElement("h1", { className: "dsh-vw-title" }, t("title")),
						React.createElement("p", { className: "dsh-vw-intro" }, t("intro")),
					),
					React.createElement(
						"div",
						{ className: "dsh-vw-actions" },
						React.createElement(
							"button",
							{
								type: "button",
								className: "dsh-vw-btn",
								disabled: checking || busy !== null,
								onClick: () => props.onRefresh?.(true),
							},
							checking ? t("refreshing") : t("forceCheck"),
						),
					),
				),
				React.createElement("div", { className: "dsh-vw-meta" }, meta.join(" · ")),
				body,
			);
		}

		/**
		 * Stateful Settings page: reads the Host check and performs updates.
		 * @param {{ t: (key: string) => string }} props - translate function from `apply`.
		 * @returns {object}
		 */
		function UpdatesPage(props) {
			const t = props.t;
			const [data, setData] = React.useState(null);
			const [phase, setPhase] = React.useState("checking");
			const [error, setError] = React.useState(null);
			const [results, setResults] = React.useState({});
			const [busy, setBusy] = React.useState(null);
			const reads = React.useRef(0);

			const load = React.useCallback(async (force) => {
				const read = ++reads.current;
				setPhase("checking");
				try {
					const answer = await requestJson(force ? `${STATUS_ROUTE}?refresh=1` : STATUS_ROUTE);
					if (read !== reads.current) return;
					setData(answer);
					setError(null);
					setPhase("ready");
				} catch (failure) {
					if (read !== reads.current) return;
					setError(String(failure?.message ?? failure));
					setPhase("failed");
				}
			}, []);

			React.useEffect(() => {
				load(false);
				const timer = setInterval(() => load(false), AUTO_CHECK_MS);
				return () => clearInterval(timer);
			}, [load]);

			const update = React.useCallback(async (plugin) => {
				setBusy(plugin.name);
				setResults((previous) => ({ ...previous, [plugin.name]: { phase: "updating" } }));
				try {
					const answer = await requestJson(UPDATE_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ name: plugin.name }),
					});
					setResults((previous) => ({ ...previous, [plugin.name]: { phase: "done", answer } }));
				} catch (failure) {
					setResults((previous) => ({
						...previous,
						[plugin.name]: { phase: "failed", error: String(failure?.message ?? failure) },
					}));
				} finally {
					setBusy(null);
					load(true);
				}
			}, [load]);

			return React.createElement(UpdatesView, {
				t,
				data,
				phase,
				error,
				results,
				busy,
				onRefresh: load,
				onUpdate: update,
				resolveText: props.resolveText,
			});
		}

		/**
		 * Register the Settings section and its navigation glyph.
		 * @param {object} ctx - Client plugin context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, DICT), "version-watch: dictionary");
			const t = ctx.locale.bind(NS);
			const resolveText = (text) => ctx.locale.resolveText(text);
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.textContent = CSS;
				document.head.append(tag);
				return () => tag.remove();
			}, "version-watch: styles");
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{ name: "settings.section", id: SECTION_ID, order: 35, label: () => t("navLabel") },
					() => React.createElement(UpdatesPage, { t, resolveText }),
				),
			);
			ctx.slots.inject("settings.section.icon", () =>
				ctx.slots.register({ name: "settings.section.icon", id: SECTION_ID }, (owner) =>
					React.createElement(WatchIcon, { size: owner?.size ?? 20, active: owner?.active === true }),
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		exports.UpdatesPage = UpdatesPage;
		exports.UpdatesView = UpdatesView;
		exports.summaryOf = summaryOf;
		exports.stateText = stateText;
		exports.detailText = detailText;
		exports.resultText = resultText;
		exports.DICT = DICT;
		exports.WatchIcon = WatchIcon;
		return module.exports;
	},
});
