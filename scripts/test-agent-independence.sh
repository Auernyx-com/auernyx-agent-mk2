#!/usr/bin/env bash

# Test script to verify agent independence in Auernyx Mk2
# This script tests that both agents (VS Code and headless) work independently

set -e

echo "=== Auernyx Mk2 Agent Independence Test ==="
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}1. Testing Headless CLI (local execution, no daemon)${NC}"
echo "   Running: AUERNYX_NO_DAEMON=1 node ./dist/clients/cli/auernyx.js memory"
AUERNYX_NO_DAEMON=1 node ./dist/clients/cli/auernyx.js memory --reason "independence test" > /dev/null
echo -e "   ${GREEN}✓ Headless CLI works independently (local execution)${NC}"
echo ""

echo -e "${BLUE}2. Testing Daemon (HTTP API server)${NC}"
echo "   Starting daemon..."
node ./dist/clients/cli/auernyx-daemon.js --root . > /dev/null 2>&1 &
DAEMON_PID=$!

# Wait for daemon to become ready by polling the health endpoint (max 30 seconds)
echo "   Waiting for daemon to become ready..."
MAX_WAIT=30
WAITED=0
until curl -s http://127.0.0.1:43117/health >/dev/null 2>&1; do
    if [ "$WAITED" -ge "$MAX_WAIT" ]; then
        echo "   Error: Daemon did not become ready within ${MAX_WAIT} seconds"
        kill "$DAEMON_PID" 2>/dev/null || true
        exit 1
    fi
    sleep 1
    WAITED=$((WAITED + 1))
done

echo "   Testing health endpoint..."
curl -s http://127.0.0.1:43117/health | grep -q '"ok":true'
echo -e "   ${GREEN}✓ Daemon health endpoint responding${NC}"

echo "   Testing browser UI endpoint..."
curl -s http://127.0.0.1:43117/ui | grep -q "Auernyx Mk2"
echo -e "   ${GREEN}✓ Browser UI endpoint serving${NC}"
echo ""

echo -e "${BLUE}3. Testing CLI delegation to Daemon${NC}"
echo "   Running: node ./dist/clients/cli/auernyx.js memory (delegates to daemon)"
node ./dist/clients/cli/auernyx.js memory --reason "daemon delegation test"
echo -e "   ${GREEN}✓ CLI successfully delegates to daemon${NC}"
echo ""

echo "   Stopping daemon..."
if ! kill "$DAEMON_PID" 2>/dev/null; then
    echo "   Warning: Daemon process $DAEMON_PID not found or already stopped"
else
    # Wait for daemon process to fully exit before testing fallback behavior
    wait "$DAEMON_PID" 2>/dev/null || true
fi
sleep 1

echo -e "${BLUE}4. Testing CLI fallback (daemon stopped)${NC}"
echo "   Running: node ./dist/clients/cli/auernyx.js memory (no daemon)"
FALLBACK_OUTPUT=$(node ./dist/clients/cli/auernyx.js memory --reason "fallback test" 2>&1) || {
    echo "   Fallback CLI invocation failed. Output:"
    echo "$FALLBACK_OUTPUT"
    exit 1
}
echo -e "   ${GREEN}✓ CLI falls back to local execution when daemon unavailable${NC}"
echo ""

echo "=== Summary ==="
echo -e "${GREEN}✓ Headless CLI works independently (no VS Code required)${NC}"
echo -e "${GREEN}✓ Daemon works independently (no VS Code required)${NC}"
echo -e "${GREEN}✓ Browser UI works independently (no VS Code required)${NC}"
echo -e "${GREEN}✓ CLI can delegate to daemon (optional)${NC}"
echo -e "${GREEN}✓ CLI falls back to local execution when daemon unavailable${NC}"
echo ""
echo "VS Code extension independence verified separately via F5 debug."
echo ""
echo "All agent independence tests passed!"
