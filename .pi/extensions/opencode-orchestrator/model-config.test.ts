import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	effectiveModelSetting,
	loadSavedModelSettings,
	MODEL_SETTING_DEFINITIONS,
	resetSavedModelSetting,
	saveModelSetting,
	watchModelConfig,
} from "./model-config.ts";
import { DEFAULT_MODEL } from "./types.ts";

function tempDir(label: string) {
	return join(tmpdir(), `pi-orch-model-config-test-${label}-${process.pid}-${Date.now()}`);
}

test("save/load/reset round-trips settings through a JSON object", () => {
	const dir = tempDir("roundtrip");
	const path = join(dir, "models.json");
	assert.deepEqual(loadSavedModelSettings(path), {});
	saveModelSetting("worker", " opencode-go/glm-5.2 ", path);
	assert.equal(existsSync(path), true);
	// Existing keys survive unrelated saves.
	saveModelSetting("reviewer", "opencode-go/kimi-k3", path);
	assert.deepEqual(loadSavedModelSettings(path), {
		worker: "opencode-go/glm-5.2",
		reviewer: "opencode-go/kimi-k3",
	});
	resetSavedModelSetting("worker", path);
	assert.deepEqual(loadSavedModelSettings(path), { reviewer: "opencode-go/kimi-k3" });
	resetSavedModelSetting(undefined, path);
	assert.equal(existsSync(path), false);
	rmSync(dir, { recursive: true, force: true });
});

test("save rejects empty or whitespace-containing model IDs", () => {
	const dir = tempDir("reject");
	const path = join(dir, "models.json");
	assert.throws(() => saveModelSetting("worker", "   ", path));
	assert.throws(() => saveModelSetting("worker", "has space/model", path));
	assert.equal(existsSync(path), false);
	rmSync(dir, { recursive: true, force: true });
});

test("effectiveModelSetting resolves env override, then saved, then default", () => {
	const dir = tempDir("precedence");
	const path = join(dir, "models.json");
	const env = { PI_OPENCODE_MODEL: "", PI_OPENCODE_PROFILE_REVIEWER: "env/reviewer" };
	assert.equal(effectiveModelSetting("worker", {}, env), MODEL_SETTING_DEFINITIONS.worker.defaultValue);
	saveModelSetting("worker", "saved/worker", path);
	const saved = loadSavedModelSettings(path);
	assert.equal(effectiveModelSetting("worker", saved, env), "saved/worker");
	env.PI_OPENCODE_MODEL = "env/worker";
	assert.equal(effectiveModelSetting("worker", saved, env), "env/worker");
	assert.equal(
		effectiveModelSetting("implementer", saved, env),
		MODEL_SETTING_DEFINITIONS.implementer.defaultValue,
	);
	assert.equal(effectiveModelSetting("reviewer", saved, env), "env/reviewer");
	rmSync(dir, { recursive: true, force: true });
});

test("tester setting uses PI_OPENCODE_PROFILE_TESTER env, saved value, then DEFAULT_MODEL default", () => {
	const dir = tempDir("tester-precedence");
	const path = join(dir, "models.json");
	const env = { PI_OPENCODE_PROFILE_TESTER: "" };
	assert.equal(MODEL_SETTING_DEFINITIONS.tester.env, "PI_OPENCODE_PROFILE_TESTER");
	assert.equal(MODEL_SETTING_DEFINITIONS.tester.label, "Tester profile");
	// The default/fallback is derived from the existing DEFAULT_MODEL rather than
	// a new provider/model literal.
	assert.equal(MODEL_SETTING_DEFINITIONS.tester.defaultValue, DEFAULT_MODEL);
	assert.equal(effectiveModelSetting("tester", {}, env), DEFAULT_MODEL);
	saveModelSetting("tester", "saved/tester", path);
	const saved = loadSavedModelSettings(path);
	assert.equal(effectiveModelSetting("tester", saved, env), "saved/tester");
	env.PI_OPENCODE_PROFILE_TESTER = "env/tester";
	assert.equal(effectiveModelSetting("tester", saved, env), "env/tester");
	rmSync(dir, { recursive: true, force: true });
});

test("tester persists alongside other settings and resets without touching them", () => {
	const dir = tempDir("tester-roundtrip");
	const path = join(dir, "models.json");
	assert.deepEqual(loadSavedModelSettings(path), {});
	saveModelSetting("tester", "opencode-go/tester-model", path);
	assert.equal(existsSync(path), true);
	// Existing keys survive unrelated saves.
	saveModelSetting("implementer", "opencode-go/glm-5.2", path);
	assert.deepEqual(loadSavedModelSettings(path), {
		implementer: "opencode-go/glm-5.2",
		tester: "opencode-go/tester-model",
	});
	resetSavedModelSetting("tester", path);
	assert.deepEqual(loadSavedModelSettings(path), { implementer: "opencode-go/glm-5.2" });
	// Resetting an already-absent tester keeps the remaining settings.
	resetSavedModelSetting("tester", path);
	assert.deepEqual(loadSavedModelSettings(path), { implementer: "opencode-go/glm-5.2" });
	resetSavedModelSetting(undefined, path);
	assert.equal(existsSync(path), false);
	rmSync(dir, { recursive: true, force: true });
});

test("loadSavedModelSettings ignores non-string values and throws on non-object JSON", () => {
	const dir = tempDir("json");
	const path = join(dir, "models.json");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, '{"worker":"a/b","parent":42,"reviewer":["x"]}\n', "utf8");
	assert.deepEqual(loadSavedModelSettings(path), { worker: "a/b" });
	writeFileSync(path, "[1,2]\n", "utf8");
	assert.throws(() => loadSavedModelSettings(path), /JSON object/);
	rmSync(dir, { recursive: true, force: true });
});

test("save canonicalizes single/repeated opencode: prefixes and preserves pi::", () => {
	const dir = tempDir("canonical-save");
	const path = join(dir, "models.json");
	// Single prefix is stripped to the canonical provider/model value.
	saveModelSetting("worker", "opencode:opencode-go/glm-5.2", path);
	assert.deepEqual(loadSavedModelSettings(path), { worker: "opencode-go/glm-5.2" });
	// Repeated prefixes collapse to the raw value and are never persisted.
	saveModelSetting("reviewer", "opencode:opencode:opencode:opencode-go/kimi-k3", path);
	assert.deepEqual(loadSavedModelSettings(path), {
		worker: "opencode-go/glm-5.2",
		reviewer: "opencode-go/kimi-k3",
	});
	// pi:: worker values stay intact through save/load.
	saveModelSetting("implementer", "opencode:opencode:pi::provider/model", path);
	assert.deepEqual(loadSavedModelSettings(path), {
		worker: "opencode-go/glm-5.2",
		reviewer: "opencode-go/kimi-k3",
		implementer: "pi::provider/model",
	});
	rmSync(dir, { recursive: true, force: true });
});

test("parent setting is not normalized and pi:: survives canonical writes", () => {
	const dir = tempDir("parent-untouched");
	const path = join(dir, "models.json");
	// Parent is final-approval output: opencode: prefixes are preserved verbatim.
	saveModelSetting("parent", "opencode:opencode:openai-codex/gpt-5.6-sol", path);
	assert.deepEqual(loadSavedModelSettings(path), {
		parent: "opencode:opencode:openai-codex/gpt-5.6-sol",
	});
	// A save of another key must not rewrite an existing pi:: value.
	saveModelSetting("tester", "pi::provider/tester", path);
	assert.deepEqual(loadSavedModelSettings(path), {
		parent: "opencode:opencode:openai-codex/gpt-5.6-sol",
		tester: "pi::provider/tester",
	});
	rmSync(dir, { recursive: true, force: true });
});

test("save rejects values that become empty after normalization", () => {
	const dir = tempDir("normalized-empty");
	const path = join(dir, "models.json");
	assert.throws(() => saveModelSetting("worker", "opencode:", path));
	assert.throws(() => saveModelSetting("worker", "  opencode:  ", path));
	assert.throws(() => saveModelSetting("reviewer", "opencode:opencode:   ", path));
	assert.equal(existsSync(path), false);
	rmSync(dir, { recursive: true, force: true });
});

test("writeSavedModelSettings canonicalizes pre-existing dirty values on next save", () => {
	const dir = tempDir("canonical-write");
	const path = join(dir, "models.json");
	mkdirSync(dir, { recursive: true });
	// A hand-written file carries display-only prefixes and a value that
	// normalizes away entirely.
	writeFileSync(path, '{"worker":"opencode:opencode:a/b","reviewer":"opencode:","parent":"pi::keep"}\n', "utf8");
	// Saving an unrelated key rewrites the whole file canonically.
	saveModelSetting("tester", "opencode:opencode:c/d", path);
	const onDisk = JSON.parse(readFileSync(path, "utf8"));
	assert.deepEqual(onDisk, {
		worker: "a/b",
		parent: "pi::keep",
		tester: "c/d",
	});
	rmSync(dir, { recursive: true, force: true });
});

test("effectiveModelSetting normalizes env and saved values for non-parent only", () => {
	const dir = tempDir("canonical-effective");
	const path = join(dir, "models.json");
	const env: NodeJS.ProcessEnv = {
		PI_OPENCODE_MODEL: "opencode:opencode:env/worker",
		PI_CODEX_MODEL: "opencode:opencode:env/parent",
	};
	// Env override is normalized for workers.
	assert.equal(effectiveModelSetting("worker", {}, env), "env/worker");
	// Parent env is preserved verbatim.
	assert.equal(effectiveModelSetting("parent", {}, env), "opencode:opencode:env/parent");
	// Saved values are normalized for workers.
	saveModelSetting("worker", "opencode:opencode:saved/worker", path);
	const saved = loadSavedModelSettings(path);
	assert.equal(effectiveModelSetting("worker", saved, {}), "saved/worker");
	// A saved pi:: value is returned intact.
	saveModelSetting("implementer", "opencode:opencode:pi::saved/impl", path);
	assert.equal(effectiveModelSetting("implementer", loadSavedModelSettings(path), {}), "pi::saved/impl");
	rmSync(dir, { recursive: true, force: true });
});

test("read path migrates opencode: repetitions in memory without rewriting the file", () => {
	const dir = tempDir("in-memory-migration");
	const path = join(dir, "models.json");
	mkdirSync(dir, { recursive: true });
	const raw = '{"worker":"opencode:opencode:a/b","reviewer":"opencode:opencode:opencode:c/d","parent":"opencode:raw/parent"}\n';
	writeFileSync(path, raw, "utf8");
	// loadSavedModelSettings canonicalizes on read...
	assert.deepEqual(loadSavedModelSettings(path), {
		worker: "a/b",
		reviewer: "c/d",
		parent: "opencode:raw/parent",
	});
	// ...but the file is not eagerly rewritten.
	assert.equal(readFileSync(path, "utf8"), raw);
	rmSync(dir, { recursive: true, force: true });
});

test("reset deletes settings including previously normalized ones", () => {
	const dir = tempDir("reset-canonical");
	const path = join(dir, "models.json");
	saveModelSetting("worker", "opencode:opencode:a/b", path);
	saveModelSetting("reviewer", "opencode:opencode:c/d", path);
	resetSavedModelSetting("worker", path);
	assert.deepEqual(loadSavedModelSettings(path), { reviewer: "c/d" });
	resetSavedModelSetting("reviewer", path);
	assert.equal(existsSync(path), false);
	rmSync(dir, { recursive: true, force: true });
});

test("watchModelConfig reports debounced create, update, and delete of models.json", async () => {
	const dir = tempDir("watch");
	const filePath = join(dir, "nested", "models.json");
	let changes = 0;
	const watcher = watchModelConfig(() => {
		changes += 1;
	}, { path: filePath, debounceMs: 10 });

	async function waitFor(predicate: () => boolean, label: string) {
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.ok(false, `timed out waiting for ${label}`);
	}

	// Create (directory does not exist yet).
	writeFileSync(filePath, '{"worker":"created/one"}\n', "utf8");
	await waitFor(() => changes >= 1, "create event");

	// Update.
	changes = 0;
	writeFileSync(filePath, '{"worker":"updated/two"}\n', "utf8");
	await waitFor(() => changes >= 1, "update event");

	// Burst of writes collapses into at least one debounced change.
	changes = 0;
	for (let i = 0; i < 5; i += 1) {
		writeFileSync(filePath, `{"worker":"burst/${i}"}\n`, "utf8");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	await waitFor(() => changes >= 1, "burst event");

	// Delete.
	changes = 0;
	rmSync(filePath);
	await waitFor(() => changes >= 1, "delete event");

	watcher.close();
	rmSync(join(dir, "nested"), { recursive: true, force: true });
	rmSync(dir, { recursive: true, force: true });
});

test("watchModelConfig handles Japanese directory names and close() stops notifications", async () => {
	const base = tempDir("unicode");
	// Windows/Japanese path segment must survive fs.watch natively.
	const dir = join(base, "設定", "pi-orch");
	const filePath = join(dir, "models.json");
	let changes = 0;
	const watcher = watchModelConfig(() => {
		changes += 1;
	}, { path: filePath, debounceMs: 10 });

	const deadline = Date.now() + 5000;
	while (changes < 1 && Date.now() < deadline) {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(filePath, '{"worker":"unicode/one"}\n', "utf8");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.ok(changes >= 1, "expected a create event for a Japanese-named path");
	assert.match(readFileSync(filePath, "utf8"), /unicode\/one/);

	// After close(), further file activity must not fire onChange.
	changes = 0;
	watcher.close();
	writeFileSync(filePath, '{"worker":"after/close"}\n', "utf8");
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(changes, 0);

	rmSync(base, { recursive: true, force: true });
});
