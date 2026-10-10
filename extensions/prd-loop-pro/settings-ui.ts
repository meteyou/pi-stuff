/**
 * PRD Loop Pro — Settings UI.
 *
 * First-start wizard, overview dialog, model picker (scoped models first +
 * "All available models…") and thinking picker. Persistence and validation live
 * in the pure settings module (./settings.ts).
 *
 * Not an index.ts, so pi does not load this file as a separate extension.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
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
	getSupportedThinkingLevels,
	isFixThreshold,
	loadSettingsFile,
	MIN_IMPLEMENTATION_RETRIES,
	MIN_MAX_REVIEW_ROUNDS,
	modelRef,
	parseIntegerInput,
	saveSettingsFile,
	STEP_KEYS,
	STEP_LABELS,
	stepIssues,
	validateSettings,
	type FixThreshold,
	type ModelInfo,
	type PrdLoopProSettings,
	type SettingsIssue,
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

// --- Overview ---

export interface PrdOverviewInfo {
	title: string;
	openTaskCount: number;
	completedTaskCount: number;
}

function formatStepValue(settings: PrdLoopProSettings, key: StepKey): string {
	const step = settings.steps[key];
	return `${step.model || "(not configured)"} · ${step.thinking}`;
}

function formatThreshold(value: string): string {
	return isFixThreshold(value) ? FIX_THRESHOLD_LABELS[value] : value;
}

/** Build the overview text (PRD, task counts, all settings, ⚠️ on invalid entries). */
export function buildOverviewMessage(
	prd: PrdOverviewInfo,
	settings: PrdLoopProSettings,
	issues: SettingsIssue[],
	settingsPath: string,
): string {
	const row = (label: string, value: string, invalid: boolean) =>
		`   ${invalid ? "⚠️ " : "   "}${label.padEnd(20)}${value}`;

	const lines = [
		`🚀 PRD Loop Pro`,
		``,
		`   PRD:   ${prd.title}`,
		`   Tasks: ${prd.openTaskCount} open, ${prd.completedTaskCount} completed`,
		``,
		`   Settings (${settingsPath}):`,
	];

	for (const key of STEP_KEYS) {
		lines.push(row(`${STEP_LABELS[key]}:`, formatStepValue(settings, key), stepIssues(issues, key).length > 0));
	}
	lines.push(row("Fix threshold:", formatThreshold(settings.fixThreshold), fieldIssues(issues, "fixThreshold").length > 0));
	lines.push(
		row("Max review rounds:", String(settings.maxReviewRounds), fieldIssues(issues, "maxReviewRounds").length > 0),
	);
	lines.push(
		row(
			"Impl. retries:",
			String(settings.implementationRetries),
			fieldIssues(issues, "implementationRetries").length > 0,
		),
	);

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
	const startOption = valid ? "▶️  Confirm & start" : "🚫 Confirm & start (fix ⚠️ entries first)";
	const changeOption = "✏️  Change";
	const cancelOption = "✖  Cancel";
	const choice = await ctx.ui.select(message, [startOption, changeOption, cancelOption]);
	if (choice === startOption) return "start";
	if (choice === changeOption) return "change";
	return "cancel";
}

// --- Start flow ---

function saveGlobalSettings(ctx: ExtensionCommandContext, path: string, settings: PrdLoopProSettings): void {
	try {
		saveSettingsFile(path, settings);
		ctx.ui.notify(`Saved PRD Loop Pro settings to ${path}`, "info");
	} catch (err) {
		ctx.ui.notify(
			`Failed to save settings to ${path}: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

/**
 * Load + validate settings, run the wizard if none exist, then show the
 * overview until the user confirms valid settings or cancels.
 *
 * Returns the confirmed settings, or undefined if the start was cancelled.
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

	const settingsPath = getGlobalSettingsPath(getAgentDir());
	const loaded = loadSettingsFile(settingsPath);
	let settings: PrdLoopProSettings;

	const sessionModelRef = ctx.model ? modelRef(ctx.model) : undefined;
	const defaultModel =
		(sessionModelRef && findModel(catalog.available, sessionModelRef)) || catalog.scoped[0] || catalog.available[0]!;
	const firstStartDefaults = () =>
		createDefaultSettings({
			model: modelRef(defaultModel),
			thinking: clampThinkingLevel(defaultModel, pi.getThinkingLevel()),
		});

	if (loaded.status === "loaded") {
		settings = loaded.settings;
	} else {
		if (loaded.status === "invalid") {
			const rerun = "Run setup wizard (overwrites the file)";
			const choice = await ctx.ui.select(`⚠️ ${loaded.error}`, [rerun, "Cancel"]);
			if (choice !== rerun) return undefined;
		}

		const wizardResult = await runSettingsWizard(ctx, catalog, firstStartDefaults());
		if (!wizardResult) return undefined;
		settings = wizardResult;
		saveGlobalSettings(ctx, settingsPath, settings);
	}

	while (true) {
		const issues = validateSettings(settings, catalog.available, { knownModels: catalog.all });
		const message = buildOverviewMessage(prd, settings, issues, settingsPath);
		const choice = await showOverview(ctx, message, issues.length === 0);

		if (choice === "cancel") return undefined;

		if (choice === "start") {
			if (issues.length === 0) return settings;
			ctx.ui.notify("Cannot start: fix the entries marked with ⚠️ first (choose \"Change\").", "warning");
			continue;
		}

		// "Change" re-runs the wizard with the current values as defaults.
		const changed = await runSettingsWizard(ctx, catalog, settings);
		if (!changed) continue; // Cancelled — back to the overview with unchanged settings
		settings = changed;
		saveGlobalSettings(ctx, settingsPath, settings);
	}
}
