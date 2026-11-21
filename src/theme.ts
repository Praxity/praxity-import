import type { Loss, Theme } from "./model.ts";

const CATALOGUE = ["Lexend", "OpenDyslexic", "Atkinson Hyperlegible", "Verdana", "DM Sans", "Geist", "Inter", "Open Sans", "Roboto", "Red Hat Text", "Lato", "Poppins", "Montserrat", "Nunito", "Source Sans 3", "IBM Plex Sans", "Work Sans", "Karla", "Syne", "Bricolage Grotesque", "Merriweather", "Lora", "Playfair Display", "PT Serif", "DM Serif Display", "Cormorant Garamond", "Source Serif 4", "JetBrains Mono", "Fira Code"];
const SERIF = /serif|georgia|times|garamond|merriweather|lora|playfair|baskerville|palatino|cambria|book/i;

const hex = (c: string | undefined) => (c && /^#?[0-9a-f]{6}$/i.test(c.trim()) ? `#${c.trim().replace(/^#/, "").toLowerCase()}` : undefined);

function family(name: string): string | undefined {
	const clean = name.replace(/["']/g, "").split(",")[0]?.trim() ?? "";
	const base = clean.replace(/\s+(thin|light|regular|medium|semibold|bold|black|italic|\d{3})$/gi, "").trim();
	return CATALOGUE.find((f) => f.toLowerCase() === clean.toLowerCase() || f.toLowerCase() === base.toLowerCase());
}

export function designYaml(theme: Theme | undefined, logoPath: string | undefined, lose: (loss: Loss) => void, bands = false): string[] {
	if (!theme) return [];
	const out: string[] = ["  palette: clean"];
	if (theme.format === "slides") out.push("  contentMaxWidth: 960");
	else if (Number.isFinite(theme.contentWidth) && theme.contentWidth! > 0) out.push(`  contentMaxWidth: ${Math.round(theme.contentWidth!)}`);
	if (theme.density) out.push(`  density: ${theme.density}`);
	if (theme.blockSpacing) out.push(`  blockSpacing: ${theme.blockSpacing}`);
	const colour = (key: string, value: string | undefined) => {
		const h = hex(value);
		if (h) out.push(`  ${key}: "${h}"`);
	};
	const accent = hex(theme.accent);
	const rgb = accent ? [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16)) : [];
	if (accent && Math.max(...rgb) - Math.min(...rgb) < 40) lose({ at: "theme", source: "theme:accent", effect: "approximated", detail: `source accent ${accent} is a neutral grey; Studio's default accent is used` });
	else colour("colorAccent", accent);
	colour("colorText", theme.text);
	const bg = hex(theme.background);
	const lum = bg ? [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16) / 255).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i]!, 0) : 1;
	if (bg && lum < 0.35) out.push("  colorMode: dark", `  colorBackgroundDark: "${bg}"`);
	else colour("colorBackgroundLight", bg);
	colour("sectionAccentBackground", theme.sectionAccent ?? (bands ? theme.accent : undefined));
	colour("sectionDarkBackground", theme.sectionDark);
	colour("colorButtonBackground", theme.buttonBackground);
	colour("colorButtonText", theme.buttonText);
	const font = (role: "headings" | "body", name: string | undefined) => {
		if (!name) return undefined;
		const f = family(name);
		const generic = SERIF.test(name) ? "serif" : "sans-serif";
		if (!f) lose({ at: "theme", source: `theme:font`, effect: "approximated", detail: `${role} font "${name}" is not in Studio's font catalogue; a generic ${generic} font is used` });
		return `    ${role}:\n      fontFamily: [${[f, generic].filter(Boolean).map((x) => JSON.stringify(x)).join(", ")}]`;
	};
	const headings = font("headings", theme.headingFont);
	const body = font("body", theme.bodyFont);
	if (headings || body) out.push("  typography:", ...[body, headings].filter((x): x is string => !!x));
	if (theme.corners !== undefined) out.push(`  borderRadius: ${Math.max(0, Math.round(theme.corners))}`);
	if (theme.format === "slides") {
		out.push("  deck:", "    preset: selfPaced", "    outline: true", `    initialPanel: ${theme.navigation === "sidebar" ? "outline" : "closed"}`, "    slideCounter: true");
	} else if (theme.navigation) out.push(`  navArchetype: ${theme.navigation}`);
	if (bands) out.push("  sectionRhythmMode: manual");
	if (logoPath) out.push("  brand:", `    logoUrl: /${logoPath}`, "    logoPlacement: header");
	return ["design:", ...out];
}

