/**
 * Inbound dispatch: classify one WeChat message and carry out the command it
 * names, returning the text to reply with.
 *
 * This layer is where the plan's binding rules are enforced:
 *
 * - A command that fails (unknown directory, missing session, ambiguous short id,
 *   failed creation) replies with the reason and leaves the stored binding
 *   exactly as it was; a new binding is written only after the session exists.
 * - Binding is per peer, so two WeChat senders cannot steer each other's session.
 * - Task text is returned to the caller rather than submitted here: submission
 *   belongs to the same pipeline that correlates replies with a request id.
 *
 * Every dependency is injected, so the whole flow is unit-testable offline.
 */

import { helpText, parseInbound } from './commands.js';
import { createSession, listSessions, useSession } from './sessions.js';
import { queueSnapshot, removeQueued, resumeQueue, stopTask, viewQueue } from './queue.js';
import { TIME_FORMAT_NOTE, describeEntry, parseWhen, splitWhen, timeZoneLabel } from './schedule.js';
import { currentSelection, listModels, resolveModelToken, selectModel } from './model.js';
import { searchHistory, sessionUsage } from './usage.js';

/** Commands this build answers but has not implemented yet, with their stage. */
const DEFERRED = {};

/** One line describing a session, marked when it is the peer's current binding. */
function sessionLine(session, boundId) {
	const marker = session.id === boundId ? '* ' : '  ';
	const where = session.cwd === '' ? '' : ` · ${session.cwd}`;
	const state = session.live ? '' : ' · 未运行';
	return `${marker}${session.shortId}${where}${state}`;
}

/**
 * Handle one inbound message.
 *
 * @param options - peer identity, raw text, storage root, and the DSH services
 *   (`agents`, `permissionPresets`, and an optional `persistence`) plus the
 *   storage helpers.
 * @returns one of:
 *   `{ action: 'ignore' }` for empty input,
 *   `{ action: 'task', text }` for text that belongs to DSH,
 *   `{ action: 'reply', text, bindPeer? }` for a command answer (a binding was
 *   written by this call when `bound` is true).
 */
async function handleInbound({ text, peer, root, agents, permissionPresets, persistence, storage, now = Date.now, services = {} }) {
	const parsed = parseInbound(text);
	if (parsed.kind === 'empty') return { action: 'ignore' };
	if (parsed.kind === 'too-long') {
		return { action: 'reply', text: `消息过长（${parsed.length} 字符），请拆分后再发送。` };
	}
	if (parsed.kind === 'task') return { action: 'task', text: parsed.text };
	if (parsed.kind === 'unknown-command') {
		return { action: 'reply', text: `未知命令 /${parsed.name}。\n\n${helpText()}` };
	}
	if (parsed.missingArgs === true) {
		return { action: 'reply', text: `命令缺少参数：${parsed.usage}` };
	}
	const bindings = storage.readBindings(root);
	const binding = bindings[peer];
	/* The model and usage commands need the same `agents` service the caller passed. */
	const effective = { ...services, agents };
	switch (parsed.name) {
		case 'help':
			return { action: 'reply', text: helpText() };
		case 'sessions': {
			const sessions = await listSessions({ agents, persistence });
			if (sessions.length === 0) return { action: 'reply', text: '当前没有可切换的会话。用 /new <绝对目录> 新建一个。' };
			const lines = sessions.map((session) => sessionLine(session, binding?.sessionId));
			return {
				action: 'reply',
				text: ['可切换的会话（* 为当前绑定，使用 /use <短ID> 切换）：', ...lines].join('\n'),
			};
		}
		case 'cwd': {
			if (binding === undefined) return { action: 'reply', text: '尚未绑定会话。用 /new <绝对目录> 新建，或 /sessions 查看后 /use 切换。' };
			return {
				action: 'reply',
				text: `当前绑定：${binding.sessionId}\n工作目录：${binding.cwd === '' ? '（未知）' : binding.cwd}`,
			};
		}
		case 'new': {
			const cwd = parsed.args.join(' ');
			const created = await createSession({
				agents,
				permissionPresets,
				agentPresets: effective.agentPresets,
				agentDefaultModel: effective.agentDefaultModel,
				cwd,
			});
			if (!created.ok) return { action: 'reply', text: createFailureText(created, cwd) };
			storage.writeBinding(root, peer, { sessionId: created.session.id, cwd: created.session.cwd });
			return {
				action: 'reply',
				bound: true,
				text: [
					`已新建并绑定会话：${created.session.shortId}`,
					`工作目录：${created.session.cwd}`,
					`Agent 模式：${created.agentPreset}（默认标准模式）`,
					created.fullAccess === true ? '权限：完全权限（文件不限制、不逐项审批）' : '权限：未能应用完全权限预设，请检查权限插件',
				].join('\n'),
			};
		}
		case 'use': {
			const token = parsed.args.join(' ');
			const used = await useSession({
				agents,
				permissionPresets,
				agentPresets: effective.agentPresets,
				agentDefaultModel: effective.agentDefaultModel,
				persistence,
				token,
			});
			if (!used.ok) return { action: 'reply', text: useFailureText(used) };
			storage.writeBinding(root, peer, { sessionId: used.session.id, cwd: used.session.cwd });
			return {
				action: 'reply',
				bound: true,
				text: [
					`已切换到会话：${used.session.shortId}`,
					`工作目录：${used.session.cwd === '' ? '（未知）' : used.session.cwd}`,
					'权限：已为该会话应用完全权限预设。',
					used.resumed === true ? '（该会话此前未运行，已恢复）' : '',
				].filter((line) => line !== '').join('\n'),
			};
		}
		case 'stop': {
			if (binding === undefined) return { action: 'reply', text: NO_BINDING_FOR_CONTROL };
			const stopped = stopTask({ agents, sessionId: binding.sessionId });
			if (!stopped.ok) return { action: 'reply', text: controlFailureText(stopped, '停止') };
			return {
				action: 'reply',
				paused: true,
				text: [
					stopped.wasRunning ? '已请求取消当前任务。' : '当前没有正在运行的任务。',
					`待执行队列保留 ${stopped.pending} 项，已暂停。`,
					'取消不等于回滚：已修改的文件和已发出的请求不会自动恢复。',
					'用 /queue 查看待执行项，/queue resume 继续。',
				].join('\n'),
			};
		}
		case 'queue': {
			if (binding === undefined) return { action: 'reply', text: NO_BINDING_FOR_CONTROL };
			const [subcommand = '', ...rest] = parsed.args;
			if (subcommand === '') {
				const view = viewQueue({ agents, sessionId: binding.sessionId });
				if (!view.ok) return { action: 'reply', text: controlFailureText(view, '查看队列') };
				if (view.pending === 0) {
					return { action: 'reply', text: view.running ? '当前任务正在运行，队列为空。' : '队列为空。' };
				}
				const lines = view.items.map((item, index) => `${index + 1}. ${item.id} · ${item.preview}`);
				return {
					action: 'reply',
					text: [
						view.running ? '当前任务正在运行。' : '当前没有运行中的任务（队列已暂停）。',
						`待执行 ${view.pending} 项：`,
						...lines,
						'用 /queue remove <任务ID> 删除，/queue resume 继续。',
					].join('\n'),
				};
			}
			if (subcommand === 'remove') {
				const itemId = rest.join(' ').trim();
				const removed = removeQueued({ agents, sessionId: binding.sessionId, itemId });
				if (!removed.ok) {
					if (removed.reason === 'item-not-pending') {
						return { action: 'reply', text: `该任务不在待执行队列中（可能已开始执行）。当前待执行 ${removed.pending} 项。` };
					}
					return { action: 'reply', text: controlFailureText(removed, '删除队列项') };
				}
				/* The id is echoed so the caller can retire that task's tracker: it will
				 * never run, and waiting for its turn would only surface a timeout later. */
				return { action: 'reply', removedItemId: itemId, text: `已删除，剩余待执行 ${removed.pending} 项。` };
			}
			if (subcommand === 'resume') {
				const resumed = resumeQueue({ agents, sessionId: binding.sessionId });
				if (!resumed.ok) return { action: 'reply', text: controlFailureText(resumed, '继续队列') };
				const lines = {
					woken: '已继续执行队列。',
					'existing-running': '任务已在运行，无需继续。',
					already_running: '任务已在运行，无需继续。',
					'empty': '队列为空，没有需要继续的任务。',
					deferred: '已解除暂停；队列会在本会话下一次被唤醒时继续。',
				};
				return { action: 'reply', resumed: true, text: lines[resumed.outcome] ?? '已解除暂停。' };
			}
			return { action: 'reply', text: '用法：/queue、/queue remove <任务ID>、/queue resume' };
		}
		case 'schedule':
			return handleScheduleCommand({ parsed, binding, peer, root, storage, agents, now });
		case 'agents':
			return await handleAgents({ binding, services: effective });
		case 'agent':
			return await handleAgentCommand({ parsed, binding, services: effective });
		case 'models':
			return handleModels({ llm: effective.llm, agentDefaultModel: effective.agentDefaultModel });
		case 'model':
			return handleModelCommand({ parsed, binding, services: effective });
		case 'usage':
			return handleUsage({ binding, services: effective });
		case 'search':
			return await handleSearch({ parsed, services: effective });
		default: {
			const stage = DEFERRED[parsed.name];
			return {
				action: 'reply',
				text: stage === undefined
					? `命令 ${parsed.usage} 尚不可用。`
					: `${parsed.usage} 属于「${stage}」阶段，尚未实现；当前可用：\n\n${helpText()}`,
			};
		}
	}
}

/** Reply used when a control command needs a bound session first. */
const NO_BINDING_FOR_CONTROL = '尚未绑定 DSH 会话，无法执行该命令。用 /new <绝对目录> 新建，或 /sessions 查看后 /use <短ID> 切换。';

/** Reply text for one failed control operation. */
function controlFailureText(failure, action) {
	switch (failure.reason) {
		case 'session-not-live':
			return `绑定的会话当前未运行，${action}不可用；请先 /use 重新选择会话。`;
		case 'cancel-failed':
			return `取消失败：${failure.detail}`;
		case 'remove-failed':
			return `删除队列项失败：${failure.detail}`;
		case 'wake-failed':
			return `继续队列失败：${failure.detail}`;
		case 'item-id-missing':
			return '请提供任务 ID：/queue remove <任务ID>（可用 /queue 查看）。';
		default:
			return `${action}未完成（${failure.reason}）。`;
	}
}

/**
 * `/schedule` subcommands. Times are explicit and always shown with the timezone
 * and the next trigger; a listing also reports how many triggers were missed
 * while DSH was not running.
 */
function handleScheduleCommand({ parsed, binding, peer, root, storage, agents, now }) {
	const [subcommand = '', ...rest] = parsed.args;
	const document = storage.readSchedules(root);
	if (subcommand === '' || subcommand === 'list') {
		if (document.entries.length === 0) {
			return { action: 'reply', text: `没有定时任务。\n${TIME_FORMAT_NOTE}\n用法：/schedule add +30m <任务>` };
		}
		const mine = document.entries.filter((entry) => entry.peer === peer);
		if (mine.length === 0) return { action: 'reply', text: '没有属于你的定时任务。' };
		return {
			action: 'reply',
			text: [`定时任务（时区 ${timeZoneLabel(now(), undefined)}）：`, ...mine.map(describeEntry), '', TIME_FORMAT_NOTE].join('\n'),
		};
	}
	if (subcommand === 'remove') {
		const id = rest.join(' ').trim();
		if (id === '') return { action: 'reply', text: '用法：/schedule remove <任务ID>（可用 /schedule list 查看）。' };
		const removed = document.entries.find((entry) => entry.id === id && entry.peer === peer);
		if (removed === undefined) return { action: 'reply', text: `没有找到你的定时任务：${id}` };
		const remaining = document.entries.filter((entry) => entry !== removed);
		storage.writeSchedules(root, { nextId: document.nextId, entries: remaining });
		/* Removing the plan does not recall an occurrence that is already queued, so
		 * say exactly which one still runs and how to cancel it. Use the plan's
		 * original session because the peer may have switched bindings since firing. */
		const agent = agents?.get?.(removed.sessionId);
		const prefix = `${id}#`;
		const pending = queueSnapshot(agent).items.map((item) => item.id).filter((itemId) => itemId.startsWith(prefix));
		if (pending.length === 0) return { action: 'reply', text: `已删除定时任务 ${id}。` };
		return {
			action: 'reply',
			text: [
				`已删除定时任务 ${id}。`,
				`但本次已排队的执行仍会运行：${pending.join('、')}`,
				`如需取消，请发送 /queue remove ${pending[0]}`,
			].join('\n'),
		};
	}
	if (subcommand === 'add') {
		if (binding === undefined) return { action: 'reply', text: NO_BINDING_FOR_CONTROL };
		const split = splitWhen(rest);
		if (split.error !== undefined) return { action: 'reply', text: scheduleUsageText(split.error) };
		const when = parseWhen(split.whenTokens, now());
		if (when.ok !== true) return { action: 'reply', text: scheduleUsageText(when.reason) };
		const id = `sched-${document.nextId}`;
		const entry = {
			id,
			peer,
			sessionId: binding.sessionId,
			cwd: binding.cwd ?? '',
			text: split.text,
			kind: when.kind,
			at: when.at ?? 0,
			everyMs: when.everyMs ?? 0,
			nextAt: when.at ?? 0,
			timeZone: timeZoneLabel(now(), undefined),
			createdAt: now(),
			sequence: 0,
			runs: 0,
			missed: 0,
			lastOutcome: '',
			lastRunAt: 0,
		};
		storage.writeSchedules(root, { nextId: document.nextId + 1, entries: [...document.entries, entry] });
		return {
			action: 'reply',
			text: [
				`已创建定时任务 ${id}：${when.label}`,
				`时区：${entry.timeZone}`,
				`绑定会话：${binding.sessionId}`,
				`任务：${split.text}`,
				'仅在 DSH 服务运行期间触发；停机错过的触发会标记为"已错过"，不会补跑。',
			].join('\n'),
		};
	}
	return { action: 'reply', text: '用法：/schedule add <时间> <任务>、/schedule list、/schedule remove <任务ID>' };
}

/** Usage text for one rejected time expression, naming the accepted forms. */
function scheduleUsageText(reason) {
	const accepted = [
		'时间必须显式给出，支持：',
		'+30m / +2h（相对现在）、09:30（今天或明天的该时刻）、2026-01-02 09:30（绝对时刻）、',
		'daily 09:30（每天）、every 30m / every 2h（固定间隔）。',
		TIME_FORMAT_NOTE,
	].join('\n');
	const detail = reason === 'task-missing' ? '缺少任务内容。' : reason === 'when-missing' ? '缺少时间。' : `无法解析该时间（${reason}）。`;
	return `${detail}\n\n${accepted}`;
}

/** Current Agent preset from the durable projection, falling back to the creation header. */
function currentAgentPreset(agent, sessionProjections) {
	if (agent?.session === undefined) return '';
	try {
		const projected = sessionProjections?.stateOf?.(agent.session, 'agentPreset');
		if (typeof projected === 'string' && projected !== '') return projected;
	} catch {
		/* Fall through to the immutable creation header. */
	}
	return typeof agent.session.header?.agentPreset === 'string' ? agent.session.header.agentPreset : '';
}

/** `/agents`: list available DSH Agent presets and mark default/current. */
async function handleAgents({ binding, services }) {
	const presets = services.agentPresets;
	if (presets === undefined || typeof presets.list !== 'function') return { action: 'reply', text: 'Agent 模式服务不可用。' };
	let entries;
	try {
		entries = await presets.list();
	} catch (error) {
		return { action: 'reply', text: `Agent 模式列表读取失败：${String(error?.message ?? error)}` };
	}
	const agent = binding === undefined ? undefined : services.agents?.get?.(binding.sessionId);
	const current = currentAgentPreset(agent, services.sessionProjections);
	const lines = (Array.isArray(entries) ? entries : []).map((entry) => {
		const marks = [entry.id === presets.defaultId ? '默认' : '', entry.id === current ? '当前' : '', entry.broken ? '不可用' : ''].filter(Boolean);
		const name = typeof entry.name === 'string' && entry.name !== '' ? ` · ${entry.name}` : '';
		const description = typeof entry.description === 'string' && entry.description !== '' ? `\n  ${entry.description}` : '';
		return `${marks.length > 0 ? `[${marks.join('、')}] ` : ''}${entry.id}${name}${description}`;
	});
	if (lines.length === 0) return { action: 'reply', text: '没有可用的 Agent 模式。' };
	return { action: 'reply', text: ['Agent 模式：', ...lines, '', '切换：/agent <模式ID>（仅空白会话可切换）'].join('\n') };
}

/** `/agent [ID]`: inspect or switch the bound blank session's Agent preset. */
async function handleAgentCommand({ parsed, binding, services }) {
	if (binding === undefined) return { action: 'reply', text: NO_BINDING_FOR_CONTROL };
	const agent = services.agents?.get?.(binding.sessionId);
	if (agent === undefined) return { action: 'reply', text: '绑定的会话当前未运行，无法读取或切换 Agent 模式。' };
	const current = currentAgentPreset(agent, services.sessionProjections);
	const token = parsed.args.join(' ').trim();
	if (token === '') {
		return { action: 'reply', text: current === '' ? '当前 Agent 模式未知。用 /agents 查看可选模式。' : `当前 Agent 模式：${current}\n用 /agents 查看，/agent <模式ID> 切换。` };
	}
	if (services.agentPresets === undefined || typeof services.agentPresets.select !== 'function') return { action: 'reply', text: 'Agent 模式服务不可用。' };
	try {
		const selected = await services.agentPresets.select(agent, token);
		return { action: 'reply', text: `已切换 Agent 模式：${selected}。\n工具与系统提示已按该模式加载。` };
	} catch (error) {
		const detail = String(error?.message ?? error);
		return { action: 'reply', text: `Agent 模式切换失败：${detail}\n只有尚未产生对话内容的空白会话可以切换模式。` };
	}
}

/** `/models`: the configured catalogue, grouped by provider. */
async function handleModels({ llm, agentDefaultModel }) {
	if (llm === undefined) return { action: 'reply', text: '当前部署没有可用的模型服务，无法列出模型。' };
	const catalogue = await listModels({ llm, agentDefaultModel });
	if (catalogue.providers.length === 0) {
		const detail = catalogue.failures.length === 0 ? '' : `\n失败原因：${catalogue.failures.map((entry) => `${entry.provider}：${entry.reason}`).join('；')}`;
		return { action: 'reply', text: `没有可用的模型。${detail}` };
	}
	const lines = [];
	for (const provider of catalogue.providers) {
		lines.push(`${provider.name}（${provider.id}）`);
		lines.push(provider.models.length === 0 ? '  （无可用模型）' : provider.models.map((model) => `  ${model}`).join('\n'));
	}
	if (catalogue.failures.length > 0) lines.push(`部分提供商枚举失败：${catalogue.failures.map((entry) => entry.provider).join('、')}`);
	lines.push('');
	lines.push(catalogue.default === undefined ? '切换：/model <模型ID> 或 /model <提供商>/<模型ID>' : `部署默认：${catalogue.default.provider}/${catalogue.default.model}`);
	lines.push('切换只影响当前绑定会话，从下一条任务生效，不打断正在运行的任务。');
	return { action: 'reply', text: ['可用模型：', ...lines].join('\n') };
}

/** `/model <ID>`: switch the bound session's model. */
function handleModelCommand({ parsed, binding, services }) {
	if (binding === undefined) return { action: 'reply', text: NO_BINDING_FOR_CONTROL };
	const agent = services.agents?.get?.(binding.sessionId);
	if (agent === undefined) return { action: 'reply', text: `绑定的会话当前未运行，无法切换模型；请先 /use 重新选择会话。` };
	const token = parsed.args.join(' ').trim();
	if (token === '') {
		const active = currentSelection({ sessionProjections: services.sessionProjections, session: agent.session });
		return {
			action: 'reply',
			text: active === undefined
				? '用法：/model <模型ID>（可用 /models 查看）'
				: `当前模型：${active.provider}/${active.model}\n用法：/model <模型ID>（可用 /models 查看）`,
		};
	}
	return (async () => {
		const catalogue = await listModels({ llm: services.llm, agentDefaultModel: services.agentDefaultModel });
		const resolved = resolveModelToken(catalogue.providers, token);
		if (resolved.ok !== true) {
			const candidates = resolved.candidates ?? [];
			const hint = candidates.length === 0 ? '' : `\n可选：${candidates.slice(0, 10).join('、')}`;
			const detail = resolved.reason === 'ambiguous'
				? `模型 ID 不唯一，请写全 <提供商>/<模型ID>：${candidates.join('、')}`
				: resolved.reason === 'provider-unknown'
					? `未知提供商：${token}${hint}`
					: `没有该模型：${token}${hint}`;
			return { action: 'reply', text: detail };
		}
		const selected = selectModel({ agent, selection: resolved.selection });
		if (selected.ok !== true) return { action: 'reply', text: `切换失败（${selected.reason}）：${selected.detail ?? ''}` };
		return {
			action: 'reply',
			text: `已切换到 ${selected.selection.provider}/${selected.selection.model}。\n从下一条任务生效，当前任务不受影响；已排队与定时任务在实际执行时使用该选择。`,
		};
	})();
}

/** `/usage`: the bound session's token totals. */
function handleUsage({ binding, services }) {
	if (binding === undefined) return { action: 'reply', text: NO_BINDING_FOR_CONTROL };
	const agent = services.agents?.get?.(binding.sessionId);
	if (agent === undefined) return { action: 'reply', text: '绑定的会话当前未运行，无法读取用量；请先 /use 重新选择会话。' };
	const usage = sessionUsage({ sessionProjections: services.sessionProjections, session: agent.session });
	if (usage.ok !== true) {
		const detail = usage.reason === 'no-usage-yet' ? '本会话还没有已结算的用量。' : `用量不可用（${usage.reason}）。`;
		return { action: 'reply', text: `${detail}\n本版本只提供当前绑定会话的用量；跨会话汇总不可用。` };
	}
	return { action: 'reply', text: usage.text };
}

/** `/search <关键词>`: paged, authorized keyword search over conversation text. */
async function handleSearch({ parsed, services }) {
	const query = parsed.args.join(' ').trim();
	if (query === '') return { action: 'reply', text: '用法：/search <关键词>' };
	const result = await searchHistory({ sessionQuery: services.sessionQuery, query });
	if (result.ok !== true) {
		const detail = result.reason === 'search-unavailable'
			? '当前部署未启用会话检索（缺少会话检索服务）。'
			: result.reason === 'stale-cursor'
				? '检索游标已失效，请重新搜索。'
				: `检索失败（${result.reason}）：${result.detail ?? ''}`;
		return { action: 'reply', text: detail };
	}
	if (result.items.length === 0) return { action: 'reply', text: `没有找到包含「${query}」的对话文字。` };
	const lines = result.items.map((item, index) => `${index + 1}. ${item.shortId}${item.cwd === '' ? '' : ` · ${item.cwd}`}\n   ${item.snippet.replace(/\s+/g, ' ')}`);
	const more = result.nextCursor === '' ? '' : '\n（结果已截断，可缩小关键词继续检索。）';
	return {
		action: 'reply',
		text: [`包含「${query}」的对话（仅当前可见的对外文字）：`, ...lines, more].filter((line) => line !== '').join('\n'),
	};
}

/** Reply text for one failed creation, naming the directory problem precisely. */
function createFailureText(failure, cwd) {
	switch (failure.reason) {
		case 'cwd-empty':
			return '目录为空。请提供 DSH 所在机器上的绝对目录，例如 Windows 的 C:\\work\\项目 或 Linux 的 /home/you/project。';
		case 'cwd-not-absolute':
			return `目录必须是绝对路径：${cwd}\n（目录是 DSH 服务所在机器的路径，不是手机或浏览器本地路径。）`;
		case 'cwd-missing':
			return `目录不存在或不可访问：${cwd}`;
		case 'cwd-not-a-directory':
			return `这不是一个目录：${cwd}`;
		case 'create-failed':
			return `会话创建失败，原绑定未改变。原因：${failure.detail}`;
		case 'permission-unavailable':
			return '完全权限服务不可用，未创建会话，原绑定未改变。';
		case 'model-unavailable':
			return `默认模型不可用，未创建会话，原绑定未改变。原因：${failure.detail}`;
		case 'agent-preset-unavailable':
			return 'Agent 模式服务不可用，未创建会话，原绑定未改变。';
		case 'composition-unavailable':
			return `默认 Agent 模式加载失败，未创建会话，原绑定未改变。原因：${failure.detail}`;
		case 'permission-failed':
			return `会话已创建，但完全权限预设应用失败：${failure.detail}`;
		default:
			return `操作未完成（${failure.reason}），原绑定未改变。`;
	}
}

/** Reply text for one failed switch. */
function useFailureText(failure) {
	switch (failure.reason) {
		case 'not-found':
			return '没有找到该会话。用 /sessions 查看可切换的会话。';
		case 'ambiguous':
			return `短 ID 不唯一（${failure.matches.join('、')}），请使用完整会话 ID。`;
		case 'no-token':
			return '请提供会话 ID：/use <会话ID>（可用 /sessions 查看）。';
		case 'not-live':
			return '该会话未在运行，且当前无法恢复；请先在 DSH 中打开它。';
		case 'resume-failed':
			return `恢复会话失败，原绑定未改变。原因：${failure.detail}`;
		case 'permission-unavailable':
			return '完全权限服务不可用，原绑定未改变。';
		case 'agent-preset-unavailable':
			return 'Agent 模式服务不可用，原绑定未改变。';
		case 'model-unavailable':
			return `模型配置不可用，原绑定未改变。原因：${failure.detail}`;
		case 'permission-failed':
			return `完全权限预设应用失败，原绑定未改变。原因：${failure.detail}`;
		default:
			return `切换失败（${failure.reason}），原绑定未改变。`;
	}
}

export {
	DEFERRED, NO_BINDING_FOR_CONTROL, createFailureText, currentAgentPreset, handleAgentCommand,
	handleAgents, handleInbound, handleModelCommand, handleModels, handleScheduleCommand, handleSearch, handleUsage, scheduleUsageText,
	sessionLine, useFailureText,
};
