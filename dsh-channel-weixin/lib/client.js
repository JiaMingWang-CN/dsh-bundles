window.__ModuleLoader__.load({
	id: "dsh-channel-weixin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const React = react;
		//#region lib/client.js
		/** Read-only status route published by the host half. */
		const STATUS_PATH = "/plugins/channel-weixin/status";
		/** Pending-QR metadata (never the scannable payload itself). */
		const QR_INFO_PATH = "/plugins/channel-weixin/login/qr";
		/** Host-rendered QR image; the page needs no QR encoder of its own. */
		const QR_SVG_PATH = "/plugins/channel-weixin/login/qr.svg";
		/** Login control endpoints. */
		const LOGIN_START_PATH = "/plugins/channel-weixin/login/start";
		const LOGIN_VERIFY_PATH = "/plugins/channel-weixin/login/verify";
		const LOGIN_CANCEL_PATH = "/plugins/channel-weixin/login/cancel";
		const DISCONNECT_PATH = "/plugins/channel-weixin/disconnect";
		const RECONNECT_PATH = "/plugins/channel-weixin/reconnect";
		const LOGOUT_PATH = "/plugins/channel-weixin/logout";
		/** Status cadence while the section is open. Closing the page only stops this poll. */
		const POLL_MS = 3000;
		/** Settings stylesheet, themed through the shell's alias tokens. */
		const CSS = '.dsh-weixin-page{max-width:720px;display:flex;flex-direction:column;gap:18px;color:var(--dsw-alias-label-primary)}' +
			'.dsh-weixin-card{box-sizing:border-box;padding:18px 20px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px}' +
			'.dsh-weixin-head{display:flex;align-items:center;justify-content:space-between;gap:20px}' +
			'.dsh-weixin-title{font-size:15px;font-weight:600}' +
			'.dsh-weixin-desc{margin-top:6px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}' +
			'.dsh-weixin-phase{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;white-space:nowrap}' +
			'.dsh-weixin-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}' +
			'.dsh-weixin-dot.on{background:var(--dsw-alias-state-success-primary,#10b981)}' +
			'.dsh-weixin-dot.warn{background:var(--dsw-alias-state-warn-primary)}' +
			'.dsh-weixin-dot.err{background:var(--dsw-alias-state-error-primary)}' +
			'.dsh-weixin-grid{display:grid;grid-template-columns:minmax(96px,auto) minmax(0,1fr);gap:9px 18px;margin-top:15px;font-size:12.5px}' +
			'.dsh-weixin-key{color:var(--dsw-alias-label-tertiary)}' +
			'.dsh-weixin-val{min-width:0;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums;white-space:nowrap}' +
			'.dsh-weixin-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px}' +
			'.dsh-weixin-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}' +
			'.dsh-weixin-btn{box-sizing:border-box;padding:6px 14px;border-radius:8px;font-size:12px;cursor:pointer;background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}' +
			'.dsh-weixin-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}' +
			'.dsh-weixin-btn:disabled{opacity:.55;cursor:default}' +
			'.dsh-weixin-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}' +
			'.dsh-weixin-qr{margin-top:16px;display:flex;flex-direction:column;align-items:center;gap:10px}' +
			'.dsh-weixin-qr img{width:216px;height:216px;border-radius:12px;background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l2)}' +
			'.dsh-weixin-qr-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}' +
			'.dsh-weixin-field{display:flex;gap:8px;align-items:center;margin-top:14px}' +
			'.dsh-weixin-input{box-sizing:border-box;width:148px;padding:6px 10px;border-radius:8px;font-size:13px;letter-spacing:2px;background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}' +
			'.dsh-weixin-warn{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary)}' +
			'.dsh-weixin-warn strong{color:var(--dsw-alias-state-warn-primary)}' +
			'.dsh-weixin-error{font-size:12.5px;color:var(--dsw-alias-state-error-primary)}' +
			'.dsh-weixin-note{font-size:12px;color:var(--dsw-alias-label-secondary)}' +
			'.dsh-weixin-loading{font-size:12.5px;color:var(--dsw-alias-label-tertiary)}';
		/** Stable Cordis plugin name. */
		const name = "channel-weixin";
		/** The settings seat is the only client dependency: everything else arrives over the plugin routes. */
		const inject = ["slots"];
		/** Connection phases the host half publishes, with their display text. */
		const PHASE_TEXT = {
			stopped: "未连接",
			"login-pending": "等待扫码",
			scanned: "已扫码",
			"verify-required": "等待验证码",
			connected: "已连接",
			error: "连接异常"
		};
		/** Phase-to-indicator class: connected is live, waiting phases are warn, error is err. */
		function phaseClass(phase) {
			if (phase === "connected") return "dsh-weixin-dot on";
			if (phase === "error") return "dsh-weixin-dot err";
			if (phase === "stopped") return "dsh-weixin-dot";
			return "dsh-weixin-dot warn";
		}
		/** Display text for one phase; an unknown phase is shown as-is rather than hidden. */
		function phaseText(phase) {
			return PHASE_TEXT[phase] || String(phase || "未知");
		}
		/** One key/value row, or null when the value is empty so the page stays compact. */
		function row(key, value, mono) {
			if (value === undefined || value === null || value === "") return null;
			return [
				React.createElement("div", { className: "dsh-weixin-key", key: key }, key),
				React.createElement("div", {
					className: "dsh-weixin-val" + (mono === true ? " dsh-weixin-mono" : ""),
					key: key + ":value",
					title: value
				}, value)
			];
		}
		/** Whether the phase still expects the user to scan (or finish verifying). */
		function awaitingUser(phase) {
			return phase === "login-pending" || phase === "scanned" || phase === "verify-required";
		}
		/** Chinese explanation for the reasons the host can refuse a mutation with. */
		const REASON_TEXT = {
			"untrusted-request": "请求未通过本页来源校验，请刷新页面后重试。",
			"invalid-or-inactive-code": "验证码无效或登录已不在等待验证码，请重新发起连接。",
			"no-pending-qr": "当前没有待扫描的二维码，请重新发起连接。",
			"no-credential": "没有已保存的凭证，请点“扫码连接”。",
			"agents-unavailable": "DSH 会话服务不可用，暂时无法开始接收消息。",
			"reconnect-failed": "重新连接失败，请重试或重新扫码。",
			"qr-too-long": "服务端返回的二维码内容过长，无法编码；请重新发起连接。",
			"method-not-allowed": "请求方式不被接受。",
			"internal-error": "插件内部错误，请查看 DSH 日志。",
			"not-found": "该操作不存在。"
		};
		/** One reason code as a sentence a user can act on. */
		function reasonText(reason) {
			const key = String(reason === undefined || reason === null ? "" : reason);
			if (key === "") return "未知原因";
			return REASON_TEXT[key] === undefined ? key : REASON_TEXT[key];
		}
		/**
		 * One guarded mutation. The plugin's own header plus the same-origin POST is
		 * what the host accepts; a cross-site caller cannot forge that pair.
		 */
		async function mutate(path, body) {
			const response = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json", "x-dsh-weixin": "1" },
				body: JSON.stringify(body === undefined ? {} : body),
				cache: "no-store"
			});
			const value = await response.json().catch(() => null);
			return { ok: response.ok, value };
		}
		/** Last successful payload, kept across section open/close so reopening paints at once. */
		let lastStatus = null;
		/** The settings section body: connection state plus the QR-login actions. */
		function WeixinPage() {
			const [state, setState] = React.useState(() => (
				lastStatus === null
					? { phase: "loading", data: null, error: "" }
					: { phase: "ready", data: lastStatus, error: "" }
			));
			const [qr, setQr] = React.useState({ available: false, revision: 0 });
			const [qrFailed, setQrFailed] = React.useState(false);
			const [busy, setBusy] = React.useState(false);
			const [code, setCode] = React.useState("");
			const [notice, setNotice] = React.useState("");
			/** Neutral confirmation text, kept apart from failures so neither is styled as the other. */
			const [info, setInfo] = React.useState("");
			/** Read the host half's status and pending-QR metadata. */
			const load = () => {
				setState((current) => ({ ...current, phase: current.data === null ? "loading" : current.phase }));
				fetch(STATUS_PATH, { headers: { accept: "application/json" }, cache: "no-store" })
					.then((response) => (response.ok ? response.json() : Promise.reject(new Error("HTTP " + response.status))))
					.then((value) => {
						if (value === null || value.ok !== true) {
							setState({ phase: "error", data: null, error: String((value && value.reason) || "unknown") });
							return;
						}
						lastStatus = value;
						setState({ phase: "ready", data: value, error: "" });
					})
					.catch((error) => setState({ phase: "error", data: null, error: String((error && error.message) || error) }));
				fetch(QR_INFO_PATH, { headers: { accept: "application/json" }, cache: "no-store" })
					.then((response) => (response.ok ? response.json() : null))
					.then((value) => { if (value !== null && value.ok === true) setQr({ available: value.qrAvailable === true, revision: Number(value.qrRevision) || 0 }); })
					.catch(() => {});
			};
			React.useEffect(() => {
				load();
				const timer = setInterval(load, POLL_MS);
				return () => { clearInterval(timer); };
			}, []);
			/* A new QR is a new image: clear the previous load failure with it. */
			React.useEffect(() => { setQrFailed(false); }, [qr.revision]);
			/** Run one guarded mutation, reporting its outcome in the page. */
			const run = (path, body, done) => {
				setBusy(true);
				setNotice("");
				setInfo("");
				mutate(path, body)
					.then((result) => {
						if (!result.ok) {
							setNotice("操作未生效：" + reasonText(result.value && result.value.reason));
							return;
						}
						if (done !== undefined) done(result);
						load();
					})
					.catch((error) => setNotice("请求失败：" + String((error && error.message) || error)))
					.finally(() => setBusy(false));
			};
			const data = state.data;
			if (state.phase === "error" && data === null) {
				return React.createElement("div", { className: "dsh-weixin-page" },
					React.createElement("div", { className: "dsh-weixin-error" }, "连接状态读取失败：" + state.error),
					React.createElement("button", { type: "button", className: "dsh-weixin-btn", onClick: load }, "重试")
				);
			}
			if (data === null) {
				return React.createElement("div", { className: "dsh-weixin-page" },
					React.createElement("div", { className: "dsh-weixin-loading" }, "正在读取微信连接状态…")
				);
			}
			const pending = awaitingUser(data.phase);
			return React.createElement("div", { className: "dsh-weixin-page" },
				React.createElement("div", { className: "dsh-weixin-card" },
					React.createElement("div", { className: "dsh-weixin-head" },
						React.createElement("div", null,
							React.createElement("div", { className: "dsh-weixin-title" }, "微信连接"),
							React.createElement("div", { className: "dsh-weixin-desc" },
								"连接由 DSH 服务托管：仅在 DSH 运行且本插件启用时收发微信消息，浏览器关闭不影响连接。")
						),
						React.createElement("div", { className: "dsh-weixin-phase" },
							React.createElement("span", { className: phaseClass(data.phase) }),
							phaseText(data.phase)
						)
					),
					React.createElement("div", { className: "dsh-weixin-grid" },
						row("账号", data.account),
						row("绑定会话", data.boundSession),
						row("工作目录", data.boundCwd, true),
						row("模型", data.model),
						row("待执行队列", String(data.queueCount) + " 项"),
						row("定时任务", String(data.scheduleCount) + " 项"),
						row("最近错误", data.lastError)
					),
					React.createElement("div", { className: "dsh-weixin-actions" },
						data.phase === "connected"
							? React.createElement("button", {
								type: "button",
								className: "dsh-weixin-btn",
								disabled: busy,
								onClick: () => run(DISCONNECT_PATH, {}, () => setInfo("已断开连接：停止收发但保留凭证（可用“重新连接”恢复）。正在运行的任务不会被取消，其后续结果不会再发送到微信；已排队任务保留在会话队列中。"))
							}, "断开连接")
							: null,
						/* A stored credential reconnects without another scan; the scan stays
						 * available for the case where that credential is no longer accepted. */
						data.phase !== "connected" && data.account !== ""
							? React.createElement("button", {
								type: "button",
								className: "dsh-weixin-btn primary",
								disabled: busy,
								onClick: () => run(RECONNECT_PATH, {}, undefined)
							}, "重新连接")
							: null,
						data.phase !== "connected"
							? React.createElement("button", {
								type: "button",
								className: "dsh-weixin-btn" + (data.account === "" ? " primary" : ""),
								disabled: busy,
								onClick: () => run(LOGIN_START_PATH, {}, undefined)
							}, data.account === "" ? "扫码连接" : "重新扫码")
							: null,
						data.account === "" ? null : React.createElement("button", {
							type: "button",
							className: "dsh-weixin-btn",
							disabled: busy,
							onClick: () => run(LOGOUT_PATH, {}, undefined)
						}, "退出登录"),
						pending
							? React.createElement("button", {
								type: "button",
								className: "dsh-weixin-btn",
								disabled: busy,
								onClick: () => run(LOGIN_CANCEL_PATH, {}, undefined)
							}, "取消登录")
							: null
					),
					pending && qr.available
						? React.createElement("div", { className: "dsh-weixin-qr" },
							qrFailed
								? React.createElement("div", { className: "dsh-weixin-error" },
									"二维码生成失败（内容过长或服务端返回异常），请点“取消登录”后重新发起连接。")
								: React.createElement("img", {
									src: QR_SVG_PATH + "?rev=" + qr.revision,
									alt: "微信登录二维码",
									width: 216,
									height: 216,
									onError: () => setQrFailed(true)
								}),
							React.createElement("div", { className: "dsh-weixin-qr-hint" },
								data.phase === "verify-required"
									? "二维码已扫描，请在手机上查看并在下方输入验证码。"
									: "请用微信扫描二维码完成连接；二维码会过期并自动刷新。")
						)
						: null,
					pending && qr.available && data.phase === "verify-required"
						? React.createElement("div", { className: "dsh-weixin-field" },
							React.createElement("input", {
								className: "dsh-weixin-input",
								inputMode: "numeric",
								placeholder: "验证码",
								value: code,
								maxLength: 8,
								onChange: (event) => setCode(event.target.value.replace(/\D/g, ""))
							}),
							React.createElement("button", {
								type: "button",
								className: "dsh-weixin-btn primary",
								disabled: busy || code.length < 4,
								onClick: () => run(LOGIN_VERIFY_PATH, { code: code }, () => setCode(""))
							}, "提交验证码")
						)
						: null,
					notice === "" ? null : React.createElement("div", { className: "dsh-weixin-error", style: { marginTop: "12px" } }, notice),
					info === "" ? null : React.createElement("div", { className: "dsh-weixin-note", style: { marginTop: "12px" } }, info),
					data.phase === "error" && data.lastError !== ""
						? React.createElement("div", { className: "dsh-weixin-note", style: { marginTop: "12px" } },
							"可点击“扫码连接”重新发起；同一时间只有一个登录实例。")
						: null
				),
				React.createElement("div", { className: "dsh-weixin-card" },
					React.createElement("div", { className: "dsh-weixin-warn" },
						React.createElement("div", null,
							React.createElement("strong", null, "完全权限提示："),
							"微信提交的任务按完全权限执行，可修改 DSH 所在机器的文件并执行命令，且不逐项请求审批。"
						),
						React.createElement("div", null, "仅已扫码绑定的本人私聊可使用；群聊与其他联系人一律不处理。"),
						React.createElement("div", null, "会话切换、目录选择、任务与队列控制、定时任务、模型与用量查询均在微信中用命令完成（发送 /help 查看）。")
					)
				)
			);
		}
		/**
		 * Client half body: one settings section plus its stylesheet. Both
		 * registrations are Cordis effects/scoped registrations, so disabling the
		 * plugin removes the seat and the styles with no residue.
		 * @param ctx - client context carrying the slot registry.
		 */
		function apply(ctx) {
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => { tag.remove(); };
			}, "channel-weixin: settings stylesheet");
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "weixin", order: 35, label: "\u5FAE\u4FE1\u8FDE\u63A5" },
				() => React.createElement(WeixinPage, null),
			));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
