#!/usr/bin/env node
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { importPackage } from "./import.ts";
import { ImportError } from "./model.ts";

const USAGE = `Usage:
  praxity-import <package.zip|package-dir> --output <course-dir> [options]

Imports a SCORM package or unzipped web export into a Praxity Studio course
folder (course.yaml, .prax lessons, assets/, import-report.json).

Recognises Articulate Rise 360 exports and static multi-page HTML packages.

Options:
  -o, --output <dir>  Course folder to create. Must be new or empty, or a
                      previous import when --force is given.
      --force         Replace a previous import in --output.
      --verify        Parse the result with Studio (praxity inspect), measure
                      text coverage and try an HTML export. Needs Studio's CLI:
                      set PRAXITY_CLI or put praxity on PATH.
      --convert-media Convert HLS video (.m3u8), which Studio cannot play, to
                      MP4 with ffmpeg (must be on PATH). Streams are copied,
                      not re-encoded.
  -h, --help          Show this help.

Prints one JSON object to stdout. Exit status: 0 success, 1 import failure,
2 invalid usage.`;

function fail(code: 1 | 2, error: string, message: string): never {
	process.stdout.write(`${JSON.stringify({ ok: false, error: { code: error, message } })}\n`);
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

let parsed;
try {
	parsed = parseArgs({
		allowPositionals: true,
		options: { output: { type: "string", short: "o" }, force: { type: "boolean" }, verify: { type: "boolean" }, "convert-media": { type: "boolean" }, help: { type: "boolean", short: "h" } },
	});
} catch (e) {
	fail(2, "invalid_arguments", (e as Error).message);
}
const { values, positionals } = parsed;
if (values.help) {
	process.stdout.write(`${USAGE}\n`);
	process.exit(0);
}
const [input] = positionals;
if (!input || positionals.length > 1 || !values.output) fail(2, "invalid_arguments", USAGE);
if (!existsSync(input)) fail(1, "input_not_found", `No such file or directory: ${input}`);

/** Resolve symlinks through the deepest existing ancestor, so aliases cannot hide an overlap. */
function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return join(canonical(dirname(path)), basename(path));
	}
}
const output = canonical(resolve(values.output));
const inputPath = canonical(resolve(input));
if (output === inputPath || output.startsWith(inputPath + sep) || inputPath.startsWith(output + sep)) fail(2, "invalid_arguments", "--output must be outside the input");
const replacing = existsSync(output) && readdirSync(output).length > 0;
if (replacing) {
	// Only replace what is recognisably an earlier import, never an arbitrary folder.
	if (!values.force) fail(1, "output_exists", `${output} is not empty; pass --force to replace a previous import`);
	if (!existsSync(join(output, "import-report.json"))) fail(1, "output_exists", `${output} is not a previous import (no import-report.json); refusing to replace it`);
}

// Build beside the destination and swap only on success, so a failed import never costs the previous one.
const staging = `${output}.importing-${process.pid}`;
try {
	await rm(staging, { recursive: true, force: true });
	const report = await importPackage(inputPath, staging, { verify: values.verify ?? false, convertMedia: values["convert-media"] ?? false });
	await rm(output, { recursive: true, force: true });
	await rename(staging, output);
	const pages = report.lessons.reduce((n, l) => n + l.pages, 0);
	const v = report.verification;
	const ok = v ? v.parse.ok && (v.export?.ok ?? false) : true;
	process.stdout.write(
		`${JSON.stringify({
			ok,
			outputPath: output,
			tool: report.detected.tool,
			title: report.course.title,
			lessons: report.lessons.length,
			pages,
			assets: report.assets,
			losses: report.losses.length,
			...(v ? { verification: { parse: v.parse.ok, coverage: v.coverage?.ratio, export: v.export?.ok, accessibility: v.export?.accessibility, ...(v.parse.error ? { error: v.parse.error } : v.export?.error ? { error: v.export.error } : {}) } } : {}),
			report: join(output, "import-report.json"),
		})}\n`,
	);
	const cov = v?.coverage ? `, ${Math.round(v.coverage.ratio * 1000) / 10}% of source words kept` : "";
	const check = v ? (ok ? `; Studio parses and exports it (accessibility ${v.export?.accessibility ?? "unchecked"})` : "; Studio could not parse or export it") : "";
	process.stderr.write(`Imported ${report.detected.tool} course "${report.course.title}": ${report.lessons.length} lessons, ${pages} pages, ${report.losses.length} losses${cov}${check}.\nReview ${join(output, "import-report.json")}\n`);
	const unplayable = report.losses.filter((l) => l.source === "media:video" || l.source === "media:audio").length;
	const converted = report.losses.filter((l) => l.source === "media:converted").length;
	if (converted) process.stderr.write(`Converted ${converted} HLS video(s) to MP4 with ${report.mediaConverter ?? "ffmpeg"}.\n`);
	if (unplayable) process.stderr.write(`Warning: ${unplayable} video or audio item(s) were not imported because Studio cannot play their format; see "media:video" and "media:audio" losses in the report.\n`);
	for (const loss of report.losses) if (loss.source === "html:shallow") process.stderr.write(`Warning [${loss.source}]: ${loss.detail}\n`);
	if (!ok) process.exitCode = 1;
} catch (e) {
	await rm(staging, { recursive: true, force: true }).catch(() => {});
	fail(1, e instanceof ImportError ? e.code : "import_failed", (e as Error).message);
}
