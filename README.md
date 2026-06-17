# Claude → NVIDIA NIM Proxy

A standalone local proxy that translates Anthropic API formats (used by the Claude Code CLI) into OpenAI-compatible API formats for NVIDIA NIM. This allows you to use powerful NVIDIA-hosted models (like `moonshotai/kimi-k2.6` or others) directly within the Claude Code CLI.

## Prerequisites
- [Node.js](https://nodejs.org/) (v18+ recommended)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview)

## Installation

1. Clone or download this repository.
2. Install the required dependencies:
   ```bash
   npm install
   ```

## Configuration

1. Copy the sample environment file and set up your variables:
   ```bash
   cp .env.sample .env
   ```
2. Open `.env` and add your **NVIDIA API Key**.
   ```env
   NVIDIA_API_KEY=your_nvidia_api_key_here
   NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
   NVIDIA_MODEL=moonshotai/kimi-k2.6
   ```

## Usage

There are two primary ways to run and use the proxy:

### Method 1: Standalone Proxy (Recommended for extensions & cowork)
If you want to leave the proxy running in the background so you can use Claude Code through IDE extensions, `claude cowork`, or multiple terminal windows:

1. Start the proxy server:
   ```powershell
   .\start.ps1
   # OR
   npm start
   ```
   *(The proxy will run on `http://localhost:8082`)*

2. Use Claude as you normally would in another terminal. The local `.clauderc.json` file ensures that Claude automatically routes its requests to the proxy when you are working inside this repository.

### Method 2: Wrapper Script
If you want a quick, isolated session, you can use the provided wrapper script. This script automatically starts the proxy, launches the Claude CLI, and safely shuts down the proxy when you exit Claude.

```powershell
.\claude-nvidia.ps1
# OR
.\claude-nvidia.cmd
```

## Global Claude Configuration
If you want to use this proxy globally across *all* of your projects (not just inside this directory), you can update your global Claude Code settings file located at `~/.claude/settings.json` (or `%USERPROFILE%\.claude\settings.json` on Windows):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8082",
    "ANTHROPIC_API_KEY": "sk-nvidia-proxy",
    "ANTHROPIC_MODEL": "moonshotai/kimi-k2.6"
  }
}
```
*(When configured globally, make sure to use **Method 1** to keep the proxy running in the background).*
