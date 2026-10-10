/**
 * PRD Loop Pro — Settings UI.
 *
 * First-start wizard, overview menu (every entry with its source
 * `[global]` / `[project]` is selectable and edited in place; unsaved edits are
 * saved globally or for this project only when starting), model picker (scoped
 * models first + "All available models…") and thinking picker. Persistence, merging and validation live in the pure settings module
 * (./settings.ts).
 *
 * Not an index.ts, so pi does not load this file as a separate extension.
 */

import type { ExtensionAPI, ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir, keyText, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { buildOverviewMenu, fieldLabel } from "./overview-menu.ts";
import type { OverviewAction, PrdOverviewInfo, SettingsPaths } from "./overview-menu.ts";
import {
	changedFields,
	clampThinkingLevel,
	cloneSettings,
	createDefaultSettings,
	DEFAULT_IMPLEMENTATION_RETRIES,
	DEFAULT_MAX_REVIEW_ROUNDS,
	FIX_THRESHOLD_LABELS,
	FIX_THRESHOLDS,
	findModel,
	getGlobalSettingsPath,
	getProjectSettingsPath,
	getSupportedThinkingLevels,
	hasOverrides,
	loadProjectSettingsFile,
	loadSettingsFile,
	mergeSettings,
	MIN_IMPLEMENTATION_RETRIES,
	MIN_MAX_REVIEW_ROUNDS,
	modelRef,
	OVERRIDE_FIELDS,
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
	type SettingsOverrides,
	type SettingsState,
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

export type { PrdOverviewInfo, SettingsPaths } from "./overview-menu.ts";

// --- Menu selector ---

/**
 * Selector that looks like pi's `ctx.ui.select`, but starts at a given item
 * and can separate groups with a blank line (settings rows / actions).
 */
class MenuSelector extends Container {
	private selectedIndex: number;
	private readonly list = new Container();

	constructor(
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		title: string,
		private readonly labels: string[],
		initialIndex: number,
		private readonly gapBefore: number | undefined,
		private readonly onSelect: (index: number) => void,
		private readonly onCancel: () => void,
	) {
		super();
		this.selectedIndex = Math.max(0, Math.min(initialIndex, labels.length - 1));
		const border = () => new DynamicBorder((text) => theme.fg("border", text));
		const hint = (key: string, description: string) => theme.fg("dim", key) + theme.fg("muted", ` ${description}`);
		this.addChild(border());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				`${hint("↑↓", "navigate")}  ${hint(keyText("tui.select.confirm") || "enter", "select")}  ` +
					hint(keyText("tui.select.cancel") || "escape", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(border());
		this.updateList();
	}

	private updateList(): void {
		this.list.clear();
		this.labels.forEach((label, index) => {
			if (index > 0 && index === this.gapBefore) this.list.addChild(new Spacer(1));
			const text = index === this.selectedIndex
				? this.theme.fg("accent", `→ ${label}`)
				: `  ${this.theme.fg("text", label)}`;
			this.list.addChild(new Text(text, 1, 0));
		});
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
			this.selectedIndex = Math.min(this.labels.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (this.keybindings.matches(data, "tui.select.confirm") || data === "\n") {
			this.onSelect(this.selectedIndex);
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel();
		}
	}
}

/** Show a {@link MenuSelector}; resolves with the selected index, or undefined on cancel. */
function selectMenuItem(
	ctx: ExtensionCommandContext,
	title: string,
	labels: string[],
	initialIndex: number,
	gapBefore?: number,
): Promise<number | undefined> {
	return ctx.ui.custom<number | undefined>(
		(_tui, theme, keybindings, done) =>
			new MenuSelector(theme, keybindings, title, labels, initialIndex, gapBefore, done, () => done(undefined)),
	);
}

// --- Editing ---

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
	let saved = mergeSettings(state.global, state.overrides);
	let draft = cloneSettings(saved.settings);
	let cursor: number | undefined;

	const reloadProject = (next: SettingsState) => {
		project = loadProjectSettings(paths.projectPath);
		state = project.error ? next : { global: next.global, overrides: project.overrides };
		saved = mergeSettings(state.global, state.overrides);
		draft = cloneSettings(saved.settings);
	};
	/** Issues of the draft, plus the project file error (if any). */
	const currentIssues = (settings: PrdLoopProSettings) => {
		const issues = validateSettings(settings, catalog.available, { knownModels: catalog.all });
		if (project.error) issues.push({ field: "projectFile", message: project.error });
		return issues;
	};

	while (true) {
		const issues = currentIssues(draft);
		const changed = changedFields(saved.settings, draft);
		const menu = buildOverviewMenu({
			prd,
			paths: { ...paths, projectFileExists: project.exists },
			draft,
			sources: saved.sources,
			issues,
			changed,
			canRemoveProject: hasOverrides(state.overrides) || project.error !== undefined,
		});

		const index = await selectMenuItem(
			ctx,
			menu.title,
			menu.items.map((item) => item.label),
			cursor ?? menu.defaultIndex,
			menu.rowCount,
		);
		const item = index === undefined ? undefined : menu.items[index];
		const action: OverviewAction = item?.action ?? { kind: "cancel" };
		cursor = undefined;

		if (action.kind === "edit") {
			await editField(ctx, catalog, draft, action.field);
			cursor = index; // stay on the edited row
			continue;
		}

		if (item?.blocked) {
			ctx.ui.notify("Cannot start: fix the entries marked with ⚠️ first (select them to change them).", "warning");
			cursor = index;
			continue;
		}

		switch (action.kind) {
			case "start":
				return saved.settings;

			case "save-global-start":
			case "save-project-start": {
				try {
					if (action.kind === "save-global-start") {
						reloadProject(saveGlobally(paths, state, saved.settings, draft));
						ctx.ui.notify(`Saved PRD Loop Pro settings globally (${paths.globalPath})`, "info");
					} else {
						const next = saveProjectOnly(paths.projectPath, state.global, draft);
						const count = OVERRIDE_FIELDS.filter((f) => mergeSettings(next.global, next.overrides).sources[f] === "project").length;
						reloadProject(next);
						ctx.ui.notify(
							count > 0
								? `Saved ${count} project override(s) to ${paths.projectPath}`
								: `No differences from global settings — removed ${paths.projectPath}`,
							"info",
						);
					}
				} catch (err) {
					notifyError(ctx, "Failed to save settings", err);
					continue;
				}
				if (currentIssues(saved.settings).length === 0) return saved.settings;
				ctx.ui.notify("Saved, but the settings are still invalid — fix the entries marked with ⚠️.", "warning");
				continue;
			}

			case "discard":
				draft = cloneSettings(saved.settings);
				continue;

			case "remove-project": {
				const lost = changed.length > 0 ? ` ${changed.length} unsaved change(s) will be discarded.` : "";
				const ok = await ctx.ui.confirm(
					"Remove project overrides?",
					`Deletes ${paths.projectPath}; this project will use the global settings.${lost}`,
				);
				if (!ok) continue;
				try {
					reloadProject(removeProjectOverrides(paths.projectPath, state.global));
					ctx.ui.notify(`Removed project overrides (${paths.projectPath})`, "info");
				} catch (err) {
					notifyError(ctx, "Failed to remove project settings", err);
				}
				continue;
			}

			case "cancel": {
				if (changed.length === 0) return undefined;
				const discard = await ctx.ui.confirm(
					"Discard changes?",
					`${changed.length} unsaved change(s) will be lost and the loop will not start.`,
				);
				if (discard) return undefined;
				continue;
			}
		}
	}
}
