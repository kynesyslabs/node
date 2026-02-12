#!/bin/bash
# Setup script for all L2PS batch circuits
# Generates zkeys for batch sizes: 5, 10 (max 10 tx per batch)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ZK_DIR="$(dirname "$SCRIPT_DIR")"
CIRCUITS_DIR="$ZK_DIR/circuits"
KEYS_DIR="$ZK_DIR/keys"
PTAU_DIR="$ZK_DIR/ptau"
NODE_DIR="$(cd "$ZK_DIR/../../../../" && pwd)"
CIRCOMLIB="$NODE_DIR/node_modules/circomlib/circuits"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== L2PS Batch Circuits Setup ===${NC}"
echo -e "${YELLOW}Max batch size: 10 transactions${NC}"

# Create directories
mkdir -p "$KEYS_DIR/batch_5" "$KEYS_DIR/batch_10"
mkdir -p "$PTAU_DIR"

# Download required ptau files
download_ptau() {
    local size=$1
    local file="powersOfTau28_hez_final_${size}.ptau"
    local url="https://storage.googleapis.com/zkevm/ptau/$file"
    
    if [[ ! -f "$PTAU_DIR/$file" ]] || [[ $(stat -c%s "$PTAU_DIR/$file") -lt 1000000 ]]; then
        echo -e "${YELLOW}Downloading pot${size}...${NC}"
        rm -f "$PTAU_DIR/$file"
        curl -L -o "$PTAU_DIR/$file" "$url"
    else
        echo "pot${size} already exists"
    fi
    return 0
}

# Download ptau files (16=64MB, 17=128MB)
# Note: pot18 (256MB) removed due to WSL/system stability issues
download_ptau 16
download_ptau 17

# Setup a single batch circuit
setup_batch() {
    local size=$1
    local pot=$2
    local circuit="l2ps_batch_${size}"
    local output_dir="$KEYS_DIR/batch_${size}"
    
    echo ""
    echo -e "${GREEN}=== Setting up batch_${size} (pot${pot}) ===${NC}"
    
    # Compile circuit
    echo "Compiling ${circuit}.circom..."
    circom "$CIRCUITS_DIR/${circuit}.circom" \
        --r1cs --wasm --sym \
        -o "$output_dir" \
        -l "$CIRCOMLIB"
    
    # Get constraint count
    npx snarkjs r1cs info "$output_dir/${circuit}.r1cs"
    
    # Generate zkey (PLONK)
    echo "Generating PLONK zkey..."
    npx snarkjs plonk setup \
        "$output_dir/${circuit}.r1cs" \
        "$PTAU_DIR/powersOfTau28_hez_final_${pot}.ptau" \
        "$output_dir/${circuit}.zkey"
    
    # Export verification key
    echo "Exporting verification key..."
    npx snarkjs zkey export verificationkey \
        "$output_dir/${circuit}.zkey" \
        "$output_dir/verification_key.json"
    
    echo -e "${GREEN}✓ batch_${size} setup complete${NC}"
    return 0
}

# Setup all batch sizes
echo ""
echo "Starting circuit compilation and key generation..."
echo "This may take a few minutes..."

setup_batch 5 16   # ~37K constraints, 64MB ptau (2^16 = 65K)
setup_batch 10 17  # ~74K constraints, 128MB ptau (2^17 = 131K)
# batch_20 removed - pot18 (256MB) causes stability issues

echo ""
echo -e "${GREEN}=== All circuits set up successfully! ===${NC}"
echo ""
echo "Generated keys:"
ls -lh "$KEYS_DIR"/batch_*/*.zkey 2>/dev/null || echo "Check $KEYS_DIR for output"
