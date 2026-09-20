/**
 * Inbound text classification and command parsing.
 *
 * The plan is explicit that control commands are parsed by this plugin rather
 * than guessed by the model, so classification happens before anything reaches
 * DSH. Two rules matter for correctness:
 *
 * - `/name ...` is a command only when `name` is one this build implements.
 *   Anything else is refused as an unknown command instead of being forwarded to
 *   the model: a mistyped `/stpo` must not become a prompt, and §3.5 requires
 *   the plugin — not the model — to decide what a control instruction means.
 * - `//text` is the escape hatch: it is delivered as the literal task `/text`,
 *   which is the documented way to send a message that starts with a slash
 *   (for example a `/etc/hosts` question).
 */

/** Commands this build implements, with their minimum argument count. */
const COMMANDS = {
	help: { args: 0, usage: '/help' },
	sessions: { args: 0, usage: '/sessions' },
	new: { args: 1, usage: '/new <绝对目录>' },
	use: { args: 1, usage: '/use <会话ID>' },
	cwd: { args: 0, usage: '/cwd' },
	stop: { args: 0, usage: '/stop' },
	queue: { args: 0, usage: '/queue [remove <任务ID>|resume]' },
	agents: { args: 0, usage: '/agents' },
	agent: { args: 0, usage: '/agent [<模式ID>]' },
	models: { args: 0, usage: '/models' },
	model: { args: 0, usage: '/model [<ID>]' },
	usage: { args: 0, usage: '/usage' },
	search: { args: 1, usage: '/search <关键词>' },
	schedule: { args: 0, usage: '/schedule add|list|remove' },
};

/** Longest accepted inbound text; larger input is refused before it reaches DSH. */
const MAX_TEXT = 4000;

/**
 * Split one command line into its name and arguments.
 * @param line - the text after the leading slash.
 * @returns `{ name, args }` with arguments split on whitespace.
 */
function splitCommand(line) {
	const parts = line.trim().split(/\s+/).filter((part) => part !== '');
	const [name = '', ...args] = parts;
	return { name: name.toLowerCase(), args };
}

/**
 * Classify one inbound message.
 *
 * @param raw - the message text exactly as received.
 * @returns one of:
 *   `{ kind: 'empty' }` for blank input,
 *   `{ kind: 'command', name, args, usage }` for a known command,
 *   `{ kind: 'unknown-command', name }` for a slash token this build does not implement,
 *   `{ kind: 'too-long', length }` beyond {@link MAX_TEXT},
 *   `{ kind: 'task', text }` for everything else (including the `//` escape).
 */
function parseInbound(raw) {
	const text = typeof raw === 'string' ? raw : '';
	const trimmed = text.trim();
	if (trimmed === '') return { kind: 'empty' };
	if (trimmed.length > MAX_TEXT) return { kind: 'too-long', length: trimmed.length };
	if (trimmed.startsWith('//')) return { kind: 'task', text: trimmed.slice(1) };
	if (!trimmed.startsWith('/')) return { kind: 'task', text: trimmed };
	const { name, args } = splitCommand(trimmed.slice(1));
	if (name === '') return { kind: 'task', text: trimmed };
	const spec = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
	if (spec === undefined) return { kind: 'unknown-command', name };
	if (args.length < spec.args) return { kind: 'command', name, args, usage: spec.usage, missingArgs: true };
	return { kind: 'command', name, args, usage: spec.usage };
}

/**
 * The help text listing every command this build implements.
 * @returns one line per command.
 */
function helpText() {
	const names = Object.keys(COMMANDS);
	const lines = names.map((name) => COMMANDS[name].usage);
	return [
		'可用命令：',
		...lines,
		'',
		'以 // 开头可发送以 / 开头的普通文字；其他文字都会作为任务发给绑定的 DSH 会话。',
	].join('\n');
}

/** Pure helpers exercised by the unit tests. */
const testing = { COMMANDS, MAX_TEXT, splitCommand };

export { COMMANDS, MAX_TEXT, helpText, parseInbound, splitCommand, testing };
