import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { liaSources } from "./extract/liascript.ts";
import { insidePackage } from "./input.ts";
import { kids, local, parseXml } from "./xml.ts";

export type Tool = "rise" | "storyline" | "captivate" | "adapt" | "ispring" | "lectora" | "liascript" | "xerte" | "html";

export type Detected = {
	tool: Tool;
	/** Directory holding the tool's output, relative to the package root ("" for the root). */
	dir: string;
	/** Why: the marker files that matched, so a wrong guess is easy to see. */
	evidence: string[];
};

const has = (root: string, rel: string) => existsSync(join(root, rel));
const read = (root: string, rel: string) => (has(root, rel) ? readFileSync(join(root, rel), "utf8") : "");

/**
 * A zip often wraps the package in one top-level folder. Descend through lone
 * directories until something package-like appears.
 */
export function packageRoot(root: string): string {
	let dir = root;
	for (let i = 0; i < 4; i++) {
		if (["imsmanifest.xml", "index.html", "story.html", "tincan.xml", "cmi5.xml", "course/config.json"].some((f) => has(dir, f))) return dir;
		const entries = readdirSync(dir).filter((e) => !e.startsWith(".") && e !== "__MACOSX");
		const only = entries.length === 1 && entries[0] ? join(dir, entries[0]) : undefined;
		if (!only || !statSync(only).isDirectory()) return dir;
		dir = only;
	}
	return dir;
}

/**
 * Ordered fingerprints: the first match wins. Each checks files the tool's
 * player needs to run, not names or comments an author can edit.
 */
export function detect(root: string): Detected {
	for (const dir of ["", "scormcontent", "content", "res"]) {
		const html = read(root, join(dir, "index.html"));
		const rise = [join(dir, "lib/rise"), join(dir, "lib/main.bundle.js")].filter((p) => has(root, p));
		if (rise.length || /__fetchCourse|deserialize\(\s*["']|window\.courseData/.test(html)) return { tool: "rise", dir, evidence: rise.length ? rise : [join(dir, "index.html")] };
	}
	const storyline = ["html5/data/js/data.js", "story_content", "story.html"].filter((p) => has(root, p));
	if (storyline.length) return { tool: "storyline", dir: "", evidence: storyline };
	const captivate = ["assets/js/CPM.js", "project.txt", "dr"].filter((p) => has(root, p));
	if (captivate.includes("assets/js/CPM.js") || /"generator"\s*:\s*"Captivate"/.test(read(root, "project.txt"))) return { tool: "captivate", dir: "", evidence: captivate };
	for (const dir of ["", "res"]) {
		const ispring = [join(dir, "data/player.js"), join(dir, "data/slide1.js")].filter((p) => has(root, p));
		if (ispring.length === 2) return { tool: "ispring", dir, evidence: ispring };
	}
	if (has(root, "trivantis.js")) return { tool: "lectora", dir: "", evidence: ["trivantis.js"] };
	const adapt = has(root, "course/config.json") && existsSync(join(root, "course")) && readdirSync(join(root, "course")).some((d) => has(root, `course/${d}/components.json`));
	if (adapt) return { tool: "adapt", dir: "", evidence: ["course/config.json", "course/<lang>/components.json"] };
	const index = insidePackage(root, "index.html");
	if (index && /<meta\b[^>]*name=["']apple-mobile-web-app-title["'][^>]*content=["']LiaScript["']/i.test(readFileSync(index, "utf8")) && liaSources(root).length) return { tool: "liascript", dir: "", evidence: ["index.html", "imsmanifest.xml"] };
	const template = insidePackage(root, "template.xml");
	if (template && insidePackage(root, "common_html5/js/xenith.js") && kids(parseXml(readFileSync(template, "utf8"))).some((el) => local(el.name) === "learningobject")) return { tool: "xerte", dir: "", evidence: ["template.xml", "common_html5/js/xenith.js"] };
	return { tool: "html", dir: "", evidence: has(root, "imsmanifest.xml") ? ["imsmanifest.xml"] : [] };
}
