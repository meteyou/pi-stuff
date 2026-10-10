import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildOverviewMenu, formatOverviewRow } from "./overview-menu.ts";
import type { OverviewMenuInput } from "./overview-menu.ts";
import { createDefaultSettings, OVERRIDE_FIELDS } from "./settings.ts";
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

describe("formatOverviewRow", () => {
	it("aligns invalid and valid rows and shows source and change marker", () => {
		const draft = createDefaultSettings({ model: "a/b", thinking: "low" });
		const valid = formatOverviewRow("maxReviewRounds", draft, "project", false, false);
		const invalid = formatOverviewRow("maxReviewRounds", draft, "project", true, true);
		assert.equal(valid, `   ${"Max review rounds:".padEnd(20)}${"3".padEnd(44)} [project]`);
		assert.equal(invalid, `⚠️ ${"Max review rounds:".padEnd(20)}${"3".padEnd(44)} [project] • changed`);
	});
});
