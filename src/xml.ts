/**
 * Minimal XML reader for SCORM manifests and similar descriptor files. Handles
 * elements, attributes, self-closing tags, text, CDATA, comments and the five
 * predefined entities plus numeric references. No DTDs or namespaces: element
 * names keep their prefix, and `local()` strips it for matching.
 */
export type XmlElement = { name: string; attrs: Record<string, string>; children: XmlNode[] };
export type XmlNode = XmlElement | string;

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export const decode = (s: string) =>
	s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
		e[0] === "#" ? String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITY[e] ?? m),
	);

export function parseXml(src: string): XmlElement {
	const root: XmlElement = { name: "#root", attrs: {}, children: [] };
	const stack = [root];
	const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gi;
	for (const m of src.matchAll(re)) {
		const top = stack.at(-1) as XmlElement;
		if (m[1] !== undefined) top.children.push(m[1]);
		else if (m[2]) {
			const i = stack.findLastIndex((e) => e.name === m[2]);
			if (i > 0) stack.length = i;
		} else if (m[3]) {
			const attrs: Record<string, string> = {};
			for (const a of (m[4] ?? "").matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1] as string] = decode(a[2] ?? a[3] ?? "");
			const el: XmlElement = { name: m[3], attrs, children: [] };
			top.children.push(el);
			if (!m[5]) stack.push(el);
		} else if (m[6] && m[6].trim()) top.children.push(decode(m[6]));
	}
	return root;
}

export const local = (name: string) => name.slice(name.indexOf(":") + 1).toLowerCase();

export const kids = (el: XmlElement, name?: string): XmlElement[] =>
	el.children.filter((c): c is XmlElement => typeof c !== "string" && (!name || local(c.name) === name));

export function find(el: XmlElement, name: string): XmlElement[] {
	const out: XmlElement[] = [];
	const walk = (e: XmlElement) => {
		for (const c of kids(e)) {
			if (local(c.name) === name) out.push(c);
			walk(c);
		}
	};
	walk(el);
	return out;
}

export const textOf = (el: XmlElement | undefined): string =>
	el ? el.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("").trim() : "";
