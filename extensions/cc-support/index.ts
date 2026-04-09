import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getModels } from "@mariozechner/pi-ai";

export const CLAUDE_CODE_VERSION = "2.1.96";

export default function ccSupportExtension(pi: ExtensionAPI) {
	// Override user-agent to advertise Claude Code CLI version
	const anthropicBaseUrl =
		getModels("anthropic")[0]?.baseUrl ?? "https://api.anthropic.com";

	pi.registerProvider("anthropic", {
		baseUrl: anthropicBaseUrl,
		headers: {
			"user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
		},
	});

	// Replace "pi" with "claude code" in the system prompt
	pi.on("before_agent_start", async (event) => {
		// Replace standalone "pi" / "Pi" but preserve file paths and partial words
		// Match "pi" only when it's a whole word (not inside paths, URLs, or other words)
		const transformedSystemPrompt = event.systemPrompt.replace(
			/(?<![\w\/.\-@])pi(?![\w\/.\-])/gi,
			"claude code",
		);

		if (transformedSystemPrompt === event.systemPrompt) {
			return undefined;
		}

		return {
			systemPrompt: transformedSystemPrompt,
		};
	});
}
