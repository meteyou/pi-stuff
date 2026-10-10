/**
 * PRD Loop Pro — Settings module (pure, no pi imports).
 *
 * Schema, defaults, load/save of the global settings file, per-project
 * overrides (per-field merge with source tracking, project-only save, removal)
 * and validation against an injected list of available models.
 *
 * This file is intentionally free of pi imports so it can be unit-tested with
 * `node --test` (native TypeScript type stripping). Only erasable TypeScript
 * syntax is allowed here (no enums, no parameter properties, no namespaces).
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// --- Constants ---

export const SETTINGS_VERSION = 1;
export const SETTINGS_FILE_NAME = "prd-loop-pro.json";
/** Project config directory (relative to the project root) holding the project settings file. */
export const PROJECT_CONFIG_DIR_NAME = ".pi";

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
	| "implementationRetries"
	/** The project settings file itself cannot be used (unreadable / invalid JSON). */
	| "projectFile";

/**
 * A field that can be overridden per project. Steps are overridden as a unit
 * (model + thinking belong together), all other fields individually.
 */
export type OverrideField = `steps.${StepKey}` | "fixThreshold" | "maxReviewRounds" | "implementationRetries";

/** All overridable fields in display order. */
export const OVERRIDE_FIELDS: readonly OverrideField[] = [
	...STEP_KEYS.map((key) => `steps.${key}` as const),
	"fixThreshold",
	"maxReviewRounds",
	"implementationRetries",
];

/** Where a resolved field value comes from. */
export type SettingsSource = "global" | "project";

/**
 * Contents of the project settings file: only the overridden fields.
 * A step override may be partial; missing parts are taken from the global step.
 */
export interface SettingsOverrides {
	version?: number;
	steps?: Partial<Record<StepKey, Partial<StepSetting>>>;
	fixThreshold?: string;
	maxReviewRounds?: number;
	implementationRetries?: number;
}

/** Effective settings (global merged with project overrides) plus the source of every field. */
export interface ResolvedSettings {
	settings: PrdLoopProSettings;
	sources: Record<OverrideField, SettingsSource>;
}

export type LoadOverridesResult =
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: string }
	| { status: "loaded"; path: string; overrides: SettingsOverrides };

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

/** Path of the project settings file inside the project's `.pi` directory. */
export function getProjectSettingsPath(projectDir: string): string {
	return join(projectDir, PROJECT_CONFIG_DIR_NAME, SETTINGS_FILE_NAME);
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

/**
 * Normalize raw parsed JSON of a project settings file into overrides.
 *
 * Only fields present in the file become overrides. Values of the wrong type are
 * kept in a form that validation of the merged settings will flag.
 */
export function normalizeOverrides(raw: Record<string, unknown>): SettingsOverrides {
	const overrides: SettingsOverrides = {};
	if (typeof raw.version === "number") overrides.version = raw.version;

	if (isPlainObject(raw.steps)) {
		const steps: Partial<Record<StepKey, Partial<StepSetting>>> = {};
		for (const key of STEP_KEYS) {
			if (!(key in raw.steps)) continue;
			const step = raw.steps[key];
			if (!isPlainObject(step)) {
				// Unusable step override: flagged as "no model configured" by validation
				steps[key] = { model: "" };
				continue;
			}
			const override: Partial<StepSetting> = {};
			if ("model" in step) override.model = typeof step.model === "string" ? step.model.trim() : "";
			if ("thinking" in step) {
				override.thinking = typeof step.thinking === "string" ? step.thinking : String(step.thinking);
			}
			if (override.model !== undefined || override.thinking !== undefined) steps[key] = override;
		}
		if (Object.keys(steps).length > 0) overrides.steps = steps;
	}

	if (raw.fixThreshold !== undefined) {
		overrides.fixThreshold = typeof raw.fixThreshold === "string" ? raw.fixThreshold : String(raw.fixThreshold);
	}
	if (raw.maxReviewRounds !== undefined) {
		overrides.maxReviewRounds = normalizeNumber(raw.maxReviewRounds, DEFAULT_MAX_REVIEW_ROUNDS);
	}
	if (raw.implementationRetries !== undefined) {
		overrides.implementationRetries = normalizeNumber(raw.implementationRetries, DEFAULT_IMPLEMENTATION_RETRIES);
	}

	return overrides;
}

// --- Load / save ---

type ReadJsonResult =
	| { status: "missing" }
	| { status: "invalid"; error: string }
	| { status: "loaded"; data: Record<string, unknown> };

function readJsonObject(path: string): ReadJsonResult {
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "missing" };
		return { status: "invalid", error: `Cannot read ${path}: ${errorMessage(err)}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (err) {
		return { status: "invalid", error: `Invalid JSON in ${path}: ${errorMessage(err)}` };
	}

	if (!isPlainObject(parsed)) {
		return { status: "invalid", error: `Invalid settings in ${path}: expected a JSON object` };
	}
	return { status: "loaded", data: parsed };
}

/** Load a settings file. Never throws. */
export function loadSettingsFile(path: string): LoadSettingsResult {
	const result = readJsonObject(path);
	if (result.status === "missing") return { status: "missing", path };
	if (result.status === "invalid") return { status: "invalid", path, error: result.error };
	return { status: "loaded", path, settings: normalizeSettings(result.data) };
}

/** Load a project settings file (overrides only). Never throws. */
export function loadProjectSettingsFile(path: string): LoadOverridesResult {
	const result = readJsonObject(path);
	if (result.status === "missing") return { status: "missing", path };
	if (result.status === "invalid") return { status: "invalid", path, error: result.error };
	const overrides = normalizeOverrides(result.data);
	if (overrides.version !== undefined && overrides.version > SETTINGS_VERSION) {
		return {
			status: "invalid",
			path,
			error: `Project settings version ${overrides.version} in ${path} is newer than supported (${SETTINGS_VERSION})`,
		};
	}
	return { status: "loaded", path, overrides };
}

/** Write a settings file (creates parent directories, atomic rename). */
export function saveSettingsFile(path: string, settings: PrdLoopProSettings): void {
	const data: PrdLoopProSettings = { ...cloneSettings(settings), version: SETTINGS_VERSION };
	writeJsonAtomic(path, data);
}

function writeJsonAtomic(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmpPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
	renameSync(tmpPath, path);
}

/**
 * Write the project settings file with the given overrides. If there are no
 * overrides, the file is removed instead (project files stay minimal).
 */
export function saveProjectSettingsFile(path: string, overrides: SettingsOverrides): "written" | "removed" {
	if (!hasOverrides(overrides)) {
		removeProjectSettingsFile(path);
		return "removed";
	}
	const data: SettingsOverrides = { version: SETTINGS_VERSION };
	if (overrides.steps) {
		const steps: Partial<Record<StepKey, Partial<StepSetting>>> = {};
		for (const key of STEP_KEYS) {
			const step = overrides.steps[key];
			if (step) steps[key] = { ...step };
		}
		if (Object.keys(steps).length > 0) data.steps = steps;
	}
	if (overrides.fixThreshold !== undefined) data.fixThreshold = overrides.fixThreshold;
	if (overrides.maxReviewRounds !== undefined) data.maxReviewRounds = overrides.maxReviewRounds;
	if (overrides.implementationRetries !== undefined) data.implementationRetries = overrides.implementationRetries;
	writeJsonAtomic(path, data);
	return "written";
}

/** Delete the project settings file. Returns true if a file was removed. */
export function removeProjectSettingsFile(path: string): boolean {
	try {
		rmSync(path);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
		throw err;
	}
}

// --- Project overrides: merge, diff, save targets ---

/** Whether the overrides contain at least one overridden field. */
export function hasOverrides(overrides: SettingsOverrides | undefined): boolean {
	if (!overrides) return false;
	if (overrides.steps && STEP_KEYS.some((key) => overrides.steps![key] !== undefined)) return true;
	return (
		overrides.fixThreshold !== undefined ||
		overrides.maxReviewRounds !== undefined ||
		overrides.implementationRetries !== undefined
	);
}

/** Step key of a `steps.*` override field, or undefined for scalar fields. */
export function overrideFieldStep(field: OverrideField): StepKey | undefined {
	return field.startsWith("steps.") ? (field.slice("steps.".length) as StepKey) : undefined;
}

/** Whether a single field is overridden. */
function isOverridden(overrides: SettingsOverrides, field: OverrideField): boolean {
	const step = overrideFieldStep(field);
	if (step) return overrides.steps?.[step] !== undefined;
	return overrides[field as Exclude<OverrideField, `steps.${StepKey}`>] !== undefined;
}

/** Copy a field value from `source` settings into `target` settings. */
function copyField(target: PrdLoopProSettings, source: PrdLoopProSettings, field: OverrideField): void {
	const step = overrideFieldStep(field);
	if (step) {
		target.steps[step] = { ...source.steps[step] };
	} else if (field === "fixThreshold") {
		target.fixThreshold = source.fixThreshold;
	} else if (field === "maxReviewRounds") {
		target.maxReviewRounds = source.maxReviewRounds;
	} else if (field === "implementationRetries") {
		target.implementationRetries = source.implementationRetries;
	}
}

/** Whether a field has the same value in both settings objects. */
export function fieldEquals(a: PrdLoopProSettings, b: PrdLoopProSettings, field: OverrideField): boolean {
	const step = overrideFieldStep(field);
	if (step) return a.steps[step].model === b.steps[step].model && a.steps[step].thinking === b.steps[step].thinking;
	const key = field as "fixThreshold" | "maxReviewRounds" | "implementationRetries";
	return Object.is(a[key], b[key]);
}

/** Fields whose value differs between `before` and `after`. */
export function changedFields(before: PrdLoopProSettings, after: PrdLoopProSettings): OverrideField[] {
	return OVERRIDE_FIELDS.filter((field) => !fieldEquals(before, after, field));
}

/**
 * Merge global settings with project overrides (per field) and record the
 * source of every field. A partial step override takes the missing part from
 * the global step and counts as a project value.
 */
export function mergeSettings(global: PrdLoopProSettings, overrides?: SettingsOverrides): ResolvedSettings {
	const settings = cloneSettings(global);
	const sources = {} as Record<OverrideField, SettingsSource>;
	for (const field of OVERRIDE_FIELDS) sources[field] = "global";
	if (!overrides) return { settings, sources };

	for (const key of STEP_KEYS) {
		const step = overrides.steps?.[key];
		if (!step) continue;
		settings.steps[key] = {
			model: step.model ?? global.steps[key].model,
			thinking: step.thinking ?? global.steps[key].thinking,
		};
		sources[`steps.${key}`] = "project";
	}
	if (overrides.fixThreshold !== undefined) {
		settings.fixThreshold = overrides.fixThreshold;
		sources.fixThreshold = "project";
	}
	if (overrides.maxReviewRounds !== undefined) {
		settings.maxReviewRounds = overrides.maxReviewRounds;
		sources.maxReviewRounds = "project";
	}
	if (overrides.implementationRetries !== undefined) {
		settings.implementationRetries = overrides.implementationRetries;
		sources.implementationRetries = "project";
	}
	return { settings, sources };
}

/**
 * Overrides containing only the fields of `target` that differ from `global`
 * (used for "Save for this project only"). Steps are stored as a whole.
 */
export function computeProjectOverrides(global: PrdLoopProSettings, target: PrdLoopProSettings): SettingsOverrides {
	const overrides: SettingsOverrides = {};
	for (const field of OVERRIDE_FIELDS) {
		if (fieldEquals(global, target, field)) continue;
		const step = overrideFieldStep(field);
		if (step) {
			overrides.steps = { ...overrides.steps, [step]: { ...target.steps[step] } };
		} else if (field === "fixThreshold") {
			overrides.fixThreshold = target.fixThreshold;
		} else if (field === "maxReviewRounds") {
			overrides.maxReviewRounds = target.maxReviewRounds;
		} else if (field === "implementationRetries") {
			overrides.implementationRetries = target.implementationRetries;
		}
	}
	return overrides;
}

/** Copy of the overrides without the given fields. */
export function withoutOverrides(overrides: SettingsOverrides, fields: readonly OverrideField[]): SettingsOverrides {
	const result: SettingsOverrides = {};
	if (overrides.version !== undefined) result.version = overrides.version;
	for (const field of OVERRIDE_FIELDS) {
		if (fields.includes(field) || !isOverridden(overrides, field)) continue;
		const step = overrideFieldStep(field);
		if (step) {
			result.steps = { ...result.steps, [step]: { ...overrides.steps![step] } };
		} else if (field === "fixThreshold") {
			result.fixThreshold = overrides.fixThreshold;
		} else if (field === "maxReviewRounds") {
			result.maxReviewRounds = overrides.maxReviewRounds;
		} else if (field === "implementationRetries") {
			result.implementationRetries = overrides.implementationRetries;
		}
	}
	return result;
}

/** Current settings state of a project: global settings + optional project overrides. */
export interface SettingsState {
	global: PrdLoopProSettings;
	/** Project overrides (empty object if there is no project file). */
	overrides: SettingsOverrides;
}

/**
 * "Save globally": the fields changed between `before` (effective settings when
 * editing started) and `draft` are written to the global settings, and project
 * overrides of exactly those fields are dropped so the change takes effect here
 * too. Untouched project overrides stay in place.
 */
export function planGlobalSave(state: SettingsState, before: PrdLoopProSettings, draft: PrdLoopProSettings): SettingsState {
	const changed = changedFields(before, draft);
	const global = cloneSettings(state.global);
	for (const field of changed) copyField(global, draft, field);
	return { global, overrides: withoutOverrides(state.overrides, changed) };
}

/**
 * Write "Save globally" to disk: global file always, project file only if it
 * had overrides of changed fields. Returns the new state.
 */
export function saveGlobally(
	paths: { globalPath: string; projectPath: string },
	state: SettingsState,
	before: PrdLoopProSettings,
	draft: PrdLoopProSettings,
): SettingsState {
	const next = planGlobalSave(state, before, draft);
	saveSettingsFile(paths.globalPath, next.global);
	const projectChanged = OVERRIDE_FIELDS.some(
		(field) => isOverridden(state.overrides, field) !== isOverridden(next.overrides, field),
	);
	if (projectChanged) saveProjectSettingsFile(paths.projectPath, next.overrides);
	return next;
}

/**
 * "Save for this project only": writes only the fields of `draft` that differ
 * from the global settings (removes the file if nothing differs). Returns the new state.
 */
export function saveProjectOnly(projectPath: string, global: PrdLoopProSettings, draft: PrdLoopProSettings): SettingsState {
	const overrides = computeProjectOverrides(global, draft);
	saveProjectSettingsFile(projectPath, overrides);
	return { global: cloneSettings(global), overrides };
}

/** "Remove project overrides": deletes the project file. Returns the new state. */
export function removeProjectOverrides(projectPath: string, global: PrdLoopProSettings): SettingsState {
	removeProjectSettingsFile(projectPath);
	return { global: cloneSettings(global), overrides: {} };
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

/** Issues belonging to an overridable field (a step's model + thinking, or a scalar field). */
export function overrideFieldIssues(issues: readonly SettingsIssue[], field: OverrideField): SettingsIssue[] {
	const step = overrideFieldStep(field);
	return step ? stepIssues(issues, step) : fieldIssues(issues, field as SettingsField);
}
