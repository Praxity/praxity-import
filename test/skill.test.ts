import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { test } from "node:test";

// Rubato installs skill/ alone, so every relative link must stay inside it.
test("skill links resolve inside the installed skill folder", async () => {
	const files = (await readdir("skill", { recursive: true })).map((path) => path.replaceAll("\\", "/")).filter((path) => path.endsWith(".md"));
	assert.ok(files.includes("SKILL.md"));
	for (const file of files) {
		const prose = (await readFile(join("skill", file), "utf8")).replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "").replace(/(`+)[\s\S]*?\1/g, "");
		for (const [, href] of prose.matchAll(/\]\(([^\s)]+)\)/g)) {
			if (/^(?:[a-z][\w+.-]*:|#)/i.test(href!)) continue;
			const target = posix.normalize(posix.join(posix.dirname(file), href!.split("#")[0]!));
			assert.ok(!target.startsWith(".."), `${file} links outside the skill: ${href}`);
			await readFile(join("skill", target));
		}
	}
});

// Checks the facts an agent acts on, not their wording.
test("skill gives the Rubato and standalone invocations and the Studio 0.3.0 CLI it needs", async () => {
	const skill = await readFile("skill/SKILL.md", "utf8");
	assert.match(skill, /`praxity import <package> --output <dir>`/);
	assert.match(skill, /`praxity-import`/);
	// Owner, 2026-10-19: Import stays on the frozen Studio 0.3.0 CLI until a pilot needs current Studio.
	assert.match(skill, /https:\/\/github\.com\/Praxity\/desktop\/releases\/tag\/v0\.3\.0/);
	assert.doesNotMatch(skill, /prax-format skill's identity|macOS app/);
});
