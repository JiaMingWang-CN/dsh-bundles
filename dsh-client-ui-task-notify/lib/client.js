window.__ModuleLoader__.load({
	id: "dsh-client-ui-task-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const React = react;
		//#region lib/client.js
		/** Toggle-row stylesheet, themed through the shell's alias tokens. */
		const CSS = '.dsh-notify-page{max-width:720px;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary)}' +
			'.dsh-notify-row{display:flex;align-items:center;justify-content:space-between;gap:24px}' +
			'.dsh-notify-title{font-weight:600;font-size:14px}' +
			'.dsh-notify-desc{margin-top:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}' +
			'.dsh-notify-switch{position:relative;box-sizing:border-box;width:40px;height:22px;border-radius:11px;padding:0;cursor:pointer;flex:none;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);transition:background .15s,border-color .15s}' +
			'.dsh-notify-switch.on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}' +
			'.dsh-notify-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-overlay,#fff);box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s}' +
			'.dsh-notify-switch.on .dsh-notify-knob{transform:translateX(18px)}' +
			'.dsh-notify-warn{font-size:12px;color:var(--dsw-alias-state-warn-primary)}' +
			'.dsh-notify-seg{display:flex;gap:8px;flex-wrap:wrap}' +
			'.dsh-notify-segbtn{box-sizing:border-box;padding:4px 12px;border-radius:14px;font-size:12px;cursor:pointer;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);transition:background .15s,border-color .15s,color .15s}' +
			'.dsh-notify-segbtn.on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-overlay,#fff)}';
		/** Stable Cordis plugin name. */
		const name = "ui-task-notify";
		/** The session list store carries running state; slots carry the settings
		 *  seat, configForms the durable toggle storage, uiWorkspace the
		 *  notification click-through. */
		const inject = ["slots", "sessions", "configForms", "uiWorkspace"];
		/** Main sessions only: subagent children carry origin/parentId on their summary. */
		function isMainSession(entry) {
			return entry !== void 0 && entry.origin === void 0 && entry.parentId === void 0;
		}
		/** The session the main view currently shows: the list marks it by
		 *  main-view retention, not by a `current` field. */
		function shownInView(list) {
			return Object.values(list.byId).find((row) => (row?.retainedBy?.mainView ?? 0) > 0)?.id;
		}
		/** Off the DSH interface: tab hidden, minimized, or another window focused. */
		function offScreen() {
			return document.visibilityState !== "visible" || !document.hasFocus();
		}
		/**
		 * Completion-sound presets synthesized with Web Audio: each entry is a
		 * note table ({ freq Hz, at, dur } in seconds) played at fixed unity
		 * gain, so the perceived loudness tracks the OS volume with no private
		 * scaling stage (a volume control here would break that alignment).
		 */
		const SOUNDS = {
			ding: [{ freq: 880, at: 0, dur: 0.35 }],
			chime: [{ freq: 660, at: 0, dur: 0.25 }, { freq: 880, at: 0.18, dur: 0.35 }],
			rise: [{ freq: 523.25, at: 0, dur: 0.18 }, { freq: 659.25, at: 0.12, dur: 0.18 }, { freq: 783.99, at: 0.24, dur: 0.4 }],
		};
		/** Segmented-control options for the settings row. */
		const SOUND_OPTIONS = [
			{ id: "system", label: "\u7CFB\u7EDF\u9ED8\u8BA4" },
			{ id: "ding", label: "\u53EE" },
			{ id: "chime", label: "\u53EE\u54DA" },
			{ id: "rise", label: "\u4E0A\u5347" },
			{ id: "silent", label: "\u9759\u97F3" },
		];
		/** Shared AudioContext; created/resumed on user gestures (selector clicks). */
		let audioCtx;
		/** Ensure the context exists and runs; without a gesture it stays suspended. */
		function ensureAudio() {
			audioCtx ??= new AudioContext();
			if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
			return audioCtx;
		}
		/** Play one synthesized preset; `system`/`silent` never reach here. */
		function playSound(id) {
			const notes = SOUNDS[id];
			if (notes === void 0) return;
			const ctx = ensureAudio();
			const base = ctx.currentTime + 0.02;
			for (const note of notes) {
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.type = "sine";
				osc.frequency.value = note.freq;
				gain.gain.setValueAtTime(1, base + note.at);
				gain.gain.exponentialRampToValueAtTime(0.001, base + note.at + note.dur);
				osc.connect(gain).connect(ctx.destination);
				osc.start(base + note.at);
				osc.stop(base + note.at + note.dur + 0.05);
			}
		}
		/**
		 * Settings page: the toggle row, the sound-selection row (clicking a
		 * segment also previews it — the click doubles as the user gesture that
		 * unlocks Web Audio for later background playback), and a hint when the
		 * browser denied notification permission. Displayed values follow the
		 * durable settings form through the bound configuration scope, never the click echo.
		 */
		function SettingsPage(props) {
			const host = props.host;
			const readEnabled = () => host.getSnapshot().value?.enabled === true;
			const readSound = () => host.getSnapshot().value?.sound ?? "system";
			const [on, setOn] = React.useState(readEnabled);
			const [sound, setSound] = React.useState(readSound);
			const [denied, setDenied] = React.useState(typeof Notification !== "undefined" && Notification.permission === "denied");
			React.useEffect(() => host.subscribe(() => {
				setOn(readEnabled());
				setSound(readSound());
			}), [host]);
			const toggle = () => {
				const next = !on;
				if (next && typeof Notification !== "undefined" && Notification.permission === "default") {
					Notification.requestPermission().then((p) => setDenied(p === "denied")).catch(() => setDenied(true));
				}
				host.set("enabled", next);
				setOn(next);
			};
			const selectSound = (id) => {
				ensureAudio();
				host.set("sound", id);
				setSound(id);
				if (id !== "system" && id !== "silent") playSound(id);
			};
			return React.createElement("div", { className: "dsh-notify-page" },
				React.createElement("div", { className: "dsh-notify-row" },
					React.createElement("div", null,
						React.createElement("div", { className: "dsh-notify-title" }, "\u4F1A\u8BDD\u5B8C\u6210\u901A\u77E5"),
						React.createElement("div", { className: "dsh-notify-desc" }, "\u4E3B\u4F1A\u8BDD\u5B8C\u6210\u4EFB\u52A1\u4E14\u672A\u9009\u4E2D\u8BE5\u4F1A\u8BDD\u6216\u4E0D\u5728\u672C\u754C\u9762\u65F6\uFF0C\u53D1\u9001\u7CFB\u7EDF\u901A\u77E5\uFF1B\u5B50 Agent \u5B8C\u6210\u4E0D\u901A\u77E5\u3002"),
					),
					React.createElement("button", {
						type: "button",
						className: "dsh-notify-switch" + (on ? " on" : ""),
						role: "switch",
						"aria-checked": on ? "true" : "false",
						"aria-label": "\u4F1A\u8BDD\u5B8C\u6210\u901A\u77E5",
						onClick: toggle,
					}, React.createElement("span", { className: "dsh-notify-knob" })),
				),
				React.createElement("div", { className: "dsh-notify-row" },
					React.createElement("div", null,
						React.createElement("div", { className: "dsh-notify-title" }, "\u63D0\u793A\u97F3"),
						React.createElement("div", { className: "dsh-notify-desc" }, "\u5B8C\u6210\u901A\u77E5\u7684\u63D0\u793A\u97F3\uFF1B\u70B9\u9009\u5373\u8BD5\u542C\uFF0C\u54CD\u5EA6\u8DDF\u968F\u7CFB\u7EDF\u97F3\u91CF\u3002"),
					),
					React.createElement("div", { className: "dsh-notify-seg" },
						SOUND_OPTIONS.map((option) => React.createElement("button", {
							key: option.id,
							type: "button",
							className: "dsh-notify-segbtn" + (sound === option.id ? " on" : ""),
							"aria-pressed": sound === option.id ? "true" : "false",
							onClick: () => selectSound(option.id),
						}, option.label)),
					),
				),
				on && denied ? React.createElement("div", { className: "dsh-notify-warn" }, "\u7CFB\u7EDF\u901A\u77E5\u6743\u9650\u5DF2\u88AB\u62D2\u7EDD\uFF0C\u8BF7\u5728\u6D4F\u89C8\u5668\u7AD9\u70B9\u8BBE\u7F6E\u4E2D\u5141\u8BB8\u901A\u77E5\u540E\u91CD\u8BD5\u3002") : null,
			);
		}
		/**
		 * Client plugin body: the completion watcher over the session list store and
		 * the settings.section toggle page.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const host = ctx.configForms.get(name);
			/** Seed from the durable section (undefined while the read is in flight → off). */
			const enabled = { value: host.getSnapshot().value?.enabled === true };
			/** Last-observed running bit per session; the true→false edge arms a notification. */
			const prevRunning = new Map();
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.textContent = CSS;
				document.head.append(tag);
				return () => tag.remove();
			}, "ui-task-notify: styles");
			ctx.effect(() => host.subscribe(() => {
				const section = host.getSnapshot().value;
				if (section !== void 0) enabled.value = section.enabled === true;
			}), "ui-task-notify: settings adoption");
			ctx.effect(() => {
				const sessions = ctx.sessions;
				const snap = sessions.list.getSnapshot();
				for (const id of snap.ids) prevRunning.set(id, snap.byId[id]?.running === true);
				return sessions.list.subscribe(() => {
					const list = sessions.list.getSnapshot();
					for (const id of list.ids) {
						const entry = list.byId[id];
						const now = entry?.running === true;
						const was = prevRunning.get(id);
						prevRunning.set(id, now);
						if (was !== true || now !== false) continue;
						if (!isMainSession(entry)) continue;
						if (!enabled.value) continue;
						if (typeof Notification === "undefined" || Notification.permission !== "granted") continue;
						if (shownInView(list) === id && !offScreen()) continue;
						const sound = host.getSnapshot().value?.sound ?? "system";
						const notification = new Notification("\u4EFB\u52A1\u5B8C\u6210", {
							body: (entry.displayTitle || id) + " \u5DF2\u5B8C\u6210\u5F53\u524D\u4EFB\u52A1",
							tag: "dsh-task-notify-" + id,
							/* Custom or muted: drop the OS sound so it never doubles the synth (or noise). */
							silent: sound !== "system",
						});
						if (sound !== "system" && sound !== "silent") playSound(sound);
						notification.onclick = () => {
							try { ctx.uiWorkspace.openSession(id); } catch (error) { console.error("ui-task-notify: open session failed", error); }
							window.focus();
						};
					}
					for (const id of [...prevRunning.keys()]) if (!list.ids.includes(id)) prevRunning.delete(id);
				});
			}, "ui-task-notify: completion watcher");
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "session-notify", order: 25, label: "\u4EFB\u52A1\u901A\u77E5" },
				() => React.createElement(SettingsPage, { host }),
			));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
