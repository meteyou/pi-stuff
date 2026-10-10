import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CLAUDE_CODE_VERSION = "2.1.280";

// Replace standalone "pi" / "Pi" but preserve file paths and partial words
// Match "pi" only when it's a whole word (not inside paths, URLs, or other words).
// A trailing "." is allowed (end of sentence) unless followed by a word char (e.g. "pi.dev").
const PI_WORD = /(?<![\w\/.\-@])pi(?![\w\/\-]|\.\w)/gi;

function rewrite(text: string): string {
	return text.replace(PI_WORD, "claude code");
}

type TextBlock = { type: string; text?: unknown };

/** Rewrite all text blocks in an Anthropic system block list in place. */
function rewriteBlocks(blocks: unknown): void {
	if (!Array.isArray(blocks)) return;
	for (const block of blocks as TextBlock[]) {
		if (block && block.type === "text" && typeof block.text === "string") {
			block.text = rewrite(block.text);
		}
	}
}

export default function ccSupportExtension(pi: ExtensionAPI) {
	// Override user-agent to advertise Claude Code CLI version.
	// No baseUrl: the built-in (or models.json) base URL stays in effect.
	pi.registerProvider("anthropic", {
		headers: {
			"user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
		},
	});

	// Replace "pi" with "claude code" in the system prompt of every Anthropic request.
	//
	// This runs on the final provider payload instead of `before_agent_start`, because
	// `before_agent_start` only fires for user prompts. Turns started otherwise
	// (e.g. `pi.sendMessage(..., { triggerTurn: true })`, retries, continuations)
	// would otherwise go out with the original, unrewritten system prompt.
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "anthropic") return undefined;

		const payload = event.payload as { system?: unknown; messages?: unknown } | null;
		if (!payload || typeof payload !== "object") return undefined;

		// Leading system prompt
		if (typeof payload.system === "string") {
			payload.system = rewrite(payload.system);
		} else {
			rewriteBlocks(payload.system);
		}

		// Mid-conversation system messages (system prompt deltas)
		if (Array.isArray(payload.messages)) {
			for (const msg of payload.messages as { role?: string; content?: unknown }[]) {
				if (msg?.role !== "system") continue;
				if (typeof msg.content === "string") {
					msg.content = rewrite(msg.content);
				} else {
					rewriteBlocks(msg.content);
				}
			}
		}

		return payload;
	});
}
