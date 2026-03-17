/**
 * Codex Usage Extension
 *
 * Displays ChatGPT Plus/Pro (Codex) usage in the footer.
 * Reads OAuth credentials from pi's auth.json (~/.pi/agent/auth.json).
 * Requires /login with OpenAI Codex OAuth.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

// Fetch at most once every 10 minutes
const MIN_FETCH_INTERVAL_MS = 10 * 60 * 1000;

// Background polling interval: 15 minutes
const POLL_INTERVAL_MS = 15 * 60 * 1000;

// Rate-limit backoff: start at 15 min, double each time, cap at 2 hours
const INITIAL_BACKOFF_MS = 15 * 60 * 1000;
const MAX_BACKOFF_MS = 2 * 60 * 60 * 1000;

interface UsageWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  reset_at: number; // unix seconds
}

interface RateLimitInfo {
  allowed: boolean;
  limit_reached: boolean;
  primary_window?: UsageWindow | null;
  secondary_window?: UsageWindow | null;
}

interface CreditsInfo {
  has_credits: boolean;
  unlimited: boolean;
  balance?: string | null;
}

interface CodexUsage {
  plan_type?: string;
  rate_limit?: RateLimitInfo | null;
  code_review_rate_limit?: RateLimitInfo | null;
  credits?: CreditsInfo | null;
}

interface PiAuthFile {
  "openai-codex"?: {
    type: "oauth" | "api_key";
    access?: string;
    refresh?: string;
    expires?: number;
    accountId?: string;
    key?: string;
  };
}

interface CodexCredentials {
  accessToken: string;
  accountId: string;
}

function extractAccountIdFromJwt(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payloadBase64 = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");

    const payloadText = Buffer.from(payloadBase64, "base64").toString("utf-8");
    const payload = JSON.parse(payloadText) as {
      [JWT_CLAIM_PATH]?: {
        chatgpt_account_id?: string;
      };
    };

    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
  } catch {
    return null;
  }
}

/**
 * Reads OpenAI Codex OAuth credentials from pi's auth.json file.
 */
function getCodexCredentialsFromPiAuth(): CodexCredentials | null {
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    const authData = JSON.parse(readFileSync(authPath, "utf-8")) as PiAuthFile;

    const codex = authData["openai-codex"];
    if (codex?.type !== "oauth" || !codex.access) {
      return null;
    }

    const accountId = codex.accountId || extractAccountIdFromJwt(codex.access);
    if (!accountId) {
      return null;
    }

    return {
      accessToken: codex.access,
      accountId,
    };
  } catch {
    // File not found or invalid JSON
    return null;
  }
}

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
 * Fetch usage data from ChatGPT backend API.
 */
async function fetchUsage(
  creds: CodexCredentials
): Promise<{ usage: CodexUsage | null; status?: number; retryAfterMs?: number }> {
  try {
    const response = await fetch(CODEX_USAGE_ENDPOINT, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${creds.accessToken}`,
        "ChatGPT-Account-Id": creds.accountId,
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      console.error(`Codex Usage API error: ${response.status} ${response.statusText}`);
      return {
        usage: null,
        status: response.status,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      };
    }

    return {
      usage: (await response.json()) as CodexUsage,
      status: response.status,
    };
  } catch (error) {
    console.error("Codex Usage fetch error:", error);
    return { usage: null };
  }
}

function normalizePct(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.max(0, Math.min(100, Math.round(val)));
}

function getUsageColor(pct: number): "success" | "warning" | "error" {
  if (pct >= 90) return "error";
  if (pct >= 70) return "warning";
  return "success";
}

function formatResetIn(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || seconds <= 0) return "now";

  const mins = Math.ceil(seconds / 60);
  if (mins < 60) return `${mins}m`;

  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }

  return `${hours}h ${remMins}m`;
}

function capitalizeFirstLetter(val: string): string {
  return val.charAt(0).toUpperCase() + val.slice(1);
}

function formatResetTimeNice(unixSeconds: number, showTimezone: boolean = false): string {
  const reset = new Date(unixSeconds * 1000);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const dateStr = capitalizeFirstLetter(
    reset
      .toLocaleDateString("en-US", {
        weekday: "short",
        timeZone: timezone,
      })
      .toLowerCase()
  );

  const timeStr = reset
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: timezone,
    })
    .toLowerCase()
    .replace(" ", "");

  const val = `${dateStr} at ${timeStr}`;
  return showTimezone ? `${val} (${timezone})` : val;
}

function renderProgressBar(
  pct: number,
  width: number,
  theme: { fg: (color: string, text: string) => string }
): string {
  const safePct = normalizePct(pct);
  const filled = (safePct / 100) * width;
  const fullBlocks = Math.floor(filled);
  const hasHalf = filled - fullBlocks >= 0.5;
  const emptyBlocks = width - fullBlocks - (hasHalf ? 1 : 0);

  const color = getUsageColor(safePct);
  return (
    theme.fg(color, "█".repeat(fullBlocks)) +
    (hasHalf ? theme.fg(color, "▌") : "") +
    theme.fg("dim", "░".repeat(Math.max(0, emptyBlocks)))
  );
}

function limitLabel(seconds: number): string {
  if (seconds === 18000) return "5h";
  if (seconds === 604800) return "7d";

  if (seconds % 86400 === 0) {
    return `${Math.round(seconds / 86400)}d`;
  }
  if (seconds % 3600 === 0) {
    return `${Math.round(seconds / 3600)}h`;
  }
  return `${Math.round(seconds / 60)}m`;
}

export default function (pi: ExtensionAPI) {
  let lastUsage: CodexUsage | null = null;
  let updateInterval: ReturnType<typeof setInterval> | null = null;
  let isCodexModel = false;
  let hasCodexTurn = false;
  let lastFetchAt = 0;
  let rateLimitedUntil = 0;
  let currentBackoffMs = INITIAL_BACKOFF_MS;

  function checkIsCodexModel(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === "openai-codex";
  }

  function getPrimaryWindow(usage: CodexUsage): UsageWindow | null {
    return usage.rate_limit?.primary_window ?? null;
  }

  function getSecondaryWindow(usage: CodexUsage): UsageWindow | null {
    return usage.rate_limit?.secondary_window ?? null;
  }

  /**
   * Core fetch + update function.
   * Respects rate limits and minimum fetch intervals.
   * Only `force: true` (from /quota-openai command) bypasses the interval guard.
   */
  async function updateUsageStatus(
    ctx: ExtensionContext,
    options: { force?: boolean } = {}
  ) {
    if (!ctx.hasUI) return;

    if (!isCodexModel) {
      ctx.ui.setStatus("codex-usage", undefined);
      return;
    }

    if (!hasCodexTurn && !options.force) {
      ctx.ui.setStatus("codex-usage", undefined);
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
          ctx.ui.setStatus("codex-usage",
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

    // --- Fetch ---
    let creds = getCodexCredentialsFromPiAuth();
    if (!creds) {
      ctx.ui.setStatus(
        "codex-usage",
        theme.fg("warning", "⚠ Codex OAuth not found (use /login)")
      );
      return;
    }

    lastFetchAt = Date.now();
    const firstAttempt = await fetchUsage(creds);
    let usage = firstAttempt.usage;
    let status = firstAttempt.status;
    let retryAfterMs = firstAttempt.retryAfterMs;

    // Retry once if token may have been refreshed on disk
    if (!usage && status === 401) {
      creds = getCodexCredentialsFromPiAuth();
      if (creds) {
        const retryAttempt = await fetchUsage(creds);
        usage = retryAttempt.usage;
        status = retryAttempt.status ?? status;
        retryAfterMs = retryAttempt.retryAfterMs ?? retryAfterMs;
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
          ctx.ui.setStatus("codex-usage",
            theme.fg("warning", `⚠ Usage API rate-limited (retry in ${remainMin}m)`));
        }
        return;
      }

      const statusSuffix = status ? ` (${status})` : "";
      ctx.ui.setStatus(
        "codex-usage",
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
    if (!ctx.hasUI || !lastUsage) return;

    const theme = ctx.ui.theme;
    const parts: string[] = [];

    const primary = getPrimaryWindow(lastUsage);
    if (primary) {
      const pct = normalizePct(primary.used_percent);
      parts.push(
        theme.fg(getUsageColor(pct), `${limitLabel(primary.limit_window_seconds)}: ${pct}%`) +
          " " +
          theme.fg("dim", `(${formatResetIn(primary.reset_after_seconds)})`)
      );
    }

    const secondary = getSecondaryWindow(lastUsage);
    if (secondary) {
      const pct = normalizePct(secondary.used_percent);
      parts.push(
        theme.fg(getUsageColor(pct), `${limitLabel(secondary.limit_window_seconds)}: ${pct}%`) +
          " " +
          theme.fg("dim", `(${formatResetIn(secondary.reset_after_seconds)})`)
      );
    }

    if (parts.length === 0) {
      ctx.ui.setStatus("codex-usage", theme.fg("dim", "Codex: no data"));
      return;
    }

    const warningSuffix = options.stale ? theme.fg("warning", " ⚠") : "";
    const status = theme.fg("dim", "Codex: ") + parts.join(theme.fg("dim", " │ ")) + warningSuffix;
    ctx.ui.setStatus("codex-usage", status);
  }

  pi.on("session_start", async (_event, ctx) => {
    isCodexModel = checkIsCodexModel(ctx);
    hasCodexTurn = false;

    // Don't fetch on session start — wait for first turn or interval
    if (lastUsage && isCodexModel) {
      renderStatus(ctx);
    }

    // Background poll every 15 minutes
    if (updateInterval) clearInterval(updateInterval);
    updateInterval = setInterval(() => updateUsageStatus(ctx), POLL_INTERVAL_MS);
  });

  pi.on("model_select", async (event, ctx) => {
    isCodexModel = event.model.provider === "openai-codex";
    // Only re-render cached data, never fetch on model change
    if (isCodexModel && lastUsage) {
      renderStatus(ctx);
    } else if (!isCodexModel && ctx.hasUI) {
      ctx.ui.setStatus("codex-usage", undefined);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!isCodexModel) return;

    const wasFirstTurn = !hasCodexTurn;
    hasCodexTurn = true;

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

  const showQuotaHandler = async (_args: string[], ctx: ExtensionContext) => {
    await updateUsageStatus(ctx, { force: true });

    if (!lastUsage) {
      ctx.ui.notify("No usage data available", "error");
      return;
    }

    const theme = ctx.ui.theme;
    const lines: string[] = [];

    if (lastUsage.plan_type) {
      lines.push(theme.bold(`  Plan: ${capitalizeFirstLetter(lastUsage.plan_type)}`));
      lines.push("");
    }

    const primary = getPrimaryWindow(lastUsage);
    if (primary) {
      const pct = normalizePct(primary.used_percent);
      lines.push(theme.bold(`  Current window (${limitLabel(primary.limit_window_seconds)})`));
      lines.push(
        "  " +
          renderProgressBar(pct, 50, theme) +
          " " +
          theme.fg(getUsageColor(pct), `${pct}% used`)
      );
      lines.push("  " + theme.fg("dim", `Resets in ${formatResetIn(primary.reset_after_seconds)}`));
      lines.push("");
    }

    const secondary = getSecondaryWindow(lastUsage);
    if (secondary) {
      const pct = normalizePct(secondary.used_percent);
      lines.push(theme.bold(`  Long window (${limitLabel(secondary.limit_window_seconds)})`));
      lines.push(
        "  " +
          renderProgressBar(pct, 50, theme) +
          " " +
          theme.fg(getUsageColor(pct), `${pct}% used`)
      );
      lines.push("  " + theme.fg("dim", `Resets ${formatResetTimeNice(secondary.reset_at, true)}`));
      lines.push("");
    }

    const reviewWindow = lastUsage.code_review_rate_limit?.primary_window;
    if (reviewWindow) {
      const pct = normalizePct(reviewWindow.used_percent);
      lines.push(theme.bold(`  Code review (${limitLabel(reviewWindow.limit_window_seconds)})`));
      lines.push(
        "  " +
          renderProgressBar(pct, 50, theme) +
          " " +
          theme.fg(getUsageColor(pct), `${pct}% used`)
      );
      lines.push("  " + theme.fg("dim", `Resets ${formatResetTimeNice(reviewWindow.reset_at, true)}`));
      lines.push("");
    }

    const credits = lastUsage.credits;
    if (credits) {
      if (credits.unlimited) {
        lines.push(theme.bold("  Credits: Unlimited"));
      } else if (credits.has_credits && credits.balance) {
        lines.push(theme.bold(`  Credits: ${credits.balance}`));
      } else if (!credits.has_credits) {
        lines.push(theme.bold("  Credits: None"));
      }
    }

    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    if (lines.length === 0) {
      ctx.ui.notify("Codex: no usage windows returned", "warning");
      return;
    }

    ctx.ui.notify(lines.join("\n"), "info");
  };

  pi.registerCommand("quota-openai", {
    description: "Show/refresh OpenAI Codex usage",
    handler: showQuotaHandler,
  });

  // Backwards-compatible alias
  pi.registerCommand("quota-codex", {
    description: "Alias for /quota-openai",
    handler: showQuotaHandler,
  });
}
