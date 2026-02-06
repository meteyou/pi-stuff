/**
 * Claude Usage Extension
 *
 * Displays Claude Code / Claude Max usage in the footer.
 * Reads the OAuth token from pi's auth.json (~/.pi/agent/auth.json).
 * Requires /login with Anthropic OAuth.
 *
 * Based on: https://codelynx.dev/posts/claude-code-usage-limits-statusline
 * Auth logic from: https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/providers/anthropic.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Version must match Claude Code
const claudeCodeVersion = "2.1.2";

interface UsageLimits {
  five_hour: {
    utilization: number;
    resets_at: string | null;
  } | null;
  seven_day: {
    utilization: number;
    resets_at: string | null;
  } | null;
  seven_day_oauth_apps: null;
  seven_day_opus: {
    utilization: number;
    resets_at: string | null;
  } | null;
  seven_day_sonnet: {
    utilization: number;
    resets_at: string | null;
  } | null;
  iguana_necktie: null;
}

interface PiAuthFile {
  anthropic?: {
    type: "oauth" | "api_key";
    access?: string;
    refresh?: string;
    expires?: number;
    key?: string;
  };
}

/**
 * Retrieves the OAuth access token from pi's auth.json file.
 * Pi stores OAuth credentials in ~/.pi/agent/auth.json after /login.
 */
function getAccessTokenFromPiAuth(): string | null {
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    const authData = JSON.parse(readFileSync(authPath, "utf-8")) as PiAuthFile;
    
    if (authData.anthropic?.type === "oauth" && authData.anthropic.access) {
      return authData.anthropic.access;
    }
    
    return null;
  } catch (error) {
    // File not found or invalid JSON
    return null;
  }
}

/**
 * Fetches usage data from the Anthropic API.
 * Uses the same headers as Claude Code.
 */
async function fetchUsageLimits(
  accessToken: string
): Promise<{ usage: UsageLimits | null; status?: number }> {
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": `claude-cli/${claudeCodeVersion} (external, cli)`,
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-dangerous-direct-browser-access": "true",
        "x-app": "cli",
      },
    });

    if (!response.ok) {
      console.error(`Claude Usage API error: ${response.status} ${response.statusText}`);
      return { usage: null, status: response.status };
    }

    return { usage: (await response.json()) as UsageLimits, status: response.status };
  } catch (error) {
    console.error("Claude Usage fetch error:", error);
    return { usage: null };
  }
}

/**
 * Formats the reset time relative to the current time.
 */
function formatResetTime(resetAt: string | null): string {
  if (!resetAt) return "";
  const reset = new Date(resetAt);
  const now = new Date();
  const diffMs = reset.getTime() - now.getTime();

  if (diffMs <= 0) return "now";

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Returns the color based on usage percentage.
 */
function getUsageColor(pct: number): "success" | "warning" | "error" {
  if (pct >= 90) return "error";
  if (pct >= 70) return "warning";
  return "success";
}

/**
 * Renders a progress bar with Unicode characters.
 * █ = filled (bold color), ░ = empty (dark background)
 */
function renderProgressBar(
  pct: number,
  width: number,
  theme: { fg: (color: string, text: string) => string }
): string {
  const filled = (pct / 100) * width;
  const fullBlocks = Math.floor(filled);
  const hasHalf = filled - fullBlocks >= 0.5;
  const emptyBlocks = width - fullBlocks - (hasHalf ? 1 : 0);

  const color = getUsageColor(pct);
  const bar =
    theme.fg(color, "█".repeat(fullBlocks)) +
    (hasHalf ? theme.fg(color, "▌") : "") +
    theme.fg("dim", "░".repeat(Math.max(0, emptyBlocks)));

  return bar;
}

/**
 * Capitalizes the first letter of a string.
 */
function capitalizeFirstLetter(val) {
  return String(val).charAt(0).toUpperCase() + String(val).slice(1);
}

/**
 * Formats the reset time nicely with timezone.
 * e.g. "11:59pm (Europe/Vienna)"
 */
function formatResetTimeNice(resetAt: string, showTimezone: boolean = false): string {
  const reset = new Date(resetAt);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Date format
  const dateStr = capitalizeFirstLetter(reset.toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: timezone,
  }).toLowerCase());

  // Time in 12-hour format
  const timeStr = reset.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timezone,
  }).toLowerCase().replace(" ", "");

  const string = `${dateStr} at ${timeStr}`;

  if (!showTimezone) return string;

  return `${string} (${timezone})`;
}

export default function (pi: ExtensionAPI) {
  let lastUsage: UsageLimits | null = null;
  let updateInterval: ReturnType<typeof setInterval> | null = null;
  let accessToken: string | null = null;
  let isAnthropicModel = false;

  function checkIsAnthropicModel(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === "anthropic";
  }

  async function updateUsageStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    // Only show status for Anthropic models
    if (!isAnthropicModel) {
      ctx.ui.setStatus("claude-usage", undefined);
      return;
    }

    const theme = ctx.ui.theme;

    // Always reload access token (pi may refresh it on model use)
    accessToken = getAccessTokenFromPiAuth();
    if (!accessToken) {
      ctx.ui.setStatus(
        "claude-usage",
        theme.fg("warning", "⚠ Claude OAuth not found (use /login)")
      );
      return;
    }

    const firstAttempt = await fetchUsageLimits(accessToken);
    let usage = firstAttempt.usage;
    let status = firstAttempt.status;

    // Retry once in case the token was refreshed on disk
    if (!usage && status === 401) {
      accessToken = getAccessTokenFromPiAuth();
      if (accessToken) {
        const retryAttempt = await fetchUsageLimits(accessToken);
        usage = retryAttempt.usage;
        status = retryAttempt.status ?? status;
      }
    }

    if (!usage) {
      const statusSuffix = status ? ` (${status})` : "";
      ctx.ui.setStatus(
        "claude-usage",
        theme.fg("error", `✗ Failed to fetch usage${statusSuffix}`)
      );
      return;
    }

    lastUsage = usage;
    renderStatus(ctx);
  }

  function renderStatus(ctx: ExtensionContext) {
    if (!lastUsage || !ctx.hasUI) return;
    const theme = ctx.ui.theme;

    const parts: string[] = [];

    // 5-hour limit
    if (lastUsage.five_hour) {
      const pct = lastUsage.five_hour.utilization;
      const reset = formatResetTime(lastUsage.five_hour.resets_at);
      parts.push(theme.fg(getUsageColor(pct), `5h: ${pct}%`) + ' ' + theme.fg("dim", `(${reset})`));
    }

    // 7-day limit
    if (lastUsage.seven_day) {
      const pct = lastUsage.seven_day.utilization;
      const reset = formatResetTimeNice(lastUsage.seven_day.resets_at);
      parts.push(theme.fg(getUsageColor(pct), `7d: ${pct}%`) + ' ' + theme.fg("dim", `(${reset})`));
    }

    // Opus limit (if present)
    if (lastUsage.seven_day_opus && lastUsage.seven_day_opus.utilization > 0) {
      const pct = lastUsage.seven_day_opus.utilization;
      parts.push(theme.fg(getUsageColor(pct), `Opus: ${pct}%`));
    }

    if (parts.length === 0) {
      ctx.ui.setStatus("claude-usage", theme.fg("dim", "Claude: no data"));
      return;
    }

    const status = theme.fg("dim", "Claude: ") + parts.join(theme.fg("dim", " │ "));
    ctx.ui.setStatus("claude-usage", status);
  }

  pi.on("session_start", async (_event, ctx) => {
    isAnthropicModel = checkIsAnthropicModel(ctx);
    await updateUsageStatus(ctx);

    // Update every 5 minutes
    if (updateInterval) clearInterval(updateInterval);
    updateInterval = setInterval(() => updateUsageStatus(ctx), 5 * 60 * 1000);
  });

  // Update when model changes
  pi.on("model_select", async (event, ctx) => {
    isAnthropicModel = event.model.provider === "anthropic";
    await updateUsageStatus(ctx);
  });

  // Update after each turn (only for Anthropic models)
  pi.on("turn_end", async (_event, ctx) => {
    if (!isAnthropicModel) return;
    // Wait briefly so the API has the new values
    setTimeout(() => updateUsageStatus(ctx), 2000);
  });

  pi.on("session_shutdown", async () => {
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
  });

  // Command for manual refresh and detailed display
  pi.registerCommand("quota-claude", {
    description: "Show/refresh Claude usage",
    handler: async (_args, ctx) => {
      // Reload token (in case login changed)
      accessToken = getAccessTokenFromPiAuth();
      await updateUsageStatus(ctx);

      if (!lastUsage) {
        ctx.ui.notify("No usage data available", "error");
        return;
      }

      const theme = ctx.ui.theme;
      const lines: string[] = [];

      // Current session (5h)
      if (lastUsage.five_hour) {
        const pct = lastUsage.five_hour.utilization;
        lines.push(theme.bold("  Current session"));
        lines.push("  " + renderProgressBar(pct, 50, theme) + " " + theme.fg(getUsageColor(pct), `${pct}% used`));
        if (lastUsage.five_hour.resets_at) {
          lines.push("  " + theme.fg("dim", `Resets in ${formatResetTime(lastUsage.five_hour.resets_at)}`));
        }
        lines.push("");
      }

      // Current week (7d)
      if (lastUsage.seven_day) {
        const pct = lastUsage.seven_day.utilization;
        lines.push(theme.bold("  Current week (all models)"));
        lines.push("  " + renderProgressBar(pct, 50, theme) + " " + theme.fg(getUsageColor(pct), `${pct}% used`));
        if (lastUsage.seven_day.resets_at) {
          lines.push("  " + theme.fg("dim", `Resets ${formatResetTimeNice(lastUsage.seven_day.resets_at, true)}`));
        }
        lines.push("");
      }

      // Opus (if present and > 0)
      if (lastUsage.seven_day_opus && lastUsage.seven_day_opus.utilization > 0) {
        const pct = lastUsage.seven_day_opus.utilization;
        lines.push(theme.bold("  Opus (7 days)"));
        lines.push("  " + renderProgressBar(pct, 50, theme) + " " + theme.fg(getUsageColor(pct), `${pct}% used`));
        if (lastUsage.seven_day_opus.resets_at) {
          lines.push("  " + theme.fg("dim", `Resets ${formatResetTimeNice(lastUsage.seven_day_opus.resets_at, true)}`));
        }
        lines.push("");
      }

      // Sonnet (if present and > 0)
      if (lastUsage.seven_day_sonnet && lastUsage.seven_day_sonnet.utilization > 0) {
        const pct = lastUsage.seven_day_sonnet.utilization;
        lines.push(theme.bold("  Sonnet (7 days)"));
        lines.push("  " + renderProgressBar(pct, 50, theme) + " " + theme.fg(getUsageColor(pct), `${pct}% used`));
        if (lastUsage.seven_day_sonnet.resets_at) {
          lines.push("  " + theme.fg("dim", `Resets ${formatResetTimeNice(lastUsage.seven_day_sonnet.resets_at, true)}`));
        }
        lines.push("");
      }

      // Remove last line (empty line)
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
