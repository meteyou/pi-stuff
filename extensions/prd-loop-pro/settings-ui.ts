/**
 * PRD Loop Pro — Settings UI.
 *
 * First-start wizard, overview dialog (with the source of every entry:
 * `[global]` / `[project]`), per-entry change menu with the save targets
 * "Save globally" / "Save for this project only" / "Remove project overrides",
 * model picker (scoped models first + "All available models…") and thinking
 * picker. Persistence, merging and validation live in the pure settings module
 * (./settings.ts).
 *
 * Not an index.ts, so pi does not load this file as a separate extension.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	changedFields,
	clampThinkingLevel,
	cloneSettings,
	createDefaultSettings,
	DEFAULT_IMPLEMENTATION_RETRIES,
	DEFAULT_MAX_REVIEW_ROUNDS,
	FIX_THRESHOLD_LABELS,
	FIX_THRESHOLDS,
	fieldIssues,
	findModel,
	getGlobalSettingsPath,
	getProjectSettingsPath,
	getSupportedThinkingLevels,
	hasOverrides,
	isFixThreshold,
	loadProjectSettingsFile,
	loadSettingsFile,
	mergeSettings,
	MIN_IMPLEMENTATION_RETRIES,
	MIN_MAX_REVIEW_ROUNDS,
	modelRef,
	OVERRIDE_FIELDS,
	overrideFieldIssues,
	overrideFieldStep,
	parseIntegerInput,
	removeProjectOverrides,
	saveGlobally,
	saveProjectOnly,
	saveSettingsFile,
	STEP_KEYS,
	STEP_LABELS,
	validateSettings,
	type FixThreshold,
	type ModelInfo,
	type OverrideField,
	type PrdLoopProSettings,
	type ResolvedSettings,
	type SettingsIssue,
	type SettingsOverrides,
	type SettingsSource,
	type SettingsState,
	type StepKey,
	type ThinkingLevel,
} from "./settings.ts";

// --- Model catalog ---

/** Model as needed by the pickers (structurally compatible with pi's Model). */
export interface CatalogModel extends ModelInfo {
	name: string;
}

export interface ModelCatalog {
	/** Models with configured auth. */
	available: CatalogModel[];
	/** All known models (used for more specific validation messages). */
	all: CatalogModel[];
	/** Available models matching the `enabledModels` setting (empty if not configured). */
	scoped: CatalogModel[];
}

const VALID_THINKING_SUFFIXES = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function stripThinkingSuffix(modelPattern: string): string {
	const trimmed = modelPattern.trim();
	const lastColon = trimmed.lastIndexOf(":");
	if (lastColon === -1) return trimmed;
	const suffix = trimmed.slice(lastColon + 1).toLowerCase();
	if (!VALID_THINKING_SUFFIXES.has(suffix)) return trimmed;
	return trimmed.slice(0, lastColon);
}

function wildcardToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

function matchesModelPattern(pattern: string, model: CatalogModel): boolean {
	const normalized = stripThinkingSuffix(pattern);
	if (!normalized) return false;

	const matcher = wildcardToRegex(normalized);
	if (matcher.test(modelRef(model))) return true;
	if (!normalized.includes("/")) {
		if (matcher.test(model.id)) return true;
		if (matcher.test(model.name)) return true;
	}
	return false;
}

function getScopedModels(cwd: string, availableModels: CatalogModel[]): CatalogModel[] {
	try {
		const settings = SettingsManager.create(cwd);
		const patterns = settings.getEnabledModels();
		if (!patterns || patterns.length === 0) return [];
		return availableModels.filter((model) => patterns.some((pattern) => matchesModelPattern(pattern, model)));
	} catch {
		return [];
	}
}

export function buildModelCatalog(ctx: ExtensionCommandContext): ModelCatalog {
	const available = ctx.modelRegistry.getAvailable() as CatalogModel[];
	const all = ctx.modelRegistry.getAll() as CatalogModel[];
	return { available, all, scoped: getScopedModels(ctx.cwd, available) };
}

// --- Pickers ---

const ALL_MODELS_OPTION = "All available models…";

function modelOptionLabel(model: CatalogModel, currentRef: string | undefined): string {
	const ref = modelRef(model);
	return ref === currentRef ? `${model.name} (${ref}) ★` : `${model.name} (${ref})`;
}

async function pickFromModelList(
	ctx: ExtensionCommandContext,
	title: string,
	models: CatalogModel[],
	currentRef: string | undefined,
	extraOption?: string,
): Promise<CatalogModel | typeof ALL_MODELS_OPTION | undefined> {
	const options = models.map((m) => modelOptionLabel(m, currentRef));
	if (extraOption) options.push(extraOption);
	const choice = await ctx.ui.select(title, options);
	if (choice === undefined) return undefined;
	if (extraOption && choice === extraOption) return ALL_MODELS_OPTION;
	const index = options.indexOf(choice);
	return index === -1 ? undefined : models[index];
}

/**
 * Model picker: scoped models first with "All available models…" as last option.
 * Without scoped models, all available models are listed directly.
 * Returns the "provider/model-id" reference or undefined if cancelled.
 */
export async function pickModel(
	ctx: ExtensionCommandContext,
	title: string,
	catalog: ModelCatalog,
	currentRef: string | undefined,
): Promise<string | undefined> {
	if (catalog.scoped.length === 0) {
		const picked = await pickFromModelList(ctx, title, catalog.available, currentRef);
		return picked && picked !== ALL_MODELS_OPTION ? modelRef(picked) : undefined;
	}

	while (true) {
		const picked = await pickFromModelList(
			ctx,
			`${title} (scoped models)`,
			catalog.scoped,
			currentRef,
			ALL_MODELS_OPTION,
		);
		if (picked === undefined) return undefined;
		if (picked !== ALL_MODELS_OPTION) return modelRef(picked);

		const fromAll = await pickFromModelList(ctx, `${title} (all available models)`, catalog.available, currentRef);
		// Escape in the full list returns to the scoped list
		if (fromAll && fromAll !== ALL_MODELS_OPTION) return modelRef(fromAll);
	}
}

/**
 * Thinking picker: `off`, `minimal` … `xhigh` (restricted to what the model supports).
 * Non-reasoning models only support `off`, which is returned without prompting.
 */
export async function pickThinking(
	ctx: ExtensionCommandContext,
	title: string,
	model: ModelInfo | undefined,
	current: string,
): Promise<ThinkingLevel | undefined> {
	const levels: ThinkingLevel[] = model
		? getSupportedThinkingLevels(model)
		: ["off", "minimal", "low", "medium", "high", "xhigh"];
	if (levels.length === 1) return levels[0];

	const options = levels.map((level) => (level === current ? `${level} ★` : level));
	const choice = await ctx.ui.select(title, options);
	if (choice === undefined) return undefined;
	const index = options.indexOf(choice);
	return index === -1 ? undefined : levels[index];
}

async function pickFixThreshold(
	ctx: ExtensionCommandContext,
	title: string,
	current: string,
): Promise<FixThreshold | undefined> {
	const describe: Record<FixThreshold, string> = {
		P0: "fix only P0 findings",
		P1: "fix P0–P1 findings",
		P2: "fix P0–P2 findings",
		P3: "fix all findings (P0–P3)",
	};
	const options = FIX_THRESHOLDS.map((t) => {
		const label = `${FIX_THRESHOLD_LABELS[t]} — ${describe[t]}`;
		return t === current ? `${label} ★` : label;
	});
	const choice = await ctx.ui.select(title, options);
	if (choice === undefined) return undefined;
	const index = options.indexOf(choice);
	return index === -1 ? undefined : FIX_THRESHOLDS[index];
}

async function inputInteger(
	ctx: ExtensionCommandContext,
	title: string,
	options: { min: number; current: number },
): Promise<number | undefined> {
	while (true) {
		const input = await ctx.ui.input(`${title} (integer ≥ ${options.min}, Enter = ${options.current})`);
		if (input === undefined) return undefined;
		const parsed = parseIntegerInput(input, { min: options.min, fallback: options.current });
		if (parsed.ok) return parsed.value;
		ctx.ui.notify(parsed.error, "warning");
	}
}

// --- Wizard ---

const WIZARD_ENTRY_COUNT = STEP_KEYS.length + 3;

/**
 * Walk through every settings entry, using `initial` as defaults.
 * Returns the new settings or undefined if the user cancelled.
 */
export async function runSettingsWizard(
	ctx: ExtensionCommandContext,
	catalog: ModelCatalog,
	initial: PrdLoopProSettings,
): Promise<PrdLoopProSettings | undefined> {
	const settings = cloneSettings(initial);
	let entry = 0;
	const prefix = () => `PRD Loop Pro setup [${entry}/${WIZARD_ENTRY_COUNT}]`;

	for (const key of STEP_KEYS) {
		entry++;
		const label = STEP_LABELS[key];
		const step = settings.steps[key];

		const model = await pickModel(ctx, `${prefix()} ${label} — model`, catalog, step.model || undefined);
		if (model === undefined) return undefined;

		const modelInfo = findModel(catalog.available, model);
		const currentThinking = clampThinkingLevel(modelInfo, step.thinking);
		const thinking = await pickThinking(ctx, `${prefix()} ${label} — thinking level`, modelInfo, currentThinking);
		if (thinking === undefined) return undefined;

		settings.steps[key] = { model, thinking };
	}

	entry++;
	const threshold = await pickFixThreshold(ctx, `${prefix()} Fix threshold`, settings.fixThreshold);
	if (threshold === undefined) return undefined;
	settings.fixThreshold = threshold;

	entry++;
	const maxRounds = await inputInteger(ctx, `${prefix()} Max review rounds`, {
		min: MIN_MAX_REVIEW_ROUNDS,
		current: isValidInteger(settings.maxReviewRounds, MIN_MAX_REVIEW_ROUNDS)
			? settings.maxReviewRounds
			: DEFAULT_MAX_REVIEW_ROUNDS,
	});
	if (maxRounds === undefined) return undefined;
	settings.maxReviewRounds = maxRounds;

	entry++;
	const retries = await inputInteger(ctx, `${prefix()} Implementation retries`, {
		min: MIN_IMPLEMENTATION_RETRIES,
		current: isValidInteger(settings.implementationRetries, MIN_IMPLEMENTATION_RETRIES)
			? settings.implementationRetries
			: DEFAULT_IMPLEMENTATION_RETRIES,
	});
	if (retries === undefined) return undefined;
	settings.implementationRetries = retries;

	return settings;
}

function isValidInteger(value: number, min: number): boolean {
	return Number.isInteger(value) && value >= min;
}

// --- Formatting ---

export interface PrdOverviewInfo {
	title: string;
	openTaskCount: number;
	completedTaskCount: number;
}

/** Paths of the settings files shown in the overview. */
export interface SettingsPaths {
	globalPath: string;
	projectPath: string;
}

const FIELD_LABELS: Record<Exclude<OverrideField, `steps.${StepKey}`>, string> = {
	fixThreshold: "Fix threshold",
	maxReviewRounds: "Max review rounds",
	implementationRetries: "Impl. retries",
};

function fieldLabel(field: OverrideField): string {
	const step = overrideFieldStep(field);
	return step ? STEP_LABELS[step] : FIELD_LABELS[field as keyof typeof FIELD_LABELS];
}

function formatThreshold(value: string): string {
	return isFixThreshold(value) ? FIX_THRESHOLD_LABELS[value] : value;
}

function formatFieldValue(settings: PrdLoopProSettings, field: OverrideField): string {
	const step = overrideFieldStep(field);
	if (step) {
		const setting = settings.steps[step];
		return `${setting.model || "(not configured)"} · ${setting.thinking}`;
	}
	if (field === "fixThreshold") return formatThreshold(settings.fixThreshold);
	if (field === "maxReviewRounds") return String(settings.maxReviewRounds);
	return String(settings.implementationRetries);
}

function formatSource(source: SettingsSource): string {
	return `[${source}]`;
}

/**
 * Build the overview text (PRD, task counts, all settings with their source,
 * ⚠️ on invalid entries).
 */
export function buildOverviewMessage(
	prd: PrdOverviewInfo,
	resolved: ResolvedSettings,
	issues: SettingsIssue[],
	paths: SettingsPaths & { projectFileExists: boolean },
): string {
	const { settings, sources } = resolved;
	const row = (label: string, value: string, source: SettingsSource, invalid: boolean) =>
		`   ${invalid ? "⚠️ " : "   "}${label.padEnd(20)}${value.padEnd(44)} ${formatSource(source)}`;

	const lines = [
		`🚀 PRD Loop Pro`,
		``,
		`   PRD:   ${prd.title}`,
		`   Tasks: ${prd.openTaskCount} open, ${prd.completedTaskCount} completed`,
		``,
		`   Settings:`,
		`      global:  ${paths.globalPath}`,
		`      project: ${paths.projectPath}${paths.projectFileExists ? "" : " (none)"}`,
		``,
	];

	for (const field of OVERRIDE_FIELDS) {
		lines.push(
			row(
				`${fieldLabel(field)}:`,
				formatFieldValue(settings, field),
				sources[field],
				overrideFieldIssues(issues, field).length > 0,
			),
		);
	}
	if (fieldIssues(issues, "projectFile").length > 0) {
		lines.push(`   ⚠️ ${"Project file:".padEnd(20)}invalid — remove or overwrite it via "Change"`);
	}

	if (issues.length > 0) {
		lines.push("", "⚠️  Invalid settings — change them before starting:");
		for (const issue of issues) lines.push(`   • ${issue.message}`);
	}

	return lines.join("\n");
}

type OverviewChoice = "start" | "change" | "cancel";

async function showOverview(
	ctx: ExtensionCommandContext,
	message: string,
	valid: boolean,
): Promise<OverviewChoice> {
	const startOption = valid ? "🚀 Confirm & start" : "🚫 Confirm & start (fix ⚠️ entries first)";
	const changeOption = "📝 Change";
	const cancelOption = "❌ Cancel";
	const choice = await ctx.ui.select(message, [startOption, changeOption, cancelOption]);
	if (choice === startOption) return "start";
	if (choice === changeOption) return "change";
	return "cancel";
}

// --- Change menu ---

/** Edit a single entry in place. Returns false if the user cancelled. */
async function editField(
	ctx: ExtensionCommandContext,
	catalog: ModelCatalog,
	draft: PrdLoopProSettings,
	field: OverrideField,
): Promise<boolean> {
	const label = fieldLabel(field);
	const step = overrideFieldStep(field);

	if (step) {
		const current = draft.steps[step];
		const model = await pickModel(ctx, `${label} — model`, catalog, current.model || undefined);
		if (model === undefined) return false;
		const modelInfo = findModel(catalog.available, model);
		const thinking = await pickThinking(
			ctx,
			`${label} — thinking level`,
			modelInfo,
			clampThinkingLevel(modelInfo, current.thinking),
		);
		if (thinking === undefined) return false;
		draft.steps[step] = { model, thinking };
		return true;
	}

	if (field === "fixThreshold") {
		const threshold = await pickFixThreshold(ctx, label, draft.fixThreshold);
		if (threshold === undefined) return false;
		draft.fixThreshold = threshold;
		return true;
	}

	if (field === "maxReviewRounds") {
		const value = await inputInteger(ctx, label, {
			min: MIN_MAX_REVIEW_ROUNDS,
			current: isValidInteger(draft.maxReviewRounds, MIN_MAX_REVIEW_ROUNDS)
				? draft.maxReviewRounds
				: DEFAULT_MAX_REVIEW_ROUNDS,
		});
		if (value === undefined) return false;
		draft.maxReviewRounds = value;
		return true;
	}

	const value = await inputInteger(ctx, label, {
		min: MIN_IMPLEMENTATION_RETRIES,
		current: isValidInteger(draft.implementationRetries, MIN_IMPLEMENTATION_RETRIES)
			? draft.implementationRetries
			: DEFAULT_IMPLEMENTATION_RETRIES,
	});
	if (value === undefined) return false;
	draft.implementationRetries = value;
	return true;
}

function notifyError(ctx: ExtensionCommandContext, prefix: string, err: unknown): void {
	ctx.ui.notify(`${prefix}: ${err instanceof Error ? err.message : String(err)}`, "error");
}

/**
 * Change menu: one row per entry (with source and ⚠️ marker) plus the save
 * actions. Selecting a row edits only that entry and returns to the menu.
 *
 * Returns the new settings state after a save/remove action, or undefined if
 * the user went back to the overview without saving.
 */
async function runChangeMenu(
	ctx: ExtensionCommandContext,
	catalog: ModelCatalog,
	paths: SettingsPaths,
	state: SettingsState,
	projectFileError: string | undefined,
): Promise<SettingsState | undefined> {
	const before = mergeSettings(state.global, state.overrides);
	const draft = cloneSettings(before.settings);

	const SAVE_GLOBAL = "💾 Save globally";
	const SAVE_PROJECT = "📁 Save for this project only";
	const REMOVE_PROJECT = "🧹 Remove project overrides";
	const BACK = "🔙 Back to overview (discard changes)";

	while (true) {
		const issues = validateSettings(draft, catalog.available, { knownModels: catalog.all });
		const changed = changedFields(before.settings, draft);

		const rows = OVERRIDE_FIELDS.map((field) => {
			const invalid = overrideFieldIssues(issues, field).length > 0;
			const modified = changed.includes(field) ? " • changed" : "";
			return `${invalid ? "⚠️ " : ""}${fieldLabel(field)}: ${formatFieldValue(draft, field)} ${formatSource(before.sources[field])}${modified}`;
		});

		const canRemoveProject = hasOverrides(state.overrides) || projectFileError !== undefined;
		const actions = [SAVE_GLOBAL, SAVE_PROJECT, ...(canRemoveProject ? [REMOVE_PROJECT] : []), BACK];

		const titleLines = ["📝 Change PRD Loop Pro settings — select an entry or an action"];
		if (changed.length > 0) titleLines.push(`   ${changed.length} unsaved change(s)`);
		if (projectFileError) titleLines.push(`   ⚠️ ${projectFileError}`);
		for (const issue of issues) titleLines.push(`   ⚠️ ${issue.message}`);

		const choice = await ctx.ui.select(titleLines.join("\n"), [...rows, ...actions]);

		if (choice === undefined || choice === BACK) {
			if (changed.length === 0) return undefined;
			const discard = await ctx.ui.confirm(
				"Discard changes?",
				`${changed.length} unsaved change(s) will be lost.`,
			);
			if (discard) return undefined;
			continue;
		}

		const rowIndex = rows.indexOf(choice);
		if (rowIndex !== -1) {
			await editField(ctx, catalog, draft, OVERRIDE_FIELDS[rowIndex]!);
			continue;
		}

		if (choice === SAVE_GLOBAL) {
			try {
				const next = saveGlobally(paths, state, before.settings, draft);
				ctx.ui.notify(`Saved PRD Loop Pro settings globally (${paths.globalPath})`, "info");
				return next;
			} catch (err) {
				notifyError(ctx, "Failed to save global settings", err);
				continue;
			}
		}

		if (choice === SAVE_PROJECT) {
			try {
				const next = saveProjectOnly(paths.projectPath, state.global, draft);
				const count = OVERRIDE_FIELDS.filter((f) => mergeSettings(next.global, next.overrides).sources[f] === "project").length;
				ctx.ui.notify(
					count > 0
						? `Saved ${count} project override(s) to ${paths.projectPath}`
						: `No differences from global settings — removed ${paths.projectPath}`,
					"info",
				);
				return next;
			} catch (err) {
				notifyError(ctx, "Failed to save project settings", err);
				continue;
			}
		}

		if (choice === REMOVE_PROJECT) {
			const lost = changed.length > 0 ? ` ${changed.length} unsaved change(s) will be discarded.` : "";
			const ok = await ctx.ui.confirm(
				"Remove project overrides?",
				`Deletes ${paths.projectPath}; this project will use the global settings.${lost}`,
			);
			if (!ok) continue;
			try {
				const next = removeProjectOverrides(paths.projectPath, state.global);
				ctx.ui.notify(`Removed project overrides (${paths.projectPath})`, "info");
				return next;
			} catch (err) {
				notifyError(ctx, "Failed to remove project settings", err);
				continue;
			}
		}
	}
}

// --- Start flow ---

function saveGlobalSettings(ctx: ExtensionCommandContext, path: string, settings: PrdLoopProSettings): void {
	try {
		saveSettingsFile(path, settings);
		ctx.ui.notify(`Saved PRD Loop Pro settings to ${path}`, "info");
	} catch (err) {
		notifyError(ctx, `Failed to save settings to ${path}`, err);
	}
}

interface ProjectSettingsLoad {
	overrides: SettingsOverrides;
	exists: boolean;
	error?: string;
}

function loadProjectSettings(path: string): ProjectSettingsLoad {
	const loaded = loadProjectSettingsFile(path);
	if (loaded.status === "missing") return { overrides: {}, exists: false };
	if (loaded.status === "invalid") return { overrides: {}, exists: true, error: loaded.error };
	return { overrides: loaded.overrides, exists: true };
}

/**
 * Load global settings (wizard if none exist) and project overrides, then show
 * the overview until the user confirms valid settings or cancels.
 *
 * Returns the confirmed effective settings (global merged with project
 * overrides), or undefined if the start was cancelled.
 */
export async function resolveStartSettings(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	prd: PrdOverviewInfo,
): Promise<PrdLoopProSettings | undefined> {
	const catalog = buildModelCatalog(ctx);
	if (catalog.available.length === 0) {
		ctx.ui.notify("No models available. Please configure an API key.", "error");
		return undefined;
	}

	const paths: SettingsPaths = {
		globalPath: getGlobalSettingsPath(getAgentDir()),
		projectPath: getProjectSettingsPath(ctx.cwd),
	};
	const loaded = loadSettingsFile(paths.globalPath);
	let global: PrdLoopProSettings;

	const sessionModelRef = ctx.model ? modelRef(ctx.model) : undefined;
	const defaultModel =
		(sessionModelRef && findModel(catalog.available, sessionModelRef)) || catalog.scoped[0] || catalog.available[0]!;
	const firstStartDefaults = () =>
		createDefaultSettings({
			model: modelRef(defaultModel),
			thinking: clampThinkingLevel(defaultModel, pi.getThinkingLevel()),
		});

	if (loaded.status === "loaded") {
		global = loaded.settings;
	} else {
		if (loaded.status === "invalid") {
			const rerun = "Run setup wizard (overwrites the file)";
			const choice = await ctx.ui.select(`⚠️ ${loaded.error}`, [rerun, "Cancel"]);
			if (choice !== rerun) return undefined;
		}

		const wizardResult = await runSettingsWizard(ctx, catalog, firstStartDefaults());
		if (!wizardResult) return undefined;
		global = wizardResult;
		saveGlobalSettings(ctx, paths.globalPath, global);
	}

	let project = loadProjectSettings(paths.projectPath);
	let state: SettingsState = { global, overrides: project.overrides };

	while (true) {
		const resolved = mergeSettings(state.global, state.overrides);
		const issues = validateSettings(resolved.settings, catalog.available, { knownModels: catalog.all });
		if (project.error) issues.push({ field: "projectFile", message: project.error });

		const message = buildOverviewMessage(prd, resolved, issues, { ...paths, projectFileExists: project.exists });
		const choice = await showOverview(ctx, message, issues.length === 0);

		if (choice === "cancel") return undefined;

		if (choice === "start") {
			if (issues.length === 0) return resolved.settings;
			ctx.ui.notify("Cannot start: fix the entries marked with ⚠️ first (choose \"Change\").", "warning");
			continue;
		}

		const next = await runChangeMenu(ctx, catalog, paths, state, project.error);
		if (!next) continue; // Back without saving — overview with unchanged settings
		state = next;
		// Re-read the project file so its existence / error state reflects what was written
		project = loadProjectSettings(paths.projectPath);
		if (!project.error) state = { global: state.global, overrides: project.overrides };
	}
}
