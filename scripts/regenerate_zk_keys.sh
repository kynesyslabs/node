#!/bin/bash
# Production ZK Keys Regeneration Script
# Fixes Issue #4: Identical vk_gamma_2 and vk_delta_2 in verification key

set -e  # Exit on any error

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Production ZK Keys Regeneration                          ║${NC}"
echo -e "${BLUE}║  Fixes: Identical vk_gamma_2 and vk_delta_2               ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Step 1: Backup current key
echo -e "${YELLOW}[1/5] Backing up current verification key...${NC}"
if [ -f "src/features/zk/keys/verification_key_merkle.json" ]; then
    cp src/features/zk/keys/verification_key_merkle.json src/features/zk/keys/verification_key_merkle.json.UNSAFE_BACKUP
    echo -e "${GREEN}✓ Backed up to verification_key_merkle.json.UNSAFE_BACKUP${NC}"
else
    echo -e "${YELLOW}⚠ No existing verification key found${NC}"
fi

# Step 2: Remove old proving keys
echo -e "${YELLOW}[2/5] Removing old proving keys...${NC}"
REMOVED=0
if [ -f "src/features/zk/keys/identity_with_merkle_0000.zkey" ]; then
    rm src/features/zk/keys/identity_with_merkle_0000.zkey
    REMOVED=$((REMOVED + 1))
fi
if [ -f "src/features/zk/keys/identity_with_merkle_0001.zkey" ]; then
    rm src/features/zk/keys/identity_with_merkle_0001.zkey
    REMOVED=$((REMOVED + 1))
fi
if [ -f "src/features/zk/keys/identity_0000.zkey" ]; then
    rm src/features/zk/keys/identity_0000.zkey
    REMOVED=$((REMOVED + 1))
fi
if [ -f "src/features/zk/keys/identity_0001.zkey" ]; then
    rm src/features/zk/keys/identity_0001.zkey
    REMOVED=$((REMOVED + 1))
fi
if [ $REMOVED -gt 0 ]; then
    echo -e "${GREEN}✓ Removed $REMOVED old proving key(s)${NC}"
else
    echo -e "${YELLOW}⚠ No old proving keys found${NC}"
fi

# Step 3: Regenerate keys
echo -e "${YELLOW}[3/5] Regenerating verification and proving keys...${NC}"
echo -e "${BLUE}This may take 10-60 seconds depending on circuit size${NC}"
bun run zk:setup-all

# Step 4: Verify gamma ≠ delta
echo -e "${YELLOW}[4/5] Verifying key safety (gamma ≠ delta)...${NC}"
node -e "
const vk = require('./src/features/zk/keys/verification_key_merkle.json');
const gamma = JSON.stringify(vk.vk_gamma_2);
const delta = JSON.stringify(vk.vk_delta_2);
if (gamma === delta) {
  console.error('\x1b[31m❌ CRITICAL: vk_gamma_2 and vk_delta_2 are still identical!\x1b[0m');
  console.error('\x1b[31m   Key regeneration failed. Do not use these keys.\x1b[0m');
  process.exit(1);
} else {
  console.log('\x1b[32m✅ SUCCESS: vk_gamma_2 and vk_delta_2 are distinct\x1b[0m');
  console.log('\x1b[32m   Verification key is production-safe\x1b[0m');
}
"

# Step 5: Instructions
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✓ Keys Regenerated Successfully!                         ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}[5/5] Next Steps:${NC}"
echo ""
echo -e "${YELLOW}1. Commit the new verification key:${NC}"
echo "   git add src/features/zk/keys/verification_key_merkle.json"
echo "   git commit -m \"SECURITY: Regenerate verification_key_merkle.json with proper trusted setup\""
echo ""
echo -e "${YELLOW}2. Upload to CDN (client-side proving):${NC}"
echo "   sftp tcsenpai@discus.sh"
echo "   cd /home/tcsenpai/kynesys/caddycdn/files/zk-circuits/v1"
echo "   put src/features/zk/circuits/identity_with_merkle_js/identity_with_merkle.wasm"
echo "   put src/features/zk/keys/identity_with_merkle_0001.zkey identity_with_merkle_final.zkey"
echo "   put src/features/zk/keys/verification_key_merkle.json"
echo "   exit"
echo ""
echo -e "${YELLOW}3. Test verification:${NC}"
echo "   bun test src/features/zk/tests/"
echo ""
echo -e "${BLUE}See REGENERATE_ZK_KEYS_PRODUCTION.md for detailed documentation${NC}"
