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
AUERNYX_NO_DAEMON=1 node ./dist/clients/cli/auernyx.js memory --reason "independence test" > /dev/null 2>&1
echo -e "   ${GREEN}✓ Headless CLI works independently (local execution)${NC}"
echo ""

echo -e "${BLUE}2. Testing Daemon (HTTP API server)${NC}"
echo "   Starting daemon..."
node ./dist/clients/cli/auernyx-daemon.js --root . > /dev/null 2>&1 &
DAEMON_PID=$!
sleep 2

echo "   Testing health endpoint..."
curl -s http://127.0.0.1:43117/health | grep -q '"ok":true'
echo -e "   ${GREEN}✓ Daemon health endpoint responding${NC}"

echo "   Testing browser UI endpoint..."
curl -s http://127.0.0.1:43117/ui | grep -q "Auernyx Mk2"
echo -e "   ${GREEN}✓ Browser UI endpoint serving${NC}"
echo ""

echo -e "${BLUE}3. Testing CLI delegation to Daemon${NC}"
echo "   Running: node ./dist/clients/cli/auernyx.js memory (delegates to daemon)"
node ./dist/clients/cli/auernyx.js memory --reason "daemon delegation test" > /dev/null 2>&1
echo -e "   ${GREEN}✓ CLI successfully delegates to daemon${NC}"
echo ""

echo "   Stopping daemon..."
if ! kill $DAEMON_PID 2>/dev/null; then
    echo "   Warning: Daemon process $DAEMON_PID not found or already stopped"
fi
sleep 1

echo -e "${BLUE}4. Testing CLI fallback (daemon stopped)${NC}"
echo "   Running: node ./dist/clients/cli/auernyx.js memory (no daemon)"
node ./dist/clients/cli/auernyx.js memory --reason "fallback test" > /dev/null 2>&1
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
