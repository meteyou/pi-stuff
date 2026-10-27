import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { arrowNavigation, clampScroll, findTaskBlock, revealBlock } from "./overlay-scroll.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("module purity", () => {
	it("has no pi imports", () => {
		const source = readFileSync(join(HERE, "overlay-scroll.ts"), "utf8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works\//);
	});
});

describe("clampScroll", () => {
	it("keeps the offset within [0, totalRows - viewHeight]", () => {
		assert.equal(clampScroll(-3, 10, 30), 0);
		assert.equal(clampScroll(25, 10, 30), 20);
		assert.equal(clampScroll(5, 10, 8), 0);
	});
});

describe("findTaskBlock", () => {
	it("returns the contiguous rows of a task", () => {
		const rows = [0, 0, 0, 1, 2, 2].map((taskIndex) => ({ taskIndex }));
		assert.deepEqual(findTaskBlock(rows, 0), { start: 0, end: 3 });
		assert.deepEqual(findTaskBlock(rows, 1), { start: 3, end: 4 });
		assert.deepEqual(findTaskBlock(rows, 2), { start: 4, end: 6 });
		assert.deepEqual(findTaskBlock(rows, 7), { start: 0, end: 0 });
	});
});

describe("revealBlock", () => {
	it("shows the whole last block instead of only its header", () => {
		// The case from the bug: view 1-26 of 30, last task block = rows 24..29.
		assert.equal(revealBlock({ offset: 0, viewHeight: 26, totalRows: 30 }, { start: 24, end: 30 }), 4);
	});

	it("keeps a fully visible block where it is", () => {
		assert.equal(revealBlock({ offset: 5, viewHeight: 10, totalRows: 40 }, { start: 7, end: 12 }), 5);
	});

	it("scrolls up to a block above the view", () => {
		assert.equal(revealBlock({ offset: 10, viewHeight: 10, totalRows: 40 }, { start: 3, end: 6 }), 3);
	});

	it("shows a block taller than the view from its header", () => {
		assert.equal(revealBlock({ offset: 0, viewHeight: 5, totalRows: 40 }, { start: 8, end: 20 }), 8);
	});
});

describe("arrowNavigation", () => {
	const view = (offset: number) => ({ offset, viewHeight: 10, totalRows: 30 });

	it("down: scrolls through a block that ends below the view before moving on", () => {
		assert.deepEqual(arrowNavigation("down", view(0), { start: 5, end: 14 }, 1, 4), { kind: "scroll", offset: 1 });
		assert.deepEqual(arrowNavigation("down", view(4), { start: 5, end: 14 }, 1, 4), { kind: "select", index: 2 });
	});

	it("down: on the last task, scrolls to the bottom, then stops", () => {
		assert.deepEqual(arrowNavigation("down", view(18), { start: 25, end: 30 }, 3, 4), { kind: "scroll", offset: 19 });
		assert.deepEqual(arrowNavigation("down", view(20), { start: 25, end: 30 }, 3, 4), { kind: "none" });
	});

	it("up: scrolls back to the header of the selected block before moving on", () => {
		assert.deepEqual(arrowNavigation("up", view(8), { start: 5, end: 20 }, 2, 4), { kind: "scroll", offset: 7 });
		assert.deepEqual(arrowNavigation("up", view(5), { start: 5, end: 20 }, 2, 4), { kind: "select", index: 1 });
	});

	it("up: on the first task, scrolls to the top, then stops", () => {
		assert.deepEqual(arrowNavigation("up", view(2), { start: 0, end: 5 }, 0, 4), { kind: "scroll", offset: 1 });
		assert.deepEqual(arrowNavigation("up", view(0), { start: 0, end: 5 }, 0, 4), { kind: "none" });
	});
});
