#!/bin/bash

# Solana Tank - Build and Deploy Script
# Usage: ./build_and_deploy.sh [--prod] [--skip-build] [--airdrop]

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
CLUSTER="devnet"
CLUSTER_URL="https://api.devnet.solana.com"
SKIP_BUILD=false
REQUEST_AIRDROP=false
PROGRAM_NAME="solana_tank"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --prod)
            CLUSTER="mainnet-beta"
            CLUSTER_URL="https://api.mainnet-beta.solana.com"
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --airdrop)
            REQUEST_AIRDROP=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --prod         Deploy to mainnet-beta (default: devnet)"
            echo "  --skip-build   Skip the build step"
            echo "  --airdrop      Request SOL airdrop (devnet only)"
            echo "  -h, --help     Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                    # Build and deploy to devnet"
            echo "  $0 --prod            # Build and deploy to mainnet"
            echo "  $0 --airdrop         # Build, airdrop SOL, and deploy to devnet"
            echo "  $0 --skip-build      # Deploy without building (use existing build)"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            echo "Use -h or --help for usage information"
            exit 1
            ;;
    esac
done

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Pre-flight checks
print_status "Running pre-flight checks..."

# Check if required tools are installed
if ! command_exists anchor; then
    print_error "Anchor CLI is not installed. Please install it first:"
    print_error "cargo install --git https://github.com/coral-xyz/anchor anchor-cli --locked"
    exit 1
fi

if ! command_exists solana; then
    print_error "Solana CLI is not installed. Please install it first:"
    print_error "https://docs.solana.com/cli/install-solana-cli-tools"
    exit 1
fi

# Check if we're in the correct directory
if [[ ! -f "Anchor.toml" ]]; then
    print_error "Anchor.toml not found. Please run this script from the project root directory."
    exit 1
fi

print_success "Pre-flight checks passed"

# Show deployment configuration
echo ""
print_status "=== DEPLOYMENT CONFIGURATION ==="
print_status "Cluster: ${CLUSTER}"
print_status "URL: ${CLUSTER_URL}"
print_status "Skip build: ${SKIP_BUILD}"
print_status "Request airdrop: ${REQUEST_AIRDROP}"
echo ""

# Confirmation for production deployment
if [[ "$CLUSTER" == "mainnet-beta" ]]; then
    print_warning "🚨 YOU ARE ABOUT TO DEPLOY TO MAINNET-BETA! 🚨"
    print_warning "This will cost real SOL and cannot be undone."
    read -p "Are you sure you want to continue? (type 'YES' to confirm): " -r
    if [[ ! $REPLY == "YES" ]]; then
        print_status "Deployment cancelled."
        exit 0
    fi
fi

# Configure Solana CLI
print_status "Configuring Solana CLI for ${CLUSTER}..."
solana config set --url "$CLUSTER_URL"

# Check wallet balance
print_status "Checking wallet balance..."
BALANCE=$(solana balance --lamports)
BALANCE_SOL=$(echo "scale=9; $BALANCE / 1000000000" | bc -l)
print_status "Current balance: ${BALANCE_SOL} SOL"

# Minimum balance check (deployment typically costs ~0.01-0.1 SOL)
MIN_BALANCE_LAMPORTS=10000000  # 0.01 SOL in lamports
if [[ "$BALANCE" -lt "$MIN_BALANCE_LAMPORTS" ]]; then
    if [[ "$CLUSTER" == "devnet" ]]; then
        print_warning "Low balance detected. You may need more SOL for deployment."
        if [[ "$REQUEST_AIRDROP" == "true" ]]; then
            print_status "Requesting airdrop..."
            solana airdrop 2
            print_success "Airdrop completed"
        else
            print_warning "Consider using --airdrop flag or manually run: solana airdrop 2"
        fi
    else
        print_error "Insufficient balance for mainnet deployment. Please fund your wallet."
        exit 1
    fi
fi

# Build the program
if [[ "$SKIP_BUILD" == "false" ]]; then
    print_status "Building Anchor program..."
    anchor build
    print_success "Build completed"
else
    print_status "Skipping build step"
fi

# Get and verify program ID
print_status "Checking program ID..."
if [[ ! -f "target/deploy/${PROGRAM_NAME}-keypair.json" ]]; then
    print_error "Program keypair not found. Please ensure the build was successful."
    exit 1
fi

PROGRAM_ID=$(solana address -k "target/deploy/${PROGRAM_NAME}-keypair.json")
print_status "Program ID: ${PROGRAM_ID}"

# Verify program ID matches Anchor.toml
ANCHOR_PROGRAM_ID=$(grep -A 1 "\[programs\.${CLUSTER}\]" Anchor.toml | grep "${PROGRAM_NAME}" | cut -d'"' -f2)
if [[ "$PROGRAM_ID" != "$ANCHOR_PROGRAM_ID" ]]; then
    print_warning "Program ID mismatch!"
    print_warning "Keypair: ${PROGRAM_ID}"
    print_warning "Anchor.toml: ${ANCHOR_PROGRAM_ID}"
    print_warning "You may need to update Anchor.toml or generate new keys with: anchor keys sync"
fi

# Deploy the program
print_status "Deploying program to ${CLUSTER}..."
DEPLOY_OUTPUT=$(anchor deploy --provider.cluster "$CLUSTER" 2>&1)
DEPLOY_EXIT_CODE=$?

if [[ $DEPLOY_EXIT_CODE -eq 0 ]]; then
    # Extract transaction signature from deploy output
    SIGNATURE=$(echo "$DEPLOY_OUTPUT" | grep "Signature:" | awk '{print $2}')
    
    print_success "🎉 Deployment successful!"
    echo ""
    print_status "=== DEPLOYMENT SUMMARY ==="
    print_status "Program Name: ${PROGRAM_NAME}"
    print_status "Program ID: ${PROGRAM_ID}"
    print_status "Network: ${CLUSTER}"
    print_status "Transaction: ${SIGNATURE}"
    
    if [[ "$CLUSTER" == "devnet" ]]; then
        print_status "Explorer: https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet"
    else
        print_status "Explorer: https://explorer.solana.com/address/${PROGRAM_ID}"
    fi
    
    echo ""
    print_status "=== NEXT STEPS ==="
    print_status "1. Verify deployment on Solana Explorer"
    print_status "2. Run tests: anchor test --provider.cluster ${CLUSTER}"
    print_status "3. Initialize IDL: anchor idl init --provider.cluster ${CLUSTER} ${PROGRAM_ID}"
    
else
    print_error "Deployment failed!"
    echo "$DEPLOY_OUTPUT"
    exit 1
fi

# Final balance check
print_status "Final wallet balance:"
FINAL_BALANCE=$(solana balance --lamports)
FINAL_BALANCE_SOL=$(echo "scale=9; $FINAL_BALANCE / 1000000000" | bc -l)
COST_LAMPORTS=$((BALANCE - FINAL_BALANCE))
COST_SOL=$(echo "scale=9; $COST_LAMPORTS / 1000000000" | bc -l)

print_status "Balance: ${FINAL_BALANCE_SOL} SOL"
print_status "Deployment cost: ${COST_SOL} SOL"

print_success "All operations completed successfully! 🚀"