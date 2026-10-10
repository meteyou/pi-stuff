/**
 * Scrolling of the loop overlay's task list (pure, no pi imports).
 *
 * The task list is a flat list of rows; every task occupies a contiguous block
 * (its header row plus the detail rows when expanded). The overlay shows a
 * window of `viewHeight` rows starting at `offset`.
 */

/** Rows `[start, end)` of a task block in the row list. */
export interface RowBlock {
	start: number;
	end: number;
}

export interface ScrollView {
	/** First visible row. */
	offset: number;
	/** Number of visible rows. */
	viewHeight: number;
	/** Total number of rows. */
	totalRows: number;
}

/** Clamp an offset to the scrollable range. */
export function clampScroll(offset: number, viewHeight: number, totalRows: number): number {
	return Math.max(0, Math.min(offset, Math.max(0, totalRows - viewHeight)));
}

/**
 * Offset that brings a task block into view, scrolling as little as possible:
 * a block that fits is shown completely; a block taller than the view is
 * shown from its header row. A fully visible block keeps the offset.
 */
export function revealBlock(view: ScrollView, block: RowBlock): number {
	const blockHeight = block.end - block.start;
	let offset = view.offset;
	if (blockHeight > view.viewHeight) {
		offset = block.start;
	} else if (block.start < view.offset) {
		offset = block.start;
	} else if (block.end > view.offset + view.viewHeight) {
		offset = block.end - view.viewHeight;
	}
	return clampScroll(offset, view.viewHeight, view.totalRows);
}

export type ArrowResult =
	| { kind: "scroll"; offset: number }
	| { kind: "select"; index: number }
	| { kind: "none" };

/**
 * ↑/↓ navigation: rows of the selected block that are outside the view are
 * scrolled through line by line before the selection moves to the
 * previous/next task. At the first/last task, the arrows scroll to the very
 * top/bottom of the list.
 */
export function arrowNavigation(
	direction: "up" | "down",
	view: ScrollView,
	block: RowBlock,
	selectedIndex: number,
	taskCount: number,
): ArrowResult {
	const maxOffset = Math.max(0, view.totalRows - view.viewHeight);
	if (direction === "down") {
		if (block.end > view.offset + view.viewHeight && view.offset < maxOffset) {
			return { kind: "scroll", offset: view.offset + 1 };
		}
		if (selectedIndex < taskCount - 1) return { kind: "select", index: selectedIndex + 1 };
		if (view.offset < maxOffset) return { kind: "scroll", offset: view.offset + 1 };
		return { kind: "none" };
	}

	if (block.start < view.offset) return { kind: "scroll", offset: view.offset - 1 };
	if (selectedIndex > 0) return { kind: "select", index: selectedIndex - 1 };
	if (view.offset > 0) return { kind: "scroll", offset: view.offset - 1 };
	return { kind: "none" };
}

/** Block `[start, end)` of the rows belonging to `taskIndex` (empty block at 0 if none). */
export function findTaskBlock(rows: readonly { taskIndex: number }[], taskIndex: number): RowBlock {
	const start = rows.findIndex((row) => row.taskIndex === taskIndex);
	if (start === -1) return { start: 0, end: 0 };
	let end = start;
	while (end < rows.length && rows[end]!.taskIndex === taskIndex) end++;
	return { start, end };
}
