/**
 * PRD Loop Pro — overview menu model (pure, no pi imports).
 *
 * The overview is a single menu: one selectable row per settings entry,
 * followed by the actions. Selecting a row edits that entry in a draft; the
 * actions depend on whether the draft has unsaved changes:
 *
 * - no changes:  Confirm & start · [Remove project overrides] · Cancel
 * - changes:     Save globally & start · Save for this project only & start ·
 *                Discard changes · [Remove project overrides] · Cancel
 */

import {
	FIX_THRESHOLD_LABELS,
	isFixThreshold,
	OVERRIDE_FIELDS,
	overrideFieldIssues,
	overrideFieldStep,
	STEP_LABELS,
	type OverrideField,
	type PrdLoopProSettings,
	type SettingsIssue,
	type SettingsSource,
	type StepKey,
} from "./settings.ts";

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

export function fieldLabel(field: OverrideField): string {
	const step = overrideFieldStep(field);
	return step ? STEP_LABELS[step] : FIELD_LABELS[field as keyof typeof FIELD_LABELS];
}

function formatThreshold(value: string): string {
	return isFixThreshold(value) ? FIX_THRESHOLD_LABELS[value] : value;
}

export function formatFieldValue(settings: PrdLoopProSettings, field: OverrideField): string {
	const step = overrideFieldStep(field);
	if (step) {
		const setting = settings.steps[step];
		return `${setting.model || "(not configured)"} · ${setting.thinking}`;
	}
	if (field === "fixThreshold") return formatThreshold(settings.fixThreshold);
	if (field === "maxReviewRounds") return String(settings.maxReviewRounds);
	return String(settings.implementationRetries);
}

export type OverviewAction =
	| { kind: "edit"; field: OverrideField }
	| { kind: "start" }
	| { kind: "save-global-start" }
	| { kind: "save-project-start" }
	| { kind: "discard" }
	| { kind: "remove-project" }
	| { kind: "cancel" };

export interface OverviewItem {
	label: string;
	action: OverviewAction;
	/** Set when the action cannot run with the current settings (shown in the label). */
	blocked?: boolean;
}

export interface OverviewMenu {
	title: string;
	items: OverviewItem[];
	/** Number of settings rows (the actions follow them). */
	rowCount: number;
	/** Default cursor position: the first action. */
	defaultIndex: number;
}

export interface OverviewMenuInput {
	prd: PrdOverviewInfo;
	paths: SettingsPaths & { projectFileExists: boolean };
	/** Effective settings including unsaved edits. */
	draft: PrdLoopProSettings;
	/** Source of every field in the saved settings. */
	sources: Record<OverrideField, SettingsSource>;
	/** Issues of the draft, plus a `projectFile` issue if the project file is invalid. */
	issues: SettingsIssue[];
	/** Fields with unsaved edits. */
	changed: OverrideField[];
	/** Offer "Remove project overrides" (overrides exist or the project file is invalid). */
	canRemoveProject: boolean;
}

const BLOCKED_SUFFIX = " (fix ⚠️ entries first)";

/** One settings row: `⚠️ Review:   provider/model · high   [project] • changed`. */
export function formatOverviewRow(
	field: OverrideField,
	draft: PrdLoopProSettings,
	source: SettingsSource,
	invalid: boolean,
	changed: boolean,
): string {
	const marker = invalid ? "⚠️ " : "   ";
	const label = `${fieldLabel(field)}:`.padEnd(20);
	const value = formatFieldValue(draft, field).padEnd(44);
	return `${marker}${label}${value} [${source}]${changed ? " • changed" : ""}`;
}

export function buildOverviewMenu(input: OverviewMenuInput): OverviewMenu {
	const { prd, paths, draft, sources, issues, changed } = input;

	const title = [
		`🚀 PRD Loop Pro`,
		``,
		`   PRD:   ${prd.title}`,
		`   Tasks: ${prd.openTaskCount} open, ${prd.completedTaskCount} completed`,
		``,
		`   Settings (select an entry to change it):`,
		`      global:  ${paths.globalPath}`,
		`      project: ${paths.projectPath}${paths.projectFileExists ? "" : " (none)"}`,
	];
	if (issues.length > 0) {
		title.push("", "⚠️  Invalid settings — change them before starting:");
		for (const issue of issues) title.push(`   • ${issue.message}`);
	}
	if (changed.length > 0) {
		title.push("", `   ${changed.length} unsaved change(s) — save them to start, or discard them`);
	}

	const items: OverviewItem[] = OVERRIDE_FIELDS.map((field) => ({
		label: formatOverviewRow(
			field,
			draft,
			sources[field],
			overrideFieldIssues(issues, field).length > 0,
			changed.includes(field),
		),
		action: { kind: "edit", field },
	}));

	const fieldInvalid = issues.some((issue) => issue.field !== "projectFile");
	const projectFileInvalid = issues.some((issue) => issue.field === "projectFile");
	const action = (label: string, value: OverviewAction, blocked = false): OverviewItem =>
		blocked ? { label: `${label}${BLOCKED_SUFFIX}`, action: value, blocked } : { label, action: value };

	if (changed.length === 0) {
		items.push(action("Confirm & start", { kind: "start" }, issues.length > 0));
	} else {
		// Saving globally keeps an invalid project file in effect; saving for the
		// project overwrites it.
		items.push(action("Save globally & start", { kind: "save-global-start" }, fieldInvalid || projectFileInvalid));
		items.push(action("Save for this project only & start", { kind: "save-project-start" }, fieldInvalid));
		items.push(action("Discard changes", { kind: "discard" }));
	}
	if (input.canRemoveProject) items.push(action("Remove project overrides", { kind: "remove-project" }));
	items.push(action("Cancel", { kind: "cancel" }));

	return { title: title.join("\n"), items, rowCount: OVERRIDE_FIELDS.length, defaultIndex: OVERRIDE_FIELDS.length };
}
