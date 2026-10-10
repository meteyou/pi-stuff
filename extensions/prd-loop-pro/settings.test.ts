import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
	DEFAULT_FIX_THRESHOLD,
	DEFAULT_IMPLEMENTATION_RETRIES,
	DEFAULT_MAX_REVIEW_ROUNDS,
	OVERRIDE_FIELDS,
	SETTINGS_FILE_NAME,
	SETTINGS_VERSION,
	STEP_KEYS,
	changedFields,
	clampThinkingLevel,
	computeProjectOverrides,
	createDefaultSettings,
	fieldIssues,
	getGlobalSettingsPath,
	getProjectSettingsPath,
	getSupportedThinkingLevels,
	hasOverrides,
	loadProjectSettingsFile,
	loadSettingsFile,
	mergeSettings,
	overrideFieldIssues,
	parseIntegerInput,
	planGlobalSave,
	removeProjectOverrides,
	removeProjectSettingsFile,
	saveGlobally,
	saveProjectOnly,
	saveProjectSettingsFile,
	saveSettingsFile,
	stepIssues,
	validateSettings,
} from "./settings.ts";
import type { ModelInfo, PrdLoopProSettings } from "./settings.ts";

const REASONING: ModelInfo = { provider: "anthropic", id: "claude-sonnet", name: "Sonnet", reasoning: true };
const REASONING_XHIGH: ModelInfo = {
	provider: "openai",
	id: "gpt-5",
	name: "GPT-5",
	reasoning: true,
	thinkingLevelMap: { xhigh: "xhigh", minimal: null },
};
const NON_REASONING: ModelInfo = { provider: "openai", id: "gpt-4o-mini", name: "4o mini", reasoning: false };
const ROUTED: ModelInfo = { provider: "openrouter", id: "anthropic/claude-3.5", reasoning: false };

const AVAILABLE = [REASONING, REASONING_XHIGH, NON_REASONING, ROUTED];

function validSettings(): PrdLoopProSettings {
	return createDefaultSettings({ model: "anthropic/claude-sonnet", thinking: "medium" });
}

describe("createDefaultSettings", () => {
	it("uses the given model + thinking for every step and default numbers", () => {
		const settings = createDefaultSettings({ model: "anthropic/claude-sonnet", thinking: "high" });
		assert.equal(settings.version, SETTINGS_VERSION);
		for (const key of STEP_KEYS) {
			assert.deepEqual(settings.steps[key], { model: "anthropic/claude-sonnet", thinking: "high" });
		}
		assert.equal(settings.fixThreshold, DEFAULT_FIX_THRESHOLD);
		assert.equal(settings.maxReviewRounds, 3);
		assert.equal(settings.implementationRetries, 0);
		assert.equal(DEFAULT_MAX_REVIEW_ROUNDS, 3);
		assert.equal(DEFAULT_IMPLEMENTATION_RETRIES, 0);
	});
});

describe("load / save", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prd-loop-pro-settings-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("places the global settings file in the agent directory", () => {
		assert.equal(getGlobalSettingsPath(dir), join(dir, SETTINGS_FILE_NAME));
	});

	it("reports a missing file", () => {
		const result = loadSettingsFile(join(dir, "prd-loop-pro.json"));
		assert.equal(result.status, "missing");
	});

	it("roundtrips saved settings", () => {
		const path = join(dir, "nested", "agent", SETTINGS_FILE_NAME);
		const settings = validSettings();
		settings.steps.review = { model: "openai/gpt-5", thinking: "xhigh" };
		settings.steps.commit = { model: "openai/gpt-4o-mini", thinking: "off" };
		settings.fixThreshold = "P2";
		settings.maxReviewRounds = 5;
		settings.implementationRetries = 2;

		saveSettingsFile(path, settings);
		assert.ok(existsSync(path));

		const result = loadSettingsFile(path);
		assert.equal(result.status, "loaded");
		if (result.status !== "loaded") return;
		assert.deepEqual(result.settings, settings);

		// File is human-readable JSON with the schema fields
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		assert.equal(raw.version, SETTINGS_VERSION);
		assert.deepEqual(Object.keys(raw.steps).sort(), [...STEP_KEYS].sort());
	});

	it("overwrites an existing file", () => {
		const path = join(dir, SETTINGS_FILE_NAME);
		saveSettingsFile(path, validSettings());
		const changed = validSettings();
		changed.maxReviewRounds = 7;
		saveSettingsFile(path, changed);
		const result = loadSettingsFile(path);
		assert.equal(result.status, "loaded");
		if (result.status === "loaded") assert.equal(result.settings.maxReviewRounds, 7);
	});

	it("reports invalid JSON", () => {
		const path = join(dir, SETTINGS_FILE_NAME);
		writeFileSync(path, "{ not json", "utf-8");
		const result = loadSettingsFile(path);
		assert.equal(result.status, "invalid");
	});

	it("reports a non-object JSON document", () => {
		const path = join(dir, SETTINGS_FILE_NAME);
		writeFileSync(path, "[1, 2]", "utf-8");
		assert.equal(loadSettingsFile(path).status, "invalid");
	});

	it("fills defaults for missing fields and flags missing models", () => {
		const path = join(dir, SETTINGS_FILE_NAME);
		writeFileSync(
			path,
			JSON.stringify({ version: 1, steps: { implement: { model: "anthropic/claude-sonnet", thinking: "low" } } }),
			"utf-8",
		);
		const result = loadSettingsFile(path);
		assert.equal(result.status, "loaded");
		if (result.status !== "loaded") return;
		const { settings } = result;
		assert.deepEqual(settings.steps.implement, { model: "anthropic/claude-sonnet", thinking: "low" });
		assert.deepEqual(settings.steps.review, { model: "", thinking: "off" });
		assert.equal(settings.fixThreshold, DEFAULT_FIX_THRESHOLD);
		assert.equal(settings.maxReviewRounds, DEFAULT_MAX_REVIEW_ROUNDS);
		assert.equal(settings.implementationRetries, DEFAULT_IMPLEMENTATION_RETRIES);

		const issues = validateSettings(settings, AVAILABLE);
		assert.equal(stepIssues(issues, "implement").length, 0);
		assert.equal(fieldIssues(issues, "steps.review.model").length, 1);
	});

	it("keeps wrongly typed numbers so validation flags them", () => {
		const path = join(dir, SETTINGS_FILE_NAME);
		const raw = { ...validSettings(), maxReviewRounds: "3" };
		writeFileSync(path, JSON.stringify(raw), "utf-8");
		const result = loadSettingsFile(path);
		assert.equal(result.status, "loaded");
		if (result.status !== "loaded") return;
		assert.equal(fieldIssues(validateSettings(result.settings, AVAILABLE), "maxReviewRounds").length, 1);
	});
});

describe("validateSettings", () => {
	it("accepts valid settings", () => {
		assert.deepEqual(validateSettings(validSettings(), AVAILABLE), []);
	});

	it("accepts model ids containing slashes", () => {
		const settings = validSettings();
		settings.steps.orchestrator = { model: "openrouter/anthropic/claude-3.5", thinking: "off" };
		assert.deepEqual(validateSettings(settings, AVAILABLE), []);
	});

	it("flags an unknown model", () => {
		const settings = validSettings();
		settings.steps.review.model = "acme/does-not-exist";
		const issues = validateSettings(settings, AVAILABLE);
		assert.equal(issues.length, 1);
		assert.equal(issues[0]!.field, "steps.review.model");
		assert.match(issues[0]!.message, /acme\/does-not-exist/);
	});

	it("flags a known but unauthenticated model with a specific message", () => {
		const settings = validSettings();
		settings.steps.fix.model = "google/gemini";
		const known: ModelInfo[] = [...AVAILABLE, { provider: "google", id: "gemini", reasoning: true }];
		const issues = validateSettings(settings, AVAILABLE, { knownModels: known });
		assert.equal(issues.length, 1);
		assert.equal(issues[0]!.field, "steps.fix.model");
		assert.match(issues[0]!.message, /not available/);
		assert.match(issues[0]!.message, /auth/);
	});

	it("flags an empty model", () => {
		const settings = validSettings();
		settings.steps.commit.model = "";
		const issues = validateSettings(settings, AVAILABLE);
		assert.deepEqual(issues.map((i) => i.field), ["steps.commit.model"]);
	});

	it("flags a thinking level other than off for a non-reasoning model", () => {
		const settings = validSettings();
		settings.steps.commit = { model: "openai/gpt-4o-mini", thinking: "low" };
		const issues = validateSettings(settings, AVAILABLE);
		assert.equal(issues.length, 1);
		assert.equal(issues[0]!.field, "steps.commit.thinking");
	});

	it("accepts off for a non-reasoning model", () => {
		const settings = validSettings();
		settings.steps.commit = { model: "openai/gpt-4o-mini", thinking: "off" };
		assert.deepEqual(validateSettings(settings, AVAILABLE), []);
	});

	it("accepts off for a reasoning model", () => {
		const settings = validSettings();
		settings.steps.implement = { model: "anthropic/claude-sonnet", thinking: "off" };
		assert.deepEqual(validateSettings(settings, AVAILABLE), []);
	});

	it("flags an unknown thinking level", () => {
		const settings = validSettings();
		settings.steps.implement.thinking = "ultra";
		const issues = validateSettings(settings, AVAILABLE);
		assert.deepEqual(issues.map((i) => i.field), ["steps.implement.thinking"]);
	});

	it("flags xhigh for a model without xhigh support and accepts it where supported", () => {
		const settings = validSettings();
		settings.steps.implement.thinking = "xhigh";
		settings.steps.review = { model: "openai/gpt-5", thinking: "xhigh" };
		const issues = validateSettings(settings, AVAILABLE);
		assert.deepEqual(issues.map((i) => i.field), ["steps.implement.thinking"]);
	});

	it("flags levels mapped to null", () => {
		const settings = validSettings();
		settings.steps.review = { model: "openai/gpt-5", thinking: "minimal" };
		const issues = validateSettings(settings, AVAILABLE);
		assert.deepEqual(issues.map((i) => i.field), ["steps.review.thinking"]);
	});

	it("flags out-of-range numbers", () => {
		const settings = validSettings();
		settings.maxReviewRounds = 0;
		settings.implementationRetries = -1;
		const issues = validateSettings(settings, AVAILABLE);
		assert.deepEqual(issues.map((i) => i.field).sort(), ["implementationRetries", "maxReviewRounds"]);
	});

	it("flags non-integer numbers", () => {
		const settings = validSettings();
		settings.maxReviewRounds = 2.5;
		settings.implementationRetries = Number.NaN;
		const issues = validateSettings(settings, AVAILABLE);
		assert.deepEqual(issues.map((i) => i.field).sort(), ["implementationRetries", "maxReviewRounds"]);
	});

	it("accepts boundary values", () => {
		const settings = validSettings();
		settings.maxReviewRounds = 1;
		settings.implementationRetries = 0;
		assert.deepEqual(validateSettings(settings, AVAILABLE), []);
	});

	it("flags an invalid fix threshold", () => {
		const settings = validSettings();
		settings.fixThreshold = "P4";
		const issues = validateSettings(settings, AVAILABLE);
		assert.deepEqual(issues.map((i) => i.field), ["fixThreshold"]);
	});

	it("flags every model step when no models are available", () => {
		const issues = validateSettings(validSettings(), []);
		assert.equal(issues.length, STEP_KEYS.length);
		for (const key of STEP_KEYS) assert.equal(stepIssues(issues, key).length, 1);
	});
});

describe("thinking level helpers", () => {
	it("non-reasoning models only support off", () => {
		assert.deepEqual(getSupportedThinkingLevels(NON_REASONING), ["off"]);
	});

	it("reasoning models support off..high, xhigh only when mapped", () => {
		assert.deepEqual(getSupportedThinkingLevels(REASONING), ["off", "minimal", "low", "medium", "high"]);
		assert.deepEqual(getSupportedThinkingLevels(REASONING_XHIGH), ["off", "low", "medium", "high", "xhigh"]);
	});

	it("clamps defaults to a supported level", () => {
		assert.equal(clampThinkingLevel(NON_REASONING, "high"), "off");
		assert.equal(clampThinkingLevel(REASONING, "xhigh"), "high");
		assert.equal(clampThinkingLevel(REASONING, "medium"), "medium");
		assert.equal(clampThinkingLevel(undefined, "bogus"), "off");
	});
});

describe("parseIntegerInput", () => {
	it("returns the fallback for empty input", () => {
		assert.deepEqual(parseIntegerInput("  ", { min: 1, fallback: 3 }), { ok: true, value: 3 });
	});

	it("parses integers at or above the minimum", () => {
		assert.deepEqual(parseIntegerInput("5", { min: 1, fallback: 3 }), { ok: true, value: 5 });
		assert.deepEqual(parseIntegerInput("0", { min: 0, fallback: 3 }), { ok: true, value: 0 });
	});

	it("rejects non-integers and values below the minimum", () => {
		assert.equal(parseIntegerInput("abc", { min: 1, fallback: 3 }).ok, false);
		assert.equal(parseIntegerInput("1.5", { min: 1, fallback: 3 }).ok, false);
		assert.equal(parseIntegerInput("0", { min: 1, fallback: 3 }).ok, false);
		assert.equal(parseIntegerInput("-1", { min: 0, fallback: 0 }).ok, false);
	});
});

describe("project overrides: merge + source tracking", () => {
	it("uses global values with source global when there are no overrides", () => {
		const global = validSettings();
		for (const overrides of [undefined, {}]) {
			const { settings, sources } = mergeSettings(global, overrides);
			assert.deepEqual(settings, global);
			for (const field of OVERRIDE_FIELDS) assert.equal(sources[field], "global");
		}
	});

	it("overrides only the review step; all other steps keep global values", () => {
		const global = validSettings();
		const { settings, sources } = mergeSettings(global, {
			steps: { review: { model: "openai/gpt-5", thinking: "xhigh" } },
		});
		assert.deepEqual(settings.steps.review, { model: "openai/gpt-5", thinking: "xhigh" });
		assert.equal(sources["steps.review"], "project");
		for (const key of STEP_KEYS) {
			if (key === "review") continue;
			assert.deepEqual(settings.steps[key], global.steps[key]);
			assert.equal(sources[`steps.${key}`], "global");
		}
		assert.equal(settings.fixThreshold, global.fixThreshold);
		assert.equal(sources.fixThreshold, "global");
		assert.equal(sources.maxReviewRounds, "global");
		assert.equal(sources.implementationRetries, "global");
	});

	it("merges scalar fields individually", () => {
		const global = validSettings();
		const { settings, sources } = mergeSettings(global, { maxReviewRounds: 5 });
		assert.equal(settings.maxReviewRounds, 5);
		assert.equal(sources.maxReviewRounds, "project");
		assert.equal(settings.implementationRetries, global.implementationRetries);
		assert.equal(sources.implementationRetries, "global");
		assert.equal(sources.fixThreshold, "global");
	});

	it("fills a partial step override from the global step", () => {
		const global = validSettings();
		const { settings, sources } = mergeSettings(global, { steps: { fix: { thinking: "low" } } });
		assert.deepEqual(settings.steps.fix, { model: global.steps.fix.model, thinking: "low" });
		assert.equal(sources["steps.fix"], "project");
	});

	it("does not mutate the global settings", () => {
		const global = validSettings();
		const copy = structuredClone(global);
		mergeSettings(global, { steps: { review: { model: "openai/gpt-5" } }, maxReviewRounds: 9 });
		assert.deepEqual(global, copy);
	});

	it("validation of merged settings flags an invalid project override", () => {
		const global = validSettings();
		const { settings, sources } = mergeSettings(global, {
			steps: { review: { model: "acme/gone", thinking: "high" } },
		});
		const issues = validateSettings(settings, AVAILABLE);
		assert.deepEqual(issues.map((i) => i.field), ["steps.review.model"]);
		assert.equal(sources["steps.review"], "project");
		assert.equal(overrideFieldIssues(issues, "steps.review").length, 1);
		assert.equal(overrideFieldIssues(issues, "steps.implement").length, 0);
	});
});

describe("project overrides: computeProjectOverrides / planGlobalSave", () => {
	it("contains only fields that differ from global", () => {
		const global = validSettings();
		const draft = validSettings();
		draft.steps.review = { model: "openai/gpt-5", thinking: "high" };
		draft.maxReviewRounds = 4;
		assert.deepEqual(computeProjectOverrides(global, draft), {
			steps: { review: { model: "openai/gpt-5", thinking: "high" } },
			maxReviewRounds: 4,
		});
		assert.deepEqual(computeProjectOverrides(global, validSettings()), {});
		assert.equal(hasOverrides(computeProjectOverrides(global, validSettings())), false);
	});

	it("lists changed fields", () => {
		const before = validSettings();
		const after = validSettings();
		after.steps.commit.thinking = "low";
		after.fixThreshold = "P3";
		assert.deepEqual(changedFields(before, after), ["steps.commit", "fixThreshold"]);
	});

	it("global save writes changed fields and drops only their project overrides", () => {
		const global = validSettings();
		const overrides = {
			steps: { review: { model: "openai/gpt-5", thinking: "high" } },
			maxReviewRounds: 5,
		};
		const before = mergeSettings(global, overrides).settings;
		const draft = structuredClone(before);
		draft.maxReviewRounds = 2; // was a project override
		draft.steps.commit = { model: "openai/gpt-4o-mini", thinking: "off" }; // was global

		const next = planGlobalSave({ global, overrides }, before, draft);
		assert.equal(next.global.maxReviewRounds, 2);
		assert.deepEqual(next.global.steps.commit, { model: "openai/gpt-4o-mini", thinking: "off" });
		// Untouched project-overridden step is NOT copied into global
		assert.deepEqual(next.global.steps.review, global.steps.review);
		assert.deepEqual(next.overrides, { steps: { review: { model: "openai/gpt-5", thinking: "high" } } });

		const merged = mergeSettings(next.global, next.overrides);
		assert.deepEqual(merged.settings, draft);
		assert.equal(merged.sources["steps.review"], "project");
		assert.equal(merged.sources.maxReviewRounds, "global");
	});
});

describe("project overrides: files", () => {
	let dir: string;
	let globalPath: string;
	let projectPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prd-loop-pro-project-test-"));
		globalPath = join(dir, "agent", SETTINGS_FILE_NAME);
		projectPath = getProjectSettingsPath(join(dir, "project"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("places the project settings file in the project's .pi directory", () => {
		assert.equal(getProjectSettingsPath("/repo"), join("/repo", ".pi", SETTINGS_FILE_NAME));
	});

	it("reports a missing project file", () => {
		assert.equal(loadProjectSettingsFile(projectPath).status, "missing");
	});

	it("reports an invalid project file", () => {
		mkdirSync(dirname(projectPath), { recursive: true });
		writeFileSync(projectPath, "{ nope", "utf-8");
		assert.equal(loadProjectSettingsFile(projectPath).status, "invalid");
		writeFileSync(projectPath, JSON.stringify({ version: SETTINGS_VERSION + 1 }), "utf-8");
		assert.equal(loadProjectSettingsFile(projectPath).status, "invalid");
	});

	it("loads only the fields present in the project file", () => {
		mkdirSync(dirname(projectPath), { recursive: true });
		writeFileSync(
			projectPath,
			JSON.stringify({ version: 1, steps: { review: { model: "openai/gpt-5", thinking: "high" } } }),
			"utf-8",
		);
		const result = loadProjectSettingsFile(projectPath);
		assert.equal(result.status, "loaded");
		if (result.status !== "loaded") return;
		assert.deepEqual(result.overrides, {
			version: 1,
			steps: { review: { model: "openai/gpt-5", thinking: "high" } },
		});
		const { sources } = mergeSettings(validSettings(), result.overrides);
		assert.deepEqual(
			OVERRIDE_FIELDS.filter((f) => sources[f] === "project"),
			["steps.review"],
		);
	});

	it("keeps wrongly typed override values so validation flags them", () => {
		mkdirSync(dirname(projectPath), { recursive: true });
		writeFileSync(projectPath, JSON.stringify({ maxReviewRounds: "many", steps: { fix: "x" } }), "utf-8");
		const result = loadProjectSettingsFile(projectPath);
		assert.equal(result.status, "loaded");
		if (result.status !== "loaded") return;
		const { settings, sources } = mergeSettings(validSettings(), result.overrides);
		const issues = validateSettings(settings, AVAILABLE);
		assert.deepEqual(issues.map((i) => i.field).sort(), ["maxReviewRounds", "steps.fix.model"]);
		assert.equal(sources.maxReviewRounds, "project");
		assert.equal(sources["steps.fix"], "project");
	});

	it("project-only save writes only the fields that differ from global", () => {
		const global = validSettings();
		saveSettingsFile(globalPath, global);
		const draft = validSettings();
		draft.steps.review = { model: "openai/gpt-5", thinking: "xhigh" };
		draft.implementationRetries = 2;

		const state = saveProjectOnly(projectPath, global, draft);
		const raw = JSON.parse(readFileSync(projectPath, "utf-8"));
		assert.deepEqual(raw, {
			version: SETTINGS_VERSION,
			steps: { review: { model: "openai/gpt-5", thinking: "xhigh" } },
			implementationRetries: 2,
		});
		// Global file untouched
		const globalLoaded = loadSettingsFile(globalPath);
		assert.equal(globalLoaded.status, "loaded");
		if (globalLoaded.status === "loaded") assert.deepEqual(globalLoaded.settings, global);

		// Reload → merged = draft
		const loaded = loadProjectSettingsFile(projectPath);
		assert.equal(loaded.status, "loaded");
		if (loaded.status === "loaded") assert.deepEqual(mergeSettings(global, loaded.overrides).settings, draft);
		assert.deepEqual(mergeSettings(state.global, state.overrides).settings, draft);
	});

	it("project-only save drops overrides that now equal global and removes an empty file", () => {
		const global = validSettings();
		const draft = validSettings();
		draft.maxReviewRounds = 6;
		saveProjectOnly(projectPath, global, draft);
		assert.ok(existsSync(projectPath));

		const state = saveProjectOnly(projectPath, global, validSettings());
		assert.deepEqual(state.overrides, {});
		assert.equal(existsSync(projectPath), false);
	});

	it("global save updates the global file and prunes overrides of changed fields", () => {
		const global = validSettings();
		saveSettingsFile(globalPath, global);
		const overrides = { steps: { review: { model: "openai/gpt-5", thinking: "high" } }, fixThreshold: "P0" };
		saveProjectSettingsFile(projectPath, overrides);

		const before = mergeSettings(global, overrides).settings;
		const draft = structuredClone(before);
		draft.fixThreshold = "P2";

		const next = saveGlobally({ globalPath, projectPath }, { global, overrides }, before, draft);
		const globalLoaded = loadSettingsFile(globalPath);
		assert.equal(globalLoaded.status, "loaded");
		if (globalLoaded.status === "loaded") {
			assert.equal(globalLoaded.settings.fixThreshold, "P2");
			assert.deepEqual(globalLoaded.settings.steps.review, global.steps.review);
		}
		const projectLoaded = loadProjectSettingsFile(projectPath);
		assert.equal(projectLoaded.status, "loaded");
		if (projectLoaded.status === "loaded") {
			assert.equal(projectLoaded.overrides.fixThreshold, undefined);
			assert.deepEqual(projectLoaded.overrides.steps, { review: { model: "openai/gpt-5", thinking: "high" } });
		}
		assert.deepEqual(mergeSettings(next.global, next.overrides).settings, draft);
	});

	it("global save without project file does not create one", () => {
		const global = validSettings();
		const draft = validSettings();
		draft.maxReviewRounds = 8;
		saveGlobally({ globalPath, projectPath }, { global, overrides: {} }, global, draft);
		assert.equal(existsSync(projectPath), false);
		const loaded = loadSettingsFile(globalPath);
		assert.equal(loaded.status, "loaded");
		if (loaded.status === "loaded") assert.equal(loaded.settings.maxReviewRounds, 8);
	});

	it("removing project overrides deletes the file and falls back to global", () => {
		const global = validSettings();
		saveProjectSettingsFile(projectPath, { maxReviewRounds: 9 });
		assert.ok(existsSync(projectPath));

		const state = removeProjectOverrides(projectPath, global);
		assert.equal(existsSync(projectPath), false);
		assert.equal(loadProjectSettingsFile(projectPath).status, "missing");
		const { settings, sources } = mergeSettings(state.global, state.overrides);
		assert.deepEqual(settings, global);
		for (const field of OVERRIDE_FIELDS) assert.equal(sources[field], "global");

		// Removing again is a no-op
		assert.equal(removeProjectSettingsFile(projectPath), false);
	});
});
