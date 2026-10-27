import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildOverviewMenu, buildRunSettingsMenu, formatOverviewRow, formatRunSettingsRow } from "./overview-menu.ts";
import type { OverviewMenuInput, RunSettingsMenuInput } from "./overview-menu.ts";
import { createDefaultSettings, OVERRIDE_FIELDS, STEP_KEYS } from "./settings.ts";
import type { OverrideField, SettingsSource } from "./settings.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function input(overrides: Partial<OverviewMenuInput> = {}): OverviewMenuInput {
	const sources = Object.fromEntries(OVERRIDE_FIELDS.map((f) => [f, "global"])) as Record<OverrideField, SettingsSource>;
	return {
		prd: { title: "PRD #1: Demo", openTaskCount: 5, completedTaskCount: 0 },
		paths: { globalPath: "/g/prd-loop-pro.json", projectPath: "/p/.pi/prd-loop-pro.json", projectFileExists: false },
		draft: createDefaultSettings({ model: "anthropic/claude", thinking: "medium" }),
		sources,
		issues: [],
		changed: [],
		canRemoveProject: false,
		...overrides,
	};
}

const labels = (menu: ReturnType<typeof buildOverviewMenu>) => menu.items.map((item) => item.label);
const actions = (menu: ReturnType<typeof buildOverviewMenu>) => menu.items.slice(menu.rowCount).map((item) => item.label);

describe("module purity", () => {
	it("has no pi imports", () => {
		const source = readFileSync(join(HERE, "overview-menu.ts"), "utf8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works\//);
	});
});

describe("buildOverviewMenu", () => {
	it("lists one selectable row per entry before the actions, cursor on the first action", () => {
		const menu = buildOverviewMenu(input());
		assert.equal(menu.rowCount, OVERRIDE_FIELDS.length);
		assert.equal(menu.defaultIndex, OVERRIDE_FIELDS.length);
		assert.deepEqual(
			menu.items.slice(0, menu.rowCount).map((item) => item.action),
			OVERRIDE_FIELDS.map((field) => ({ kind: "edit", field })),
		);
		assert.deepEqual(actions(menu), ["Confirm & start", "Cancel"]);
		assert.match(labels(menu)[0]!, /^ {3}Implement: +anthropic\/claude · medium +\[global\]$/);
	});

	it("offers save & start, discard and cancel when there are unsaved changes", () => {
		const menu = buildOverviewMenu(input({ changed: ["steps.review"] }));
		assert.deepEqual(actions(menu), ["Save globally & start", "Save for this project only & start", "Discard changes", "Cancel"]);
		assert.match(labels(menu)[1]!, /• changed$/);
		assert.match(menu.title, /1 unsaved change\(s\)/);
	});

	it("blocks starting while entries are invalid and marks them", () => {
		const menu = buildOverviewMenu(input({ issues: [{ field: "steps.fix.model", message: "Fix: model x/y is not available" }] }));
		assert.equal(menu.items[menu.rowCount]!.label, "Confirm & start (fix ⚠️ entries first)");
		assert.equal(menu.items[menu.rowCount]!.blocked, true);
		assert.match(labels(menu)[2]!, /^⚠️ Fix:/);
		assert.match(menu.title, /Fix: model x\/y is not available/);
	});

	it("lets an invalid project file be overwritten by saving for the project", () => {
		const menu = buildOverviewMenu(
			input({ changed: ["fixThreshold"], issues: [{ field: "projectFile", message: "invalid JSON" }], canRemoveProject: true }),
		);
		const byKind = (kind: string) => menu.items.find((item) => item.action.kind === kind)!;
		assert.equal(byKind("save-global-start").blocked, true);
		assert.equal(byKind("save-project-start").blocked, undefined);
		assert.deepEqual(actions(menu).slice(-2), ["Remove project overrides", "Cancel"]);
	});
});

describe("buildRunSettingsMenu", () => {
	function runInput(overrides: Partial<RunSettingsMenuInput> = {}): RunSettingsMenuInput {
		return {
			draft: createDefaultSettings({ model: "anthropic/claude", thinking: "medium" }),
			changed: [],
			issues: [],
			...overrides,
		};
	}
	const runActions = (menu: ReturnType<typeof buildRunSettingsMenu>) =>
		menu.items.slice(menu.rowCount).map((item) => item.label);

	it("lists one row per step (no scalar fields) and only 'Back to loop' without changes", () => {
		const menu = buildRunSettingsMenu(runInput());
		assert.equal(menu.rowCount, STEP_KEYS.length);
		assert.equal(menu.defaultIndex, 0);
		assert.deepEqual(
			menu.items.slice(0, menu.rowCount).map((item) => item.action),
			STEP_KEYS.map((step) => ({ kind: "edit", step })),
		);
		assert.deepEqual(runActions(menu), ["Back to loop"]);
		assert.equal(menu.items[0]!.label, `   ${"Implement:".padEnd(20)}anthropic/claude · medium`);
		assert.match(menu.title, /Running now: no subagent/);
		assert.match(menu.title, /running subagent keeps its model/);
	});

	it("marks the running step and shows its start model in the title", () => {
		const draft = createDefaultSettings({ model: "anthropic/claude", thinking: "medium" });
		draft.steps.fix = { model: "openai/gpt-5", thinking: "high" };
		const menu = buildRunSettingsMenu(
			runInput({ draft, changed: ["fix"], running: { step: "fix", model: "anthropic/claude", thinking: "medium" } }),
		);
		const fixRow = menu.items[STEP_KEYS.indexOf("fix")]!.label;
		assert.match(fixRow, /openai\/gpt-5 · high +▶ running • changed$/);
		assert.match(menu.title, /Running now: Fix — anthropic\/claude · medium/);
	});

	it("offers apply (run / global / project) and discard with unsaved changes", () => {
		const menu = buildRunSettingsMenu(runInput({ changed: ["review", "commit"] }));
		assert.deepEqual(runActions(menu), [
			"Apply to this run",
			"Apply & save globally",
			"Apply & save for this project only",
			"Discard changes & back to loop",
		]);
		assert.deepEqual(
			menu.items.slice(menu.rowCount).map((item) => item.action),
			[
				{ kind: "apply", scope: "run" },
				{ kind: "apply", scope: "global" },
				{ kind: "apply", scope: "project" },
				{ kind: "discard" },
			],
		);
		assert.match(menu.title, /2 unsaved change\(s\)/);
	});

	it("blocks applying only for issues of changed steps", () => {
		const issues = [{ field: "steps.fix.model" as const, message: "Fix: model x/y is not available" }];
		const unrelated = buildRunSettingsMenu(runInput({ changed: ["review"], issues }));
		assert.equal(unrelated.items.some((item) => item.blocked), false);
		assert.match(unrelated.items[STEP_KEYS.indexOf("fix")]!.label, /^⚠️ Fix:/);

		const related = buildRunSettingsMenu(runInput({ changed: ["fix"], issues }));
		const applies = related.items.filter((item) => item.action.kind === "apply");
		assert.equal(applies.length, 3);
		assert.ok(applies.every((item) => item.blocked && item.label.endsWith("(fix ⚠️ entries first)")));
		assert.equal(related.items.find((item) => item.action.kind === "discard")!.blocked, undefined);
	});
});

describe("formatRunSettingsRow", () => {
	it("has no trailing padding without tags", () => {
		const draft = createDefaultSettings({ model: "a/b", thinking: "low" });
		const row = formatRunSettingsRow("commit", draft, { invalid: false, changed: false, running: false });
		assert.equal(row, `   ${"Commit:".padEnd(20)}a/b · low`);
		const tagged = formatRunSettingsRow("commit", draft, { invalid: true, changed: true, running: false });
		assert.equal(tagged, `⚠️ ${"Commit:".padEnd(20)}${"a/b · low".padEnd(44)} • changed`);
	});
});

describe("formatOverviewRow", () => {
	it("aligns invalid and valid rows and shows source and change marker", () => {
		const draft = createDefaultSettings({ model: "a/b", thinking: "low" });
		const valid = formatOverviewRow("maxReviewRounds", draft, "project", false, false);
		const invalid = formatOverviewRow("maxReviewRounds", draft, "project", true, true);
		assert.equal(valid, `   ${"Max review rounds:".padEnd(20)}${"3".padEnd(44)} [project]`);
		assert.equal(invalid, `⚠️ ${"Max review rounds:".padEnd(20)}${"3".padEnd(44)} [project] • changed`);
	});
});
