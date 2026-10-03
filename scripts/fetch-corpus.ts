/**
 * Fetch every public package in corpus/sources.json into the corpus folder
 * (scripts/corpus.ts): git sources at their pinned commit, zips checked against
 * their SHA-256. Existing copies are left alone. `member` names one course
 * inside a bundle zip. Licences are mostly unknown: the copies are for local
 * testing only and never leave the machines that test with them.
 *
 *   node scripts/fetch-corpus.ts           fetch missing public packages
 *   node scripts/fetch-corpus.ts --lock    record every file's SHA-256 in <corpus>/manifest.json
 *   node scripts/fetch-corpus.ts --check   compare the corpus with its manifest; list missing inputs
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { checkManifest, corpusRoot, hashTree, inputOf, loadSources, repo, type ManifestFile, type Source } from "./corpus.ts";

const { values } = parseArgs({ options: { lock: { type: "boolean" }, check: { type: "boolean" } } });
const root = corpusRoot();
const manifestPath = join(root, "manifest.json");

if (values.lock) {
	const files = hashTree(root);
	writeFileSync(manifestPath, `${JSON.stringify({ files }, null, "\t")}\n`);
	process.stdout.write(`${files.length} files recorded in ${manifestPath}\n`);
} else if (values.check) {
	const { sources, privateList } = loadSources(root);
	const absent = sources.filter((s) => !existsSync(inputOf(s, root))).map((s) => s.id);
	let failed = absent.length > 0;
	process.stdout.write(`${root}: ${sources.length - absent.length}/${sources.length} inputs present${privateList ? "" : " (no sources.local.json: public only)"}\n`);
	for (const id of absent) process.stdout.write(`  missing input: ${id}\n`);
	if (!existsSync(manifestPath)) {
		process.stdout.write("  no manifest.json; run with --lock once the corpus is complete\n");
		failed = true;
	} else {
		const { files } = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: ManifestFile[] };
		const r = checkManifest(root, files);
		process.stdout.write(`${files.length} manifest files: ${r.missing.length} missing, ${r.changed.length} changed, ${r.unlisted.length} not listed\n`);
		for (const [label, paths] of [["missing", r.missing], ["changed", r.changed], ["not listed", r.unlisted]] as const) {
			for (const p of paths.slice(0, 20)) process.stdout.write(`  ${label}: ${p}\n`);
			if (paths.length > 20) process.stdout.write(`  ... ${paths.length - 20} more ${label}\n`);
		}
		failed ||= r.missing.length + r.changed.length + r.unlisted.length > 0;
	}
	if (failed) process.exitCode = 1;
} else {
	await fetchPublic(JSON.parse(readFileSync(join(repo, "corpus/sources.json"), "utf8")).sources);
}

async function fetchPublic(sources: Source[]) {
	const git = (...args: string[]) => execFileSync("git", args, { stdio: "inherit" });
	for (const s of sources) {
		if (s.git && s.commit && s.clone) {
			const dir = join(root, s.clone);
			if (existsSync(dir)) continue;
			git("init", "-q", dir);
			git("-C", dir, "remote", "add", "origin", s.git);
			git("-C", dir, "fetch", "-q", "--depth", "1", "origin", s.commit);
			git("-C", dir, "checkout", "-q", "FETCH_HEAD");
		} else if (s.zip && s.file && s.sha256) {
			const path = inputOf(s, root);
			if (existsSync(path)) continue;
			const res = await fetch(s.zip);
			if (!res.ok) throw new Error(`${s.zip}: HTTP ${res.status}`);
			const body = Buffer.from(await res.arrayBuffer());
			const sha = createHash("sha256").update(body).digest("hex");
			if (sha !== s.sha256) throw new Error(`${s.zip}: SHA-256 ${sha} does not match ${s.sha256}`);
			mkdirSync(join(root, "zips"), { recursive: true });
			if (!s.member) writeFileSync(path, body);
			else {
				// A course inside a bundle: keep just that member, not the whole archive.
				const bundle = join(root, "zips", `.bundle-${sha}.zip`);
				writeFileSync(bundle, body);
				execFileSync("unzip", ["-oqj", bundle, s.member, "-d", join(root, "zips")]);
				rmSync(bundle);
			}
		}
	}
}
