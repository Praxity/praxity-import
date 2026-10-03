import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkManifest, corpusRoot, hashTree, inputOf, loadSources, repo } from "../scripts/corpus.ts";

test("the corpus folder comes from PRAXITY_IMPORT_CORPUS, else corpus/local", () => {
	const elsewhere = mkdtempSync(join(tmpdir(), "corpus-root-"));
	assert.equal(corpusRoot({ PRAXITY_IMPORT_CORPUS: elsewhere }), resolve(elsewhere));
	assert.equal(corpusRoot({}), resolve(repo, "corpus/local"));
	assert.equal(corpusRoot({ PRAXITY_IMPORT_CORPUS: "" }), resolve(repo, "corpus/local"));
});

test("inputs resolve inside the corpus folder; private files may also be absolute", () => {
	const root = mkdtempSync(join(tmpdir(), "corpus-inputs-"));
	assert.equal(inputOf({ id: "a", tool: "rise", git: "g", commit: "c", clone: "owner__repo", path: "course" }, root), join(root, "owner__repo", "course"));
	assert.equal(inputOf({ id: "b", tool: "rise", zip: "https://example.test/b.zip", file: "b.zip" }, root), join(root, "zips", "b.zip"));
	assert.equal(inputOf({ id: "c", tool: "html", file: "private/c.zip" }, root), join(root, "private", "c.zip"));
	const absolute = resolve(tmpdir(), "elsewhere", "d.zip");
	assert.equal(inputOf({ id: "d", tool: "html", file: absolute }, root), absolute);
});

test("private sources are read only when the corpus folder lists them", () => {
	const root = mkdtempSync(join(tmpdir(), "corpus-sources-"));
	const publicOnly = loadSources(root);
	assert.equal(publicOnly.privateList, false);
	writeFileSync(join(root, "sources.local.json"), JSON.stringify({ sources: [{ id: "zz-private", tool: "html", file: "p.zip" }] }));
	const withPrivate = loadSources(root);
	assert.equal(withPrivate.privateList, true);
	assert.equal(withPrivate.sources.length, publicOnly.sources.length + 1);
	assert.equal(withPrivate.sources.at(-1)?.id, "zz-private");
});

test("the manifest covers corpus files, not clone metadata, Finder files or itself", () => {
	const root = mkdtempSync(join(tmpdir(), "corpus-hash-"));
	mkdirSync(join(root, "clone/.git"), { recursive: true });
	mkdirSync(join(root, "clone/sub"), { recursive: true });
	writeFileSync(join(root, "clone/.git/HEAD"), "ref");
	writeFileSync(join(root, "clone/.DS_Store"), "x");
	writeFileSync(join(root, "clone/sub/manifest.json"), "{}");
	writeFileSync(join(root, "clone/index.html"), "<p>hi</p>");
	writeFileSync(join(root, "manifest.json"), "{}");
	writeFileSync(join(root, "sources.local.json"), "{}");
	const files = hashTree(root);
	assert.deepEqual(
		files.map((f) => f.path),
		["clone/index.html", "clone/sub/manifest.json", "sources.local.json"],
	);
	assert.equal(files[0]?.bytes, 9);
	assert.match(files[0]?.sha256 ?? "", /^[0-9a-f]{64}$/);
});

test("checking the manifest reports missing, changed and unlisted files", () => {
	const root = mkdtempSync(join(tmpdir(), "corpus-check-"));
	writeFileSync(join(root, "kept.zip"), "same");
	writeFileSync(join(root, "edited.zip"), "before");
	writeFileSync(join(root, "gone.zip"), "here");
	const manifest = hashTree(root);
	assert.deepEqual(checkManifest(root, manifest), { missing: [], changed: [], unlisted: [] });

	writeFileSync(join(root, "edited.zip"), "after!");
	rmSync(join(root, "gone.zip"));
	writeFileSync(join(root, "new.zip"), "extra");
	assert.deepEqual(checkManifest(root, manifest), { missing: ["gone.zip"], changed: ["edited.zip"], unlisted: ["new.zip"] });
});
