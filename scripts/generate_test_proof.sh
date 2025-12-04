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

# REVIEW: HIGH FIX - Clarify this is intentional dummy data for basic tests
# NOTE: This generates invalid Merkle proof data (all zeros) for simple circuit testing
# For real proofs with valid Merkle paths, use actual tree data from RPC
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
# REVIEW: HIGH FIX - Hide secrets in output to prevent log leakage
echo "   Secret: (hidden for security)"
echo "   Provider ID: (hidden for security)"
echo "   Context: (hidden for security)"

# Check required files exist
echo "🔍 Checking required files..."
required_files=(
  "src/features/zk/circuits/identity_with_merkle_js/identity_with_merkle.wasm"
  "src/features/zk/keys/identity_with_merkle_0000.zkey"
  "src/features/zk/keys/verification_key_merkle.json"
)

for file in "${required_files[@]}"; do
  if [ ! -f "$file" ]; then
    echo "❌ Missing required file: $file" >&2
    echo "   Run 'bun run zk:setup-all' to generate keys first" >&2
    exit 1
  fi
done

# Verify bunx is available
if ! command -v bunx &> /dev/null; then
  echo "❌ bunx is not installed" >&2
  echo "   Install Bun first: https://bun.sh/" >&2
  exit 1
fi

echo "✅ All required files present"

# Generate witness
echo "🧮 Generating witness..."
bunx snarkjs wtns calculate \
  src/features/zk/circuits/identity_with_merkle_js/identity_with_merkle.wasm \
  test_input.json \
  test_witness.wtns

# Generate proof
echo "🔐 Generating proof..."
bunx snarkjs groth16 prove \
  src/features/zk/keys/identity_with_merkle_0000.zkey \
  test_witness.wtns \
  test_proof.json \
  test_public.json

echo "✅ Proof generated!"
echo "   Proof: test_proof.json"
echo "   Public signals: test_public.json"

# Verify it works
echo "🔍 Verifying proof..."
bunx snarkjs groth16 verify \
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
