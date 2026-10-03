import { numberedList, pictureLayout, slideLayout, type HeroItem } from "./hero.ts";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { blocks as htmlBlocks, inline, line, neutralize, parse, text } from "../html.ts";
import type { DefaultTreeAdapterMap } from "parse5";
import { parseLiteral } from "../jslit.ts";
import { readManifest } from "../manifest.ts";
import { insidePackage } from "../input.ts";
import type { Block, Course, Inline, Lesson, Loss, Option, Page, Theme } from "../model.ts";
import { decode, find, kids, parseXml, textOf } from "../xml.ts";

/*
 * Lectora (Online / Inspire) HTML publish. One pageNNN.html per page; its head
 * script declares the page's objects (`var text12 = new jsWndText(); //Content`),
 * their tab/DOM order (`var arWnds = [...]`), which objects make up a question
 * (`qu90.arChld = [...]`, `qu90.arChoices = [...]`) and the
 * navigation functions (`trivNextChapter` names the next chapter's first
 * page). Each device folder (device_Desktop/pageNNN.js) holds the rendered
 * objects as `<var>.rcdData.att_<Device> = { innerHtml, cssText, cwObj, objData }`
 * literals, plus `rcdObj.rcdData.att_<Device>.pageIdx`, the page's place in
 * the title. A test is base64 XML in `_tobj<id>.txt`: name, passing grade,
 * member pages and per-choice feedback. Chapters have no names in the publish.
 */
type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Answer keys are written as `\uXXXX` escapes inside an already escaped string. */
const unescapeJs = (s: string) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
/** Text drawn inside an SVG shape or button. */
const tspans = (html: string) => [...html.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => decode(m[1] ?? "").trim()).filter(Boolean).join(" ");
const options = (html: string) => [...html.matchAll(/<option[^>]*\bvalue="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => ({ value: decode(m[1] ?? ""), label: decode(m[2] ?? "").trim() }));
/** Actions that only move between pages or submit a question: navigation chrome, not content. */
const NAV_ACTION = /^(GoTo|OnMClk|xAPI_Statement)/;
const FORM = new Set(["jsWndFormRadio", "jsWndFormCheck", "jsWndFormEntry", "jsWndFormList", "jsWndFormArea"]);

type Obj = { name: string; authoredName: string; cls: string; html: string; css: string; hidden: boolean; htmlId: string; actions: string[]; cw: J; data: J };
type Question = { name: string; children: string[]; choices: J[] };
type Action = { call: string; args: string[] } | { condition: string; yes: Action[]; no: Action[] };
type Event = { on: number; actions: Action[] };
type PageSrc = {
	file: string;
	id: string;
	title: string;
	idx: number;
	nextChapter: string;
	order: string[];
	objects: Map<string, Obj>;
	questions: Question[];
	functions: Map<string, Action[]>;
	groups: Map<string, string[]>;
	events: Map<string, Event[]>;
	/** Strings actions write into text objects (feedback swaps, scores). */
	changed: string[];
	/** Variables whose runtime value is spliced into text. */
	variables: string[];
	css: string;
	font: J;
	background: string;
	backgroundImage: string;
	pageStyle: string;
};
type Test = { id: string; name: string; passingScore?: number; pages: string[]; feedback: Map<string, string[]> };

/** A page title spliced into a JS string literal that is itself HTML. */
const jsHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/[\\"]/g, "\\$&");

// Tokenise only to read recorded action statements. Strings/comments remain opaque;
// no package code is evaluated, and unsupported statements stay explicit losses.
const actionTokens = (s: string): string[] => (s.match(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|[\w$]+|===|!==|==|!=|[^\s]/g) ?? []).filter((s) => !s.startsWith("//") && !s.startsWith("/*"));
const actionString = (s: string | undefined): string | undefined => s && /^(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')$/.test(s) ? str(parseLiteral(s)) : undefined;
/** Index after a balanced (), [] or {} group, without inspecting string tokens. */
function afterGroup(tokens: string[], start: number): number {
	const closes: string[] = [];
	for (let i = start; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (["(", "[", "{"].includes(t)) closes.push({ "(": ")", "[": "]", "{": "}" }[t]!);
		else if ([")", "]", "}"].includes(t) && t !== closes.pop()) return tokens.length;
		if (!closes.length) return i + 1;
	}
	return tokens.length;
}

function recordedActions(tokens: string[]): Action[] {
	try { return parseActions(tokens); } catch { return [{ call: "unsupported", args: [] }]; }
}

function parseActions(tokens: string[], depth = 0): Action[] {
	if (depth >= 32) throw new Error("action nesting limit");
	let i = 0;
	const statement = (level = depth): Action[] => {
		if (level >= 32) throw new Error("action nesting limit");
		if (tokens[i] === ";") { i++; return []; }
		if (tokens[i] === "{") {
			const end = afterGroup(tokens, i);
			const out = parseActions(tokens.slice(i + 1, end - 1), level + 1);
			i = end;
			return out;
		}
		if (tokens[i] === "if" && tokens[i + 1] === "(") {
			const end = afterGroup(tokens, i + 1);
			const condition = tokens.slice(i + 2, end - 1).join("");
			i = end;
			const yes = statement(level + 1);
			const no = tokens[i] === "else" ? (i++, statement(level + 1)) : [];
			// The publisher's completion callback contains no feedback.
			if (/^typeofpF===?['"]function['"]$/.test(condition) && yes.every((a) => "call" in a && a.call === "pF" && !a.args.length) && !no.length) return [];
			return [{ condition, yes, no }];
		}
		const start = i;
		while (i < tokens.length && tokens[i] !== ";" && tokens[i] !== "else") {
			if (["(", "[", "{"].includes(tokens[i]!)) i = afterGroup(tokens, i);
			else i++;
		}
		const part = tokens.slice(start, i);
		if (tokens[i] === ";") i++;
		// Disabled publisher actions can contain only a literal true expression.
		if (part.length === 1 && part[0] === "true") return [];
		const open = part.indexOf("(");
		const call = part.slice(0, open).join("");
		if (open < 1 || afterGroup(part, open) !== part.length || !/^[\w$]+(?:\.[\w$]+)?$/.test(call)) return [{ call: "unsupported", args: [] }];
		const args: string[] = [];
		for (let j = open + 1, begin = j; j < part.length; j++) {
			if (j === part.length - 1 || part[j] === ",") { if (j > begin) args.push(part.slice(begin, j).join("")); begin = j + 1; }
			else if (["(", "[", "{"].includes(part[j]!)) j = afterGroup(part, j) - 1;
		}
		return [{ call, args }];
	};
	const out: Action[] = [];
	while (i < tokens.length) {
		const before = i;
		out.push(...statement());
		if (i === before) { out.push({ call: "unsupported", args: [] }); break; }
	}
	return out;
}

function recordedEvents(tokens: string[], start: number): Event[] {
	const events: Event[] = [];
	const end = afterGroup(tokens, start);
	for (let i = start + 1; i < end - 1; i++) {
		if (tokens[i] !== "{") continue;
		const next = afterGroup(tokens, i);
		const entry = tokens.slice(i, next);
		const data = obj(parseLiteral(entry.join("")));
		const act = entry.findIndex((t, j) => /^(?:actItem|"actItem"|'actItem')$/.test(t) && entry[j + 1] === ":");
		const body = act >= 0 && entry[act + 2] === "function" && entry[act + 3] === "(" ? afterGroup(entry, act + 3) : -1;
		if (typeof data.on === "number") events.push({ on: data.on, actions: body >= 0 && entry[body] === "{" && (!("delay" in data) || data.delay === 0) ? recordedActions(entry.slice(body + 1, afterGroup(entry, body) - 1)) : [{ call: "unsupported", args: [] }] });
		i = next - 1;
	}
	return events;
}

function readPage(root: string, file: string, device: string): PageSrc {
	const path = insidePackage(root, file);
	const html = path ? readFileSync(path, "utf8") : "";
	const id = file.replace(/\.html$/i, "");
	const title = text(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]) || id;
	const decl = new Map<string, string>();
	const authoredNames = new Map<string, string>();
	for (const m of html.matchAll(/\bvar (\w+) = new (jsWnd\w+)\(\)(?:;[ \t]*\/\/([^\r\n]*))?/g)) {
		decl.set(m[1] ?? "", m[2] ?? "");
		authoredNames.set(m[1] ?? "", m[3]?.trim() ?? "");
	}
	const names = (s: string) => s.split(",").map((n) => n.trim()).filter(Boolean);
	const order = names(/var arWnds\s*=\s*\[([^\]]*)\]/.exec(html)?.[1] ?? "");
	const nextChapter = /function trivNextChapter\(\)\s*\{\s*trivExitPage\(\s*'([^']*)'/.exec(html)?.[1] ?? "";
	const questions: Question[] = [...html.matchAll(/\b(qu\d+)\.arChld\s*=\s*\[([^\]]*)\]/g)].map((m) => ({ name: m[1] ?? "", children: names(m[2] ?? ""), choices: [] }));
	for (const m of html.matchAll(/\b(qu\d+)\.arChoices\s*=\s*(\[[\s\S]*?\]);/g)) {
		const q = questions.find((x) => x.name === m[1]);
		if (q) q.choices = arr(parseLiteral(m[2] ?? "[]")).map(obj);
	}

	const devFile = insidePackage(root, `${device}/${id}.js`);
	const variables: string[] = [];
	const src = (devFile ? readFileSync(devFile, "utf8") : "").replace(/"\s*\+\s*([\w$]+)\.getValueForDisplay\(\)\s*\+\s*"/g, (_, v: string) => {
		if (v === "VarCurrentPageName") return jsHtml(title);
		if (!variables.includes(v)) variables.push(v);
		return "";
	});
	const objects = new Map<string, Obj>();
	const events = new Map<string, Event[]>();
	let idx = Number.POSITIVE_INFINITY;
	let font: J = {};
	const records = [...src.matchAll(/^(\w+)\.rcdData\.att_\w+\s*=\s*\{/gm)];
	for (const [i, m] of records.entries()) {
		const name = m[1] ?? "";
		let o: J;
		try {
			o = obj(parseLiteral(src, (m.index ?? 0) + m[0].length - 1));
		} catch {
			continue;
		}
		if (name === "rcdObj") {
			if (typeof o.pageIdx === "number") idx = o.pageIdx;
			font = obj(o.font);
			continue;
		}
		const cw = obj(o.cwObj);
		const tokens = actionTokens(src.slice(m.index + m[0].length - 1, records[i + 1]?.index));
		const record = tokens.slice(0, afterGroup(tokens, 0));
		const childActions = record.findIndex((t, i) => /^(?:arChld|"arChld"|'arChld')$/.test(t) && record[i + 1] === ":" && record[i + 2] === "[");
		if (childActions >= 0) events.set(name, recordedEvents(record, childActions + 2));
		objects.set(name, {
			name,
			authoredName: str(cw.name) || authoredNames.get(name) || "",
			cls: decl.get(name) ?? "",
			html: str(o.innerHtml),
			css: str(o.cssText),
			hidden: /visibility:\s*hidden/.test(str(o.cssText)),
			htmlId: str(o.htmlId),
			actions: arr(cw.arChld).map((a) => str(obj(a).name)).filter(Boolean),
			cw,
			data: obj(o.objData),
		});
	}
	const changed = [...`${html}\n${src}`.matchAll(/\.changeContents\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => text(str(parseLiteral(`"${m[1]}"`)))).filter((s) => /\p{L}/u.test(s));
	// Only linked local stylesheets, in document order. Remote fonts are not fetched.
	const css: string[] = [];
	for (const m of html.matchAll(/<link\b[^>]*>|<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
		if (m[1] !== undefined) css.push(m[1]);
		else {
			const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1];
			const path = href && /\brel\s*=\s*["']stylesheet["']/i.test(m[0]) ? insidePackage(root, decode(href)) : undefined;
			if (path) css.push(readFileSync(path, "utf8"));
		}
	}
	const bg = /rcdObj\.backgrd_\w+\s*=\s*\[/.exec(src);
	const backgroundData = bg ? arr(parseLiteral(src, bg.index + bg[0].length - 1)) : [];
	const background = str(backgroundData[0]);
	const backgroundImage = str(backgroundData[1]);
	const style = /rcdObj\.pgStyle_\w+\s*=\s*/.exec(src);
	const pageStyle = style ? str(parseLiteral(src, style.index + style[0].length)) : "";
	const functions = new Map<string, Action[]>();
	const groups = new Map<string, string[]>();
	const tokens = actionTokens(`${html}\n${src}`);
	for (let i = 0; i < tokens.length; i++) {
		const name = tokens[i]!;
		if (/^(?:action\w+|grpAction\w+)$/.test(name) && tokens[i + 1] === "=" && tokens[i + 2] === "function" && tokens[i + 3] === "(") {
			const body = afterGroup(tokens, i + 3);
			if (tokens[body] === "{") functions.set(name, recordedActions(tokens.slice(body + 1, afterGroup(tokens, body) - 1)));
		}
		if (tokens[i + 1] !== ".") continue;
		if (tokens.slice(i + 2, i + 5).join("") === "arChld=[") groups.set(name, tokens.slice(i + 5, afterGroup(tokens, i + 4) - 1).filter((t) => /^[\w$]+$/.test(t)));
		if (tokens.slice(i + 2, i + 7).join("") === "cwObj.arChld=[") events.set(name, recordedEvents(tokens, i + 6));
	}
	const inventoryActions = (actions: Action[]) => {
		for (const a of actions) {
			if ("condition" in a) { inventoryActions(a.yes); inventoryActions(a.no); }
			else {
				for (const arg of a.call === "trivAlert" ? a.args.slice(1, 3) : a.call.endsWith(".changeContents") ? a.args.slice(0, 1) : []) {
					const value = text(actionString(arg));
					if (value && !changed.includes(value)) changed.push(value);
				}
			}
		}
	};
	for (const actions of functions.values()) inventoryActions(actions);
	for (const list of events.values()) for (const event of list) inventoryActions(event.actions);
	return { file, id, title, idx, nextChapter, order, objects, questions, functions, groups, events, changed, variables, css: css.join("\n"), font, background, backgroundImage, pageStyle };
}

/** Lectora uses hex and rgb() in page styles, plus black/white in its base CSS. */
function colour(value: string | undefined): string | undefined {
	const s = value?.trim().toLowerCase() ?? "";
	if (/^#[\da-f]{6}$/.test(s)) return s;
	if (/^#[\da-f]{3}$/.test(s)) return `#${[...s.slice(1)].map((x) => x + x).join("")}`;
	if (s === "black" || s === "white") return s === "black" ? "#000000" : "#ffffff";
	const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(s)?.slice(1).map(Number);
	return rgb?.every((n) => n <= 255) ? `#${rgb.map((n) => n.toString(16).padStart(2, "0")).join("")}` : undefined;
}

const declarations = (css: string): Record<string, string> => Object.fromEntries([...css.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)].map((m) => [m[1]?.toLowerCase(), m[2]?.replace(/\s*!important\s*$/i, "").trim()]));
const pixels = (s: string | undefined) => s && /^-?\d+(?:\.\d+)?(?:px)?$/.test(s) ? Number.parseFloat(s) : Number.NaN;
const fixedGeometry = (css: Record<string, string>) => !css.transform && !css["-webkit-transform"] && ["left", "top", "width", "height"].every((key) => css[key] === undefined || Number.isFinite(pixels(css[key])));
const fontFamily = (s: string | undefined) => s?.split(",")[0]?.trim().replace(/^["']|["']$/g, "") || undefined;

function textRules(source: string): Map<string, Record<string, string>> {
	const rules = new Map<string, Record<string, string>>();
	// ponytail: only flat body/.ttxt rules and inline styles; a full CSS cascade is
	// needed if a future publish relies on conditional rules or selector inheritance.
	let css = source.replace(/\/\*[\s\S]*?\*\//g, "");
	while (/@[^{}]*\{[^{}]*\}/.test(css)) css = css.replace(/@[^{}]*\{[^{}]*\}/g, "");
	// Drop nested at-rule bodies rather than selecting a viewport during import.
	css = css.replace(/@[^{}]*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
	for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) for (const s of (m[1] ?? "").split(",").map((s) => s.trim())) {
		if (/^(body|\.ttxt|(?:\.ttxt )?h[1-6])$/.test(s)) rules.set(s, { ...rules.get(s), ...declarations(m[2] ?? "") });
	}
	return rules;
}

function lectoraTheme(root: string, pages: PageSrc[], isChrome: (o: Obj) => boolean, losses: Loss[]): Theme {
	const weights = new Map<keyof Theme, Map<string, number>>();
	const pageFonts = new Map<string, number>();
	const add = (key: keyof Theme, value: string | undefined, count: number) => {
		if (!value || !count) return;
		const values = weights.get(key) ?? new Map<string, number>();
		values.set(value, (values.get(value) ?? 0) + count);
		weights.set(key, values);
	};
	const marked = new Map<string, Set<string>>();
	const shapeFill = (o: Obj) => colour(declarations(/<path\b[^>]*\bstyle="([^"]*)"/i.exec(o.html)?.[1] ?? "").fill);
	const templateKey = (o: Obj) => `${str(o.cw.name)}\n${o.cls}\n${o.cls === "jsWndImage" ? /\bsrc="([^"]+)"/.exec(o.html)?.[1] : shapeFill(o)}`;
	for (const p of pages) for (const o of p.objects.values()) {
		if (o.hidden) continue;
		const name = str(o.cw.name);
		if (/\blogo\b/i.test(name.replace(/_/g, " ")) || /^(?:(header|title|nav(?:igation)?)[ _-]*(background|bar)|background[ _-]*color)$/i.test(name)) {
			const key = templateKey(o);
			const files = marked.get(key) ?? new Set<string>();
			files.add(p.file);
			marked.set(key, files);
		}
	}
	for (const p of pages) {
		const rules = textRules(p.css);
		const base = { ...rules.get("body"), ...rules.get(".ttxt") };
		const family = fontFamily(str(p.font.name)) || fontFamily(base["font-family"]);
		const bodyColour = colour(str(p.font.color)) || colour(base.color);
		if (family) pageFonts.set(family, (pageFonts.get(family) ?? 0) + 1);
		let background = colour(p.background) || colour(rules.get("body")?.["background-color"]);
		for (const o of p.objects.values()) {
			if (o.hidden) continue;
			const markedTemplate = (marked.get(templateKey(o))?.size ?? 0) >= 3;
			if (markedTemplate && o.cls === "jsWndImage" && /\blogo\b/i.test(str(o.cw.name).replace(/_/g, " "))) {
				const src = decode(/\bsrc="([^"]+)"/.exec(o.html)?.[1] ?? "");
				if (src && insidePackage(root, src)) add("logo", src, 1);
			}
			if (markedTemplate && o.cls === "jsWndShape" && /^(header|title|nav(?:igation)?)[ _-]*(background|bar)$/i.test(str(o.cw.name))) {
				add("accent", shapeFill(o), 1);
			}
			// Authored Background_Color shapes cover the page's underlying backgrd colour.
			if (markedTemplate && o.cls === "jsWndShape" && /^background[ _-]*color$/i.test(str(o.cw.name))) {
				background = shapeFill(o) || background;
			}
			if (o.cls !== "jsWndText" || o.data.bHideFromScrRdr === true || isChrome(o)) continue;
			const defaults = declarations(o.css);
			type Node = DefaultTreeAdapterMap["childNode"] | DefaultTreeAdapterMap["documentFragment"];
			const walk = (n: Node, font: string | undefined, color: string | undefined, heading: boolean): void => {
				if (n.nodeName === "#text") {
					const count = [...(n as DefaultTreeAdapterMap["textNode"]).value.replace(/\s/g, "")].length;
					add(heading ? "headingFont" : "bodyFont", font, count);
					if (!heading) add("text", color, count);
				} else if ("childNodes" in n) {
					if ("tagName" in n) {
						if (["script", "style"].includes(n.tagName)) return;
						heading ||= /^h[1-6]$/.test(n.tagName);
						const style = { ...rules.get(n.tagName), ...rules.get(`.ttxt ${n.tagName}`), ...declarations(n.attrs.find((a) => a.name === "style")?.value ?? "") };
						font = fontFamily(style["font-family"]) || font;
						color = colour(style.color) || color;
					}
					for (const c of n.childNodes) walk(c, font, color, heading);
				}
			};
			walk(parse(o.html), fontFamily(defaults["font-family"]) || family, colour(defaults.color) || bodyColour, false);
		}
		add("background", background, 1);
	}
	if (!weights.get("bodyFont")?.size) weights.set("bodyFont", pageFonts);
	// Fonts/text colours are weighted by non-whitespace Unicode characters. Page
	// backgrounds and marked template colours/logos by pages; ties use code-unit order.
	const theme: Theme = { navigation: "slides" };
	for (const [key, values] of weights) {
		const value = [...values].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0];
		if (value) Object.assign(theme, { [key]: value });
	}
	losses.push({ at: "course", source: "lectora:theme", effect: "approximated", detail: "Page fonts and inline text colours are reduced to their most-used values; marked repeated header and background shapes supply theme colours. Fixed page layouts, template artwork, background images, per-object styling and the full CSS cascade are not retained. Sources: pageNNN.html, device page data and linked stylesheets." });
	return theme;
}

function readTests(root: string): Test[] {
	return readdirSync(root)
		.filter((f) => /^_tobj\d+\.txt$/.test(f))
		.sort()
		.flatMap((f) => {
			const file = insidePackage(root, f);
			if (!file) return [];
			const doc = parseXml(Buffer.from(readFileSync(file, "utf8").trim(), "base64").toString("utf8"));
			const t = find(doc, "lectoratest")[0];
			if (!t) return [];
			const grade = Number(textOf(kids(t, "passinggrade")[0]));
			const feedback = new Map<string, string[]>();
			const pages = kids(t, "page").map((p) => {
				for (const q of kids(p, "question")) {
					const fbs = textOf(kids(q, "choicefbs")[0]);
					if (fbs) feedback.set(textOf(kids(q, "id")[0]), fbs.split("~|~"));
				}
				return textOf(kids(p, "name")[0]);
			});
			return [{ id: f.replace(/\.txt$/, ""), name: textOf(kids(t, "name")[0]) || "Test", ...(Number.isFinite(grade) && grade > 0 ? { passingScore: grade } : {}), pages, feedback }];
		});
}

/** Read the supported action subset; never execute package JavaScript. */
function resolveActions(p: PageSrc, entry: string | Action[], condition?: (value: string) => boolean | undefined) {
	const visited = new Set<string>();
	const problems = new Set<string>();
	const shown = new Map<string, boolean>();
	const changed = new Map<string, string>();
	const messages: string[] = [];
	const active = new Set<string>();
	let steps = 0;
	const fail = (reason: string) => { problems.add(reason); };
	const follow = (id: string, actions: Action[] | undefined, depth: number) => {
		if (depth >= 32 || ++steps > 1024 || active.has(id)) { fail("cycle or traversal limit"); return; }
		if (!actions) { fail("missing action definition"); return; }
		visited.add(id);
		active.add(id);
		walk(actions, depth + 1);
		active.delete(id);
	};
	const event = (name: string, on: number, depth: number) => {
		const events = p.events.get(name);
		if (!events && on === 1001) fail("missing object actions");
		for (const [i, e] of (events ?? []).entries()) if (e.on === on) follow(`${name}:${i}`, e.actions, depth);
	};
	const visibility = (name: string, show: boolean, depth: number) => {
		if (depth >= 32 || ++steps > 1024) { fail("cycle or traversal limit"); return; }
		if (!p.objects.has(name) && !p.groups.has(name)) fail("missing feedback object");
		shown.set(name, show);
		for (const child of p.groups.get(name) ?? []) visibility(child, show, depth + 1);
		event(name, show ? 5 : 8, depth + 1);
	};
	const walk = (actions: Action[], depth: number): void => {
		if (depth >= 32 || ++steps > 1024) { fail("cycle or traversal limit"); return; }
		for (const action of actions) {
			if ("condition" in action) {
				const branch = condition?.(action.condition);
				if (branch === undefined) { fail("unsupported feedback condition"); continue; }
				walk(branch ? action.yes : action.no, depth + 1);
				continue;
			}
			const [name, method] = action.call.split(".");
			if (!method && p.functions.has(name!) && (!action.args.length || action.args.length === 1 && action.args[0] === "pF")) follow(name!, p.functions.get(name!), depth);
			else if (method === "issueActions" && action.args.length === 1 && /^\d+$/.test(action.args[0] ?? "")) event(name!, Number(action.args[0]), depth);
			else if ((method === "show" || method === "hide") && !action.args.length) visibility(name!, method === "show", depth);
			else if (method === "changeContents" && actionString(action.args[0]) !== undefined && action.args.length === 1) {
				changed.set(name!, actionString(action.args[0])!);
				if (!shown.has(name!)) shown.set(name!, !p.objects.get(name!)?.hidden);
			} else if (action.call === "trivAlert" && action.args.slice(0, 3).every((a) => actionString(a) !== undefined) && (action.args.length === 3 || action.args.length === 4 && action.args[3] === "pF")) {
				for (const arg of action.args.slice(1, 3)) messages.push(inline(actionString(arg)!));
			} else if (action.call !== "pF" || action.args.length) fail("unsupported feedback action");
		}
	};
	if (typeof entry === "string") follow(entry, p.functions.get(entry), 0);
	else walk(entry, 0);
	return { shown, changed, messages, visited, problems };
}

/** Resolve only the publisher's recorded feedback operations, in authored order. */
function questionFeedback(p: PageSrc, q: Question, losses: Loss[]) {
	const cw = p.objects.get(q.name)?.cw ?? {};
	const keys = [...arr(cw.arrAns), ...arr(cw.arAnswers)].map((a) => unescapeJs(str(a)));
	const consumed = new Set<string>();
	const retainedChanges = new Set<string>();
	const visited = new Set<string>();
	const fields: { correct?: string; incorrect?: string } = {};
	const problems = new Set<string>();
	for (const outcome of ["correct", "incorrect"] as const) {
		const entry = str(cw[`${outcome}FeedbackFunc`]);
		if (!entry || entry === "0") continue;
		const { shown, changed, messages, visited: followed, problems: failed } = resolveActions(p, entry, (value) => {
			const m = /^(!?)(VarQuestion_\d+)\.(isCorr|isCorrFIB)\(("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')(?:,([01]),([01]))?\)$/.exec(value);
			const key = actionString(m?.[4]);
			const flags = Number(cw.dwQuestFlags) || 0;
			const matches = m?.[3] === "isCorrFIB" ? key === keys.join("~;~") && m[5] === String(Number(!!(flags & 0x400000))) && m[6] === String(Number(!!(flags & 0x800000))) : keys.length === 1 && key === keys[0] && !m?.[5];
			if (!m || m[2] !== `VarQuestion_${q.name.slice(2)}` || !matches) return undefined;
			return (outcome === "correct") !== !!m[1];
		});
		for (const id of followed) visited.add(id);
		for (const reason of failed) problems.add(reason);
		if (failed.size) continue;
		for (const message of messages) retainedChanges.add(text(message));
		const parts: string[] = [];
		for (const [name, visible] of shown) {
			const o = p.objects.get(name);
			if (!o) continue;
			if (o.hidden) consumed.add(name);
			if (!visible) continue;
			const html = changed.get(name) ?? o.html;
			const value = o.cls === "jsWndText" ? inline(html) : o.cls === "jsWndShape" ? neutralize(tspans(html)) : "";
			if (value) {
				parts.push(value);
				if (changed.has(name)) retainedChanges.add(text(html));
			}
			else if (o.cls === "jsWndImage" || o.cls === "jsWndTextButton") problems.add("feedback artwork or controls");
		}
		const value = [...parts, ...messages].filter(Boolean).join(" ");
		if (value) fields[outcome] = value;
	}
	// A hidden object also referenced outside these chains is shared content.
	const shared = new Set<string>();
	const sharedActions = new Set<Action[]>();
	const preserve = (actions: Action[]) => {
		const pending = [actions];
		for (let i = 0; i < pending.length; i++) {
			const list = pending[i]!;
			if (sharedActions.has(list)) continue;
			sharedActions.add(list);
			for (const a of list) {
				if ("condition" in a) { pending.push(a.yes, a.no); continue; }
				const [name, method] = a.call.split(".");
				const fn = p.functions.get(a.call);
				if (fn) pending.push(fn);
				if (method === "issueActions") for (const e of p.events.get(name!) ?? []) if (String(e.on) === a.args[0]) pending.push(e.actions);
				if (method !== "show" && method !== "changeContents") continue;
				const queue = [name!];
				for (let j = 0; j < queue.length; j++) {
					const target = queue[j]!;
					if (shared.has(target)) continue;
					shared.add(target);
					queue.push(...(p.groups.get(target) ?? []));
					if (method === "show") for (const e of p.events.get(target) ?? []) if (e.on === 5) pending.push(e.actions);
				}
			}
		}
	};
	for (const [name, actions] of p.functions) if (!visited.has(name)) preserve(actions);
	for (const [name, events] of p.events) for (const [i, e] of events.entries()) if (!visited.has(`${name}:${i}`)) preserve(e.actions);
	for (const name of shared) consumed.delete(name);
	if (problems.size) losses.push({ at: `${p.id}/${q.name}`, source: "lectora:feedback", effect: "dropped", detail: `Feedback could not be fully represented: ${[...problems].sort().join(", ")}.` });
	return { fields, consumed, retainedChanges };
}

function groupMembers(p: PageSrc) {
	const members = new Map<string, Set<string>>();
	for (const name of p.groups.keys()) {
		const found = new Set<string>();
		const queue = [{ name, depth: 0 }];
		for (let i = 0; i < queue.length; i++) {
			const item = queue[i]!;
			if (i >= 1024 || item.depth >= 32) return;
			if (found.has(item.name)) continue;
			found.add(item.name);
			for (const child of p.groups.get(item.name) ?? []) queue.push({ name: child, depth: item.depth + 1 });
		}
		members.set(name, found);
	}
	return members;
}

/** A single-use scene, or buttons that hide the other panels, records an exclusive choice. */
function branchingChoice(p: PageSrc, isChrome: (o: Obj) => boolean, losses: Loss[]) {
	if (p.questions.length) return;
	const ordered = p.order.map((name) => p.objects.get(name)).filter((o): o is Obj => !!o);
	const readable = (o: Obj) => o.data.bHideFromScrRdr === true ? "" : o.cls === "jsWndText" ? inline(o.html) : o.cls === "jsWndShape" ? neutralize(tspans(o.html)) : "";
	const members = groupMembers(p);
	if (!members) return;
	const buttons = ordered.filter((o) => o.cls === "jsWndTextButton" && !isChrome(o) && p.events.get(o.name)?.some((e) => e.on === 2));
	const candidates = buttons.flatMap((button) => {
		const result = resolveActions(p, [{ call: `${button.name}.issueActions`, args: ["2"] }]);
		if (result.problems.size) return [];
		const panels = [...members].filter(([name, children]) => result.shown.get(name) === true && [...children].every((n) => {
			const o = p.objects.get(n);
			return members.has(n) || !!o && o.hidden && ["jsWndText", "jsWndShape", "jsWndImage"].includes(o.cls);
		}) && [...children].some((n) => {
			const o = p.objects.get(n);
			return o && result.shown.get(n) === true && readable(o);
		}));
		// Nested groups are part of their outer panel, not additional outcomes.
		const outer = panels.filter(([name]) => !panels.some(([other, children]) => other !== name && children.has(name)));
		return outer.length === 1 ? [{ button, result, panel: outer[0]![0], children: outer[0]![1] }] : [];
	});
	if (candidates.length < 2) return;
	for (const a of candidates) for (const b of candidates) {
		if (a === b) continue;
		if ([...a.children].some((n) => b.children.has(n))) return;
		const hidesChoices = candidates.every((c) => a.result.shown.get(c.button.name) === false);
		if (a.result.shown.get(b.panel) !== false && !hidesChoices) return;
	}
	// An unresolved sibling button must not disappear from the imported choice.
	if (buttons.some((b) => !candidates.some((c) => c.button === b) && candidates.some((c) => c.result.shown.get(b.name) === false))) return;
	const consumed = new Set<string>();
	const retainedChanges = new Set<string>();
	let artwork = false;
	const opts: Option[] = [];
	const keys: Array<boolean | undefined> = [];
	for (const c of candidates) {
		const { button, result, children } = c;
		const optionLabel = (o: Obj) => o.cls === "jsWndText" && o.hidden === button.hidden && readable(o) && !candidates.some((other) => other.children.has(o.name));
		const labelledBy = [...button.html.matchAll(/\baria-labelledby=["']([^"']+)["']/g)].flatMap((m) => m[1]!.split(/\s+/));
		const linked = ordered.filter((o) => optionLabel(o) && (labelledBy.includes(o.htmlId) || [...o.html.matchAll(/<label\b[^>]*\bfor=["']([^"']+)["']/g)].some((m) => m[1] === button.htmlId)));
		// Only a group containing one option can supply text attached to that option.
		const attached = linked.length ? linked : [...members.values()].filter((names) => names.has(button.name) && candidates.filter((other) => names.has(other.button.name)).length === 1)
			.sort((a, b) => a.size - b.size).map((names) => ordered.filter((o) => names.has(o.name) && optionLabel(o))).find((texts) => texts.length);
		const optionText = attached?.map(readable).join(" ") || neutralize(tspans(button.html)) || inline(button.html) || neutralize(str(button.data.altValue) || str(button.data.titleValue));
		if (!optionText) return;
		consumed.add(button.name);
		for (const o of attached ?? []) consumed.add(o.name);
		const markers = new Set([...children].flatMap((name) => {
			const o = p.objects.get(name);
			// Authored object names are metadata; learner-facing feedback prose is never an answer key.
			const marker = /(?:^|[_ -])(incorrect|correct)(?:$|[_ -])/i.exec(o?.authoredName ?? "")?.[1]?.toLowerCase();
			return marker ? [marker === "correct"] : [];
		}));
		keys.push(markers.size === 1 ? [...markers][0] : undefined);
		const feedback: string[] = [];
		for (const o of ordered) {
			if (children.has(o.name)) consumed.add(o.name);
			if (!o.hidden || result.shown.get(o.name) !== true) continue;
			if (!["jsWndText", "jsWndShape", "jsWndImage"].includes(o.cls)) return;
			consumed.add(o.name);
			const html = result.changed.get(o.name);
			const value = readable(html === undefined ? o : { ...o, html });
			if (value) feedback.push(value);
			if (html !== undefined) retainedChanges.add(text(html));
			artwork ||= o.cls === "jsWndImage" || /<(?:img|svg)\b/i.test(o.html);
		}
		if (!feedback.length) return;
		for (const message of result.messages) retainedChanges.add(text(message));
		opts.push({ text: optionText, correct: false, feedback: [...feedback, ...result.messages].join(" ") });
	}
	const first = ordered.indexOf(candidates[0]!.button);
	const setup = ordered.slice(0, first).filter((o) => !o.hidden && !isChrome(o) && !consumed.has(o.name) && o.cls === "jsWndText" && readable(o) && text(o.html) !== p.title);
	if (!setup.length) return;
	for (const o of setup) consumed.add(o.name);
	const known = keys.every((key) => key !== undefined);
	if (known) for (const [i, option] of opts.entries()) option.correct = keys[i]!;
	const block: Block = { kind: "choice", prompt: setup.map(readable).join("\n"), scored: false, multiple: false, options: opts };
	losses.push({ at: p.id, source: "lectora:branching-choice", effect: "approximated", detail: `Exclusive button reveals imported as one practice choice with per-option feedback${artwork ? "; feedback panel pictures omitted" : ""}${known ? "" : "; no complete recorded answer key, so no answer is marked correct"}.` });
	return { block, at: candidates[0]!.button.name, consumed, retainedChanges };
}

/** Recorded reveal chains can coexist with separate button-state/animation actions. */
function revealAccordion(p: PageSrc, isChrome: (o: Obj) => boolean) {
	if (p.questions.length) return;
	const members = groupMembers(p);
	if (!members) return;
	const ordered = p.order.map((name) => p.objects.get(name)).filter((o): o is Obj => !!o);
	const buttons = ordered.filter((o) => o.cls === "jsWndTextButton" && !isChrome(o));
	const results = new Map(buttons.map((button) => {
		const shown = new Map<string, boolean>();
		for (const event of p.events.get(button.name) ?? []) {
			if (event.on !== 2) continue;
			const result = resolveActions(p, event.actions);
			if (result.problems.size || result.changed.size || result.messages.length) continue;
			for (const [name, visible] of result.shown) shown.set(name, visible);
		}
		return [button, shown];
	}));
	const closeButtons = new Set([...results].filter(([, shown]) => shown.size && [...shown.values()].every((value) => !value)).map(([button]) => button.name));
	const candidates = buttons.flatMap((button) => {
		const shown = results.get(button)!;
		const panels = [...members].filter(([name, children]) => shown.get(name) === true && [...children].every((n) => {
			const o = p.objects.get(n);
			return members.has(n) || closeButtons.has(n) || !!o && o.hidden && shown.get(n) === true && ["jsWndText", "jsWndShape", "jsWndImage"].includes(o.cls);
		}) && ordered.some((o) => children.has(o.name) && shown.get(o.name) === true && (o.cls === "jsWndImage" || o.cls === "jsWndText" && o.data.bHideFromScrRdr !== true && text(o.html) || o.cls === "jsWndShape" && tspans(o.html))));
		const outer = panels.filter(([name]) => !panels.some(([other, children]) => other !== name && children.has(name)));
		const title = neutralize(tspans(button.html)) || inline(button.html) || neutralize(str(button.data.altValue) || str(button.data.titleValue));
		return outer.length === 1 && title ? [{ button, title, panel: outer[0]![0], children: outer[0]![1], shown }] : [];
	});
	const visible = candidates.filter((c) => !c.button.hidden);
	if (visible.length < 2) return;
	for (const a of visible) for (const b of visible) if (a !== b && [...a.children].some((n) => b.children.has(n))) return;
	const consumed = new Set(visible.flatMap((c) => [c.button.name, ...c.children]));
	// The publisher duplicates buttons for visited states. They do not add items.
	for (const c of candidates) if (visible.some((v) => v.panel === c.panel && v.title === c.title)) consumed.add(c.button.name);
	for (const name of closeButtons) consumed.add(name);
	return { at: visible[0]!.button.name, consumed, items: visible.map((c) => ({ title: c.title, objects: ordered.filter((o) => c.children.has(o.name) && !closeButtons.has(o.name) && c.shown.get(o.name) === true) })) };
}

export function extractLectora(root: string): Course {
	const manifest = readManifest(root);
	const lom = existsSync(join(root, "metadata.xml")) ? find(parseXml(readFileSync(join(root, "metadata.xml"), "latin1")), "general")[0] : undefined;
	const indexHtml = existsSync(join(root, "index.html")) ? readFileSync(join(root, "index.html"), "utf8") : "";
	const title = manifest?.title || (lom ? textOf(find(lom, "title")[0]) : "") || text(/<title>([\s\S]*?)<\/title>/i.exec(indexHtml)?.[1]) || "Untitled course";
	const description = lom ? textOf(find(lom, "description")[0]) : "";
	const locale = (lom ? textOf(find(lom, "language")[0]) : "") || /<html[^>]*\blang="([^"]+)"/i.exec(indexHtml)?.[1] || "";
	const version = /GENERATED BY:\s*(Lectora.*?)\s*(?:\(http|-->)/.exec(indexHtml)?.[1]?.trim();
	const losses: Loss[] = [];
	const sourceText: string[] = [];

	const entries = readdirSync(root).sort();
	const devices = entries.filter((d) => d.startsWith("device_") && lstatSync(join(root, d)).isDirectory());
	const device = devices.includes("device_Desktop") ? "device_Desktop" : (devices[0] ?? "");
	if (device && device !== "device_Desktop") losses.push({ at: "package", source: "lectora:device", effect: "approximated", detail: `no device_Desktop folder; content read from ${device}` });
	const pages = entries
		.filter((f) => /^page\d+\.html$/i.test(f))
		.map((f) => readPage(root, f, device))
		.sort((a, b) => a.idx - b.idx || (a.file < b.file ? -1 : 1));
	if (!pages.length) throw new Error("Lectora package found, but no pageNNN.html files");
	const tests = readTests(root);
	const testOf = new Map<string, Test>();
	for (const t of tests) for (const f of t.pages) testOf.set(f, t);

	const label = (o: Obj) => str(o.data.altValue) || str(o.data.titleValue) || tspans(o.html);
	const isNav = (o: Obj) => o.actions.every((a) => NAV_ACTION.test(a));
	/** What a learner sees of an object, used to spot template chrome and to inventory text. */
	const seen = (o: Obj): string => {
		switch (o.cls) {
			case "jsWndText":
				return o.data.bHideFromScrRdr === true ? "" : text(o.html);
			case "jsWndImage":
				return /\bsrc="([^"]*)"/.exec(o.html)?.[1] ?? "";
			case "jsWndShape":
				return tspans(o.html);
			case "jsWndTextButton":
				return isNav(o) ? "" : label(o);
			case "jsWndFormList":
				return options(o.html).map((x) => x.label).join(" ");
			default:
				return FORM.has(o.cls) ? "" : text(o.html) || tspans(o.html);
		}
	};

	/** Objects shown on three or more pages are the title's template (logo, skip link, nav), not page content. */
	const chrome = new Set<string>();
	{
		const usage = new Map<string, Set<string>>();
		for (const p of pages)
			for (const o of p.objects.values()) {
				const k = seen(o) && `${o.cls}:${seen(o)}`;
				if (k) (usage.get(k) ?? usage.set(k, new Set()).get(k))?.add(p.file);
			}
		for (const [k, files] of usage) if (files.size >= 3) chrome.add(k);
		if (chrome.size) losses.push({ at: "package", source: "lectora:template", effect: "dropped", detail: `${chrome.size} objects repeated on 3+ pages are treated as title template chrome and skipped: ${[...chrome].sort().map((k) => k.replace(/^jsWnd\w+:/, "")).join(", ").slice(0, 300)}` });
	}
	// Authored pattern objects must also cover the page and have no readable label
	// or actions. A filename, or an ordinary large photograph, is not a designation.
	const backgrounds = new Set<Obj>();
	for (const p of pages) for (const o of p.objects.values()) {
		if (o.cls !== "jsWndImage" || o.actions.length || label(o) || /\balt="[^"]+"/.test(o.html)) continue;
		const css = declarations(o.css), page = declarations(p.pageStyle);
		const [x, y, w, h, pw, ph] = [css.left, css.top, css.width, css.height, page.width, page.height].map(pixels);
		const covers = fixedGeometry(css) && fixedGeometry(page) && !obj(o.data.rotateEffect).angle && pw! > 0 && ph! > 0 && x! <= 0 && y! <= 0 && x! + w! >= pw! && y! + h! >= ph!;
		if ((p.backgroundImage && seen(o) === p.backgroundImage) || (covers && /^(?:Image(?:Pattern|BG)(?:[_ -]|$)|Background(?:[_ -]|$))/i.test(str(o.cw.name)))) backgrounds.add(o);
	}
	const isChrome = (o: Obj) => backgrounds.has(o) || chrome.has(`${o.cls}:${seen(o)}`);
	const theme = lectoraTheme(root, pages, isChrome, losses);
	theme.density = theme.blockSpacing = "compact";
	const width = pages.map((p) => pixels(declarations(p.pageStyle).width)).find((w) => w > 0 && Number.isFinite(w));
	if (width) theme.contentWidth = width;

	const question = (p: PageSrc, q: Question, at: string): Block[] => {
		const qo = p.objects.get(q.name);
		const cls = qo?.cls ?? "";
		const cw = qo?.cw ?? {};
		const answers = [...arr(cw.arrAns), ...arr(cw.arAnswers)].map((a) => unescapeJs(str(a)));
		// A multiple-response key is one comma-joined string, and answers may themselves contain commas:
		// an option is correct when it appears whole as a delimited part. Entities are normalised on both sides.
		const keys = answers.map((a) => text(a));
		const isCorrect = (value: string) => {
			const v = text(value);
			return !!v && keys.some((k) => k === v || k.startsWith(`${v},`) || k.endsWith(`,${v}`) || k.includes(`,${v},`));
		};
		const children = q.children.map((n) => p.objects.get(n)).filter((o): o is Obj => !!o);
		const byId = new Map(children.map((c) => [c.htmlId, c]));
		const choiceText = new Set(q.choices.map((c) => str(c.txt)));
		const stem = children.find((c) => c.cls === "jsWndText" && !choiceText.has(c.htmlId));
		const prompt = (stem ? inline(stem.html) : "") || "Question";
		const fbs = tests.flatMap((t) => t.feedback.get(q.name.replace(/^qu/, "")) ?? []);
		const feedback = (i: number) => (fbs[i]?.trim() ? { feedback: inline(fbs[i]) } : {});
		let opts: Option[] = q.choices.flatMap((c, i) => {
			const t = byId.get(str(c.txt));
			const b = byId.get(str(c.btn));
			if (!t && !b) return [];
			const value = decode(/\bvalue="([^"]*)"/.exec(b?.html ?? "")?.[1] ?? "") || text(t?.html);
			return [{ text: t ? line(t.html) : neutralize(value), correct: isCorrect(value), ...feedback(i) }];
		});
		if (!opts.length) {
			const list = children.find((c) => c.cls === "jsWndFormList");
			if (list) opts = options(list.html).map((x, i) => ({ text: neutralize(x.label || x.value), correct: isCorrect(x.value), ...feedback(i) }));
		}
		const lose = (effect: Loss["effect"], detail: string) => losses.push({ at, source: `lectora:question/${cls.replace(/^jsWnd/, "") || "unknown"}`, effect, detail });
		switch (cls) {
			case "jsWndMultiChoiceQuestion":
			case "jsWndMultiResponseQuestion": {
				if (!opts.length) {
					lose("dropped", "question has no readable answer options; its text is kept as a paragraph");
					return [{ kind: "paragraph", text: prompt }];
				}
				if (!opts.some((o) => o.correct)) lose("approximated", "no correct answer found; imported with none marked");
				return [{ kind: "choice", prompt, multiple: cls === "jsWndMultiResponseQuestion" || opts.filter((o) => o.correct).length > 1, options: opts }];
			}
			case "jsWndFillBlankQuestion": {
				if (!answers[0]) {
					lose("approximated", "accepted answers could not be read; imported as a free response");
					return [{ kind: "freeResponse", prompt }];
				}
				lose("approximated", "the blank's position in the sentence is not recorded in the package; the answer follows the prompt");
				return [{ kind: "fillBlank", prompt, parts: [{ answers }] }];
			}
			case "jsWndEssayQuestion":
				return [{ kind: "freeResponse", prompt }];
			case "jsWndOrdinalQuestion": {
				// trivantis-questions.js uses arChoices[].val as the response token,
				// arrAns[0] as the comma-separated correct order, and btnnm for each list.
				const values = q.choices.map((c) => str(c.val));
				const order = answers.length === 1 ? answers[0]!.split(",") : [];
				const labels = new Map(q.choices.map((c) => {
					const label = byId.get(str(c.txt));
					const list = p.objects.get(str(c.btnnm));
					return [str(c.val), label ? line(label.html) : neutralize(options(list?.html ?? "").find((o) => o.value === str(c.val))?.label ?? "")];
				}));
				if (values.length < 2 || new Set(values).size !== values.length || order.length !== values.length || new Set(order).size !== order.length || order.some((v) => !labels.get(v))) {
					lose("dropped", "ordering values, labels or complete answer key could not be read; question text is kept as a paragraph");
					return [{ kind: "paragraph", text: prompt }];
				}
				return [{ kind: "order", prompt, items: order.map((v) => labels.get(v)!) }];
			}
			default:
				lose("dropped", `${cls || "unknown"} question is not imported; its text is kept as a paragraph`);
				return [{ kind: "paragraph", text: prompt }];
		}
	};

	const build = (p: PageSrc): Page => {
		const at = p.id;
		const visible: Block[] = [];
		const heroItems: HeroItem[] = [];
		const numberedItems: HeroItem[] = [];
		const pictureItems: HeroItem[] = [];
		const hiddenPanels = new Map<HeroItem, string>();
		const members = [...(groupMembers(p) ?? [])].sort((a, b) => b[1].size - a[1].size);
		const page = declarations(p.pageStyle);
		const width = pixels(page.width);
		const rules = textRules(p.css);
		const baseStyle = { ...rules.get("body"), ...rules.get(".ttxt") };
		const hidden: Block[] = [];
		const counts = new Map<string, number>();
		const count = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
		const buttons = new Set<string>();
		const ctx = { base: "", lose: (source: string, detail: string) => losses.push({ at, source, effect: "dropped" as const, detail }) };
		const questionOf = new Map(p.questions.flatMap((q) => q.children.map((c) => [c, q] as const)));
		// Assessment groups score every member, so these practice-only choices stay outside tests.
		const branch = testOf.has(p.file) ? undefined : branchingChoice(p, isChrome, losses);
		const reveals = branch ? undefined : revealAccordion(p, isChrome);
		const feedbackOnly = new Set(branch?.consumed ?? reveals?.consumed);
		const retainedChanges = new Set(branch?.retainedChanges);
		const questions = new Map(p.questions.map((q) => {
			const feedback = questionFeedback(p, q, losses);
			const blocks = question(p, q, `${at}/${q.name}`);
			for (const b of blocks) {
				if (b.kind === "choice" || b.kind === "fillBlank" || b.kind === "order" || b.kind === "match" || b.kind === "categorize") {
					Object.assign(b, feedback.fields);
					for (const name of feedback.consumed) feedbackOnly.add(name);
					for (const value of feedback.retainedChanges) retainedChanges.add(value);
				} else if (feedback.fields.correct || feedback.fields.incorrect) losses.push({ at: `${at}/${q.name}`, source: "lectora:feedback", effect: "dropped", detail: "This question could not carry per-outcome feedback in the course model." });
			}
			return [q.name, blocks];
		}));
		const done = new Set<string>();
		const content = (o: Obj): Block[] => {
			if (o.actions.length && o.cls !== "jsWndTextButton") count("object with actions");
			switch (o.cls) {
				case "jsWndText":
					// Spacer paragraphs hold only zero-width or non-breaking spaces.
					return o.data.bHideFromScrRdr === true ? [] : htmlBlocks(o.html, ctx).filter((b) => b.kind !== "paragraph" || /[^\s​﻿ ]/.test(b.text));
				case "jsWndImage": {
					const css = declarations(o.css);
					const images = htmlBlocks(o.html, ctx).map((b): Block => {
						return b.kind === "image" && width > 0 && pixels(css.left) === 0 && pixels(css.width) === width && fixedGeometry(css) && fixedGeometry(page) && !obj(o.data.rotateEffect).angle ? { ...b, layout: "full" } : b;
					});
					if (fixedGeometry(page) && fixedGeometry(css) && !obj(o.data.rotateEffect).angle) {
						const item: HeroItem = { blocks: images, box: { x: pixels(css.left), y: pixels(css.top), w: pixels(css.width), h: pixels(css.height) }, order: 0 };
						pictureItems.push(item);
						if (o.hidden) {
							pictureLayout(images, [item], width);
							hiddenPanels.set(item, members.find(([, children]) => children.has(o.name))?.[0] ?? "");
						}
					}
					return images;
				}
				case "jsWndShape": {
					const t = tspans(o.html);
					return t ? [{ kind: "paragraph", text: neutralize(t) }] : [];
				}
				case "jsWndTextButton":
					if (isNav(o)) count("navigation button");
					else buttons.add(label(o) || o.name);
					return [];
				default: {
					if (FORM.has(o.cls)) {
						count("form field outside a question");
						return [];
					}
					const b = htmlBlocks(o.html, ctx);
					if (!b.length) count(`${o.cls.replace(/^jsWnd/, "") || "unknown"} object`);
					return b;
				}
			}
		};
		const accordion: Block | undefined = reveals ? { kind: "container", as: "accordion", items: reveals.items.map((item) => ({ title: item.title, blocks: item.objects.flatMap(content) })) } : undefined;
		for (const name of p.order) {
			const o = p.objects.get(name);
			if (o && name === branch?.at) (o.hidden ? hidden : visible).push(branch.block);
			if (name === reveals?.at && accordion) visible.push(accordion);
			if (!o || feedbackOnly.has(name)) continue;
			const target = o.hidden ? hidden : visible;
			const q = questionOf.get(name);
			if (q) {
				if (!done.has(q.name)) {
					done.add(q.name);
					target.push(...(questions.get(q.name) ?? []));
				}
				continue;
			}
			if (!isChrome(o)) {
				const emitted = content(o);
				target.push(...emitted);
				const css = declarations(o.css);
				if (!o.hidden && fixedGeometry(css) && !obj(o.data.rotateEffect).angle && [css.left, css.top, css.width, css.height].every((s) => Number.isFinite(pixels(s)))) {
					let fontSize: number | undefined;
					let color: string | undefined;
					const size = (value: string | undefined) => value?.endsWith("pt") ? pixels(value.slice(0, -2)) * 4 / 3 : pixels(value);
					const visit = (node: DefaultTreeAdapterMap["childNode"] | DefaultTreeAdapterMap["documentFragment"], font: number, ink?: string) => {
						if ("tagName" in node) {
							const style = { ...rules.get(node.tagName), ...rules.get(`.ttxt ${node.tagName}`), ...declarations(node.attrs.find((a) => a.name === "style")?.value ?? "") };
							if (Number.isFinite(size(style["font-size"]))) font = size(style["font-size"]);
							ink = colour(style.color) ?? ink;
						}
						if (node.nodeName === "#text" && "value" in node && node.value.trim() && (fontSize === undefined || (Number.isFinite(font) && font > fontSize))) { fontSize = Number.isFinite(font) ? font : undefined; color = ink; }
						if ("childNodes" in node) for (const child of node.childNodes) visit(child, font, ink);
					};
					visit(parse(o.html), size(css["font-size"] ?? (str(p.font.size) || baseStyle["font-size"])), colour(css.color) ?? colour(str(p.font.color)) ?? colour(baseStyle.color));
					const item: HeroItem = { blocks: emitted, box: { x: pixels(css.left), y: pixels(css.top), w: pixels(css.width), h: pixels(css.height) }, order: /^-?\d+$/.test(css["z-index"] ?? "") ? Number(css["z-index"]) : 0, fontSize, color, singleLine: !/<br\b/i.test(o.html) && emitted.length === 1 };
					heroItems.push(item);
					if (o.cls === "jsWndText" || o.cls === "jsWndShape") numberedItems.push(item);
				} else if (!o.hidden && (o.cls === "jsWndText" || o.cls === "jsWndShape")) numberedItems.push({ blocks: emitted, order: 0 });
			}
		}
		for (const q of p.questions) if (!done.has(q.name)) visible.push(...(questions.get(q.name) ?? []));
		// Traverse the final reading order, including accordion items, with one set per page.
		const pictures = new Set<string>();
		const deduplicate = (blocks: Block[]): void => {
			blocks.splice(0, blocks.length, ...blocks.filter((b) => {
				if (b.kind === "container") for (const item of b.items) deduplicate(item.blocks);
				if (b.kind !== "image") return true;
				if (pictures.has(b.src)) return false;
				pictures.add(b.src);
				return true;
			}));
		};
		deduplicate(visible);
		deduplicate(hidden);
		if (accordion?.kind === "container") for (const item of accordion.items) pictureLayout(item.blocks, pictureItems, width);
		for (const panel of new Set(hiddenPanels.values())) pictureLayout(hidden, pictureItems.filter((item) => hiddenPanels.get(item) === panel), width);
		if (buttons.size) losses.push({ at, source: "lectora:action", effect: "dropped", detail: `${buttons.size} button${buttons.size > 1 ? "s" : ""} with actions (${[...buttons].join(", ").slice(0, 200)}): actions, states and variables are not imported` });
		if (p.changed.some((value) => !retainedChanges.has(value))) count("text change by action");
		if (counts.size) losses.push({ at, source: "lectora:interaction", effect: "dropped", detail: `${[...counts].map(([k, n]) => `${n} ${n > 1 ? k.replace(/\b(button|object|field|change)\b/, "$1s") : k}`).join(", ")}: not imported` });
		if (p.variables.length) losses.push({ at, source: "lectora:variable", effect: "dropped", detail: `text shows the runtime value of ${p.variables.join(", ")}; imported without it` });
		if (hidden.length) losses.push({ at, source: "lectora:hidden", effect: "approximated", detail: hidden.length > 1 ? `${hidden.length} blocks hidden until an action shows them are imported after the visible content` : "1 block hidden until an action shows it is imported after the visible content" });
		if (reveals) losses.push({ at, source: "lectora:hidden", effect: "approximated", detail: `${reveals.items.length} button reveals became an accordion; button styling, states and animations are not retained.` });
		const drawOrder = [...heroItems].sort((a, b) => a.order - b.order);
		for (const item of heroItems) item.order = drawOrder.indexOf(item);
		if (fixedGeometry(page)) {
			numberedList(visible, numberedItems);
			slideLayout(visible, heroItems, pixels(page.width), pixels(page.height));
		}
		return { title: p.title, blocks: [...visible, ...hidden] };
	};

	/** Everything a learner can read on a page, gathered without going through the block mapping. */
	const inventory = (p: PageSrc) => {
		const push = (s: string) => s.trim() && sourceText.push(s.trim());
		push(p.title);
		const inOrder = [...p.order.map((n) => p.objects.get(n)), ...[...p.objects.values()].filter((o) => !p.order.includes(o.name))];
		// `seen` keys images by file for the chrome check; a learner reads the alt text. A button's
		// hidden state variants (Button1_visited) repeat its label, so each label counts once per page.
		const labels = new Set<string>();
		for (const o of inOrder) {
			if (!o || isChrome(o)) continue;
			if (o.cls === "jsWndTextButton") {
				if (!labels.has(seen(o))) push(seen(o));
				labels.add(seen(o));
			} else push(o.cls === "jsWndImage" ? text(o.html) : seen(o));
		}
		p.changed.forEach(push);
		for (const q of p.questions) for (const t of tests) (t.feedback.get(q.name.replace(/^qu/, "")) ?? []).forEach((fb) => push(text(fb)));
	};

	/** Headings inside an assessment group would start a new item; keep them as bold text. */
	// Headings inside an assessment group become bold text; a hero keeps its picture and subtitle as blocks.
	const demote = (b: Block): Block[] =>
		b.kind !== "heading"
			? [b]
			: [
					...(b.background ? [{ kind: "image", src: b.background.src, alt: b.background.alt } as Block] : []),
					{ kind: "paragraph", text: `**${b.text}**` },
					...(b.subtitle ? [{ kind: "paragraph", text: b.subtitle } as Block] : []),
				];

	/** Consecutive pages of one test become a single page holding the assessment group. */
	const fold = (items: Array<{ page: Page; test?: Test }>): Page[] => {
		const out: Page[] = [];
		for (let i = 0; i < items.length; ) {
			const t = items[i]?.test;
			if (!t) {
				out.push((items[i] as { page: Page }).page);
				i++;
				continue;
			}
			let j = i;
			while (j < items.length && items[j]?.test === t) j++;
			const run = items.slice(i, j).map((x) => x.page);
			out.push({ title: t.name, blocks: [{ kind: "group", title: t.name, ...(t.passingScore !== undefined ? { passingScore: t.passingScore } : {}), blocks: run.flatMap((r) => r.blocks.flatMap(demote)) }] });
			if (run.length > 1) losses.push({ at: t.id, source: "lectora:test", effect: "approximated", detail: `${run.length} test pages (${run.map((r) => r.title).join(", ").slice(0, 200)}) merged into one assessment group; their page titles are not kept` });
			i = j;
		}
		return out;
	};

	const starts = new Set(pages.map((p) => p.nextChapter).filter(Boolean));
	const lessons: Array<{ lesson: Lesson; items: Array<{ page: Page; test?: Test }> }> = [];
	for (const p of pages) {
		const test = testOf.get(p.file);
		if (!lessons.length || starts.has(p.file)) {
			const n = lessons.length + 1;
			lessons.push({ lesson: { sourceId: p.id, title: starts.size ? test?.name || `Chapter ${n}` : title, pages: [] }, items: [] });
		}
		lessons.at(-1)?.items.push({ page: build(p), ...(test ? { test } : {}) });
		inventory(p);
	}
	for (const l of lessons) l.lesson.pages = fold(l.items);

	if (description && description !== title) sourceText.unshift(description);
	sourceText.unshift(title);
	return {
		tool: "lectora",
		...(version ? { toolVersion: version } : {}),
		sourceId: manifest?.identifier ?? title,
		title,
		...(description && description !== title ? { description } : {}),
		...(locale ? { locale } : {}),
		lessons: lessons.map((l) => l.lesson),
		theme,
		losses,
		sourceText,
	};
}
