import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	DEFAULT_FIX_THRESHOLD,
	DEFAULT_IMPLEMENTATION_RETRIES,
	DEFAULT_MAX_REVIEW_ROUNDS,
	SETTINGS_FILE_NAME,
	SETTINGS_VERSION,
	STEP_KEYS,
	clampThinkingLevel,
	createDefaultSettings,
	fieldIssues,
	getGlobalSettingsPath,
	getSupportedThinkingLevels,
	loadSettingsFile,
	parseIntegerInput,
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
