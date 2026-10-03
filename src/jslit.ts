/**
 * Read a JavaScript object literal as data, without executing it. Packages are
 * untrusted, and `node:vm` is not a security boundary, so vendor models such
 * as Captivate's `cp.model.data = {...}` are parsed, not evaluated.
 *
 * Supports objects (quoted, bare or numeric keys), arrays, single/double-quoted
 * strings with escapes, `+` concatenation of strings, numbers, true/false/
 * null/undefined/NaN/Infinity. Any other expression (a runtime reference like
 * `cp.fd`, a call, a function) is skipped up to the next `,`, `}` or `]` at
 * its nesting depth and read as `undefined`.
 */
export function parseLiteral(src: string, start = 0): unknown {
	let i = start;
	const ws = () => {
		for (;;) {
			while (i < src.length && /\s/.test(src[i] as string)) i++;
			if (src.startsWith("//", i)) i = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
			else if (src.startsWith("/*", i)) i = src.indexOf("*/", i) < 0 ? src.length : src.indexOf("*/", i) + 2;
			else return;
		}
	};
	const string = (): string => {
		const q = src[i++];
		let out = "";
		while (i < src.length && src[i] !== q) {
			const c = src[i++] as string;
			if (c !== "\\") {
				out += c;
				continue;
			}
			const e = src[i++] as string;
			if (e === "u") {
				const braced = src[i] === "{";
				const hex = braced ? src.slice(i + 1, src.indexOf("}", i)) : src.slice(i, i + 4);
				out += String.fromCodePoint(parseInt(hex, 16));
				i += braced ? hex.length + 2 : 4;
			} else if (e === "x") {
				out += String.fromCharCode(parseInt(src.slice(i, i + 2), 16));
				i += 2;
			} else if (e === "\n" || e === "\r") {
				if (e === "\r" && src[i] === "\n") i++;
			} else out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" } as Record<string, string>)[e] ?? e;
		}
		i++;
		return out;
	};
	/** Skip an expression we will not interpret, respecting strings and brackets. */
	const skip = () => {
		let depth = 0;
		while (i < src.length) {
			const c = src[i] as string;
			if (c === '"' || c === "'" || c === "`") {
				if (c === "`") {
					i = src.indexOf("`", i + 1) + 1 || src.length;
				} else string();
				continue;
			}
			if ("([{".includes(c)) depth++;
			else if (")]}".includes(c)) {
				if (depth === 0) return;
				depth--;
			} else if (c === "," && depth === 0) return;
			i++;
		}
	};
	const value = (): unknown => {
		ws();
		const c = src[i];
		if (c === "{") {
			i++;
			const o: Record<string, unknown> = {};
			for (;;) {
				ws();
				if (src[i] === "}") return i++, o;
				let key: string;
				if (src[i] === '"' || src[i] === "'") key = string();
				else {
					const m = /^[$\w.-]+/.exec(src.slice(i, i + 256));
					if (!m) throw new Error(`Unexpected ${src[i]} at ${i}`);
					key = m[0];
					i += key.length;
				}
				ws();
				if (src[i++] !== ":") throw new Error(`Expected : at ${i - 1}`);
				const v = value();
				if (key !== "__proto__") o[key] = v;
				ws();
				if (src[i] === ",") i++;
				else if (src[i] !== "}") throw new Error(`Expected , or } at ${i}`);
			}
		}
		if (c === "[") {
			i++;
			const a: unknown[] = [];
			for (;;) {
				ws();
				if (src[i] === "]") return i++, a;
				a.push(value());
				ws();
				if (src[i] === ",") i++;
				else if (src[i] !== "]") throw new Error(`Expected , or ] at ${i}`);
			}
		}
		if (c === '"' || c === "'") {
			let s = string();
			// Adjacent string concatenation: "a" + "b".
			for (;;) {
				const save = i;
				ws();
				if (src[i] !== "+") return (i = save), s;
				i++;
				ws();
				if (src[i] !== '"' && src[i] !== "'") {
					skip();
					return s;
				}
				s += string();
			}
		}
		const num = /^-?(0x[0-9a-f]+|\d*\.?\d+(e[+-]?\d+)?)(?=\s*[,}\]])/i.exec(src.slice(i, i + 64));
		if (num) {
			i += num[0].length;
			return Number(num[0]);
		}
		for (const [word, v] of [["true", true], ["false", false], ["null", null], ["undefined", undefined], ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY]] as const) {
			if (src.startsWith(word, i) && !/[\w$.(]/.test(src[i + word.length] ?? "")) {
				i += word.length;
				return v;
			}
		}
		skip();
		return undefined;
	};
	return value();
}
