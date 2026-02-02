# Quota Antigravity Extension

Monitor your Antigravity (Google Cloud Shell Editor / Codeium) quota usage directly in Pi.

## Concept

This extension helps you track Antigravity model quota:
1. **Monitor** - See remaining quota for all available models
2. **Track** - Footer status shows current model's quota at a glance
3. **Plan** - Know when quotas reset to manage your usage

## Commands

| Command | Description |
|---------|-------------|
| `/quota-antigravity` | Display detailed quota usage for all Antigravity models |

## Footer Status

When using an Antigravity model, the extension automatically displays quota status in the footer:

```
🟢 85% (claude-sonnet)
```

Status indicators:
- 🟢 **Green** - More than 20% remaining
- 🟡 **Yellow** - Less than 20% remaining
- 🔴 **Red** - Quota exhausted

The status updates automatically every 2 minutes and when switching models.

## Detailed View

Running `/quota-antigravity` shows a full dashboard:

```
╔═══════════════════════════════════════════════════════════════════╗
║                          ANTIGRAVITY QUOTA                        ║
╠═══════════════════════════════════════════════════════════════════╣
║  CREDITS: 50,000 / 100,000                                        ║
║  [████████████░░░░░░░░░░░░░] 50%                                  ║
╠═══════════════════════════════════════════════════════════════════╣
║  🟡 claude-3-5-sonnet                [██░░░░░░░░░░]  15%      2h 30m ║
║  🟢 gemini-2.0-flash                 [████████████] 100%            ║
║  🟢 claude-3-5-haiku                 [██████████░░]  85%      1h 15m ║
║  🔴 gpt-4o                           [░░░░░░░░░░░░]   0%      4h 00m ║
╠═══════════════════════════════════════════════════════════════════╣
║  Updated: 3:45:22 PM                                              ║
║  Press ENTER or ESC to close                                      ║
╚═══════════════════════════════════════════════════════════════════╝
```

### Display Elements

| Column | Description |
|--------|-------------|
| Status | 🟢🟡🔴 Visual indicator of quota health |
| Model | Model name/label |
| Bar | Visual progress bar of remaining quota |
| Percentage | Exact remaining percentage |
| Reset Time | Time until quota resets (if applicable) |

## Connection Methods

The extension automatically detects how to connect to Antigravity:

### 1. Local Process (Recommended)
Automatically detects the running Antigravity language server process by:
- Finding the process by name (platform-specific)
- Extracting the extension port and CSRF token from command line
- Connecting via localhost HTTPS

Supported platforms:
- **macOS** - `language_server_macos` or `language_server_macos_arm`
- **Linux** - `language_server_linux_x64` or `language_server_linux_arm`
- **Windows** - `language_server_windows_x64.exe`

### 2. Pi Auth Config
Uses credentials from `~/.pi/agent/auth.json` if available (experimental).

### 3. Environment Variables
```bash
# API token
export ANTIGRAVITY_TOKEN=your_token

# Optional: Custom API URL (defaults to https://server.codeium.com)
export ANTIGRAVITY_URL=https://custom.server.com
```

## Requirements

- **Antigravity extension** must be running (VS Code, Cloud Shell Editor, etc.)
- The extension needs access to the local Antigravity language server process

## Troubleshooting

### "No Antigravity connection available"
- Ensure the Antigravity extension is running in your editor
- Check that the language server process is running:
  ```bash
  # macOS/Linux
  pgrep -fl language_server
  
  # Windows (PowerShell)
  Get-Process | Where-Object { $_.Name -like "*language_server*" }
  ```

### Status not showing in footer
- Verify you're using an Antigravity provider model
- Check the model provider in your Pi settings

### Quota shows "Error"
- The language server may have restarted - try running `/quota-antigravity` again
- Check if your Antigravity session is still active in your editor

## Technical Details

### API Endpoint
The extension uses the Language Server's gRPC-web API:
```
POST /exa.language_server_pb.LanguageServerService/GetUserStatus
```

### Polling Interval
Footer status updates every **2 minutes** to avoid excessive API calls.

### Token Estimation
The extension reads quota data including:
- Prompt credits (monthly allocation and remaining)
- Per-model quota fractions and reset times
- Model exhaustion status
