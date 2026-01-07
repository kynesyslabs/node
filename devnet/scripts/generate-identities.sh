#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVNET_DIR="$(dirname "$SCRIPT_DIR")"
IDENTITIES_DIR="$DEVNET_DIR/identities"
NODE_DIR="$(dirname "$DEVNET_DIR")"

mkdir -p "$IDENTITIES_DIR"

echo "🔑 Generating devnet identities..."

# Generate 4 identities using bun
for i in 1 2 3 4; do
    echo "  Generating node$i identity..."

    # Use bun to generate mnemonic and derive pubkey
    # Run from NODE_DIR to have access to node_modules
    cd "$NODE_DIR"
    bun "$SCRIPT_DIR/generate-identity-helper.ts" > /tmp/identity_$i.txt

    # Extract mnemonic and pubkey
    MNEMONIC=$(grep "^MNEMONIC:" /tmp/identity_$i.txt | cut -d: -f2-)
    PUBKEY=$(grep "^PUBKEY:" /tmp/identity_$i.txt | cut -d: -f2-)

    # Save identity (mnemonic)
    echo "$MNEMONIC" > "$IDENTITIES_DIR/node$i.identity"

    # Save pubkey
    echo "$PUBKEY" > "$IDENTITIES_DIR/node$i.pubkey"

    echo "    ✓ node$i: $PUBKEY"
done

rm -f /tmp/identity_*.txt

echo ""
echo "✅ Generated 4 identities in $IDENTITIES_DIR"
echo ""
echo "Next: Run ./scripts/generate-peerlist.sh to create demos_peerlist.json"
