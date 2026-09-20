import assert from 'node:assert/strict';
import test from 'node:test';

import { COMMANDS, MAX_TEXT, helpText, parseInbound, splitCommand } from '../lib/commands.js';

test('a plain message is a task', () => {
	assert.deepEqual(parseInbound('帮我看看 README'), { kind: 'task', text: '帮我看看 README' });
	assert.deepEqual(parseInbound('  spaced  '), { kind: 'task', text: 'spaced' });
});

test('a known command parses into a name and arguments', () => {
	const parsed = parseInbound('/new C:\\work\\项目');
	assert.equal(parsed.kind, 'command');
	assert.equal(parsed.name, 'new');
	assert.deepEqual(parsed.args, ['C:\\work\\项目']);
	assert.equal(parsed.usage, '/new <绝对目录>');
});

test('command names are case-insensitive and arguments keep their case', () => {
	const parsed = parseInbound('/USE Session-ABC');
	assert.equal(parsed.name, 'use');
	assert.deepEqual(parsed.args, ['Session-ABC']);
});

test('a command missing its argument is reported with its usage', () => {
	const parsed = parseInbound('/new');
	assert.equal(parsed.kind, 'command');
	assert.equal(parsed.missingArgs, true);
	assert.equal(parsed.usage, '/new <绝对目录>');
});

test('a slash token this build does not implement is refused, never forwarded to the model', () => {
	assert.deepEqual(parseInbound('/etc/hosts 是什么'), { kind: 'unknown-command', name: 'etc/hosts' });
	assert.deepEqual(parseInbound('/stpo'), { kind: 'unknown-command', name: 'stpo' });
	/* The documented escape is how such a message is actually sent. */
	assert.deepEqual(parseInbound('//etc/hosts 是什么'), { kind: 'task', text: '/etc/hosts 是什么' });
});

test('the double slash escape delivers a literal leading slash', () => {
	assert.deepEqual(parseInbound('//help'), { kind: 'task', text: '/help' });
	assert.deepEqual(parseInbound('//new C:\\x'), { kind: 'task', text: '/new C:\\x' });
});

test('blank input is empty rather than a task', () => {
	assert.deepEqual(parseInbound('   '), { kind: 'empty' });
	assert.deepEqual(parseInbound(''), { kind: 'empty' });
	assert.deepEqual(parseInbound(undefined), { kind: 'empty' });
});

test('oversized input is refused before it reaches DSH', () => {
	const parsed = parseInbound('x'.repeat(MAX_TEXT + 1));
	assert.equal(parsed.kind, 'too-long');
	assert.equal(parsed.length, MAX_TEXT + 1);
	assert.equal(parseInbound('x'.repeat(MAX_TEXT)).kind, 'task');
});

test('a bare slash is a task, not an empty command', () => {
	assert.deepEqual(parseInbound('/'), { kind: 'task', text: '/' });
});

test('every documented command in §7.1 is implemented', () => {
	for (const name of ['help', 'sessions', 'new', 'use', 'cwd', 'stop', 'queue', 'agents', 'agent', 'models', 'model', 'usage', 'search', 'schedule']) {
		assert.equal(Object.hasOwn(COMMANDS, name), true, `missing command ${name}`);
	}
});

test('argument splitting collapses whitespace and drops empties', () => {
	assert.deepEqual(splitCommand('  queue   remove    abc  '), { name: 'queue', args: ['remove', 'abc'] });
	assert.deepEqual(splitCommand(''), { name: '', args: [] });
});

test('help lists every command and the escape rule', () => {
	const text = helpText();
	for (const name of Object.keys(COMMANDS)) {
		assert.equal(text.includes(COMMANDS[name].usage), true, `help omits ${name}`);
	}
	assert.equal(text.includes('//'), true);
});
