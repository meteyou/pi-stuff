import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as https from "node:https";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const execAsync = promisify(exec);

// --- Auth Config Reader ---

interface PiAuthConfig {
  [provider: string]: {
    type: string;
    refresh?: string;
    access?: string;
    expires?: number;
    projectId?: string;
    apiKey?: string;
  };
}

function getPiAuthConfig(): PiAuthConfig | null {
  try {
    const homeDir = os.homedir();
    const authPath = path.join(homeDir, '.pi', 'agent', 'auth.json');
    
    if (fs.existsSync(authPath)) {
      const content = fs.readFileSync(authPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (e) {
    // Ignore errors
  }
  return null;
}

function getAntigravityToken(): { token: string; projectId?: string } | null {
  const auth = getPiAuthConfig();
  if (!auth) return null;
  
  // Look for google-antigravity or similar provider
  const antigravityKey = Object.keys(auth).find(k => 
    k.toLowerCase().includes('antigravity') || 
    k.toLowerCase().includes('codeium')
  );
  
  if (antigravityKey && auth[antigravityKey]) {
    const config = auth[antigravityKey];
    
    // Check if token is expired
    if (config.expires && config.expires < Date.now()) {
      // Token expired - would need refresh, but we can still try
    }
    
    if (config.access) {
      return { 
        token: config.access, 
        projectId: config.projectId 
      };
    }
    
    if (config.apiKey) {
      return { token: config.apiKey };
    }
  }
  
  return null;
}

// --- Types ---

interface ProcessInfo {
  pid: number;
  extension_port: number;
  csrf_token: string;
}

interface QuotaSnapshot {
  timestamp: Date;
  prompt_credits?: PromptCreditsInfo;
  models: ModelQuotaInfo[];
}

interface PromptCreditsInfo {
  available: number;
  monthly: number;
  used_percentage: number;
  remaining_percentage: number;
}

interface ModelQuotaInfo {
  label: string;
  model_id: string;
  remaining_fraction?: number;
  remaining_percentage?: number;
  is_exhausted: boolean;
  reset_time: Date;
  time_until_reset: number;
  time_until_reset_formatted: string;
}

// --- Strategies ---

interface PlatformStrategy {
  get_process_list_command(process_name: string): string;
  parse_process_info(stdout: string): ProcessInfo | null;
  get_port_list_command(pid: number): string;
  parse_listening_ports(stdout: string, pid: number): number[];
}

class WindowsStrategy implements PlatformStrategy {
  get_process_list_command(process_name: string): string {
    // Using PowerShell approach as it's more reliable for JSON output
    return `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='${process_name}'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;
  }

  parse_process_info(stdout: string): ProcessInfo | null {
    try {
      // Clean up potential noise
      const cleanStdout = stdout.trim();
      if (!cleanStdout) return null;

      let data: any;
      try {
        data = JSON.parse(cleanStdout);
      } catch (e) {
        return null;
      }

      const processes = Array.isArray(data) ? data : [data];
      
      // Filter for Antigravity processes
      const antigravityProcess = processes.find((p: any) => {
        const cmd = (p.CommandLine || "").toLowerCase();
        return cmd.includes("--app_data_dir antigravity") || 
               cmd.includes("\\antigravity\\") || 
               cmd.includes("/antigravity/");
      });

      if (!antigravityProcess || !antigravityProcess.CommandLine) return null;

      const cmd = antigravityProcess.CommandLine;
      const pid = antigravityProcess.ProcessId;

      const portMatch = cmd.match(/--extension_server_port[=\s]+(\d+)/);
      const tokenMatch = cmd.match(/--csrf_token[=\s]+([a-f0-9\-]+)/i);

      if (!tokenMatch || !tokenMatch[1]) return null;

      return {
        pid,
        extension_port: portMatch ? parseInt(portMatch[1], 10) : 0,
        csrf_token: tokenMatch[1],
      };
    } catch (e) {
      return null;
    }
  }

  get_port_list_command(pid: number): string {
    return `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen | Select-Object -ExpandProperty LocalPort | ConvertTo-Json"`;
  }

  parse_listening_ports(stdout: string, pid: number): number[] {
    try {
      const data = JSON.parse(stdout.trim());
      if (Array.isArray(data)) {
        return data.map(Number).filter(p => !isNaN(p));
      } else if (typeof data === 'number') {
        return [data];
      }
    } catch (e) {}
    return [];
  }
}

class UnixStrategy implements PlatformStrategy {
  constructor(private platform: string) {}

  get_process_list_command(process_name: string): string {
    if (this.platform === 'darwin') {
      return `pgrep -fl ${process_name}`;
    }
    return `pgrep -af ${process_name}`;
  }

  parse_process_info(stdout: string): ProcessInfo | null {
    const lines = stdout.split('\n');
    for (const line of lines) {
      if (line.includes('--extension_server_port')) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[0], 10);
        const cmd = line.substring(parts[0].length).trim();

        const portMatch = cmd.match(/--extension_server_port[=\s]+(\d+)/);
        const tokenMatch = cmd.match(/--csrf_token[=\s]+([a-zA-Z0-9\-]+)/);

        if (tokenMatch) {
          return {
            pid,
            extension_port: portMatch ? parseInt(portMatch[1], 10) : 0,
            csrf_token: tokenMatch[1],
          };
        }
      }
    }
    return null;
  }

  get_port_list_command(pid: number): string {
    if (this.platform === 'darwin') {
      return `lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid}`;
    }
    // Linux: try ss, fallback to lsof
    return `ss -tlnp 2>/dev/null | grep "pid=${pid}" || lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid} 2>/dev/null`;
  }

  parse_listening_ports(stdout: string, pid: number): number[] {
    const ports: number[] = [];
    const lsofRegex = new RegExp(`^\\S+\\s+${pid}\\s+.*?(?:TCP|UDP)\\s+(?:\\*|[\\d.]+|\\[[\\da-f:]+\\]):(\\d+)\\s+\\(LISTEN\\)`, 'gim');

    if (this.platform === 'darwin') {
      let match;
      while ((match = lsofRegex.exec(stdout)) !== null) {
        ports.push(parseInt(match[1], 10));
      }
    } else {
      // Try parsing SS output first
      const ssRegex = new RegExp(`LISTEN\\s+\\d+\\s+\\d+\\s+(?:\\*|[\\d.]+|\\[[\\da-f:]*\\]):(\\d+).*?users:.*?,pid=${pid},`, 'gi');
      let match;
      let foundSs = false;
      while ((match = ssRegex.exec(stdout)) !== null) {
        ports.push(parseInt(match[1], 10));
        foundSs = true;
      }
      
      // If no SS results, try LSOF regex on the output (since we pipe both)
      if (!foundSs) {
        while ((match = lsofRegex.exec(stdout)) !== null) {
          ports.push(parseInt(match[1], 10));
        }
      }
    }
    
    return [...new Set(ports)].sort((a, b) => a - b);
  }
}

// --- Process Finder ---

class ProcessFinder {
  private strategy: PlatformStrategy;
  private processName: string;

  constructor() {
    if (os.platform() === 'win32') {
      this.strategy = new WindowsStrategy();
      this.processName = 'language_server_windows_x64.exe';
    } else if (os.platform() === 'darwin') {
      this.strategy = new UnixStrategy('darwin');
      this.processName = `language_server_macos${os.arch() === 'arm64' ? '_arm' : ''}`;
    } else {
      this.strategy = new UnixStrategy('linux');
      this.processName = `language_server_linux${os.arch() === 'arm64' ? '_arm' : '_x64'}`;
    }
  }

  async detectProcessInfo(): Promise<{ connect_port: number; csrf_token: string } | null> {
    try {
      const cmd = this.strategy.get_process_list_command(this.processName);
      const { stdout } = await execAsync(cmd);
      const info = this.strategy.parse_process_info(stdout);

      if (!info) return null;

      const portCmd = this.strategy.get_port_list_command(info.pid);
      const { stdout: portStdout } = await execAsync(portCmd);
      const ports = this.strategy.parse_listening_ports(portStdout, info.pid);

      for (const port of ports) {
        if (await this.testPort(port, info.csrf_token)) {
          return { connect_port: port, csrf_token: info.csrf_token };
        }
      }
    } catch (e) {
      // console.error(e);
    }
    return null;
  }

  private testPort(port: number, csrfToken: string): Promise<boolean> {
    return new Promise(resolve => {
      const options = {
        hostname: '127.0.0.1',
        port,
        path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Codeium-Csrf-Token': csrfToken,
          'Connect-Protocol-Version': '1',
        },
        rejectUnauthorized: false,
        timeout: 1000,
      };

      const req = https.request(options, res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              JSON.parse(body);
              resolve(true);
            } catch { resolve(false); }
          } else { resolve(false); }
        });
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(JSON.stringify({ wrapper_data: {} }));
      req.end();
    });
  }
}

// --- Quota Manager ---

class QuotaManager {
  private baseUrl: string;
  private apiKey?: string;
  private csrfToken: string = '';

  constructor(
    hostOrUrl: string, 
    portOrToken?: number | string, 
    csrfToken?: string
  ) {
    if (typeof portOrToken === 'number') {
      // Local process mode - use provided protocol (http/https)
      this.baseUrl = `${hostOrUrl}:${portOrToken}`;
      this.csrfToken = csrfToken || '';
    } else {
      // Remote/Direct mode
      this.baseUrl = hostOrUrl.replace(/\/$/, '');
      this.apiKey = portOrToken as string;
    }
  }
  
  getBaseUrl(): string {
    return this.baseUrl;
  }
  
  isLocalMode(): boolean {
    return !!this.csrfToken;
  }

  private lastError: string = '';
  
  getLastError(): string {
    return this.lastError;
  }

  async fetchQuota(): Promise<QuotaSnapshot | null> {
    try {
      const data: any = await this.request('/exa.language_server_pb.LanguageServerService/GetUserStatus', {
        metadata: {
          ideName: 'antigravity',
          extensionName: 'antigravity',
          locale: 'en',
        },
      });
      return this.parseResponse(data);
    } catch (e: any) {
      this.lastError = e.message || String(e);
      return null;
    }
  }

  private request(path: string, body: object): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const url = new URL(this.baseUrl + path);
      
      const headers: any = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      };

      if (this.csrfToken) {
        // Local mode headers (Codeium Language Server)
        headers['Connect-Protocol-Version'] = '1';
        headers['X-Codeium-Csrf-Token'] = this.csrfToken;
      } else if (this.apiKey) {
        // Remote mode headers (Google Antigravity API)
        if (this.apiKey.startsWith('ya29.')) {
          // Google OAuth token with Antigravity-specific headers
          headers['Authorization'] = `Bearer ${this.apiKey}`;
          headers['User-Agent'] = 'antigravity/1.11.5 darwin/arm64';
          headers['X-Goog-Api-Client'] = 'google-cloud-sdk vscode_cloudshelleditor/0.1';
        } else {
          headers['Authorization'] = `Basic ${this.apiKey}`;
        }
      }

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        rejectUnauthorized: false,
        timeout: 5000,
      };

      // Import http dynamically only if needed, but handled synchronously in promise executor is tricky if using await.
      // Since we are in an environment that likely has both, let's just use require or rely on the global availability
      // or import it at top level if possible. Since we can't easily change top level here safely without rewriting the file:
      // We will assume https is fine for both usually? No, http module is needed for http.
      
      const isHttps = url.protocol === 'https:';
      
      // We can use the global `fetch` if available in newer Node, but let's stick to 'https'/'http'.
      // To fix the await error, we'll wrap the logic in an async IIFE inside the promise, 
      // OR better, import http at the top of the file.
      
      const performRequest = async () => {
         const lib = isHttps ? https : await import("node:http");
         const req = (lib as any).request(options, (res: any) => {
            let body = '';
            res.on('data', (chunk: any) => (body += chunk));
            res.on('end', () => {
              if (res.statusCode === 200) {
                try {
                  resolve(JSON.parse(body));
                } catch {
                  reject(new Error('Invalid JSON'));
                }
              } else {
                try {
                    const err = JSON.parse(body);
                    reject(new Error(`API Error ${res.statusCode}: ${JSON.stringify(err)}`));
                } catch {
                    reject(new Error(`API Error ${res.statusCode}`));
                }
              }
            });
         });
         
         req.on('error', reject);
         req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
         req.write(data);
         req.end();
      };
      
      performRequest().catch(reject);
    });
  }

  private parseResponse(data: any): QuotaSnapshot {
    const userStatus = data.userStatus || {};
    const planInfo = userStatus.planStatus?.planInfo;
    const availableCredits = userStatus.planStatus?.availablePromptCredits;

    let promptCredits: PromptCreditsInfo | undefined;

    if (planInfo && availableCredits !== undefined) {
      const monthly = Number(planInfo.monthlyPromptCredits);
      const available = Number(availableCredits);
      if (monthly > 0) {
        promptCredits = {
          available,
          monthly,
          used_percentage: ((monthly - available) / monthly) * 100,
          remaining_percentage: (available / monthly) * 100,
        };
      }
    }

    const rawModels = userStatus.cascadeModelConfigData?.clientModelConfigs || [];
    
    const models: ModelQuotaInfo[] = rawModels
      .filter((m: any) => m.quotaInfo)
      .map((m: any) => {
        const resetTime = new Date(m.quotaInfo.resetTime);
        const now = new Date();
        const diff = resetTime.getTime() - now.getTime();

        // remainingFraction can be 0, so check explicitly for undefined/null
        // Note: API returns fraction as decimal (0.2 = 20%)
        // If remainingFraction is missing, assume 100% available (model not used yet)
        const rawFraction = m.quotaInfo?.remainingFraction;
        let fraction: number;
        if (typeof rawFraction === 'number') {
          fraction = rawFraction;
        } else if (typeof rawFraction === 'string') {
          fraction = parseFloat(rawFraction);
        } else {
          // No remainingFraction = model not used yet = 100% available
          fraction = 1.0;
        }
        
        return {
          label: m.label,
          model_id: m.modelOrAlias?.model || 'unknown',
          remaining_fraction: fraction,
          remaining_percentage: fraction * 100,
          is_exhausted: fraction === 0,
          reset_time: resetTime,
          time_until_reset: diff,
          time_until_reset_formatted: this.formatTime(diff, resetTime),
        };
      });

    return {
      timestamp: new Date(),
      prompt_credits: promptCredits,
      models,
    };
  }

  private formatTime(ms: number, resetTime: Date): string {
    if (ms <= 0) return 'Ready';
    const mins = Math.ceil(ms / 60000);
    let duration = '';
    if (mins < 60) {
      duration = `${mins}m`;
    } else {
      const hours = Math.floor(mins / 60);
      duration = `${hours}h ${mins % 60}m`;
    }
    return `${duration}`;
  }
}

// --- Extension ---

function createProgressBar(percentage: number, width: number): string {
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;
    const filledChar = "█";
    const emptyChar = "░";
    return `[${filledChar.repeat(filled)}${emptyChar.repeat(empty)}]`;
}

// Pad string to target width accounting for wide characters (emojis)
function padEndVisible(str: string, targetWidth: number, padChar: string = " "): string {
    const { visibleWidth } = require("@mariozechner/pi-tui");
    const currentWidth = visibleWidth(str);
    if (currentWidth >= targetWidth) return str;
    return str + padChar.repeat(targetWidth - currentWidth);
}

function isAntigravityModel(ctx: ExtensionContext): boolean {
    const model = ctx.model;
    if (!model) return false;
    
    const provider = (model.provider || '').toLowerCase();
    // Check if the provider is "antigravity" or similar
    return provider.includes('antigravity') || provider.includes('codeium');
}

function getCurrentModelId(ctx: ExtensionContext): string | null {
    const model = ctx.model;
    if (!model) return null;
    return model.id || null;
}

async function getQuotaManager(): Promise<{ manager: QuotaManager; source: string } | null> {
    // 1. Try Local Process FIRST (most reliable)
    const finder = new ProcessFinder();
    const conn = await finder.detectProcessInfo();

    if (conn) {
        return { 
            manager: new QuotaManager('https://127.0.0.1', conn.connect_port, conn.csrf_token),
            source: `Local (port ${conn.connect_port})`
        };
    }

    // 2. Try Pi auth.json config (Remote API - experimental, may not work)
    const authToken = getAntigravityToken();
    if (authToken) {
        const customUrl = process.env.ANTIGRAVITY_URL;
        if (customUrl) {
            return { 
                manager: new QuotaManager(customUrl, authToken.token), 
                source: `Remote (${customUrl})` 
            };
        }
    }

    // 3. Try Environment variable
    const envToken = process.env.ANTIGRAVITY_TOKEN || process.env.PI_ANTIGRAVITY_TOKEN;
    if (envToken) {
        const envUrl = process.env.ANTIGRAVITY_URL || "https://server.codeium.com";
        return { 
            manager: new QuotaManager(envUrl, envToken),
            source: `Env (${envUrl})`
        };
    }

    return null;
}

export default function(pi: ExtensionAPI) {
  let pollingInterval: NodeJS.Timeout | undefined;
  let lastSnapshot: QuotaSnapshot | undefined;

  function findCurrentModel(snapshot: QuotaSnapshot, ctx: ExtensionContext): ModelQuotaInfo | undefined {
    const currentModelId = getCurrentModelId(ctx);
    if (!currentModelId) return undefined;
    
    // Try to match by model_id or label
    const normalizedCurrent = currentModelId.toLowerCase();
    
    return snapshot.models.find(m => {
      const modelId = (m.model_id || '').toLowerCase();
      const label = (m.label || '').toLowerCase();
      
      // Match if the current model ID contains the quota model ID or vice versa
      return modelId.includes(normalizedCurrent) || 
             normalizedCurrent.includes(modelId) ||
             label.includes(normalizedCurrent) ||
             normalizedCurrent.includes(label);
    });
  }

  async function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    // Hide status if not using Antigravity
    if (!isAntigravityModel(ctx)) {
      ctx.ui.setStatus("antigravity-quota", undefined);
      return;
    }

    const result = await getQuotaManager();

    if (!result) {
      ctx.ui.setStatus("antigravity-quota", undefined);
      return;
    }

    const snapshot = await result.manager.fetchQuota();

    if (snapshot) {
        lastSnapshot = snapshot;
        
        // Find the current model's quota
        const currentModel = findCurrentModel(snapshot, ctx);
        
        if (currentModel && currentModel.remaining_percentage !== undefined) {
            const pct = Math.round(currentModel.remaining_percentage);
            const icon = currentModel.is_exhausted ? "🔴" : (pct < 20 ? "🟡" : "🟢");
            ctx.ui.setStatus("antigravity-quota", `${icon} ${pct}% (${currentModel.label})`);
        } else {
            ctx.ui.setStatus("antigravity-quota", undefined);
        }
    } else {
        ctx.ui.setStatus("antigravity-quota", "AGQ: Error");
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    // Initial check
    updateStatus(ctx);
    
    // Poll every 2 minutes
    pollingInterval = setInterval(() => updateStatus(ctx), 120000);
  });

  pi.on("session_shutdown", async () => {
    if (pollingInterval) clearInterval(pollingInterval);
  });

  // Update status when model changes
  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.registerCommand("quota-antigravity", {
    description: "Show Antigravity quota usage",
    handler: async (args, ctx) => {
        if (!ctx.hasUI) {
            return;
        }

        const result = await getQuotaManager();

        if (!result) {
            ctx.ui.notify("No Antigravity connection available (local process not running)", "error");
            return;
        }

        const snapshot = await result.manager.fetchQuota();

        if (!snapshot) {
            const err = result.manager.getLastError();
            ctx.ui.notify(`Failed to fetch quota: ${err}`, "error");
            return;
        }

        // Sort models by remaining percentage (lowest first)
        const sortedModels = [...snapshot.models].sort((a, b) => {
            const pctA = a.remaining_percentage ?? 100;
            const pctB = b.remaining_percentage ?? 100;
            return pctA - pctB;
        });

        // Build output
        const lines: string[] = [];
        const W = 69;
        
        lines.push("╔" + "═".repeat(W-2) + "╗");
        lines.push("║" + " ANTIGRAVITY QUOTA ".padStart((W-2+19)/2).padEnd(W-2) + "║");
        lines.push("╠" + "═".repeat(W-2) + "╣");
        
        if (snapshot.prompt_credits) {
            const pct = Math.round(snapshot.prompt_credits.remaining_percentage);
            const bar = createProgressBar(pct, 25);
            lines.push(`║  CREDITS: ${snapshot.prompt_credits.available.toLocaleString()} / ${snapshot.prompt_credits.monthly.toLocaleString()}`.padEnd(W-1) + "║");
            lines.push(`║  ${bar} ${pct}%`.padEnd(W-1) + "║");
            lines.push("╠" + "═".repeat(W-2) + "╣");
        }
        
        for (const model of sortedModels) {
            const pctNum = Math.round(model.remaining_percentage);
            const pctStr = `${pctNum}%`.padStart(4);
            
            let status = "🟢";
            if (model.is_exhausted || pctNum === 0) status = "🔴";
            else if (pctNum < 20) status = "🟡";
            
            const bar = createProgressBar(pctNum, 12);
            const name = model.label.padEnd(30);
            const reset = model.time_until_reset > 0 ? model.time_until_reset_formatted.padStart(8) : "".padStart(8);
            
            // Use padEndVisible to account for emoji width (W-1 because we add ║ after)
            lines.push(padEndVisible(`║  ${status} ${name} ${bar} ${pctStr}  ${reset}`, W-1) + "║");
        }
        
        lines.push("╠" + "═".repeat(W-2) + "╣");
        lines.push(`║  Updated: ${snapshot.timestamp.toLocaleTimeString()}`.padEnd(W-1) + "║");
        lines.push("║  Press ENTER or ESC to close".padEnd(W-1) + "║");
        lines.push("╚" + "═".repeat(W-2) + "╝");

        // Show in custom UI (full screen, no truncation)
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
            const { Text, matchesKey, Key } = require("@mariozechner/pi-tui");
            const content = lines.join("\n");
            const text = new Text(theme.fg("accent", content), 1, 1);
            
            return {
                render: (width: number) => text.render(width),
                invalidate: () => text.invalidate(),
                handleInput: (data: string) => {
                    if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
                        done();
                    }
                }
            };
        });
        

    }
  });
}
