import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getModels } from "@mariozechner/pi-ai";

const CLAUDE_CODE_VERSION = "2.1.96";

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
		const transformedSystemPrompt = event.systemPrompt.replace(
			/pi/gi,
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
