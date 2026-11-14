/**
 * PRD Loop Pro — Stored subagent sessions on disk (no pi imports).
 *
 * Every subagent run is a normal pi session with an id chosen by the loop
 * (`--session-id`), stored where pi stores the sessions of the project. This
 * module finds the session file of an id again, e.g. to switch to it from
 * `/todos` or to hand it to the main agent.
 *
 * Only erasable TypeScript syntax is used (`node --test` type stripping).
 */

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** Name of pi's default session directory for a working directory (`--Users-me-project--`). */
export function defaultSessionDirName(cwd: string): string {
	return `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Directories in which the sessions of a project can be stored: the
 * directory of the current session (covers a custom `sessionDir`) and pi's
 * default directory for the working directory.
 */
export function sessionDirsFor(cwd: string, agentDir: string, currentSessionDir?: string): string[] {
	const dirs = [currentSessionDir ?? "", join(agentDir, "sessions", defaultSessionDirName(cwd))].filter(Boolean);
	return [...new Set(dirs)];
}

/** Session file with the given id (`<timestamp>_<id>.jsonl`) in one of the directories, or null. */
export function findSessionFile(dirs: string[], sessionId: string): string | null {
	const suffix = `_${sessionId}.jsonl`;
	for (const dir of dirs) {
		if (!dir) continue;
		try {
			const file = readdirSync(dir).find((name) => name.endsWith(suffix));
			if (file) return join(dir, file);
		} catch {
			// directory does not exist
		}
	}
	return null;
}
