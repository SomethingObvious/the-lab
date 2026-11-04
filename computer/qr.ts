// A QR code for a short link, so the phone can pair by pointing its camera
// at the computer. Byte mode, medium error correction, versions 1 to 20 (up to
// 666 bytes), after Project Nayuki's reference encoder.

const EC = [
	0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];
// Error correction words per block and how many blocks, for versions 1 to 20.
const ecOf = (v: number) => EC[v] ?? 0;
const blocksOf = (v: number) => BLOCKS[v] ?? 0;

const raw = (v: number) => {
	let r = (16 * v + 128) * v + 64;
	if (v >= 2) {
		const n = Math.floor(v / 7) + 2;
		r -= (25 * n - 10) * n - 55;
		if (v >= 7) r -= 36;
	}
	return r;
};
const capacity = (v: number) => Math.floor(raw(v) / 8) - ecOf(v) * blocksOf(v);

const bit = (n: number, i: number) => Math.floor(n / 2 ** i) % 2;
// Adding in GF(2^8) is adding each bit with no carry.
function xor(a: number, b: number) {
	let r = 0;
	for (let i = 0; 2 ** i <= Math.max(a, b); i++)
		if (bit(a, i) !== bit(b, i)) r += 2 ** i;
	return r;
}

function mul(x: number, y: number) {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = xor(z * 2, bit(z, 7) * 0x1_1d);
		z = xor(z, bit(y, i) * x);
	}
	return z;
}
function divisor(degree: number) {
	let r: number[] = Array.from({ length: degree }, (_, j) =>
		j === degree - 1 ? 1 : 0,
	);
	let root = 1;
	for (let i = 0; i < degree; i++) {
		const prev = r;
		r = prev.map((x, j) => xor(mul(x, root), prev[j + 1] ?? 0));
		root = mul(root, 2);
	}
	return r;
}
function remainder(data: number[], div: number[]) {
	let r = div.map(() => 0);
	for (const b of data) {
		const [head = 0, ...tail] = r;
		const f = xor(b, head);
		r = div.map((c, i) => xor(tail[i] ?? 0, mul(c, f)));
	}
	return r;
}

// The low len bits of val, most significant first.
const bitsOf = (val: number, len: number) => {
	const bits: number[] = [];
	for (let i = len - 1; i >= 0; i--) bits.push(bit(val, i));
	return bits;
};

// The data and error correction words in the order they go into the grid.
function codewords(bytes: number[], v: number): number[] {
	const bits: number[] = [];
	const put = (val: number, len: number) => bits.push(...bitsOf(val, len));
	put(4, 4);
	put(bytes.length, v < 10 ? 8 : 16);
	for (const b of bytes) put(b, 8);
	const cap = capacity(v) * 8;
	put(0, Math.min(4, cap - bits.length));
	put(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < cap; pad = pad === 0xec ? 0x11 : 0xec) put(pad, 8);
	const data: number[] = [];
	for (let i = 0; i < bits.length; i += 8)
		data.push(Number.parseInt(bits.slice(i, i + 8).join(""), 2));

	// Split into blocks, add error correction to each, then interleave.
	const nb = blocksOf(v);
	const ec = ecOf(v);
	const total = Math.floor(raw(v) / 8);
	const short = nb - (total % nb);
	const shortLen = Math.floor(total / nb);
	const div = divisor(ec);
	const blocks: number[][] = [];
	let k = 0;
	for (let i = 0; i < nb; i++) {
		const len = shortLen - ec + (i < short ? 0 : 1);
		const d = data.slice(k, k + len);
		k += len;
		const e = remainder(d, div);
		if (i < short) d.push(0);
		blocks.push(d.concat(e));
	}
	const words: number[] = [];
	const width = blocks[0]?.length ?? 0;
	for (let i = 0; i < width; i++)
		for (const [j, b] of blocks.entries()) {
			const word = b[i];
			if (word !== undefined && (i !== shortLen - ec || j >= short)) words.push(word);
		}
	return words;
}

// The modules of the grid, row by row, and which of them the patterns own.
class Grid {
	readonly size: number;
	readonly dark: boolean[];
	readonly fixed: boolean[];

	constructor(size: number) {
		this.size = size;
		this.dark = Array.from({ length: size * size }, () => false);
		this.fixed = Array.from({ length: size * size }, () => false);
	}

	set(x: number, y: number, on: boolean) {
		this.dark[y * this.size + x] = on;
		this.fixed[y * this.size + x] = true;
	}

	rows(): boolean[][] {
		const { size } = this;
		return Array.from({ length: size }, (_, y) =>
			this.dark.slice(y * size, (y + 1) * size),
		);
	}
}

function finders(g: Grid) {
	const { size } = g;
	for (let i = 0; i < size; i++) {
		g.set(6, i, i % 2 === 0);
		g.set(i, 6, i % 2 === 0);
	}
	for (const [cx, cy] of [
		[3, 3],
		[size - 4, 3],
		[3, size - 4],
	] as const) {
		for (let dy = -4; dy <= 4; dy++)
			for (let dx = -4; dx <= 4; dx++) {
				const x = cx + dx;
				const y = cy + dy;
				const d = Math.max(Math.abs(dx), Math.abs(dy));
				if (x >= 0 && x < size && y >= 0 && y < size) g.set(x, y, d !== 2 && d !== 4);
			}
	}
}

function alignment(g: Grid, v: number) {
	if (v <= 1) return;
	const n = Math.floor(v / 7) + 2;
	const step = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
	const pos = [6];
	for (let p = g.size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
	for (const [i, px] of pos.entries())
		for (const [j, py] of pos.entries()) {
			if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))
				continue;
			for (let dy = -2; dy <= 2; dy++)
				for (let dx = -2; dx <= 2; dx++)
					g.set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
		}
}

function versionBits(g: Grid, v: number) {
	if (v < 7) return;
	let r = v;
	for (let i = 0; i < 12; i++) r = xor(r * 2, bit(r, 11) * 0x1f_25);
	const vb = v * 2 ** 12 + r;
	for (let i = 0; i < 18; i++) {
		const on = bit(vb, i) === 1;
		const a = g.size - 11 + (i % 3);
		const b = Math.floor(i / 3);
		g.set(a, b, on);
		g.set(b, a, on);
	}
}

// ponytail: one fixed mask rather than scoring all eight. Readers decode any
// mask, so only scoring would matter for a code at the limit of a camera.
const Mask = 0;
function format(g: Grid) {
	const { size } = g;
	// Medium error correction is 00 in the two bits ahead of the mask.
	const d = Mask;
	let r = d;
	for (let i = 0; i < 10; i++) r = xor(r * 2, bit(r, 9) * 0x5_37);
	const fb = xor(d * 2 ** 10 + r, 0x54_12);
	const on = (i: number) => bit(fb, i) === 1;
	for (let i = 0; i <= 5; i++) g.set(8, i, on(i));
	g.set(8, 7, on(6));
	g.set(8, 8, on(7));
	g.set(7, 8, on(8));
	for (let i = 9; i < 15; i++) g.set(14 - i, 8, on(i));
	for (let i = 0; i < 8; i++) g.set(size - 1 - i, 8, on(i));
	for (let i = 8; i < 15; i++) g.set(8, size - 15 + i, on(i));
	g.set(8, size - 8, true);
}

function place(g: Grid, words: number[]) {
	const { size, dark, fixed } = g;
	const bits = words.flatMap((w) => bitsOf(w, 8));
	let i = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let vert = 0; vert < size; vert++)
			for (let j = 0; j < 2; j++) {
				const x = right - j;
				const y = bit(right + 1, 1) === 0 ? size - 1 - vert : vert;
				if (!fixed[y * size + x] && i < bits.length) {
					dark[y * size + x] = bits[i] === 1;
					i++;
				}
			}
	}
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++)
			if (!fixed[y * size + x] && (x + y) % 2 === 0)
				dark[y * size + x] = !dark[y * size + x];
}

export function qr(text: string): boolean[][] {
	const bytes = [...Buffer.from(text, "utf8")];
	let v = 1;
	while (v <= 20 && 12 + (v < 10 ? 0 : 8) + bytes.length * 8 > capacity(v) * 8) v++;
	if (v > 20) throw new Error(`"${text}" is too long for a QR code here.`);
	const words = codewords(bytes, v);
	const g = new Grid(v * 4 + 17);
	finders(g);
	alignment(g, v);
	versionBits(g, v);
	format(g);
	place(g, words);
	return g.rows();
}

// The code as an SVG with the four-module quiet border readers need.
export function qrSvg(text: string): string {
	const m = qr(text);
	const n = m.length + 8;
	let d = "";
	for (const [y, row] of m.entries())
		for (const [x, on] of row.entries()) if (on) d += `M${x + 4} ${y + 4}h1v1h-1z`;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
