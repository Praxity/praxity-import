import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Block, Course } from "../src/model.ts";
import { courseYaml, lesson } from "../src/prax.ts";
import { studioCli } from "../src/verify.ts";

test("Studio parses and exports question columns, title-only accordion items and unlimited scored attempts", { skip: !process.env.PRAXITY_CLI && "set PRAXITY_CLI to run the Studio contract check" }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "praxity-import-studio-followups-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "assets"));
	writeFileSync(join(root, "assets/picture.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
	const questions: Block[] = [
		{ kind: "choice", prompt: "Pick", multiple: false, options: [{ text: "Alpha", correct: true }, { text: "Beta", correct: false }] },
		{ kind: "match", prompt: "Match", pairs: [["Alpha", "First"], ["Beta", "Second"]] },
		{ kind: "order", prompt: "Order", items: ["First", "Second"] },
		{ kind: "categorize", prompt: "Sort", categories: [{ name: "Letters", items: ["Alpha"] }, { name: "Numbers", items: ["One"] }] },
		{ kind: "fillBlank", prompt: "Fill", parts: ["The first letter is ", { answers: ["Alpha"] }] },
		{ kind: "hotspot", prompt: "Find", src: "picture.png", alt: "Dot", spots: [{ label: "Dot", x: 50, y: 50, correct: true }] },
	].map((q) => ({ ...q, scored: true, attempts: 0 })) as Block[];
	const course: Course = { tool: "synthetic", sourceId: "probe", title: "Probe", losses: [], sourceText: [], lessons: [{ sourceId: "lesson", title: "Probe", pages: [{ blocks: [
		{ kind: "columns", columns: [[{ kind: "image", src: "picture.png", alt: "Dot" }], [questions[0]!]] },
		...questions.slice(1),
		{ kind: "container", as: "accordion", items: [{ title: "Only this line", blocks: [] }, { title: "Details", blocks: [{ kind: "paragraph", text: "A longer explanation." }] }] },
	] }] }] };
	writeFileSync(join(root, "course.yaml"), courseYaml(course, "probe", ["lesson.prax"]));
	writeFileSync(join(root, "lesson.prax"), lesson(course.lessons[0]!, "lesson", "en", new Map([["picture.png", "assets/picture.png"]])));
	const cli = studioCli();
	assert.ok(cli);
	const run = (args: string[]) => JSON.parse(execFileSync(cli[0]!, [...cli.slice(1), ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }));
	const inspected = run(["inspect", root]);
	assert.equal(inspected.ok, true);
	const blocks = inspected.lessons[0].pages[0].blocks;
	assert.equal(blocks[0].type, "columns");
	assert.equal(blocks[0].data.items[1].children[0].type, "assessment");
	const nodes = (v: unknown): Record<string, unknown>[] => !v || typeof v !== "object" ? [] : Array.isArray(v) ? v.flatMap(nodes) : [v as Record<string, unknown>, ...Object.values(v).flatMap(nodes)];
	const attempts = nodes(blocks).filter((n) => "attempts" in n);
	assert.equal(attempts.length, 6);
	assert.ok(attempts.every((n) => n.attempts === 0 && n.feedbackMode === "retry"));
	assert.ok(nodes(blocks).some((n) => n.label === "Only this line"));
	const exported = run(["export", root, "--format", "html", "--output", join(root, "export.zip"), "--allow-critical-a11y-issues"]);
	assert.equal(exported.ok, true);
	assert.equal(exported.accessibility.status, "passed");
});
