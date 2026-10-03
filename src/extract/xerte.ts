import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { blocks as htmlBlocks, line, text } from "../html.ts";
import { insidePackage } from "../input.ts";
import { type Block, type Course, ImportError, type Loss } from "../model.ts";
import { kids, local, parseXml, type XmlElement } from "../xml.ts";

// These are learner strings in the published XML, collected before any mapping.
const VISIBLE = /^(name|text|prompt|feedback|instructions|caption|tip|alt|title|description|onCompletion|menuText|score|quesCount|singleRight|singleWrong|multiRight|multiWrong|soundTranscript|audioTranscript|.*Label|.*BtnText|.*Btn)$/;
const body = (node: XmlElement) => node.children.filter((c): c is string => typeof c === "string").join("");
const mediaHtml = (html: string) => html.replace(/FileLocation \+ '([^']*)'/g, "$1");

/** Published Xerte learningObject XML: text, progressive bullets, and choice quizzes. */
export function extractXerte(root: string, path = "template.xml"): Course {
	const file = insidePackage(root, path);
	if (!file) throw new ImportError("no_readable_content", "Xerte learning-object XML is missing or outside the package.");
	const xml = readFileSync(file, "utf8");
	const object = kids(parseXml(xml)).find((n) => local(n.name) === "learningobject");
	if (!object) throw new ImportError("no_readable_content", "Xerte XML has no learningObject element.");
	const losses: Loss[] = [];
	const sourceText: string[] = [];
	const lose = (at: string, source: string, detail: string, effect: Loss["effect"] = "dropped") => losses.push({ at, source: `xerte:${source}`, effect, detail });
	const inventory = (node: XmlElement) => {
		for (const key of Object.keys(node.attrs).sort()) if (VISIBLE.test(key) && text(node.attrs[key])) sourceText.push(text(node.attrs[key]));
		if (text(body(node))) sourceText.push(text(body(node)));
		kids(node).forEach(inventory);
	};
	inventory(object);
	const content = (html: string | undefined, at: string): Block[] => {
		if (!html) return [];
		if (/<(?:script|object|embed|canvas|form)\b/i.test(html)) lose(at, "html-interaction", "Embedded scripts, objects, canvas or forms are not imported.");
		return htmlBlocks(mediaHtml(html), { base: posix.dirname(path), lose: (source, detail) => lose(at, source, detail) });
	};
	const title = text(object.attrs.name) || "Imported course";
	const threshold = object.attrs.trackingPassed?.trim().replace(",", ".");
	const passingScore = threshold ? Number(threshold.replace(/%$/, "")) * (threshold.endsWith("%") ? 1 : 100) : NaN;
	lose(path, "player", "Player theme, navigation rules, completion tracking, custom labels and scripts are not reproduced.", "approximated");
	const pages = kids(object).map((page, i) => {
		const at = `${path}/${page.name}[${i + 1}]`;
		const blocks: Block[] = [];
		const kind = local(page.name);
		for (const key of ["image", "img", "sound", "audio", "video", "soundTranscript", "audioTranscript", "caption", "tip"]) if (page.attrs[key]) lose(`${at}/@${key}`, "page-media", "Media stored in page attributes is not supported for this page type.");
		if (kind === "text" || kind === "bullets") {
			if (kind === "bullets") blocks.push(...content(page.attrs.text, `${at}/@text`));
			blocks.push(...content(body(page), at));
			lose(at, kind, "Page layout, progressive reveal and its control labels are replaced by static content in source order.", "approximated");
			if (kids(page).length) lose(at, "nested-content", "Nested page elements are unsupported.");
		} else if (kind === "quiz") {
			blocks.push(...content(page.attrs.instructions, `${at}/@instructions`));
			lose(at, "quiz-behaviour", "Questions and answers keep XML order; random selection, answer shuffling, retry flow, aggregate results, feedback presentation and custom player labels are not reproduced.", "approximated");
			for (const [qIndex, q] of kids(page).entries()) {
				const qAt = `${at}/${q.name}[${qIndex + 1}]`;
				const options = kids(q);
				const multiple = q.attrs.type === "Multiple Answer";
				const valid = local(q.name) === "question" && ["Single Answer", "Multiple Answer"].includes(q.attrs.type ?? "") && options.length >= 2 && options.every((o) => local(o.name) === "option" && ["true", "false"].includes(o.attrs.correct ?? "") && !!line(o.attrs.text)) && (multiple ? options.some((o) => o.attrs.correct === "true") : options.filter((o) => o.attrs.correct === "true").length === 1);
				if (!valid || !line(q.attrs.prompt)) {
					lose(qAt, "question", "Unsupported question schema or missing prompt, options or unambiguous answer key.");
					continue;
				}
				const feedback = page.attrs.showfeedback === undefined || page.attrs.showfeedback === "true";
				const judge = page.attrs.judge !== "false";
				const general = feedback ? line(q.attrs.feedback) : "";
				const right = feedback && judge ? line(page.attrs[multiple ? "multiRight" : "singleRight"]) : "";
				const wrong = feedback && judge ? line(page.attrs[multiple ? "multiWrong" : "singleWrong"]) : "";
				blocks.push({
					kind: "choice", prompt: line(q.attrs.prompt), multiple, scored: true,
					options: options.map((o) => ({ text: line(o.attrs.text), correct: o.attrs.correct === "true", ...(feedback && line(o.attrs.feedback) ? { feedback: line(o.attrs.feedback) } : {}) })),
					...((general || right) ? { correct: [general, right].filter(Boolean).join(" ") } : {}),
					...((general || wrong) ? { incorrect: [general, wrong].filter(Boolean).join(" ") } : {}),
				});
				for (const [index, node] of [q, ...options].entries()) {
					const nodeAt = index ? `${qAt}/option[${index}]` : qAt;
					for (const key of Object.keys(node.attrs).sort()) {
						if (/^(image|sound|audioFB|soundTranscript|audioTranscript|caption|tip)$/.test(key) && node.attrs[key]) lose(`${nodeAt}/@${key}`, "question-media", "Question media and transcripts are not imported.");
						if (/^(prompt|text|feedback)$/.test(key) && /<(?:img|video|audio|iframe|object|embed|script)\b/i.test(node.attrs[key] ?? "")) lose(`${nodeAt}/@${key}`, "question-rich-content", "Question fields retain inline text; embedded media and interactions are not imported.");
					}
				}
			}
			for (const key of ["feedback", "onCompletion"]) if (page.attrs[key]) lose(`${at}/@${key}`, "quiz-results", "End-of-quiz feedback is not imported.");
		} else lose(at, `page:${kind}`, "Unsupported Xerte page type; its learner strings remain in the source inventory.");
		return { title: text(page.attrs.name) || `Page ${i + 1}`, blocks };
	});
	if (!pages.some((p) => p.blocks.length)) throw new ImportError("no_readable_content", "Xerte learning object contains no supported readable pages.");
	return {
		tool: "xerte", toolVersion: object.attrs.editorVersion,
		sourceId: createHash("sha256").update(xml).digest("hex"), title,
		...(Number.isFinite(passingScore) && passingScore >= 0 && passingScore <= 100 ? { passingScore } : {}),
		...(object.attrs.language ? { locale: object.attrs.language } : {}),
		lessons: [{ sourceId: path, title, pages }],
		theme: { format: "slides", navigation: "slides" }, losses, sourceText,
	};
}
