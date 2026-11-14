/**
 * PRD Loop Pro — Task sequence labels incl. split subtasks (pure, no pi imports).
 *
 * Task titles carry a sequence label: `PRD #N - Task M/T: <title>`.
 * When a task turns out to be too big it can be split into subtasks with a
 * hierarchical label (numbers and letters alternate, one level per segment):
 *
 *   Task 17/20     original task (stays open as umbrella / integration task)
 *   Task 17a/20    first level split of 17
 *   Task 17a1/20   second level split of 17a
 *   Task 17a2/20
 *   Task 17b/20
 *
 * The total `T` stays the one of the original breakdown.
 *
 * Only erasable TypeScript syntax is used (`node --test` type stripping).
 */

/** Sequence label of tasks without a parsable label. */
export const UNKNOWN_SEQUENCE_LABEL = "?/?";

const SEQUENCE_PATTERN = /Task\s+(\d+(?:[a-z]+\d*)*\/\d+)/i;
const SHORT_TITLE_PATTERN = /Task\s+\d+(?:[a-z]+\d*)*\/\d+:\s*(.*)/i;

/** Extract the sequence label (e.g. "2/8", "17a1/20") from a task title. */
export function parseSequenceLabel(title: string): string {
	const match = title.match(SEQUENCE_PATTERN);
	return match ? match[1]!.toLowerCase() : UNKNOWN_SEQUENCE_LABEL;
}

/** Short title without the "PRD #N - Task M/T: " prefix. */
export function extractShortTitle(title: string): string {
	const match = title.match(SHORT_TITLE_PATTERN);
	return match ? match[1]!.trim() : title;
}

/**
 * Hierarchical segments of a sequence label: "17a1/20" → ["17", "a", "1"].
 * Returns [] for unknown labels.
 */
export function sequenceSegments(label: string): string[] {
	const position = label.split("/")[0] ?? "";
	if (!/^\d+(?:[a-z]+\d*)*$/i.test(position)) return [];
	return position.toLowerCase().match(/\d+|[a-z]+/g) ?? [];
}

/** Nesting depth: 0 for "17/20", 1 for "17a/20", 2 for "17a1/20". */
export function sequenceDepth(label: string): number {
	return Math.max(0, sequenceSegments(label).length - 1);
}

/** Letter segment → number (a=1 … z=26, aa=27, …) for ordering. */
function letterValue(segment: string): number {
	let value = 0;
	for (const char of segment) value = value * 26 + (char.charCodeAt(0) - 96);
	return value;
}

/**
 * Compare two sequence labels in hierarchical order:
 * 16 < 17 < 17a < 17a1 < 17a2 < 17a10 < 17b < 18. Unknown labels sort last.
 */
export function compareSequenceLabels(a: string, b: string): number {
	const sa = sequenceSegments(a);
	const sb = sequenceSegments(b);
	if (sa.length === 0 || sb.length === 0) return (sa.length === 0 ? 1 : 0) - (sb.length === 0 ? 1 : 0);
	for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
		const x = sa[i]!;
		const y = sb[i]!;
		const diff = /\d/.test(x) ? Number(x) - Number(y) : letterValue(x) - letterValue(y);
		if (diff !== 0) return diff;
	}
	return sa.length - sb.length;
}

/** True if `descendant` is a (transitive) subtask of `ancestor` (e.g. 17a1 of 17 / 17a). */
export function isSubtaskOf(descendant: string, ancestor: string): boolean {
	const d = sequenceSegments(descendant);
	const a = sequenceSegments(ancestor);
	return a.length > 0 && d.length > a.length && a.every((segment, i) => d[i] === segment);
}

/**
 * Sort tasks by sequence label (hierarchical), then by title. Stable;
 * returns a new array.
 */
export function sortBySequence<T extends { sequenceLabel: string; title: string }>(tasks: T[]): T[] {
	return [...tasks].sort((a, b) => compareSequenceLabels(a.sequenceLabel, b.sequenceLabel) || a.title.localeCompare(b.title));
}

export interface SubtaskProgress {
	done: number;
	total: number;
}

/**
 * Progress of the (transitive) subtasks of a task, or undefined if the task
 * was not split.
 */
export function subtaskProgress<T extends { sequenceLabel: string }>(
	task: T,
	tasks: T[],
	isDone: (task: T) => boolean,
): SubtaskProgress | undefined {
	const subtasks = tasks.filter((t) => isSubtaskOf(t.sequenceLabel, task.sequenceLabel));
	if (subtasks.length === 0) return undefined;
	return { done: subtasks.filter(isDone).length, total: subtasks.length };
}

/** Number → letter segment (1=a … 26=z, 27=aa, …). */
function letterSegment(value: number): string {
	let out = "";
	for (let n = value; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(97 + ((n - 1) % 26)) + out;
	return out;
}

/**
 * Labels for `count` new subtasks of a task: letters below a number
 * (`17/20` → `17a/20`, `17b/20`), digits below a letter (`17a/20` →
 * `17a1/20`, `17a2/20`). Continues after the highest suffix already used by
 * an existing (transitive) subtask, so labels are never reused. Returns [] for
 * an unknown parent label.
 */
export function nextSubtaskLabels(parentLabel: string, existingLabels: string[], count: number): string[] {
	const parent = sequenceSegments(parentLabel);
	if (parent.length === 0) return [];
	const total = parentLabel.split("/")[1] ?? "";
	const position = parentLabel.split("/")[0]!.toLowerCase();
	const letters = /\d/.test(parent.at(-1)!);

	let highest = 0;
	for (const label of existingLabels) {
		if (!isSubtaskOf(label, parentLabel)) continue;
		const segment = sequenceSegments(label)[parent.length]!;
		highest = Math.max(highest, letters ? letterValue(segment) : Number(segment));
	}

	const labels: string[] = [];
	for (let i = 1; i <= count; i++) {
		const suffix = letters ? letterSegment(highest + i) : String(highest + i);
		labels.push(`${position}${suffix}/${total}`);
	}
	return labels;
}

/** Title prefix before the sequence label: "PRD #1 - Task 17a/20: X" → "PRD #1 - ". */
export function titlePrefix(title: string): string {
	const match = title.match(SEQUENCE_PATTERN);
	return match && match.index !== undefined ? title.slice(0, match.index) : "";
}
