/**
 * Claude Usage Extension
 *
 * Displays Claude Code / Claude Max usage in the footer.
 * Uses pi's built-in AuthStorage for OAuth token management,
 * which handles token refresh with file locking.
 *
 * Requires /login with Anthropic OAuth.
 *
 * Based on: https://codelynx.dev/posts/claude-code-usage-limits-statusline
 * Auth approach: Uses ctx.modelRegistry (pi's AuthStorage) for token refresh,
 *   matching ClaudeCode's oauth/client.ts refresh flow.
 * Header format: Aligned with ClaudeCode's services/api/usage.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// OAuth beta header (matches ClaudeCode constants/oauth.ts OAUTH_BETA_HEADER)
const OAUTH_BETA_HEADER = "oauth-2025-04-20";

// Must match the version in @mariozechner/pi-ai providers/anthropic.js (claudeCodeVersion const).
// pi uses this user-agent for all OAuth Anthropic requests. Not exported, so we hardcode it.
// Source: node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js line ~35
const CLAUDE_CLI_VERSION = "2.1.75";

// Fetch at most once every 10 minutes
const MIN_FETCH_INTERVAL_MS = 10 * 60 * 1000;

// Background polling interval: 15 minutes
const POLL_INTERVAL_MS = 15 * 60 * 1000;

// Rate-limit backoff: start at 15 min, double each time, cap at 2 hours
const INITIAL_BACKOFF_MS = 15 * 60 * 1000;
const MAX_BACKOFF_MS = 2 * 60 * 60 * 1000;

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

// ---------------------------------------------------------------------------
// Auth helpers — delegate to pi's built-in AuthStorage
// ---------------------------------------------------------------------------

/**
 * Check if the Anthropic credential is OAuth-based.
 * The /api/oauth/usage endpoint only works with OAuth (subscriber) tokens,
 * matching ClaudeCode's isClaudeAISubscriber() guard in fetchUtilization().
 */
function isAnthropicOAuth(ctx: ExtensionContext): boolean {
  const cred = ctx.modelRegistry.authStorage.get("anthropic");
  return cred?.type === "oauth";
}

/**
 * Get a valid OAuth access token using pi's built-in AuthStorage.
 *
 * AuthStorage.getApiKey("anthropic") checks:
 *   1. whether the stored token is expired (pi bakes in a 5-min buffer at save time)
 *   2. if expired, refreshes via refreshOAuthTokenWithLock() (file-locked, multi-process safe)
 *   3. persists the new credentials to auth.json
 *
 * This mirrors ClaudeCode's checkAndRefreshOAuthTokenIfNeeded() flow.
 */
async function getAccessToken(ctx: ExtensionContext): Promise<string | null> {
  try {
    const token = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
    return token ?? null;
  } catch (error) {
    return null;
  }
}

/**
 * Handle a 401 response by attempting token recovery.
 *
 * Mirrors ClaudeCode's handleOAuth401Error() strategy:
 *   1. Reload from disk (another pi/CC instance may have refreshed already)
 *   2. If the stored token differs from failedToken → use it (race resolved)
 *   3. Otherwise, force a refresh by invalidating the local expiry, then let
 *      pi's built-in refreshOAuthTokenWithLock() do the actual refresh
 *
 * Returns a new valid token, or null if recovery failed.
 */
async function handleUnauthorized(
  ctx: ExtensionContext,
  failedToken: string
): Promise<string | null> {
  const authStorage = ctx.modelRegistry.authStorage;

  // Step 1: Reload from disk — another process may have written fresh tokens
  authStorage.reload();
  const reloadedToken = await getAccessToken(ctx);

  // Step 2: Different token after reload → another instance already refreshed
  if (reloadedToken && reloadedToken !== failedToken) {
    return reloadedToken;
  }

  // Step 3: Same token — server disagrees with local expiry (clock drift, revocation).
  //         Force refresh by setting expires=0, then let getApiKeyForProvider trigger
  //         pi's locked refresh. This is safe: if refresh fails the user must /login anyway.
  const cred = authStorage.get("anthropic");
  if (!cred || cred.type !== "oauth") {
    return null;
  }

  const oauthCred = cred as { type: "oauth"; access: string; refresh: string; expires: number };
  if (!oauthCred.refresh) {
    console.error("Claude Usage: no refresh token available — re-login with /login");
    return null;
  }

  // Invalidate local expiry to trigger pi's built-in OAuth refresh
  authStorage.set("anthropic", { ...oauthCred, expires: 0 });

  try {
    const refreshedToken = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
    if (refreshedToken && refreshedToken !== failedToken) {
      return refreshedToken;
    }
    console.error("Claude Usage: token refresh did not produce a new token");
    return null;
  } catch (error) {
    console.error("Claude Usage: forced token refresh failed:", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Usage API
// ---------------------------------------------------------------------------

function parseRetryAfterMs(retryAfterHeader: string | null): number | undefined {
  if (!retryAfterHeader) return undefined;

  const seconds = Number(retryAfterHeader);
  if (!Number.isNaN(seconds) && seconds > 0) {
    return Math.round(seconds * 1000);
  }

  const retryAt = new Date(retryAfterHeader).getTime();
  if (!Number.isNaN(retryAt)) {
    const diff = retryAt - Date.now();
    if (diff > 0) return diff;
  }

  return undefined;
}

/**
 * Fetch usage data from the Anthropic API.
 *
 * Headers match exactly what pi's Anthropic provider sends for OAuth requests
 * (see @mariozechner/pi-ai providers/anthropic.js createClient → isOAuthToken branch):
 *   - accept: application/json
 *   - User-Agent: claude-cli/{version}
 *   - Authorization: Bearer TOKEN
 *   - anthropic-beta: oauth-2025-04-20
 *   - anthropic-dangerous-direct-browser-access: true
 *   - x-app: cli
 *
 * This ensures the usage request appears as the same agent identity that pi
 * uses for token refresh and inference — one consistent caller for Anthropic.
 */
async function fetchUsageLimits(
  accessToken: string
): Promise<{ usage: UsageLimits | null; status?: number; retryAfterMs?: number }> {
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": `claude-cli/${CLAUDE_CLI_VERSION}`,
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
        "anthropic-dangerous-direct-browser-access": "true",
        "x-app": "cli",
      },
    });

    if (!response.ok) {
      return {
        usage: null,
        status: response.status,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      };
    }

    return { usage: (await response.json()) as UsageLimits, status: response.status };
  } catch (error) {
    // Network errors (ENETUNREACH, ENOTFOUND, etc.) are expected when offline — don't spam the console
    const cause = (error as any)?.cause;
    const code = cause?.code;
    if (code === "ENETUNREACH" || code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ECONNRESET") {
      // Silently ignore transient network errors
    } else {
      console.error("Claude Usage: fetch error:", error);
    }
    return { usage: null };
  }
}

// ---------------------------------------------------------------------------
// Formatting / rendering helpers (unchanged)
// ---------------------------------------------------------------------------

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

function getUsageColor(pct: number): "success" | "warning" | "error" {
  if (pct >= 90) return "error";
  if (pct >= 70) return "warning";
  return "success";
}

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

function capitalizeFirstLetter(val: string) {
  return String(val).charAt(0).toUpperCase() + String(val).slice(1);
}

function formatResetTimeNice(resetAt: string, showTimezone: boolean = false): string {
  const reset = new Date(resetAt);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const dateStr = capitalizeFirstLetter(reset.toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: timezone,
  }).toLowerCase());

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

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let lastUsage: UsageLimits | null = null;
  let updateInterval: ReturnType<typeof setInterval> | null = null;
  let isAnthropicModel = false;
  let hasAnthropicTurn = false;
  let lastFetchAt = 0;
  let rateLimitedUntil = 0;
  let currentBackoffMs = INITIAL_BACKOFF_MS;

  function checkIsAnthropicModel(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === "anthropic";
  }

  /**
   * Core fetch + update function.
   * Respects rate limits and minimum fetch intervals.
   * Only `force: true` (from /quota-claude command) bypasses the interval guard.
   */
  async function updateUsageStatus(
    ctx: ExtensionContext,
    options: { force?: boolean } = {}
  ) {
    if (!ctx.hasUI) return;

    if (!isAnthropicModel) {
      ctx.ui.setStatus("claude-usage", undefined);
      return;
    }

    if (!hasAnthropicTurn && !options.force) {
      ctx.ui.setStatus("claude-usage", undefined);
      return;
    }

    // Check if the Anthropic credential is OAuth-based.
    // API key users can't use /api/oauth/usage (matches ClaudeCode's isClaudeAISubscriber guard).
    if (!isAnthropicOAuth(ctx)) {
      ctx.ui.setStatus("claude-usage", undefined);
      return;
    }

    const theme = ctx.ui.theme;
    const now = Date.now();

    // --- Guards (skipped only for force) ---
    if (!options.force) {
      // Guard 1: Rate-limited → show stale/warning, don't fetch
      if (now < rateLimitedUntil) {
        if (lastUsage) {
          renderStatus(ctx, { stale: true });
        } else {
          const remainMin = Math.ceil((rateLimitedUntil - now) / 60_000);
          ctx.ui.setStatus("claude-usage",
            theme.fg("warning", `⚠ Usage API rate-limited (retry in ${remainMin}m)`));
        }
        return;
      }

      // Guard 2: Min interval not reached → show cached, don't fetch
      if (now - lastFetchAt < MIN_FETCH_INTERVAL_MS) {
        if (lastUsage) renderStatus(ctx);
        return;
      }
    }

    // --- Get access token (pi's AuthStorage handles expiry + refresh) ---
    const accessToken = await getAccessToken(ctx);
    if (!accessToken) {
      ctx.ui.setStatus(
        "claude-usage",
        theme.fg("warning", "⚠ Claude OAuth not found (use /login)")
      );
      return;
    }

    lastFetchAt = Date.now();
    const firstAttempt = await fetchUsageLimits(accessToken);
    let usage = firstAttempt.usage;
    let status = firstAttempt.status;
    let retryAfterMs = firstAttempt.retryAfterMs;

    // --- 401 handling: reload + force-refresh + single retry ---
    if (!usage && status === 401) {
      const recoveredToken = await handleUnauthorized(ctx, accessToken);
      if (recoveredToken) {
        const retryAttempt = await fetchUsageLimits(recoveredToken);
        usage = retryAttempt.usage;
        status = retryAttempt.status ?? status;
        retryAfterMs = retryAttempt.retryAfterMs ?? retryAfterMs;
      }

      // If still failing after recovery attempt, show specific message
      if (!usage && status === 401) {
        ctx.ui.setStatus(
          "claude-usage",
          theme.fg("error", "✗ Token invalid/revoked — try /login")
        );
        return;
      }
    }

    if (!usage) {
      if (status === 429) {
        // Exponential backoff: use retry-after if provided, otherwise double the backoff
        const serverBackoff = retryAfterMs;
        const backoffMs = serverBackoff ?? currentBackoffMs;
        rateLimitedUntil = Date.now() + backoffMs;

        // Increase backoff for next 429 (exponential, capped)
        if (!serverBackoff) {
          currentBackoffMs = Math.min(currentBackoffMs * 2, MAX_BACKOFF_MS);
        }

        if (lastUsage) {
          renderStatus(ctx, { stale: true });
        } else {
          const remainMin = Math.ceil(backoffMs / 60_000);
          ctx.ui.setStatus("claude-usage",
            theme.fg("warning", `⚠ Usage API rate-limited (retry in ${remainMin}m)`));
        }
        return;
      }

      if (status === 403) {
        ctx.ui.setStatus(
          "claude-usage",
          theme.fg("error", "✗ Usage API forbidden (403) — check subscription")
        );
        return;
      }

      const statusSuffix = status ? ` (${status})` : " (network error)";
      ctx.ui.setStatus(
        "claude-usage",
        theme.fg("error", `✗ Failed to fetch usage${statusSuffix}`)
      );
      return;
    }

    // Success → reset backoff, store data
    rateLimitedUntil = 0;
    currentBackoffMs = INITIAL_BACKOFF_MS;
    lastUsage = usage;
    renderStatus(ctx);
  }

  function renderStatus(ctx: ExtensionContext, options: { stale?: boolean } = {}) {
    if (!lastUsage || !ctx.hasUI) return;
    const theme = ctx.ui.theme;

    const parts: string[] = [];

    if (lastUsage.five_hour) {
      const pct = lastUsage.five_hour.utilization;
      const reset = formatResetTime(lastUsage.five_hour.resets_at);
      parts.push(theme.fg(getUsageColor(pct), `5h: ${pct}%`) + ' ' + theme.fg("dim", `(${reset})`));
    }

    if (lastUsage.seven_day) {
      const pct = lastUsage.seven_day.utilization;
      const reset = formatResetTimeNice(lastUsage.seven_day.resets_at);
      parts.push(theme.fg(getUsageColor(pct), `7d: ${pct}%`) + ' ' + theme.fg("dim", `(${reset})`));
    }

    if (lastUsage.seven_day_opus && lastUsage.seven_day_opus.utilization > 0) {
      const pct = lastUsage.seven_day_opus.utilization;
      parts.push(theme.fg(getUsageColor(pct), `Opus: ${pct}%`));
    }

    if (parts.length === 0) {
      ctx.ui.setStatus("claude-usage", theme.fg("dim", "Claude: no data"));
      return;
    }

    const warningSuffix = options.stale ? theme.fg("warning", " ⚠") : "";
    const status = theme.fg("dim", "Claude: ") + parts.join(theme.fg("dim", " │ ")) + warningSuffix;
    ctx.ui.setStatus("claude-usage", status);
  }

  // --- Event handlers ---

  pi.on("session_start", async (_event, ctx) => {
    isAnthropicModel = checkIsAnthropicModel(ctx);
    hasAnthropicTurn = false;

    // Don't fetch on session start — wait for first turn or interval
    if (lastUsage && isAnthropicModel) {
      renderStatus(ctx);
    }

    // Background poll every 15 minutes
    if (updateInterval) clearInterval(updateInterval);
    updateInterval = setInterval(() => updateUsageStatus(ctx), POLL_INTERVAL_MS);
  });

  pi.on("model_select", async (event, ctx) => {
    isAnthropicModel = event.model.provider === "anthropic";
    // Only re-render cached data, never fetch on model change
    if (isAnthropicModel && lastUsage) {
      renderStatus(ctx);
    } else if (!isAnthropicModel && ctx.hasUI) {
      ctx.ui.setStatus("claude-usage", undefined);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!isAnthropicModel) return;

    const wasFirstTurn = !hasAnthropicTurn;
    hasAnthropicTurn = true;

    if (wasFirstTurn) {
      // First turn in session: fetch after a short delay (respects all guards)
      setTimeout(() => updateUsageStatus(ctx), 5000);
    } else {
      // Subsequent turns: just re-render cached status
      renderStatus(ctx);
    }
  });

  pi.on("session_shutdown", async () => {
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
  });

  // --- Manual refresh command ---

  pi.registerCommand("quota-claude", {
    description: "Show/refresh Claude usage",
    handler: async (_args, ctx) => {
      await updateUsageStatus(ctx, { force: true });

      if (!lastUsage) {
        ctx.ui.notify("No usage data available", "error");
        return;
      }

      const theme = ctx.ui.theme;
      const lines: string[] = [];

      if (lastUsage.five_hour) {
        const pct = lastUsage.five_hour.utilization;
        lines.push(theme.bold("  Current session"));
        lines.push("  " + renderProgressBar(pct, 50, theme) + " " + theme.fg(getUsageColor(pct), `${pct}% used`));
        if (lastUsage.five_hour.resets_at) {
          lines.push("  " + theme.fg("dim", `Resets in ${formatResetTime(lastUsage.five_hour.resets_at)}`));
        }
        lines.push("");
      }

      if (lastUsage.seven_day) {
        const pct = lastUsage.seven_day.utilization;
        lines.push(theme.bold("  Current week (all models)"));
        lines.push("  " + renderProgressBar(pct, 50, theme) + " " + theme.fg(getUsageColor(pct), `${pct}% used`));
        if (lastUsage.seven_day.resets_at) {
          lines.push("  " + theme.fg("dim", `Resets ${formatResetTimeNice(lastUsage.seven_day.resets_at, true)}`));
        }
        lines.push("");
      }

      if (lastUsage.seven_day_opus && lastUsage.seven_day_opus.utilization > 0) {
        const pct = lastUsage.seven_day_opus.utilization;
        lines.push(theme.bold("  Opus (7 days)"));
        lines.push("  " + renderProgressBar(pct, 50, theme) + " " + theme.fg(getUsageColor(pct), `${pct}% used`));
        if (lastUsage.seven_day_opus.resets_at) {
          lines.push("  " + theme.fg("dim", `Resets ${formatResetTimeNice(lastUsage.seven_day_opus.resets_at, true)}`));
        }
        lines.push("");
      }

      if (lastUsage.seven_day_sonnet && lastUsage.seven_day_sonnet.utilization > 0) {
        const pct = lastUsage.seven_day_sonnet.utilization;
        lines.push(theme.bold("  Sonnet (7 days)"));
        lines.push("  " + renderProgressBar(pct, 50, theme) + " " + theme.fg(getUsageColor(pct), `${pct}% used`));
        if (lastUsage.seven_day_sonnet.resets_at) {
          lines.push("  " + theme.fg("dim", `Resets ${formatResetTimeNice(lastUsage.seven_day_sonnet.resets_at, true)}`));
        }
        lines.push("");
      }

      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
