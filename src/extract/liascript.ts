import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { blocks as htmlBlocks, line, text } from "../html.ts";
import { insidePackage } from "../input.ts";
import { readManifest } from "../manifest.ts";
import { type Block, type Course, ImportError, type Lesson, type Loss, type Page } from "../model.ts";
import { find, parseXml } from "../xml.ts";

/** SCORM exports select the Markdown with the item's parameters, not its filename. */
export function liaSources(root: string): string[] {
	const file = insidePackage(root, "imsmanifest.xml");
	if (!file) return [];
	return [...new Set(find(parseXml(readFileSync(file, "utf8")), "item").flatMap((item) => {
		const path = item.attrs.parameters?.replace(/^\?/, "").split(/[?#]/)[0];
		if (!path || !/\.md$/i.test(path)) return [];
		try { return [decodeURIComponent(path)]; } catch { return []; }
	}))];
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Small inline subset, passed through the existing HTML converter for escaping. */
function markdown(s: string): string {
	return s.replace(/<[^>]+>|`([^`\n]+)`|(!\?|\?|!)?\[((?:[^\[\]]|\[[^\]]*\])*)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|__([^_\n]+)__|\b_([^_\n]+)_\b/g,
		(all, code: string, image: string, label: string, url: string, title: string, bold: string, italic: string, strong: string, emphasis: string) => {
			if (all.startsWith("<")) return all;
			if (code !== undefined) return `<code>${escape(code)}</code>`;
			if (url !== undefined) return image === "!" ? `<img src="${escape(url)}" alt="${escape(label)}">${title ? `<span>${markdown(title)}</span>` : ""}` : `<a href="${escape(url)}">${markdown(label)}</a>`;
			return bold !== undefined || strong !== undefined ? `<strong>${escape(bold ?? strong)}</strong>` : `<em>${escape(italic ?? emphasis)}</em>`;
		});
}

const choice = /^\s*\[(?:\(([ Xx])\)|\[([ Xx])\])\]\s+(.+)$/;
const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const list = /^\s*([-+*]|\d+[.)])\s+(.+)$/;

export function extractLiaScript(root: string): Course {
	const manifest = readManifest(root);
	const losses: Loss[] = [];
	const lessons: Lesson[] = [];
	const sourceText: string[] = [];
	for (const path of liaSources(root)) {
		const file = insidePackage(root, path);
		const lose = (n: number, source: string, detail: string, effect: Loss["effect"] = "dropped") => losses.push({ at: `${path}:${n + 1}`, source: `liascript:${source}`, effect, detail });
		if (!file) { lose(0, "source", "Markdown source is missing or outside the package"); continue; }
		const original = readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
		// Strip runtime content only outside code examples; retain source line numbers.
		const runtime = /^[ \t]*(`{3,}|~{3,})[^\n]*$|(`+)[^\n]*?\2|<!--[\s\S]*?(?:-->|(?![\s\S]))|<(script|style)\b[^>]*>[\s\S]*?<\/\3\s*>/gim;
		let clean = "";
		let cursor = 0;
		for (let token = runtime.exec(original); token; token = runtime.exec(original)) {
			clean += original.slice(cursor, token.index);
			if (token[1]) {
				const close = new RegExp(`^[ \\t]*${token[1][0]}{${token[1].length},}[ \\t]*(?=\\n|$)`, "gm");
				close.lastIndex = runtime.lastIndex + 1;
				const end = close.exec(original);
				runtime.lastIndex = end ? close.lastIndex : original.length;
				clean += original.slice(token.index, runtime.lastIndex);
			} else if (token[2]) clean += token[0];
			else {
				lose(original.slice(0, token.index).split("\n").length - 1, "runtime", "metadata, styles, macros or scripts are not executed");
				clean += token[0].replace(/[^\n]/g, "");
			}
			cursor = runtime.lastIndex;
		}
		clean += original.slice(cursor);
		// Inventory the source independently of block mapping, including unsupported visible constructs.
		const inventory = clean.replace(/^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\s*\1\s*$/gm, (_all, _fence, code: string) => escape(code));
		sourceText.push(text(markdown(inventory.replace(/^\s*\{\{[^\n]*?\}\}\s*/gm, "").replace(/^\s*\[(?:\([ Xx]\)|\[[ Xx]\])\]\s*/gm, ""))));
		const lines = clean.split("\n");
		let lesson: Lesson = { sourceId: path, title: manifest?.title || posix.basename(path), pages: [] };
		let page: Page = { blocks: [] };
		lesson.pages.push(page);
		lessons.push(lesson);
		let run: string[] = [];
		let runStart = 0;
		const convert = (s: string, n: number): Block[] => {
			const html = markdown(s);
			if (/<(?:input|button|select|textarea|form|svg|canvas|object|embed)\b|\bsrc\s*=\s*["']data:/i.test(html)) lose(n, "html", "interactive HTML or inline data media cannot be carried over");
			if (/\bon\w+\s*=|\b(?:class|style)\s*=|href\s*=\s*["'](?!https?:|mailto:)/i.test(html)) lose(n, "presentation", "HTML styling, event handlers and local navigation are not retained", "approximated");
			if (/\?\[/.test(s)) lose(n, "media", "LiaScript audio/video embeds are retained as links", "approximated");
			if (/\]\[|\[\^|\$[^$\n]+\$|~~/.test(s)) lose(n, "markdown", "unsupported references, footnotes, formulas or strikethrough retained as literal text", "approximated");
			return htmlBlocks(html, { base: posix.dirname(path), lose: (source, detail) => losses.push({ at: `${path}:${n + 1}`, source, detail, effect: "dropped" }) });
		};
		const flush = () => { page.blocks.push(...convert(run.join("\n"), runStart)); run = []; };
		const prompt = (): string | undefined => {
			const last = page.blocks.at(-1);
			if (last?.kind !== "paragraph") return undefined;
			page.blocks.pop();
			return last.text;
		};
		for (let i = 0; i < lines.length; i++) {
			let s = lines[i] ?? "";
			if (!s.trim()) { flush(); continue; }
			const h = heading.exec(s);
			if (h) {
				flush();
				const title = text(markdown(h[2]!));
				if (h[1]!.length === 1 && lesson.pages.some((p) => p.blocks.length)) {
					lesson = { sourceId: `${path}:${i + 1}`, title, pages: [] }; lessons.push(lesson);
				}
				if (h[1]!.length === 1) lesson.title = title;
				if (page.blocks.length || !lesson.pages.includes(page)) { page = { title, blocks: [] }; lesson.pages.push(page); }
				else page.title = title;
				page.blocks.push({ kind: "heading", level: 1, text: line(markdown(h[2]!)) });
				continue;
			}
			const fence = /^\s*(`{3,}|~{3,})\s*(\S*)\s*$/.exec(s);
			if (fence) {
				flush(); const start = i; const code: string[] = [];
				while (++i < lines.length && !new RegExp(`^\\s*${fence[1]![0]}{${fence[1]!.length},}\\s*$`).test(lines[i]!)) code.push(lines[i]!);
				page.blocks.push({ kind: "code", text: code.join("\n"), ...(fence[2] ? { lang: fence[2] } : {}) });
				if (i === lines.length) lose(start, "code", "unclosed code fence imported as literal code", "approximated");
				continue;
			}
			if (choice.test(s)) {
				flush(); const start = i; const multiple = choice.exec(s)![2] !== undefined; const options = [];
				while (i < lines.length) {
					const q = choice.exec(lines[i]!); if (!q || (q[2] !== undefined) !== multiple) break;
					options.push({ text: line(markdown(q[3]!)), correct: /x/i.test(q[1] ?? q[2]!) }); i++;
				}
				i--;
				const correct = options.filter((o) => o.correct).length;
				const prev = page.blocks.at(-1);
				if (options.length > 1 && correct > 0 && (multiple || correct === 1) && prev?.kind === "paragraph") page.blocks.push({ kind: "choice", prompt: prompt()!, multiple, options });
				else { lose(start, "quiz", "choice question has no unambiguous prompt or answer key; option text retained", "approximated"); page.blocks.push({ kind: "list", ordered: false, items: options.map((o) => o.text) }); }
				continue;
			}
			const blank = /^\s*\[\[([^\[\]\n]+)\]\]\s*$/.exec(s);
			if (blank && !/^[ Xx]$/.test(blank[1]!)) {
				flush(); const prev = page.blocks.at(-1);
				if (prev?.kind === "paragraph" && !/[|@{}]/.test(blank[1]!)) page.blocks.push({ kind: "fillBlank", prompt: prompt()!, parts: [{ answers: [text(markdown(blank[1]!.trim()))] }] });
				else lose(i, "quiz", "text answer has no unambiguous prompt or uses unsupported evaluation");
				continue;
			}
			if (/\[\[|\[\([ Xx]\)\]|\{\{|^\s*@|^\s*--\{|\$\$/.test(s)) {
				flush(); lose(i, "extension", "unsupported quiz, macro, animation, narration or formula syntax");
				// Animation prefixes do not change the text that follows them.
				s = s.replace(/^\s*\{\{[^}]*\}\}\s*/, "");
				if (!s.trim() || /\[\[|^\s*@|^\s*--\{|\$\$/.test(s)) continue;
			}
			if (/^\s*(?:---+|\*\*\*+)\s*$/.test(s)) { flush(); page.blocks.push({ kind: "divider" }); continue; }
			if (list.test(s)) {
				flush(); const ordered = /^\s*\d/.test(s); const items: string[] = []; const start = i;
				while (i < lines.length && list.test(lines[i]!) && /^\s*\d/.test(lines[i]!) === ordered) {
					if (/^\s{2,}|^\t/.test(lines[i]!)) lose(i, "list", "nested list flattened", "approximated");
					const value = list.exec(lines[i]!)![2]!;
					if (/!\[|<img\b/.test(value)) page.blocks.push(...convert(value, i).filter((b) => b.kind === "image"));
					items.push(line(markdown(value))); i++;
				}
				i--; if (items.some(Boolean)) page.blocks.push({ kind: "list", ordered, items: items.filter(Boolean) });
				if (/^\s*\d+[.)]/.test(s) && !/^\s*1[.)]/.test(s)) lose(start, "list", "ordered list start number is not retained", "approximated");
				continue;
			}
			if (/^\s*>/.test(s)) {
				flush(); const quote: string[] = [];
				while (i < lines.length && /^\s*>/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^\s*>\s?/, ""));
				i--; page.blocks.push({ kind: "quote", text: line(markdown(quote.join("\n"))) }); continue;
			}
			if (s.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
				flush(); const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => line(markdown(c.trim().replace(/\\\|/g, "|"))));
				const rows = [cells(s)]; i += 2;
				while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!));
				i--; page.blocks.push({ kind: "table", rows }); continue;
			}
			if (!run.length) runStart = i;
			run.push(s);
		}
		flush();
	}
	const kept = lessons.filter((l) => l.pages.some((p) => p.blocks.length));
	if (!kept.length) throw new ImportError("no_readable_content", "LiaScript package has no readable shipped Markdown source");
	return { tool: "liascript", sourceId: manifest?.identifier ?? "liascript", title: manifest?.title || kept[0]!.title, lessons: kept, losses, sourceText };
}
