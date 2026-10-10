/**
 * PRD Loop Pro — Settings module (pure, no pi imports).
 *
 * Schema, defaults, load/save of the global settings file and validation
 * against an injected list of available models.
 *
 * This file is intentionally free of pi imports so it can be unit-tested with
 * `node --test` (native TypeScript type stripping). Only erasable TypeScript
 * syntax is allowed here (no enums, no parameter properties, no namespaces).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// --- Constants ---

export const SETTINGS_VERSION = 1;
export const SETTINGS_FILE_NAME = "prd-loop-pro.json";

/** Thinking levels selectable per step (ordered from none to deepest). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Agent steps that carry their own model + thinking level. */
export const STEP_KEYS = ["implement", "review", "fix", "commit", "orchestrator"] as const;
export type StepKey = (typeof STEP_KEYS)[number];

/** Human-readable labels for the step keys. */
export const STEP_LABELS: Record<StepKey, string> = {
	implement: "Implement",
	review: "Review",
	fix: "Fix",
	commit: "Commit",
	orchestrator: "Orchestrator",
};

/** Fix threshold: fix all findings with priority ≤ threshold (P0 = most severe). */
export const FIX_THRESHOLDS = ["P0", "P1", "P2", "P3"] as const;
export type FixThreshold = (typeof FIX_THRESHOLDS)[number];

export const FIX_THRESHOLD_LABELS: Record<FixThreshold, string> = {
	P0: "Only P0",
	P1: "≤ P1",
	P2: "≤ P2",
	P3: "≤ P3",
};

export const DEFAULT_FIX_THRESHOLD: FixThreshold = "P1";
export const DEFAULT_MAX_REVIEW_ROUNDS = 3;
export const DEFAULT_IMPLEMENTATION_RETRIES = 0;
export const MIN_MAX_REVIEW_ROUNDS = 1;
export const MIN_IMPLEMENTATION_RETRIES = 0;

// --- Types ---

/**
 * Model + thinking level for one agent step.
 *
 * Values are kept as plain strings because settings are loaded from disk and may
 * contain stale or invalid entries; `validateSettings()` reports those.
 */
export interface StepSetting {
	/** Model reference in "provider/model-id" format ("" = not configured). */
	model: string;
	/** Thinking level, one of THINKING_LEVELS when valid. */
	thinking: string;
}

export interface PrdLoopProSettings {
	version: number;
	steps: Record<StepKey, StepSetting>;
	/** One of FIX_THRESHOLDS when valid. */
	fixThreshold: string;
	/** Integer ≥ 1 when valid. */
	maxReviewRounds: number;
	/** Integer ≥ 0 when valid. */
	implementationRetries: number;
}

/** Minimal model description needed for validation (structurally compatible with pi's Model). */
export interface ModelInfo {
	provider: string;
	id: string;
	name?: string;
	reasoning: boolean;
	/** Per-level provider mapping; `null` marks a level as unsupported, `xhigh` must be mapped explicitly. */
	thinkingLevelMap?: Partial<Record<string, string | null>>;
}

/** Identifies a single settings entry. */
export type SettingsField =
	| `steps.${StepKey}.model`
	| `steps.${StepKey}.thinking`
	| "version"
	| "fixThreshold"
	| "maxReviewRounds"
	| "implementationRetries";

export interface SettingsIssue {
	field: SettingsField;
	message: string;
}

export type LoadSettingsResult =
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: string }
	| { status: "loaded"; path: string; settings: PrdLoopProSettings };

// --- Paths ---

/** Path of the global settings file inside the pi agent directory. */
export function getGlobalSettingsPath(agentDir: string): string {
	return join(agentDir, SETTINGS_FILE_NAME);
}

// --- Model helpers ---

/** "provider/model-id" reference for a model. */
export function modelRef(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

/** Find a model by its "provider/model-id" reference. */
export function findModel<T extends { provider: string; id: string }>(models: readonly T[], ref: string): T | undefined {
	return models.find((m) => modelRef(m) === ref);
}

/**
 * Thinking levels a model supports, restricted to THINKING_LEVELS.
 * Non-reasoning models only support "off".
 */
export function getSupportedThinkingLevels(model: ModelInfo): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined;
		return true;
	});
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function isFixThreshold(value: unknown): value is FixThreshold {
	return typeof value === "string" && (FIX_THRESHOLDS as readonly string[]).includes(value);
}

/** Pick the closest supported thinking level for a model (used for defaults). */
export function clampThinkingLevel(model: ModelInfo | undefined, level: string): ThinkingLevel {
	const requested: ThinkingLevel = isThinkingLevel(level) ? level : "off";
	if (!model) return requested;
	const supported = getSupportedThinkingLevels(model);
	if (supported.includes(requested)) return requested;
	const index = THINKING_LEVELS.indexOf(requested);
	for (let i = index; i >= 0; i--) {
		if (supported.includes(THINKING_LEVELS[i]!)) return THINKING_LEVELS[i]!;
	}
	return supported[0] ?? "off";
}

// --- Defaults ---

/**
 * Default settings for the first-start wizard: every model step uses the given
 * model + thinking level (normally the current session model).
 */
export function createDefaultSettings(defaults: { model: string; thinking: string }): PrdLoopProSettings {
	const steps = {} as Record<StepKey, StepSetting>;
	for (const key of STEP_KEYS) {
		steps[key] = { model: defaults.model, thinking: defaults.thinking };
	}
	return {
		version: SETTINGS_VERSION,
		steps,
		fixThreshold: DEFAULT_FIX_THRESHOLD,
		maxReviewRounds: DEFAULT_MAX_REVIEW_ROUNDS,
		implementationRetries: DEFAULT_IMPLEMENTATION_RETRIES,
	};
}

/** Deep copy of a settings object. */
export function cloneSettings(settings: PrdLoopProSettings): PrdLoopProSettings {
	const steps = {} as Record<StepKey, StepSetting>;
	for (const key of STEP_KEYS) {
		steps[key] = { ...settings.steps[key] };
	}
	return { ...settings, steps };
}

// --- Normalization ---

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNumber(value: unknown, fallback: number): number {
	if (value === undefined) return fallback;
	return typeof value === "number" ? value : Number.NaN;
}

/**
 * Normalize raw parsed JSON into the settings shape.
 *
 * Missing numeric/threshold fields fall back to defaults; missing step models
 * become "" (reported as "not configured" by validation); missing thinking
 * levels become "off". Values of the wrong type are kept in a form that
 * validation will flag instead of being silently replaced.
 */
export function normalizeSettings(raw: Record<string, unknown>): PrdLoopProSettings {
	const rawSteps = isPlainObject(raw.steps) ? raw.steps : {};
	const steps = {} as Record<StepKey, StepSetting>;
	for (const key of STEP_KEYS) {
		const step = isPlainObject(rawSteps[key]) ? rawSteps[key] : {};
		steps[key] = {
			model: typeof step.model === "string" ? step.model.trim() : "",
			thinking: step.thinking === undefined ? "off" : typeof step.thinking === "string" ? step.thinking : String(step.thinking),
		};
	}

	return {
		version: typeof raw.version === "number" ? raw.version : SETTINGS_VERSION,
		steps,
		fixThreshold:
			raw.fixThreshold === undefined
				? DEFAULT_FIX_THRESHOLD
				: typeof raw.fixThreshold === "string"
					? raw.fixThreshold
					: String(raw.fixThreshold),
		maxReviewRounds: normalizeNumber(raw.maxReviewRounds, DEFAULT_MAX_REVIEW_ROUNDS),
		implementationRetries: normalizeNumber(raw.implementationRetries, DEFAULT_IMPLEMENTATION_RETRIES),
	};
}

// --- Load / save ---

/** Load a settings file. Never throws. */
export function loadSettingsFile(path: string): LoadSettingsResult {
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "missing", path };
		return { status: "invalid", path, error: `Cannot read ${path}: ${errorMessage(err)}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (err) {
		return { status: "invalid", path, error: `Invalid JSON in ${path}: ${errorMessage(err)}` };
	}

	if (!isPlainObject(parsed)) {
		return { status: "invalid", path, error: `Invalid settings in ${path}: expected a JSON object` };
	}

	return { status: "loaded", path, settings: normalizeSettings(parsed) };
}

/** Write a settings file (creates parent directories, atomic rename). */
export function saveSettingsFile(path: string, settings: PrdLoopProSettings): void {
	mkdirSync(dirname(path), { recursive: true });
	const data: PrdLoopProSettings = { ...cloneSettings(settings), version: SETTINGS_VERSION };
	const tmpPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
	renameSync(tmpPath, path);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// --- Parsing user input ---

/**
 * Parse an integer entered by the user. Empty input returns the fallback.
 * Returns an error message for non-integers or values below `min`.
 */
export function parseIntegerInput(
	input: string,
	options: { min: number; fallback: number },
): { ok: true; value: number } | { ok: false; error: string } {
	const trimmed = input.trim();
	if (trimmed === "") return { ok: true, value: options.fallback };
	if (!/^-?\d+$/.test(trimmed)) return { ok: false, error: `"${trimmed}" is not an integer` };
	const value = Number(trimmed);
	if (value < options.min) return { ok: false, error: `Value must be ≥ ${options.min}` };
	return { ok: true, value };
}

// --- Validation ---

export interface ValidateSettingsOptions {
	/**
	 * All known models (including those without configured auth). Only used to
	 * produce a more specific message for models that exist but are not authenticated.
	 */
	knownModels?: readonly ModelInfo[];
}

/**
 * Validate settings against the list of available (authenticated) models.
 * Returns one issue per invalid entry; an empty list means the settings are valid.
 */
export function validateSettings(
	settings: PrdLoopProSettings,
	availableModels: readonly ModelInfo[],
	options: ValidateSettingsOptions = {},
): SettingsIssue[] {
	const issues: SettingsIssue[] = [];

	if (settings.version > SETTINGS_VERSION) {
		issues.push({
			field: "version",
			message: `Settings version ${settings.version} is newer than supported (${SETTINGS_VERSION})`,
		});
	}

	for (const key of STEP_KEYS) {
		const step = settings.steps[key];
		const label = STEP_LABELS[key];
		let model: ModelInfo | undefined;

		if (!step.model) {
			issues.push({ field: `steps.${key}.model`, message: `${label}: no model configured` });
		} else {
			model = findModel(availableModels, step.model);
			if (!model) {
				const known = options.knownModels ? findModel(options.knownModels, step.model) : undefined;
				issues.push({
					field: `steps.${key}.model`,
					message: known
						? `${label}: model "${step.model}" is not available (no API key / auth configured)`
						: `${label}: model "${step.model}" is unknown or not available`,
				});
			}
		}

		if (!isThinkingLevel(step.thinking)) {
			issues.push({
				field: `steps.${key}.thinking`,
				message: `${label}: invalid thinking level "${step.thinking}" (expected one of: ${THINKING_LEVELS.join(", ")})`,
			});
		} else if (model) {
			const supported = getSupportedThinkingLevels(model);
			if (!supported.includes(step.thinking)) {
				issues.push({
					field: `steps.${key}.thinking`,
					message: model.reasoning
						? `${label}: thinking level "${step.thinking}" is not supported by ${step.model} (supported: ${supported.join(", ")})`
						: `${label}: ${step.model} does not support reasoning; thinking level must be "off"`,
				});
			}
		}
	}

	if (!isFixThreshold(settings.fixThreshold)) {
		issues.push({
			field: "fixThreshold",
			message: `Invalid fix threshold "${settings.fixThreshold}" (expected one of: ${FIX_THRESHOLDS.join(", ")})`,
		});
	}

	if (!Number.isInteger(settings.maxReviewRounds) || settings.maxReviewRounds < MIN_MAX_REVIEW_ROUNDS) {
		issues.push({
			field: "maxReviewRounds",
			message: `Max review rounds must be an integer ≥ ${MIN_MAX_REVIEW_ROUNDS} (got ${String(settings.maxReviewRounds)})`,
		});
	}

	if (!Number.isInteger(settings.implementationRetries) || settings.implementationRetries < MIN_IMPLEMENTATION_RETRIES) {
		issues.push({
			field: "implementationRetries",
			message: `Implementation retries must be an integer ≥ ${MIN_IMPLEMENTATION_RETRIES} (got ${String(settings.implementationRetries)})`,
		});
	}

	return issues;
}

/** Issues for a given step (model + thinking). */
export function stepIssues(issues: readonly SettingsIssue[], step: StepKey): SettingsIssue[] {
	return issues.filter((issue) => issue.field === `steps.${step}.model` || issue.field === `steps.${step}.thinking`);
}

/** Issues for a single field. */
export function fieldIssues(issues: readonly SettingsIssue[], field: SettingsField): SettingsIssue[] {
	return issues.filter((issue) => issue.field === field);
}
