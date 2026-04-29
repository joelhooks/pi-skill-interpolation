import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { basename, join } from "path";
import { homedir } from "os";

const TIMEOUT_MS = 10_000;
const PATTERN = /!`([^`]+)`/g;

// --- frontmatter parsing (minimal, no deps) ---

interface Frontmatter {
	[key: string]: string;
}

function parseFrontmatter(content: string): { fm: Frontmatter; body: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { fm: {}, body: content };

	const fm: Frontmatter = {};
	for (const line of match[1].split(/\r?\n/)) {
		const i = line.indexOf(":");
		if (i > 0) {
			fm[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
		}
	}
	return { fm, body: match[2] };
}

// --- security gate ---

function allowsBash(allowedTools: string | undefined): boolean {
	if (!allowedTools) return false;
	return allowedTools.split(/\s+/).some((t) => t === "Bash" || t.startsWith("Bash("));
}

// --- interpolation ---

function interpolate(content: string, cwd: string): string {
	return content.replace(PATTERN, (_m, cmd: string) => {
		try {
			return execSync(cmd, {
				cwd,
				timeout: TIMEOUT_MS,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			}).trimEnd();
		} catch (err) {
			const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
			return `[error: \`${cmd}\` failed: ${msg}]`;
		}
	});
}

// --- skill file lookup ---

function findSkillFile(name: string, cwd: string): string | null {
	const dirs = [
		join(homedir(), ".pi", "agent", "skills"),
		join(homedir(), ".agents", "skills"),
		join(cwd, ".pi", "skills"),
		join(cwd, ".agents", "skills"),
	];

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;

		// dir/name/SKILL.md
		const nested = join(dir, name, "SKILL.md");
		if (existsSync(nested)) return nested;

		// dir/name.md (root-level skill)
		const flat = join(dir, `${name}.md`);
		if (existsSync(flat)) return flat;

		// dir/*/name/SKILL.md (one level deeper, e.g. git repos of skills)
		try {
			const { readdirSync, statSync } = require("fs");
			for (const sub of readdirSync(dir)) {
				if (sub.startsWith(".")) continue;
				const deep = join(dir, sub, name, "SKILL.md");
				if (existsSync(deep)) return deep;
			}
		} catch {}
	}
	return null;
}

// --- extension ---

export default function (pi: ExtensionAPI) {
	// Hook 1: /skill:name invocation
	// Intercept before pi's built-in expansion. If the skill has
	// allowed-tools with Bash, expand with interpolation.
	// Otherwise fall through to pi's normal expansion.
	pi.on("input", async (event, ctx) => {
		if (!event.text.startsWith("/skill:")) return { action: "continue" as const };

		const spaceIdx = event.text.indexOf(" ");
		const skillName = spaceIdx === -1 ? event.text.slice(7) : event.text.slice(7, spaceIdx);
		const args = spaceIdx === -1 ? "" : event.text.slice(spaceIdx + 1).trim();

		const skillFile = findSkillFile(skillName, ctx.cwd);
		if (!skillFile) return { action: "continue" as const };

		const raw = readFileSync(skillFile, "utf-8");
		const { fm, body } = parseFrontmatter(raw);

		if (!allowsBash(fm["allowed-tools"])) return { action: "continue" as const };
		if (!PATTERN.test(body)) return { action: "continue" as const };

		// Reset regex lastIndex after test()
		PATTERN.lastIndex = 0;

		const projectDir = ctx.cwd;
		const interpolated = interpolate(body.trim(), projectDir);
		const block = `<skill name="${skillName}" location="${skillFile}">\nCommands run from project cwd: ${projectDir}.\n\n${interpolated}\n</skill>`;
		const text = args ? `${block}\n\n${args}` : block;

		return { action: "transform" as const, text };
	});

	// Hook 2: model reads a SKILL.md via the read tool
	// Interpolate !`command` patterns in the result before the model sees it.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read") return;

		const path = (event as any).input?.path as string | undefined;
		if (!path) return;
		if (!path.endsWith("SKILL.md") && !basename(path).endsWith(".md")) return;

		// Check if any content piece has interpolation patterns
		const textPiece = event.content?.find(
			(c: any) => c.type === "text" && typeof c.text === "string" && PATTERN.test(c.text),
		) as { type: "text"; text: string } | undefined;
		if (!textPiece) return;
		PATTERN.lastIndex = 0;

		// Parse frontmatter from the full file on disk so partial reads still
		// see the real allowed-tools section at the top of SKILL.md.
		let fullRaw: string;
		try {
			fullRaw = readFileSync(path, "utf-8");
		} catch {
			return;
		}

		const { fm } = parseFrontmatter(fullRaw);
		if (!allowsBash(fm["allowed-tools"])) return;

		const projectDir = ctx.cwd;
		const interpolated = interpolate(textPiece.text, projectDir);

		return {
			content: event.content!.map((c: any) => (c === textPiece ? { type: "text", text: interpolated } : c)),
		};
	});
}
