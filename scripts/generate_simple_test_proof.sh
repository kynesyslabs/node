#!/bin/bash
# Generate a valid ZK proof using the simpler identity circuit (no Merkle proof)

# Cleanup temporary files on exit
cleanup() {
  rm -f test_input_simple.json test_witness_simple.wtns test_proof_simple.json test_public_simple.json
}
trap cleanup EXIT

set -e

echo "🔧 Generating test proof for identity circuit (Phase 3 - no Merkle)..."

# Test inputs
SECRET="12345678901234567890"
PROVIDER_ID="999888777666555444"
CONTEXT="1111111111"

# Create input JSON (simpler - no Merkle proof needed)
cat > test_input_simple.json <<EOF
{
  "secret": "$SECRET",
  "provider_id": "$PROVIDER_ID",
  "context": "$CONTEXT"
}
EOF

echo "📝 Test inputs created"
echo "   Secret: $SECRET"
echo "   Provider ID: $PROVIDER_ID"
echo "   Context: $CONTEXT"

# Generate witness
echo "🧮 Generating witness..."
npx snarkjs wtns calculate \
  src/features/zk/circuits/identity_js/identity.wasm \
  test_input_simple.json \
  test_witness_simple.wtns

# Generate proof
echo "🔐 Generating proof..."
npx snarkjs groth16 prove \
  src/features/zk/keys/identity_0000.zkey \
  test_witness_simple.wtns \
  test_proof_simple.json \
  test_public_simple.json

echo "✅ Proof generated!"
echo "   Proof: test_proof_simple.json"
echo "   Public signals: test_public_simple.json"

# Verify it works
echo "🔍 Verifying proof..."
npx snarkjs groth16 verify \
  src/features/zk/keys/verification_key.json \
  test_public_simple.json \
  test_proof_simple.json

echo ""
echo "✅ All done! Now run these commands to save the fixture:"
echo ""
echo "   mkdir -p src/tests/fixtures"
echo "   cat test_proof_simple.json test_public_simple.json | jq -s '{proof: .[0], publicSignals: .[1]}' > src/tests/fixtures/valid_proof_fixture.json"
echo ""
echo "Note: Temporary files will be cleaned up automatically on exit."
echo ""
