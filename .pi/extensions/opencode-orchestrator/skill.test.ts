import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const skillDir = path.join(repoRoot, ".pi", "skills", "orchestrator-role-coordinator");
const skillPath = path.join(skillDir, "SKILL.md");

const FORBIDDEN_FRONTMATTER_KEYS = ["allowed-tools", "license", "scripts", "dependencies"] as const;

interface SkillDocument {
	text: string;
	body: string;
	meta: Record<string, string>;
}

function readSkill(): SkillDocument {
	assert.ok(existsSync(skillPath), `SKILL.md must exist at ${skillPath}`);
	const text = readFileSync(skillPath, "utf8");
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	assert.ok(match, "SKILL.md must begin with a YAML frontmatter block");
	const frontmatter = match[1];
	const body = text.slice(match[0].length);
	const meta: Record<string, string> = {};
	for (const line of frontmatter.split(/\r?\n/)) {
		const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
		if (m) meta[m[1]] = m[2];
	}
	return { text, body, meta };
}

function linkDestinations(body: string): string[] {
	const out: string[] = [];
	const re = /\]\(\s*([^)\s]+)\s*(?:"[^"]*")?\s*\)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body)) !== null) {
		out.push(m[1]);
	}
	return out;
}

test("SKILL.md frontmatter declares the exact name and a bounded description", () => {
	const skill = readSkill();
	assert.equal(skill.meta.name, "orchestrator-role-coordinator");
	assert.ok(skill.meta.description, "SKILL.md must declare a description");
	assert.ok(
		skill.meta.description.length <= 1024,
		`description must be at most 1024 characters, got ${skill.meta.description.length}`,
	);
	for (const keyword of [
		"procedural reference",
		"coordinator",
		"role",
		"routing",
		"delivery caps",
		"delegat",
	]) {
		assert.match(skill.meta.description, new RegExp(keyword, "i"), `description must mention ${keyword}`);
	}
});

test("SKILL.md frontmatter declares no allowed-tools, license, scripts, or dependencies", () => {
	const skill = readSkill();
	assert.deepEqual(Object.keys(skill.meta).sort(), ["description", "name"]);
	for (const key of FORBIDDEN_FRONTMATTER_KEYS) {
		assert.equal(key in skill.meta, false, `frontmatter must not declare ${key}`);
		assert.doesNotMatch(skill.text, new RegExp(`^\\s*${key}:`, "m"), `SKILL.md must not declare ${key}`);
	}
});

test("SKILL.md body carries no executable, network, or install directives", () => {
	const { body } = readSkill();
	// No package-manager install directives.
	assert.doesNotMatch(
		body,
		/\b(npm|pnpm|yarn|bun|pip|uv|cargo|brew|apt|apk|gem)\s+(install|add|i|update|upgrade)\b/i,
		"no package-install directives",
	);
	// No network-command invocations.
	assert.doesNotMatch(body, /\b(git\s+clone|curl|wget|ssh|scp|ftp|rsync)\b/i, "no network-command directives");
	// No shell-executable invocations.
	assert.doesNotMatch(body, /\b(bash|sh|pwsh|powershell|cmd|zsh|fish)\s*[-=]?[^\w]/, "no shell-executable directives");
	// No shell-prompt command lines or fenced code blocks that could embed scripts.
	assert.doesNotMatch(body, /^\s*\$\s/m, "no shell-prompt command lines");
	assert.doesNotMatch(body, /```/, "no fenced code blocks");
	// No install instructions of any kind.
	assert.doesNotMatch(body, /\binstall\b/i, "no install instructions");
});

test("SKILL.md relative markdown references resolve to real files", () => {
	const skill = readSkill();
	const expected = [
		"../../../README.md",
		"../../../docs/multi-pc-setup.ja.md",
		"../../extensions/opencode-orchestrator/types.ts",
	];
	for (const ref of expected) {
		assert.ok(skill.body.includes(ref), `body must reference ${ref}`);
		const resolved = path.resolve(skillDir, ref);
		assert.ok(resolved.startsWith(repoRoot), `${ref} must resolve inside the repository`);
		assert.ok(existsSync(resolved), `${ref} must resolve to an existing file`);
		assert.ok(statSync(resolved).isFile(), `${ref} must resolve to a file, not a directory`);
	}
	// Every other relative markdown link in the body must resolve too.
	for (const dest of linkDestinations(skill.body)) {
		if (/^(https?:|mailto:|#|file:)/.test(dest)) continue;
		const resolved = path.resolve(skillDir, dest);
		assert.ok(resolved.startsWith(repoRoot), `relative link ${dest} must stay inside the repository`);
		assert.ok(existsSync(resolved), `relative link ${dest} must resolve to an existing file`);
	}
});

test("SKILL.md covers the required workflow and safety concepts", () => {
	const { body } = readSkill();
	const required: [string, RegExp][] = [
		["coordinator-only parent", /coordinator-only/],
		["delegation of implementation/testing/review", /delegat/i],
		["no broadening / report missing scope", /do not broaden|report what is missing/i],
		["implementer role", /implementer/],
		["tester role", /tester/],
		["reviewer role", /reviewer/],
		["read_only mode", /read_only/],
		["write mode", /\bwrite\b/],
		["bounded task fields", /relevant_paths/],
		["expected output field", /expected_output/],
		["parallel spawn together / wait once", /opencode_wait/],
		["sequential direct writes", /current working directory directly and run one at a time/],
		["model profiles and routing", /profile/i],
		["no model hardcoding", /hardcode/i],
		["no active-worker retargeting", /retarget/i],
		["tester/reviewer evidence", /evidence/],
		["parent final approval", /final approval|final judgment/i],
		["worker report size target", /2-4k/],
		["parent delivery cap", /8k|8,000/],
		["handoff cap", /4k|4,000/],
		["raw output retention", /120k|120,000/],
		["on-demand raw output", /opencode_output/],
		["skill grants no permissions", /never grant permissions/i],
		["runtime gates authoritative", /authoritative/],
	];
	for (const [label, re] of required) {
		assert.match(body, re, `SKILL.md must cover ${label}`);
	}
});

test("SKILL.md keeps a concise quick guide and references section", () => {
	const { body } = readSkill();
	assert.match(body, /## Quick guide/);
	assert.match(body, /## References/);
	assert.ok(body.length <= 12_000, `body should stay concise, got ${body.length} characters`);
});