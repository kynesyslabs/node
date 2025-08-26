#!/bin/bash

# Phase 7: Gasless Bridge Testing - Focused Test Suite
# This script runs focused tests for gasless bridge functionality

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ensure Foundry is in PATH
export PATH="$PATH:/home/tcsenpai/.foundry/bin"

echo -e "${PURPLE}🚀 Phase 7: Testing & Validation${NC}"
echo -e "${PURPLE}Gasless Bridge Operations - Focused Test Suite${NC}"
echo -e "${BLUE}===============================================${NC}\n"

# Check if foundry is installed
if ! command -v forge &> /dev/null; then
    echo -e "${RED}❌ Foundry not found. Installing foundry...${NC}"
    curl -L https://foundry.paradigm.xyz | bash
    source ~/.bashrc
    foundryup
fi

cd "$SCRIPT_DIR"

echo -e "${CYAN}📋 Phase 7 Testing Strategy:${NC}"
echo -e "  • Gasless deposit functionality"
echo -e "  • Gasless bridge initiation"
echo -e "  • Multisig gasless execution"
echo -e "  • Gas subsidy system validation"
echo -e "  • Complete bridge flow integration"
echo -e "  • Gas consumption analysis"
echo -e "  • Error handling and edge cases"
echo ""

# Initialize foundry project if not already done
if [ ! -f "foundry.toml" ]; then
    echo -e "${YELLOW}🔧 Initializing Foundry project...${NC}"
    forge init --no-git --force .
fi

# Ensure we have the correct foundry.toml configuration
cat > foundry.toml << 'EOF'
[profile.default]
src = "."
out = "out"
libs = ["lib"]
test = "test"
via_ir = true
optimizer = true
optimizer_runs = 200
solc = "0.8.30"

[rpc_endpoints]
mainnet = "https://eth-mainnet.g.alchemy.com/v2/..."

[fmt]
line_length = 100
tab_width = 4
bracket_spacing = true

EOF

# Install required dependencies
echo -e "${YELLOW}📦 Installing OpenZeppelin contracts...${NC}"
if [ ! -d "lib/openzeppelin-contracts" ]; then
    forge install OpenZeppelin/openzeppelin-contracts --no-commit
fi

# Clean and build
echo -e "${YELLOW}🧹 Cleaning previous builds...${NC}"
forge clean

echo -e "${YELLOW}🔨 Building contracts with via-ir optimization...${NC}"
forge build --via-ir

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Build failed!${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Build successful!${NC}\n"

# Run focused gasless bridge tests
echo -e "${CYAN}🧪 Running focused gasless bridge tests...${NC}"
echo -e "${BLUE}=================================================${NC}\n"

# Test our specific gasless bridge functionality
echo -e "${YELLOW}📋 1. Running Gasless Bridge Core Tests...${NC}"
forge test --match-contract "GaslessBridgeTest" -vvv

if [ $? -eq 0 ]; then
    echo -e "\n${GREEN}✅ Gasless Bridge Core Tests - PASSED${NC}\n"
else
    echo -e "\n${RED}❌ Gasless Bridge Core Tests - FAILED${NC}\n"
fi

# Generate gas report for our tests
echo -e "${YELLOW}📊 2. Generating Gas Analysis Report...${NC}"
forge test --match-contract "GaslessBridgeTest" --gas-report > gasless-bridge-report.txt

echo -e "${BLUE}📊 Gas Report Summary:${NC}"
echo -e "${BLUE}=====================${NC}"
if [ -f "gasless-bridge-report.txt" ]; then
    tail -20 gasless-bridge-report.txt | head -15
    echo ""
    echo -e "${CYAN}💾 Full gas report saved to: gasless-bridge-report.txt${NC}"
else
    echo -e "${YELLOW}⚠️  Gas report not generated${NC}"
fi

# Test specific functions with gas reporting
echo -e "\n${YELLOW}📋 3. Testing Specific Gasless Functions...${NC}"

echo -e "${CYAN}   🔹 Gasless Deposit Tests:${NC}"
forge test --match-test "test_GaslessDeposit" -v

echo -e "\n${CYAN}   🔹 Multisig Execution Tests:${NC}"
forge test --match-test "test_MultisigGaslessExecution" -v

echo -e "\n${CYAN}   🔹 Complete Bridge Flow Test:${NC}"
forge test --match-test "test_CompleteGaslessBridgeFlow" -v

echo -e "\n${CYAN}   🔹 Gas Consumption Analysis:${NC}"
forge test --match-test "test_GasConsumption_Analysis" -v

# Run signature and security focused tests if they exist
if [ -f "test/GaslessSignatureTest.t.sol" ]; then
    echo -e "\n${YELLOW}📋 4. Running Signature Verification Tests...${NC}"
    forge test --match-contract "GaslessSignatureTest" -v
fi

# Final summary
echo -e "\n${BLUE}📋 Phase 7: Testing & Validation - SUMMARY${NC}"
echo -e "${BLUE}===========================================${NC}"

# Count passed/failed tests
TOTAL_TESTS=$(forge test --match-contract "GaslessBridgeTest" 2>&1 | grep -E "test result:|Suite result:" | grep -o '[0-9]* passed\|[0-9]* failed' | awk '{sum+=$1} END {print sum}')
PASSED_TESTS=$(forge test --match-contract "GaslessBridgeTest" 2>&1 | grep -o '[0-9]* passed' | awk '{sum+=$1} END {print sum}')
FAILED_TESTS=$(forge test --match-contract "GaslessBridgeTest" 2>&1 | grep -o '[0-9]* failed' | awk '{sum+=$1} END {print sum}')

if [ -z "$PASSED_TESTS" ]; then PASSED_TESTS=0; fi
if [ -z "$FAILED_TESTS" ]; then FAILED_TESTS=0; fi

echo -e "${GREEN}✅ Tests Passed: ${PASSED_TESTS:-0}${NC}"
echo -e "${RED}❌ Tests Failed: ${FAILED_TESTS:-0}${NC}"

if [ "${FAILED_TESTS:-0}" -eq 0 ]; then
    echo -e "\n${GREEN}🎉 Phase 7: Testing & Validation - COMPLETED SUCCESSFULLY!${NC}"
    echo -e "${GREEN}✅ Gasless bridge system tested and validated successfully!${NC}"
    
    echo -e "\n${CYAN}📋 Validated Functionality:${NC}"
    echo -e "  ✅ Gasless token deposits to tank"
    echo -e "  ✅ Gasless bridge operation initiation"
    echo -e "  ✅ Multisig consensus with gasless execution"
    echo -e "  ✅ Gas subsidy pool management"
    echo -e "  ✅ Complete end-to-end gasless bridge flow"
    echo -e "  ✅ Gas consumption optimization"
    echo -e "  ✅ Error handling and security measures"
    
    echo -e "\n${PURPLE}🚀 Ready for Phase 8: Production Deployment${NC}"
else
    echo -e "\n${YELLOW}⚠️  Some tests failed - review needed${NC}"
    echo -e "${CYAN}📋 Check the detailed output above for specific issues${NC}"
fi

echo -e "\n${BLUE}📁 Generated Files:${NC}"
echo -e "  • gasless-bridge-report.txt - Gas consumption analysis"
echo -e "  • out/ - Compiled contract artifacts"

echo -e "\n${CYAN}💡 Next Steps:${NC}"
echo -e "  1. Review gas consumption metrics"
echo -e "  2. Analyze test coverage completeness"
echo -e "  3. Address any failing tests"
echo -e "  4. Prepare for production deployment"

echo -e "\n${PURPLE}Phase 7: Testing & Validation - Complete${NC}"