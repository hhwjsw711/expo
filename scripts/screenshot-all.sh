#!/bin/bash

# screenshot-all.sh - Run all Maestro screenshot flows
#
# Usage:
#   ./scripts/screenshot-all.sh              # Run all flows
#   ./scripts/screenshot-all.sh --device "iPhone 15 Pro Max"  # Specific device
#
# Prerequisites:
#   1. Install Maestro: curl -Ls "https://get.maestro.mobile.dev" | bash
#   2. Start your Expo app: npm start
#   3. Have a simulator running

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
OUTPUT_DIR=".maestro/screenshots"
FLOWS_DIR=".maestro/flows"
DEVICE="${1:-iPhone 15 Pro}"

echo -e "${BLUE}📸 Reelful Screenshot Automation${NC}"
echo -e "${BLUE}=================================${NC}"
echo ""

# Check if Maestro is installed
if ! command -v maestro &> /dev/null; then
    echo -e "${RED}❌ Maestro is not installed${NC}"
    echo ""
    echo "Install it with:"
    echo "  curl -Ls \"https://get.maestro.mobile.dev\" | bash"
    exit 1
fi

echo -e "${GREEN}✓ Maestro found: $(maestro --version)${NC}"

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Check for flows
if [ ! -d "$FLOWS_DIR" ]; then
    echo -e "${RED}❌ Flows directory not found: $FLOWS_DIR${NC}"
    exit 1
fi

FLOW_COUNT=$(find "$FLOWS_DIR" -name "*.yaml" | wc -l | tr -d ' ')
echo -e "${GREEN}✓ Found $FLOW_COUNT flow files${NC}"
echo ""

# List available devices
echo -e "${YELLOW}Available devices:${NC}"
maestro devices 2>/dev/null || echo "  (Run 'maestro devices' to see available devices)"
echo ""

# Run flows
echo -e "${BLUE}Running screenshot flows...${NC}"
echo ""

# Option 1: Run the full flow
if [ -f "$FLOWS_DIR/full-flow-screenshots.yaml" ]; then
    echo -e "${YELLOW}▶ Running: full-flow-screenshots.yaml${NC}"
    maestro test "$FLOWS_DIR/full-flow-screenshots.yaml" || {
        echo -e "${RED}⚠ Full flow failed, running individual flows...${NC}"
    }
fi

echo ""
echo -e "${GREEN}✅ Screenshots saved to: $OUTPUT_DIR/${NC}"
echo ""

# List captured screenshots
echo -e "${BLUE}Captured screenshots:${NC}"
ls -la "$OUTPUT_DIR"/*.png 2>/dev/null || echo "  No screenshots found"
echo ""

# Summary
echo -e "${BLUE}=================================${NC}"
echo -e "${GREEN}Done!${NC}"
echo ""
echo "Next steps:"
echo "  1. Review screenshots in $OUTPUT_DIR/"
echo "  2. Commit changes"
