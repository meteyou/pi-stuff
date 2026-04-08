import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getModels } from "@mariozechner/pi-ai";

const CLAUDE_CODE_VERSION = "2.1.94";

export default function (pi: ExtensionAPI) {
  // registerProvider() needs baseUrl in override-only mode.
  // Reuse the built-in Anthropic base URL so we only patch headers.
  const anthropicBaseUrl = getModels("anthropic")[0]?.baseUrl ?? "https://api.anthropic.com";

  pi.registerProvider("anthropic", {
    baseUrl: anthropicBaseUrl,
    headers: {
      "user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
    },
  });
}
