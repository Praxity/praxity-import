/**
 * Import every corpus package, twice, and score the result. Writes
 * out/bench/scoreboard.json and scoreboard.tsv, sorted by id so runs diff.
 *
 *   node scripts/bench.ts [--only <substring>] [--no-verify] [--jobs 4] [--release]
 *
 * Sources: corpus/sources.json (public) and the corpus folder's
 * sources.local.json (private, never committed); see scripts/corpus.ts. A
 * listed input that is missing fails the run. --release also requires the
 * private list, so a release bench cannot quietly cover only public packages.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { importPackage, type Report } from "../src/import.ts";
import { corpusRoot, inputOf, loadSources, repo as here, type Source } from "./corpus.ts";

const { values } = parseArgs({
	options: { only: { type: "string" }, "no-verify": { type: "boolean" }, jobs: { type: "string" }, release: { type: "boolean" } },
});

const root = corpusRoot();
const { sources: all, privateList } = loadSources(root);
if (!privateList) {
	process.stderr.write(`No sources.local.json in ${root}: public packages only. Set PRAXITY_IMPORT_CORPUS to the corpus folder.
`);
	if (values.release) process.exit(1);
}
const sources = all.filter((s) => !values.only || s.id.includes(values.only)).sort((a, b) => (a.id < b.id ? -1 : 1));

/** Hash of every file under a directory, by relative path, except the report (it may carry verification). */
function treeHash(dir: string): string {
	const h = createHash("sha256");
	const walk = (d: string) => {
		for (const name of readdirSync(d).sort()) {
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (relative(dir, p) !== "import-report.json") h.update(`${relative(dir, p)}\0`).update(readFileSync(p)).update("\0");
		}
	};
	walk(dir);
	return h.digest("hex");
}

type Row = {
	id: string;
	expected: string;
	detected?: string;
	ok: boolean;
	lessons?: number;
	pages?: number;
	blocks?: number;
	dropped?: number;
	approximated?: number;
	coverage?: number;
	parse?: boolean;
	export?: boolean;
	a11y?: string;
	deterministic?: boolean;
	error?: string;
};

const MISSING = "input missing; run pnpm corpus or restore the private corpus";

async function bench(s: Source): Promise<Row> {
	const input = inputOf(s, root);
	const row: Row = { id: s.id, expected: s.tool, ok: false };
	if (!existsSync(input)) return { ...row, error: MISSING };
	const a = join(here, "out/bench", s.id);
	const b = join(here, "out/bench-repeat", s.id);
	try {
		await rm(a, { recursive: true, force: true });
		await rm(b, { recursive: true, force: true });
		const report: Report = await importPackage(input, a, { verify: !values["no-verify"] });
		await importPackage(input, b);
		// The repeat skips verification, so compare everything except the report's verification block.
		const strip = (dir: string) => {
			const p = join(dir, "import-report.json");
			const r = JSON.parse(readFileSync(p, "utf8"));
			delete r.verification;
			return r;
		};
		const sameReport = JSON.stringify(strip(a)) === JSON.stringify(strip(b));
		const deterministic = sameReport && treeHash(a) === treeHash(b);
		await rm(b, { recursive: true, force: true });
		const v = report.verification;
		return {
			...row,
			detected: report.detected.tool,
			ok: v ? v.parse.ok && !!v.export?.ok : true,
			lessons: report.lessons.length,
			pages: report.lessons.reduce((n, l) => n + l.pages, 0),
			blocks: report.lessons.reduce((n, l) => n + l.blocks, 0),
			dropped: report.losses.filter((l) => l.effect === "dropped").length,
			approximated: report.losses.filter((l) => l.effect === "approximated").length,
			...(v?.coverage ? { coverage: v.coverage.ratio } : {}),
			...(v ? { parse: v.parse.ok, export: !!v.export?.ok, ...(v.export?.accessibility ? { a11y: v.export.accessibility } : {}) } : {}),
			deterministic,
			...(v?.parse.error || v?.export?.error ? { error: (v.parse.error ?? v.export?.error ?? "").slice(0, 200) } : {}),
		};
	} catch (e) {
		return { ...row, error: (e as Error).message.slice(0, 200) };
	}
}

const jobs = Number(values.jobs ?? 4);
const rows: Row[] = [];
const queue = [...sources];
await mkdir(join(here, "out/bench"), { recursive: true });
await Promise.all(
	Array.from({ length: jobs }, async () => {
		for (let s = queue.shift(); s; s = queue.shift()) {
			const r = await bench(s);
			rows.push(r);
			process.stderr.write(`${r.ok ? "ok  " : "FAIL"} ${r.id} ${r.detected ?? ""} ${r.coverage ?? ""} ${r.error ?? ""}\n`);
		}
	}),
);
rows.sort((a, b) => (a.id < b.id ? -1 : 1));
const cols: Array<keyof Row> = ["id", "expected", "detected", "ok", "lessons", "pages", "blocks", "dropped", "approximated", "coverage", "parse", "export", "a11y", "deterministic", "error"];
await writeFile(join(here, "out/bench/scoreboard.json"), `${JSON.stringify(rows, null, "\t")}\n`);
await writeFile(join(here, "out/bench/scoreboard.tsv"), `${[cols.join("\t"), ...rows.map((r) => cols.map((c) => r[c] ?? "").join("\t"))].join("\n")}\n`);
const passed = rows.filter((r) => r.ok).length;
process.stdout.write(`${passed}/${rows.length} imported and verified; ${rows.filter((r) => r.deterministic === false).length} non-deterministic. See out/bench/scoreboard.tsv\n`);
// Refusing an unsupported tool is expected; a missing input, an import Studio rejects, or output that changes between runs, is a regression.
const regressions = rows.filter((r) => r.error === MISSING || r.deterministic === false || (r.detected && r.parse !== undefined && !r.ok));
if (regressions.length) {
	process.stdout.write(`Regressions: ${regressions.map((r) => r.id).join(", ")}\n`);
	process.exitCode = 1;
}
