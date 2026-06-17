#!/bin/bash
# start.sh
# Starts the global Anthropic → NVIDIA NIM Proxy (Node.js)

echo -e "\033[0;36m=== Global NVIDIA NIM Proxy ===\033[0m"
echo -e "\033[0;32mPort  : 8082\033[0m"
echo -e "\033[0;32mModel : moonshotai/kimi-k2.6\033[0m"
echo ""
echo -e "\033[0;33mStarting proxy... (Ctrl+C to stop)\033[0m"
echo ""

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
SERVER_PATH="$SCRIPT_DIR/server.mjs"
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
LOG_PATH="$LOG_DIR/proxy_$TIMESTAMP.log"

echo -e "\033[0;37mProxy logs will be saved to: $LOG_PATH\033[0m"

node "$SERVER_PATH" 2>&1 | tee -a "$LOG_PATH"
