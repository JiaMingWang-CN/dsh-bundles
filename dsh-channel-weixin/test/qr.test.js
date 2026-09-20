import assert from 'node:assert/strict';
import test from 'node:test';

import {
	ECC_FORMAT_BITS, countBits, dataCodewords, encodeQr, formatBits, generatorPolynomial,
	reedSolomon, syndromes, testing, toSvg, versionBits,
} from '../lib/qr.js';

/* ------------------------------------------------------------------ *
 * Independent decoder: reads a matrix back with the specification's own
 * placement rules, so a wrong zigzag, mask, or interleave in the encoder
 * shows up as a round-trip failure rather than agreeing with itself.
 * ------------------------------------------------------------------ */

/** Galois-field tables (duplicated here on purpose: the decoder is independent). */
const GF = (() => {
	const exp = new Uint8Array(512);
	const log = new Uint8Array(256);
	let value = 1;
	for (let index = 0; index < 255; index += 1) {
		exp[index] = value;
		log[value] = index;
		value <<= 1;
		if ((value & 0x100) !== 0) value ^= 0x11d;
	}
	for (let index = 255; index < 512; index += 1) exp[index] = exp[index - 255];
	return { exp, log };
})();

function mul(left, right) {
	return left === 0 || right === 0 ? 0 : GF.exp[GF.log[left] + GF.log[right]];
}

/** Syndromes of one codeword block, computed here rather than imported. */
function blockSyndromes(codewords, ecCount) {
	const out = [];
	for (let index = 0; index < ecCount; index += 1) {
		const alpha = GF.exp[index];
		let value = 0;
		for (const byte of codewords) value = mul(value, alpha) ^ byte;
		out.push(value);
	}
	return out;
}

/** Which modules are function modules (used to skip them when reading data). */
function reservedMap(version) {
	const size = version * 4 + 17;
	const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
	const mark = (x, y) => { if (x >= 0 && x < size && y >= 0 && y < size) reserved[y][x] = true; };
	for (const [left, top] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
		for (let dy = -1; dy <= 7; dy += 1) for (let dx = -1; dx <= 7; dx += 1) mark(left + dx, top + dy);
	}
	for (let index = 0; index < size; index += 1) { mark(6, index); mark(index, 6); }
	const centres = testing.ALIGNMENT_POSITIONS[version];
	for (const cy of centres) {
		for (const cx of centres) {
			if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
			for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) mark(cx + dx, cy + dy);
		}
	}
	for (let index = 0; index <= 8; index += 1) { mark(index, 8); mark(8, index); }
	for (let index = 0; index < 8; index += 1) { mark(size - 1 - index, 8); mark(8, size - 1 - index); }
	if (version >= 7) {
		for (let index = 0; index < 18; index += 1) {
			const a = size - 11 + (index % 3);
			const b = Math.floor(index / 3);
			mark(a, b);
			mark(b, a);
		}
	}
	return reserved;
}

/** Mask predicate, written from the specification's formulas. */
function masked(mask, x, y) {
	switch (mask) {
		case 0: return (x + y) % 2 === 0;
		case 1: return y % 2 === 0;
		case 2: return x % 3 === 0;
		case 3: return (x + y) % 3 === 0;
		case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
		case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
		case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
		case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
		default: throw new Error('bad mask');
	}
}

/** Read the format information (first copy) out of a matrix. */
function readFormat(modules) {
	let bits = 0;
	const read = (index, x, y) => { if (modules[y][x]) bits |= 1 << index; };
	for (let index = 0; index <= 5; index += 1) read(index, index, 8);
	read(6, 7, 8);
	read(7, 8, 8);
	read(8, 8, 7);
	for (let index = 9; index < 15; index += 1) read(index, 8, 14 - index);
	return bits ^ 0x5412;
}

/** Read the version information (top-right block) out of a matrix of version >= 7. */
function readVersion(modules, size) {
	let bits = 0;
	for (let index = 0; index < 18; index += 1) {
		const a = size - 11 + (index % 3);
		const b = Math.floor(index / 3);
		if (modules[b][a]) bits |= 1 << index;
	}
	return bits;
}

/** Full byte-mode decode of a produced matrix, including EC verification. */
function decodeQr(matrix) {
	const { modules, size, version, ecc } = matrix;
	const format = readFormat(modules);
	assert.equal((format >>> 13) & 0b11, ECC_FORMAT_BITS[ecc], 'format info disagrees with the declared level');
	const mask = (format >>> 10) & 0b111;
	assert.equal(mask, matrix.mask, 'format info disagrees with the declared mask');
	const reserved = reservedMap(version);
	const bits = [];
	for (let right = size - 1; right >= 1; right -= 2) {
		/* The vertical timing column is skipped by shifting the pair, exactly as the specification says. */
		if (right === 6) right = 5;
		for (let vert = 0; vert < size; vert += 1) {
			for (let offset = 0; offset < 2; offset += 1) {
				const x = right - offset;
				const upward = ((right + 1) & 2) === 0;
				const y = upward ? size - 1 - vert : vert;
				if (reserved[y][x]) continue;
				bits.push(modules[y][x] !== masked(mask, x, y) ? 1 : 0);
			}
		}
	}
	const codewords = [];
	for (let index = 0; index + 8 <= bits.length; index += 8) {
		let byte = 0;
		for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | bits[index + offset];
		codewords.push(byte);
	}
	const entry = testing.BLOCK_TABLE[version][ecc];
	const groups = entry.length === 3
		? [{ blocks: entry[0], dataPerBlock: entry[1], ecPerBlock: entry[2] }]
		: [{ blocks: entry[0], dataPerBlock: entry[1], ecPerBlock: entry[2] }, { blocks: entry[3], dataPerBlock: entry[4], ecPerBlock: entry[2] }];
	const totalBlocks = groups.reduce((sum, group) => sum + group.blocks, 0);
	const dataBlocks = groups.flatMap((group) => Array.from({ length: group.blocks }, () => []));
	const ecBlocks = Array.from({ length: totalBlocks }, () => []);
	const maxData = Math.max(...groups.map((group) => group.dataPerBlock));
	let cursor = 0;
	for (let index = 0; index < maxData; index += 1) {
		let block = 0;
		for (const group of groups) {
			for (let offset = 0; offset < group.blocks; block += 1, offset += 1) {
				if (index < group.dataPerBlock) dataBlocks[block].push(codewords[cursor++]);
			}
		}
	}
	for (let index = 0; index < groups[0].ecPerBlock; index += 1) {
		for (let block = 0; block < totalBlocks; block += 1) ecBlocks[block].push(codewords[cursor++]);
	}
	for (let block = 0; block < totalBlocks; block += 1) {
		const full = [...dataBlocks[block], ...ecBlocks[block]];
		assert.deepEqual(blockSyndromes(full, groups[0].ecPerBlock), new Array(groups[0].ecPerBlock).fill(0), `block ${block} carries an invalid codeword`);
	}
	const data = dataBlocks.flat();
	const readBits = (value, from, count) => {
		let out = 0;
		for (let index = 0; index < count; index += 1) out = (out << 1) | ((value[from + index] ?? 0) ? 1 : 0);
		return out;
	};
	const stream = data.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((shift) => (byte >>> shift) & 1));
	const mode = readBits(stream, 0, 4);
	assert.equal(mode, 0b0100, 'not byte mode');
	const length = readBits(stream, 4, countBits(version));
	assert.equal(length, matrix.payloadBytes.length, 'length field disagrees with the payload');
	const payload = [];
	for (let index = 0; index < length; index += 1) payload.push(readBits(stream, 4 + countBits(version) + index * 8, 8));
	return { mode, length, payload: Buffer.from(payload), mask, version };
}

/* ------------------------------------------------------------------ *
 * Field and Reed-Solomon properties
 * ------------------------------------------------------------------ */

test('the generator polynomial is monic and vanishes at every alpha power', () => {
	for (const degree of [7, 10, 13, 17, 22, 28]) {
		const poly = generatorPolynomial(degree);
		assert.equal(poly.length, degree + 1);
		assert.equal(poly[0], 1, 'generator must be monic');
		for (let index = 0; index < degree; index += 1) {
			const alpha = GF.exp[index];
			let value = 0;
			for (const coefficient of poly) value = mul(value, alpha) ^ coefficient;
			assert.equal(value, 0, `generator of degree ${degree} does not vanish at alpha^${index}`);
		}
	}
});

test('the imported syndromes agree with the local ones, and a codeword has none', () => {
	const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236];
	const ec = reedSolomon(data, 13);
	assert.deepEqual(syndromes([...data, ...ec], 13), new Array(13).fill(0));
	assert.deepEqual(blockSyndromes([...data, ...ec], 13), new Array(13).fill(0));
});

test('Reed-Solomon is linear and maps the zero block to zero', () => {
	const first = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
	const second = [200, 100, 50, 25, 12, 6, 3, 129, 64, 32];
	const mixed = first.map((byte, index) => byte ^ second[index]);
	const a = reedSolomon(first, 10);
	const b = reedSolomon(second, 10);
	const both = reedSolomon(mixed, 10);
	assert.deepEqual(both, a.map((byte, index) => byte ^ b[index]));
	assert.deepEqual(reedSolomon(new Array(10).fill(0), 10), new Array(10).fill(0));
});

test('a corrupted codeword stops satisfying the syndromes', () => {
	const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
	const ec = reedSolomon(data, 10);
	const broken = [...data, ...ec];
	broken[3] ^= 0x01;
	assert.notDeepEqual(syndromes(broken, 10), new Array(10).fill(0));
});

/* ------------------------------------------------------------------ *
 * Matrix structure
 * ------------------------------------------------------------------ */

test('finder patterns, separators, timing, and the dark module are placed', () => {
	const matrix = encodeQr('https://weixin.qq.com/x/abcdef');
	const { modules, size } = matrix;
	for (const [left, top] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
		for (let dy = 0; dy < 7; dy += 1) {
			for (let dx = 0; dx < 7; dx += 1) {
				const expected = dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
				assert.equal(modules[top + dy][left + dx], expected, `finder pixel (${dx},${dy})`);
			}
		}
	}
	for (let index = 8; index < size - 8; index += 1) {
		assert.equal(modules[6][index], index % 2 === 0, `horizontal timing at ${index}`);
		assert.equal(modules[index][6], index % 2 === 0, `vertical timing at ${index}`);
	}
	assert.equal(modules[size - 8][8], true, 'dark module');
});

test('the format information is a valid BCH codeword carrying level and mask', () => {
	const matrix = encodeQr('https://weixin.qq.com/x/abcdef', { ecc: 'Q' });
	const raw = readFormat(matrix.modules);
	let remainder = raw;
	for (let shift = 14; shift >= 10; shift -= 1) if (((remainder >>> shift) & 1) !== 0) remainder ^= 0x537 << (shift - 10);
	assert.equal(remainder & 0x3ff, 0, 'format information is not a valid BCH(15,5) codeword');
	assert.equal((raw >>> 13) & 0b11, ECC_FORMAT_BITS.Q);
	assert.equal((raw >>> 10) & 0b111, matrix.mask);
	assert.equal(formatBits('Q', matrix.mask) ^ 0x5412, raw);
});

test('version information is a valid BCH codeword for version 7 and above', () => {
	const matrix = encodeQr('x'.repeat(150), { ecc: 'M' });
	assert.equal(matrix.version >= 7, true);
	const raw = readVersion(matrix.modules, matrix.size);
	assert.equal(raw, versionBits(matrix.version));
	let remainder = raw;
	for (let shift = 17; shift >= 12; shift -= 1) if (((remainder >>> shift) & 1) !== 0) remainder ^= 0x1f25 << (shift - 12);
	assert.equal(remainder & 0xfff, 0, 'version information is not a valid BCH(18,6) codeword');
});

test('every mask is a distinct, deterministic predicate', () => {
	const seen = new Set();
	for (let mask = 0; mask < 8; mask += 1) {
		const cells = [];
		for (let y = 0; y < 12; y += 1) for (let x = 0; x < 12; x += 1) cells.push(masked(mask, x, y));
		seen.add(cells.join(''));
		assert.equal(cells.join(''), Array.from({ length: 12 }, (_, y) => Array.from({ length: 12 }, (_, x) => masked(mask, x, y)).join('')).join(''));
	}
	assert.equal(seen.size, 8);
});

/* ------------------------------------------------------------------ *
 * Round trips
 * ------------------------------------------------------------------ */

test('a login link round-trips through the symbol', () => {
	const payload = 'https://weixin.qq.com/x/AbCdEf1234567890';
	const matrix = encodeQr(payload, { ecc: 'M' });
	const decoded = decodeQr({ ...matrix, payloadBytes: Buffer.from(payload, 'utf8') });
	assert.equal(decoded.payload.toString('utf8'), payload);
	assert.equal(decoded.mode, 0b0100);
});

test('a long link and a non-ASCII payload both round-trip', () => {
	for (const payload of [
		'https://weixin.qq.com/x/' + 'a1B2c3D4'.repeat(12),
		'微信连接测试-https://weixin.qq.com/x/中文参数',
	]) {
		const matrix = encodeQr(payload, { ecc: 'M' });
		const decoded = decodeQr({ ...matrix, payloadBytes: Buffer.from(payload, 'utf8') });
		assert.equal(decoded.payload.toString('utf8'), payload);
	}
});

test('every error-correction level round-trips at the version it selects', () => {
	for (const ecc of ['L', 'M', 'Q', 'H']) {
		const payload = 'https://weixin.qq.com/x/level-' + ecc;
		const matrix = encodeQr(payload, { ecc });
		assert.equal(matrix.ecc, ecc);
		const decoded = decodeQr({ ...matrix, payloadBytes: Buffer.from(payload, 'utf8') });
		assert.equal(decoded.payload.toString('utf8'), payload);
	}
});

test('a multi-block version round-trips (interleaving is correct)', () => {
	const payload = 'y'.repeat(100);
	const matrix = encodeQr(payload, { ecc: 'H' });
	assert.equal(matrix.version >= 6, true, 'expected a multi-block version');
	const decoded = decodeQr({ ...matrix, payloadBytes: Buffer.from(payload, 'utf8') });
	assert.equal(decoded.payload.toString('utf8'), payload);
});

test('encoding is deterministic', () => {
	const first = encodeQr('https://weixin.qq.com/x/same');
	const second = encodeQr('https://weixin.qq.com/x/same');
	assert.equal(first.version, second.version);
	assert.equal(first.mask, second.mask);
	assert.deepEqual(first.modules, second.modules);
});

test('the mask actually chosen has the lowest penalty among the eight', () => {
	const matrix = encodeQr('https://weixin.qq.com/x/penalty');
	const size = matrix.size;
	const reserved = reservedMap(matrix.version);
	let winner = null;
	for (let mask = 0; mask < 8; mask += 1) {
		const candidate = matrix.modules.map((row, y) => row.map((value, x) => value));
		/* Re-derive the unmasked matrix, then re-mask with each candidate. */
		for (let y = 0; y < size; y += 1) {
			for (let x = 0; x < size; x += 1) {
				if (reserved[y][x]) continue;
				const unmasked = candidate[y][x] !== masked(matrix.mask, x, y);
				candidate[y][x] = unmasked !== masked(mask, x, y);
			}
		}
		testing.applyFormat(candidate, reserved, size, matrix.ecc, mask);
		const score = testing.penaltyScore(candidate, size);
		if (winner === null || score < winner.score) winner = { mask, score };
	}
	assert.equal(matrix.mask, winner.mask);
});

/* ------------------------------------------------------------------ *
 * Capacity and rendering
 * ------------------------------------------------------------------ */

test('the version is chosen as the smallest that fits', () => {
	for (const ecc of ['L', 'M', 'Q', 'H']) {
		for (let bytes = 1; bytes <= dataCodewords(3, ecc) - 2; bytes += 1) {
			const matrix = encodeQr('a'.repeat(bytes), { ecc });
			if (matrix.version > 1) {
				const previous = dataCodewords(matrix.version - 1, ecc) - (countBits(matrix.version - 1) === 8 ? 2 : 3);
				assert.equal(bytes > previous, true, `version ${matrix.version} chosen for ${bytes} bytes`);
			}
		}
	}
});

test('a payload beyond the supported capacity fails loudly', () => {
	assert.throws(() => encodeQr('z'.repeat(dataCodewords(10, 'H') + 100), { ecc: 'H' }), /exceeds version 10-H/);
});

test('an explicit version that cannot hold the payload fails loudly', () => {
	assert.throws(() => encodeQr('z'.repeat(60), { ecc: 'H', version: 2 }), /does not fit version 2-H/);
});

test('an unknown level or version is rejected', () => {
	assert.throws(() => encodeQr('x', { ecc: 'Z' }), /unknown error-correction level/);
	assert.throws(() => encodeQr('x', { version: 11 }), /outside the supported range/);
});

test('the SVG carries the quiet zone, size, and one path per dark module', () => {
	const matrix = encodeQr('https://weixin.qq.com/x/svg');
	const svg = toSvg(matrix, { scale: 4, margin: 2 });
	const extent = (matrix.size + 4) * 4;
	assert.equal(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), true);
	assert.equal(svg.includes(`width="${extent}" height="${extent}"`), true);
	assert.equal(svg.includes('shape-rendering="crispEdges"'), true);
	const dark = matrix.modules.flat().filter(Boolean).length;
	assert.equal((svg.match(/M\d+ \d+h4v4h-4z/g) ?? []).length, dark);
	assert.equal(svg.includes('<script'), false);
});
