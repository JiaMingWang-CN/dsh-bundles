/**
 * Minimal QR Code encoder (byte mode) and SVG renderer.
 *
 * Why this exists: the WeChat login answer carries `qrcode_img_content`, the
 * link the user must scan, and neither the harness nor this bundle can resolve a
 * QR library (a third-party bundle sees only Node built-ins). Rendering happens
 * host-side so the settings page stays a plain `<img>` and needs no encoder of
 * its own.
 *
 * Scope: byte mode, error-correction levels L/M/Q/H, versions 1–10 — far beyond
 * what a login link needs (version 10-M holds 271 bytes). Bit layout, Reed-
 * Solomon coding, masking, format/version information, and penalty scoring
 * follow ISO/IEC 18004.
 */

/** Error-correction levels with their format-information bit values. */
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

/** Codewords per block group and EC codewords per block, by version then level. */
const BLOCK_TABLE = {
	1: { L: [1, 19, 7], M: [1, 16, 10], Q: [1, 13, 13], H: [1, 9, 17] },
	2: { L: [1, 34, 10], M: [1, 28, 16], Q: [1, 22, 22], H: [1, 16, 28] },
	3: { L: [1, 55, 15], M: [1, 44, 26], Q: [2, 17, 18], H: [2, 13, 22] },
	4: { L: [1, 80, 20], M: [2, 32, 18], Q: [2, 24, 26], H: [4, 9, 16] },
	5: { L: [1, 108, 26], M: [2, 43, 24], Q: [2, 15, 18, 2, 16], H: [2, 11, 22, 2, 12] },
	6: { L: [2, 68, 18], M: [4, 27, 16], Q: [4, 19, 24], H: [4, 15, 28] },
	7: { L: [2, 78, 20], M: [4, 31, 18], Q: [2, 14, 18, 4, 15], H: [4, 13, 26, 1, 14] },
	8: { L: [2, 97, 24], M: [2, 38, 22, 2, 39], Q: [4, 18, 22, 2, 19], H: [4, 14, 26, 2, 15] },
	9: { L: [2, 116, 30], M: [3, 36, 22, 2, 37], Q: [4, 16, 20, 4, 17], H: [4, 12, 24, 4, 13] },
	10: { L: [2, 68, 18, 2, 69], M: [4, 43, 26, 1, 44], Q: [6, 19, 24, 2, 20], H: [6, 15, 28, 2, 16] },
};

/** Alignment-pattern centre coordinates per version. */
const ALIGNMENT_POSITIONS = {
	1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
	6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/** Highest version this encoder implements. */
const MAX_VERSION = 10;

/**
 * Total data codewords of one version/level.
 * @param version - QR version 1–10.
 * @param ecc - error-correction level.
 * @returns usable data codewords, or 0 for an unsupported pair.
 */
function dataCodewords(version, ecc) {
	const entry = BLOCK_TABLE[version]?.[ecc];
	if (entry === undefined) return 0;
	return entry.length === 3
		? entry[0] * entry[1]
		: entry[0] * entry[1] + entry[3] * entry[4];
}

/** Byte-mode character-count indicator width for one version. */
function countBits(version) {
	return version <= 9 ? 8 : 16;
}

/** Number of remainder bits appended after interleaving, by version. */
function remainderBits(version) {
	if (version === 2 || version === 3 || version === 4 || version === 5 || version === 6) return 7;
	if (version >= 7 && version <= 13) return 0;
	return 0;
}

/** Galois-field exponent/log tables for the QR primitive polynomial 0x11D. */
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

/** Multiply two field elements. */
function gfMul(left, right) {
	if (left === 0 || right === 0) return 0;
	return GF.exp[GF.log[left] + GF.log[right]];
}

/**
 * Reed-Solomon generator polynomial of one degree: the product of (x - α^i).
 * @param degree - number of EC codewords.
 * @returns coefficients, highest power first, with a leading 1.
 */
function generatorPolynomial(degree) {
	let poly = [1];
	for (let index = 0; index < degree; index += 1) {
		const next = new Array(poly.length + 1).fill(0);
		for (let term = 0; term < poly.length; term += 1) {
			next[term] ^= poly[term];
			next[term + 1] ^= gfMul(poly[term], GF.exp[index]);
		}
		poly = next;
	}
	return poly;
}

/**
 * Reed-Solomon error-correction codewords for one block.
 * @param data - data codewords of the block.
 * @param ecCount - number of EC codewords to produce.
 * @returns the EC codewords.
 */
function reedSolomon(data, ecCount) {
	const generator = generatorPolynomial(ecCount);
	const remainder = new Array(ecCount).fill(0);
	for (const byte of data) {
		const factor = byte ^ remainder[0];
		remainder.shift();
		remainder.push(0);
		for (let index = 0; index < ecCount; index += 1) {
			remainder[index] ^= gfMul(generator[index + 1], factor);
		}
	}
	return remainder;
}

/**
 * Reed-Solomon syndromes of one codeword block; all-zero means a valid codeword.
 * Used by the tests as an independent check of {@link reedSolomon}.
 * @param codewords - data followed by EC codewords.
 * @param ecCount - number of EC codewords in the block.
 * @returns one syndrome per EC symbol.
 */
function syndromes(codewords, ecCount) {
	const result = [];
	for (let index = 0; index < ecCount; index += 1) {
		const alpha = GF.exp[index];
		let value = 0;
		for (const byte of codewords) value = gfMul(value, alpha) ^ byte;
		result.push(value);
	}
	return result;
}

/** Append `bitCount` bits of `value`, most significant first, into a bit array. */
function appendBits(bits, value, bitCount) {
	for (let shift = bitCount - 1; shift >= 0; shift -= 1) bits.push((value >>> shift) & 1);
}

/**
 * Build the interleaved data + EC codeword stream for one payload.
 * @param payload - UTF-8 bytes to encode.
 * @param version - QR version.
 * @param ecc - error-correction level.
 * @returns interleaved codewords.
 */
function buildCodewords(payload, version, ecc) {
	const entry = BLOCK_TABLE[version][ecc];
	const groups = entry.length === 3
		? [{ blocks: entry[0], dataPerBlock: entry[1] }]
		: [{ blocks: entry[0], dataPerBlock: entry[1] }, { blocks: entry[3], dataPerBlock: entry[4] }];
	const ecPerBlock = entry.length === 3 ? entry[2] : entry[2];
	const totalData = dataCodewords(version, ecc);
	const bits = [];
	appendBits(bits, 0b0100, 4);
	appendBits(bits, payload.length, countBits(version));
	for (const byte of payload) appendBits(bits, byte, 8);
	const capacityBits = totalData * 8;
	if (bits.length > capacityBits) throw new Error(`payload of ${payload.length} bytes does not fit version ${version}-${ecc}`);
	for (let index = 0; index < 4 && bits.length < capacityBits; index += 1) bits.push(0);
	while (bits.length % 8 !== 0) bits.push(0);
	const dataBytes = [];
	for (let index = 0; index < bits.length; index += 8) {
		let byte = 0;
		for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | bits[index + offset];
		dataBytes.push(byte);
	}
	for (let pad = 0; dataBytes.length < totalData; pad += 1) dataBytes.push(pad % 2 === 0 ? 0xec : 0x11);
	const blocks = [];
	let cursor = 0;
	for (const group of groups) {
		for (let block = 0; block < group.blocks; block += 1) {
			const data = dataBytes.slice(cursor, cursor + group.dataPerBlock);
			cursor += group.dataPerBlock;
			blocks.push({ data, ec: reedSolomon(data, ecPerBlock) });
		}
	}
	const codewords = [];
	const maxData = Math.max(...blocks.map((block) => block.data.length));
	for (let index = 0; index < maxData; index += 1) {
		for (const block of blocks) if (index < block.data.length) codewords.push(block.data[index]);
	}
	for (let index = 0; index < ecPerBlock; index += 1) {
		for (const block of blocks) codewords.push(block.ec[index]);
	}
	return codewords;
}

/**
 * Build the module matrix (without masking).
 * @param codewords - interleaved codewords.
 * @param version - QR version.
 * @param ecc - error-correction level.
 * @returns `{ modules, reserved }` where `reserved` marks function modules.
 */
function buildMatrix(codewords, version, ecc) {
	const size = version * 4 + 17;
	const modules = Array.from({ length: size }, () => new Array(size).fill(false));
	const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
	const setFunction = (x, y, dark) => {
		modules[y][x] = dark;
		reserved[y][x] = true;
	};
	/* Finder patterns with separators. */
	for (const [left, top] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
		for (let dy = -1; dy <= 7; dy += 1) {
			for (let dx = -1; dx <= 7; dx += 1) {
				const x = left + dx;
				const y = top + dy;
				if (x < 0 || x >= size || y < 0 || y >= size) continue;
				const inner = (dx >= 0 && dx <= 6 && (dy === 0 || dy === 6)) ||
					(dy >= 0 && dy <= 6 && (dx === 0 || dx === 6)) ||
					(dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
				setFunction(x, y, inner);
			}
		}
	}
	/* Timing patterns. */
	for (let index = 8; index < size - 8; index += 1) {
		const dark = index % 2 === 0;
		setFunction(6, index, dark);
		setFunction(index, 6, dark);
	}
	/* Alignment patterns, skipping the three finder corners. */
	const centers = ALIGNMENT_POSITIONS[version];
	for (const cy of centers) {
		for (const cx of centers) {
			const corner = (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6);
			if (corner) continue;
			for (let dy = -2; dy <= 2; dy += 1) {
				for (let dx = -2; dx <= 2; dx += 1) {
					const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
					setFunction(cx + dx, cy + dy, dark);
				}
			}
		}
	}
	/* Format information is written after masking; reserve its modules now. */
	for (let index = 0; index <= 8; index += 1) {
		if (!reserved[8][index]) setFunction(index, 8, false);
		if (!reserved[index][8]) setFunction(8, index, false);
	}
	for (let index = 0; index < 8; index += 1) {
		if (!reserved[8][size - 1 - index]) setFunction(size - 1 - index, 8, false);
		if (!reserved[size - 1 - index][8]) setFunction(8, size - 1 - index, false);
	}
	setFunction(8, size - 8, true);
	/* Version information for versions 7 and above. */
	if (version >= 7) {
		const bits = versionBits(version);
		for (let index = 0; index < 18; index += 1) {
			const bit = ((bits >>> index) & 1) !== 0;
			const a = size - 11 + (index % 3);
			const b = Math.floor(index / 3);
			setFunction(a, b, bit);
			setFunction(b, a, bit);
		}
	}
	/* Data modules in the standard zigzag, skipping the vertical timing column. */
	const totalBits = codewords.length * 8 + remainderBits(version);
	let bitIndex = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let vert = 0; vert < size; vert += 1) {
			for (let offset = 0; offset < 2; offset += 1) {
				const x = right - offset;
				const upward = ((right + 1) & 2) === 0;
				const y = upward ? size - 1 - vert : vert;
				if (reserved[y][x]) continue;
				const dark = bitIndex < totalBits && bitIndex < codewords.length * 8
					? ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0
					: false;
				modules[y][x] = dark;
				bitIndex += 1;
			}
		}
	}
	return { modules, reserved };
}

/** Version-information bits (18) for versions 7 and above. */
function versionBits(version) {
	let value = version << 12;
	for (let shift = 17; shift >= 12; shift -= 1) {
		if (((value >>> shift) & 1) !== 0) value ^= 0x1f25 << (shift - 12);
	}
	return (version << 12) | value;
}

/** Format-information bits (15) for one level and mask. */
function formatBits(ecc, mask) {
	const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
	let value = data << 10;
	for (let shift = 14; shift >= 10; shift -= 1) {
		if (((value >>> shift) & 1) !== 0) value ^= 0x537 << (shift - 10);
	}
	return ((data << 10) | value) ^ 0x5412;
}

/** Whether one module is inverted by the given mask. */
function maskApplies(mask, x, y) {
	switch (mask) {
		case 0: return (x + y) % 2 === 0;
		case 1: return y % 2 === 0;
		case 2: return x % 3 === 0;
		case 3: return (x + y) % 3 === 0;
		case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
		case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
		case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
		case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
		default: throw new Error(`unknown mask ${mask}`);
	}
}

/** Write both copies of the format information into the matrix. */
function applyFormat(modules, reserved, size, ecc, mask) {
	const bits = formatBits(ecc, mask);
	const bit = (index) => ((bits >>> index) & 1) !== 0;
	for (let index = 0; index <= 5; index += 1) modules[8][index] = bit(index);
	modules[8][7] = bit(6);
	modules[8][8] = bit(7);
	modules[7][8] = bit(8);
	for (let index = 9; index < 15; index += 1) modules[14 - index][8] = bit(index);
	for (let index = 0; index < 8; index += 1) modules[size - 1 - index][8] = bit(index);
	for (let index = 8; index < 15; index += 1) modules[8][size - 15 + index] = bit(index);
	modules[size - 8][8] = true;
	void reserved;
}

/** Penalty score of one masked matrix (ISO/IEC 18004 rules 1–4). */
function penaltyScore(modules, size) {
	let penalty = 0;
	/* Rule 1: runs of five or more same-coloured modules. */
	for (let axis = 0; axis < 2; axis += 1) {
		for (let line = 0; line < size; line += 1) {
			let run = 1;
			for (let index = 1; index < size; index += 1) {
				const previous = axis === 0 ? modules[line][index - 1] : modules[index - 1][line];
				const current = axis === 0 ? modules[line][index] : modules[index][line];
				if (current === previous) run += 1;
				else {
					if (run >= 5) penalty += 3 + (run - 5);
					run = 1;
				}
			}
			if (run >= 5) penalty += 3 + (run - 5);
		}
	}
	/* Rule 2: 2x2 blocks of one colour. */
	for (let y = 0; y < size - 1; y += 1) {
		for (let x = 0; x < size - 1; x += 1) {
			const value = modules[y][x];
			if (value === modules[y][x + 1] && value === modules[y + 1][x] && value === modules[y + 1][x + 1]) penalty += 3;
		}
	}
	/* Rule 3: finder-like patterns inside the symbol. */
	const pattern = [true, false, true, true, true, false, true, false, false, false, false];
	const reverse = [...pattern].reverse();
	const matches = (line, at, target) => {
		for (let index = 0; index < target.length; index += 1) if (line[at + index] !== target[index]) return false;
		return true;
	};
	for (let axis = 0; axis < 2; axis += 1) {
		for (let line = 0; line < size; line += 1) {
			const row = [];
			for (let index = 0; index < size; index += 1) row.push(axis === 0 ? modules[line][index] : modules[index][line]);
			for (let at = 0; at + pattern.length <= size; at += 1) {
				if (matches(row, at, pattern) || matches(row, at, reverse)) penalty += 40;
			}
		}
	}
	/* Rule 4: deviation from an even dark/light balance. */
	let dark = 0;
	for (const row of modules) for (const value of row) if (value) dark += 1;
	const percent = (dark * 100) / (size * size);
	penalty += Math.floor(Math.abs(percent - 50) / 5) * 10;
	return penalty;
}

/**
 * Encode one payload as a QR module matrix.
 * @param payload - string to encode (UTF-8, byte mode).
 * @param options - error-correction level and optional explicit version.
 * @returns `{ modules, size, version, ecc, mask }`.
 */
function encodeQr(payload, { ecc = 'M', version } = {}) {
	if (!Object.hasOwn(ECC_FORMAT_BITS, ecc)) throw new Error(`unknown error-correction level ${ecc}`);
	const bytes = Buffer.from(String(payload), 'utf8');
	let chosen = version;
	if (chosen === undefined) {
		chosen = 0;
		for (let candidate = 1; candidate <= MAX_VERSION; candidate += 1) {
			const capacity = dataCodewords(candidate, ecc) - (countBits(candidate) === 8 ? 2 : 3);
			if (bytes.length <= capacity) { chosen = candidate; break; }
		}
		if (chosen === 0) throw new Error(`payload of ${bytes.length} bytes exceeds version ${MAX_VERSION}-${ecc}`);
	}
	if (chosen < 1 || chosen > MAX_VERSION) throw new Error(`version ${chosen} is outside the supported range 1–${MAX_VERSION}`);
	const codewords = buildCodewords(bytes, chosen, ecc);
	const { modules: raw, reserved } = buildMatrix(codewords, chosen, ecc);
	const size = chosen * 4 + 17;
	let best = null;
	for (let mask = 0; mask < 8; mask += 1) {
		const candidate = raw.map((row, y) => row.map((value, x) => (reserved[y][x] ? value : value !== maskApplies(mask, x, y))));
		applyFormat(candidate, reserved, size, ecc, mask);
		const penalty = penaltyScore(candidate, size);
		if (best === null || penalty < best.penalty) best = { mask, modules: candidate, penalty };
	}
	return { modules: best.modules, size, version: chosen, ecc, mask: best.mask };
}

/**
 * Render a module matrix as a self-contained SVG string.
 * @param matrix - the result of {@link encodeQr}.
 * @param options - module scale, quiet-zone modules, and colours.
 * @returns SVG markup sized in CSS pixels.
 */
function toSvg(matrix, { scale = 6, margin = 4, dark = '#000000', light = '#ffffff' } = {}) {
	const { modules, size } = matrix;
	const extent = (size + margin * 2) * scale;
	const parts = [];
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			if (!modules[y][x]) continue;
			parts.push(`M${(x + margin) * scale} ${(y + margin) * scale}h${scale}v${scale}h-${scale}z`);
		}
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${extent}" height="${extent}" viewBox="0 0 ${extent} ${extent}" shape-rendering="crispEdges" role="img" aria-label="微信登录二维码"><rect width="${extent}" height="${extent}" fill="${light}"/><path d="${parts.join('')}" fill="${dark}"/></svg>`;
}

/** Pure helpers exercised by the unit tests. */
const testing = {
	BLOCK_TABLE, ALIGNMENT_POSITIONS, MAX_VERSION, ECC_FORMAT_BITS,
	buildCodewords, buildMatrix, dataCodewords, countBits, remainderBits, formatBits,
	versionBits, generatorPolynomial, gfMul, maskApplies, penaltyScore, applyFormat,
};

export {
	ECC_FORMAT_BITS, MAX_VERSION, countBits, dataCodewords, encodeQr, formatBits,
	generatorPolynomial, gfMul, maskApplies, penaltyScore, reedSolomon, remainderBits,
	syndromes, testing, toSvg, versionBits,
};
