#!/bin/bash
# Generate a valid ZK proof for testing

# Cleanup temporary files on exit (success or failure)
cleanup() {
  rm -f test_input.json test_witness.wtns test_proof.json test_public.json
}
trap cleanup EXIT

set -e

echo "🔧 Generating test proof for identity_with_merkle circuit..."

# Test inputs (you can change these if needed)
SECRET="12345678901234567890"
PROVIDER_ID="999888777666555444"
CONTEXT="1111111111"

# Create input JSON
cat > test_input.json <<EOF
{
  "secret": "$SECRET",
  "provider_id": "$PROVIDER_ID",
  "context": "$CONTEXT",
  "merkle_root": "0",
  "pathElements": [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0
  ],
  "pathIndices": [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0
  ]
}
EOF

echo "📝 Test inputs created"
echo "   Secret: $SECRET"
echo "   Provider ID: $PROVIDER_ID"
echo "   Context: $CONTEXT"

# Generate witness
echo "🧮 Generating witness..."
npx snarkjs wtns calculate \
  src/features/zk/circuits/identity_with_merkle_js/identity_with_merkle.wasm \
  test_input.json \
  test_witness.wtns

# Generate proof
echo "🔐 Generating proof..."
npx snarkjs groth16 prove \
  src/features/zk/keys/identity_with_merkle_0000.zkey \
  test_witness.wtns \
  test_proof.json \
  test_public.json

echo "✅ Proof generated!"
echo "   Proof: test_proof.json"
echo "   Public signals: test_public.json"

# Verify it works
echo "🔍 Verifying proof..."
npx snarkjs groth16 verify \
  src/features/zk/keys/verification_key_merkle.json \
  test_public.json \
  test_proof.json

echo ""
echo "✅ All done! Now run these commands to save the fixture:"
echo ""
echo "   mkdir -p src/tests/fixtures"
echo "   cat test_proof.json test_public.json | jq -s '{proof: .[0], publicSignals: .[1]}' > src/tests/fixtures/valid_proof_fixture.json"
echo ""
echo "Note: Temporary files will be cleaned up automatically on exit."
echo ""
