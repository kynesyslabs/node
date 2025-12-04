#!/bin/bash
#
# ZK Ceremony Contribution Automation Script
#
# This script automates the entire contribution process for illiterate users.
# Execute from the node repository root directory.
#
# Usage: ./scripts/ceremony_contribute.sh
#
# Requirements:
# - GitHub account with fork of zk_ceremony repo
# - GitHub CLI (gh) installed and authenticated
# - .demos_identity file exists (mnemonic-based)
# - bun installed
#

set -e  # Exit on any error

# =============================================================================
# Configuration
# =============================================================================

CEREMONY_REPO="kynesyslabs/zk_ceremony"
CEREMONY_DIR="zk_ceremony"
ORIGINAL_BRANCH=""
GITHUB_USERNAME=""
PUBKEY_FILE=""
PUBKEY_ADDRESS=""
CONTRIBUTION_BRANCH=""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# =============================================================================
# Helper Functions
# =============================================================================

log_info() {
    echo -e "${CYAN}ℹ ${NC}$1"
}

log_success() {
    echo -e "${GREEN}✓ ${NC}$1"
}

log_warn() {
    echo -e "${YELLOW}⚠ ${NC}$1"
}

log_error() {
    echo -e "${RED}✗ ${NC}$1"
}

log_step() {
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}▶ $1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

confirm() {
    read -p "$1 [y/N] " response
    case "$response" in
        [yY][eE][sS]|[yY])
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

cleanup_on_error() {
    log_error "An error occurred. Attempting to restore original state..."

    # Return to node repo root if we're in a subdirectory
    if [ -d "../$CEREMONY_DIR" ]; then
        cd ..
    fi

    # Try to go back to original branch
    if [ -n "$ORIGINAL_BRANCH" ]; then
        git checkout "$ORIGINAL_BRANCH" 2>/dev/null || true
    fi

    # Remove ceremony directory if it was created by this script
    if [ -d "$CEREMONY_DIR" ] && [ -f "$CEREMONY_DIR/.created_by_script" ]; then
        log_warn "Removing incomplete ceremony directory..."
        rm -rf "$CEREMONY_DIR"
    fi

    # Restore stashed changes if we stashed them
    if [ "$STASHED_CHANGES" = true ]; then
        log_info "Restoring stashed changes..."
        git stash pop 2>/dev/null || true
    fi

    log_info "Please check the error above and try again."
    exit 1
}

trap cleanup_on_error ERR

# =============================================================================
# Pre-flight Checks
# =============================================================================

log_step "STEP 1/9: Pre-flight Checks"

# Check we're in the node repository root
if [ ! -f "package.json" ] || ! grep -q "demos-node-software" package.json 2>/dev/null; then
    log_error "This script must be run from the demos node repository root!"
    log_info "Please cd to your node directory and try again."
    exit 1
fi

log_success "Running from node repository root"

# Save current branch
ORIGINAL_BRANCH=$(git branch --show-current)
log_info "Current branch: $ORIGINAL_BRANCH"

# Check for uncommitted changes - auto-stash them
STASHED_CHANGES=false
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
    log_info "Stashing uncommitted changes..."
    git stash push -m "ceremony-script-autostash-$(date +%s)"
    STASHED_CHANGES=true
    log_success "Changes stashed (will restore at end)"
fi

# Check GitHub CLI is installed and authenticated
if ! command -v gh &> /dev/null; then
    log_error "GitHub CLI (gh) is not installed!"
    log_info "Install it from: https://cli.github.com/"
    log_info "Then run: gh auth login"
    exit 1
fi

if ! gh auth status &> /dev/null; then
    log_error "GitHub CLI is not authenticated!"
    log_info "Run: gh auth login"
    exit 1
fi

log_success "GitHub CLI authenticated"

# Get GitHub username
GITHUB_USERNAME=$(gh api user -q .login)
if [ -z "$GITHUB_USERNAME" ]; then
    log_error "Could not determine GitHub username"
    exit 1
fi
log_success "GitHub username: $GITHUB_USERNAME"

# Check bun is installed
if ! command -v bun &> /dev/null; then
    log_error "Bun is not installed!"
    log_info "Install it from: https://bun.sh/"
    exit 1
fi

log_success "Bun is available"

# =============================================================================
# Identity Check
# =============================================================================

log_step "STEP 2/9: Identity Verification"

IDENTITY_FILE="${IDENTITY_FILE:-.demos_identity}"

if [ ! -f "$IDENTITY_FILE" ]; then
    log_error "Identity file not found: $IDENTITY_FILE"
    log_info "Run the node once to generate an identity, or create one manually."
    exit 1
fi

# Check if it's mnemonic-based (contains spaces)
if ! grep -q " " "$IDENTITY_FILE"; then
    log_error "Identity file appears to use old format (hex private key)."
    log_info "The ceremony requires the new mnemonic-based identity system."
    exit 1
fi

log_success "Identity file found and valid"

# =============================================================================
# Public Key File Check/Generation
# =============================================================================

log_step "STEP 3/9: Public Key File"

# Look for existing publickey_ed25519_* file
PUBKEY_FILE=$(ls publickey_ed25519_* 2>/dev/null | head -1 || true)

if [ -z "$PUBKEY_FILE" ]; then
    log_warn "No publickey_ed25519_* file found"
    log_info "Generating public key from identity..."

    # Generate pubkey using our show:pubkey script
    # First check if the script exists in current branch
    if [ -f "src/libs/utils/showPubkey.ts" ]; then
        PUBKEY_ADDRESS=$(bun run show:pubkey 2>/dev/null | grep "Public Key:" | awk '{print $3}')
    else
        # Script might only exist in testnet, try to get it
        log_info "showPubkey script not in current branch, checking testnet..."
        git show testnet:src/libs/utils/showPubkey.ts > /tmp/showPubkey_temp.ts 2>/dev/null || {
            log_error "Could not find showPubkey.ts script"
            log_info "Please ensure you have the latest testnet branch"
            exit 1
        }
        PUBKEY_ADDRESS=$(tsx -r tsconfig-paths/register /tmp/showPubkey_temp.ts 2>/dev/null | grep "Public Key:" | awk '{print $3}')
        rm -f /tmp/showPubkey_temp.ts
    fi

    if [ -z "$PUBKEY_ADDRESS" ]; then
        log_error "Failed to generate public key"
        exit 1
    fi

    # Create the pubkey file
    PUBKEY_FILE="publickey_ed25519_${PUBKEY_ADDRESS}"
    echo "$PUBKEY_ADDRESS" > "$PUBKEY_FILE"
    log_success "Created public key file: $PUBKEY_FILE"
else
    log_success "Found existing public key file: $PUBKEY_FILE"
    PUBKEY_ADDRESS=$(cat "$PUBKEY_FILE")
fi

# Extract address from filename for branch naming
if [[ "$PUBKEY_FILE" =~ publickey_ed25519_(0x[a-fA-F0-9]+) ]]; then
    PUBKEY_ADDRESS="${BASH_REMATCH[1]}"
fi

# Shorten address for branch name (first 8 + last 4 chars)
SHORT_ADDRESS="${PUBKEY_ADDRESS:0:10}...${PUBKEY_ADDRESS: -4}"
CONTRIBUTION_BRANCH="contrib-${PUBKEY_ADDRESS:0:16}"

log_info "Your address: $PUBKEY_ADDRESS"
log_info "Contribution branch will be: $CONTRIBUTION_BRANCH"

# =============================================================================
# Switch to zk_ids Branch
# =============================================================================

log_step "STEP 4/9: Switch to zk_ids Branch"

# Fetch latest
log_info "Fetching latest changes..."
git fetch origin

# Check if zk_ids branch exists
if ! git show-ref --verify --quiet refs/heads/zk_ids && ! git show-ref --verify --quiet refs/remotes/origin/zk_ids; then
    log_error "Branch zk_ids not found!"
    log_info "Please ensure the zk_ids branch exists in the repository"
    exit 1
fi

# Switch to zk_ids
git checkout zk_ids
git pull origin zk_ids

log_success "Switched to zk_ids branch"

# Install dependencies if needed
if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules" ]; then
    log_info "Installing dependencies..."
    bun install
fi

# =============================================================================
# Fork and Clone Ceremony Repository
# =============================================================================

log_step "STEP 5/9: Setup Ceremony Repository"

# Check if ceremony directory already exists
if [ -d "$CEREMONY_DIR" ]; then
    log_warn "Ceremony directory already exists"
    if ! confirm "Do you want to remove it and start fresh?"; then
        log_error "Cannot continue with existing ceremony directory"
        log_info "Remove it manually: rm -rf $CEREMONY_DIR"
        git checkout "$ORIGINAL_BRANCH"
        exit 1
    fi
    rm -rf "$CEREMONY_DIR"
fi

# Check if user has a fork, if not create one
log_info "Checking for fork of $CEREMONY_REPO..."
if ! gh repo view "$GITHUB_USERNAME/zk_ceremony" &> /dev/null; then
    log_info "Fork not found, creating fork..."
    gh repo fork "$CEREMONY_REPO" --clone=false
    sleep 2  # Wait for fork to be ready
    log_success "Fork created"
else
    log_success "Fork already exists"
fi

# Clone the main repo first to get latest state
log_info "Cloning ceremony repository..."
git clone "https://github.com/$CEREMONY_REPO.git" "$CEREMONY_DIR"

# Mark that this directory was created by the script (for cleanup)
touch "$CEREMONY_DIR/.created_by_script"

cd "$CEREMONY_DIR"

# Setup remotes
git remote rename origin upstream
git remote add origin "https://github.com/$GITHUB_USERNAME/zk_ceremony.git"

log_success "Ceremony repository cloned and configured"
log_info "Remotes configured:"
git remote -v

# =============================================================================
# Create Contribution Branch
# =============================================================================

log_step "STEP 6/9: Create Contribution Branch"

# Ensure we're on main and up to date
git checkout main
git pull upstream main

# Check if user already contributed
if [ -f "ceremony_state.json" ]; then
    if grep -q "$PUBKEY_ADDRESS" ceremony_state.json; then
        log_error "You have already contributed to this ceremony!"
        log_info "Each address can only contribute once (security requirement)"
        cd ..
        rm -rf "$CEREMONY_DIR"
        git checkout "$ORIGINAL_BRANCH"
        exit 1
    fi
fi

# Create contribution branch
git checkout -b "$CONTRIBUTION_BRANCH"
log_success "Created branch: $CONTRIBUTION_BRANCH"

cd ..

# =============================================================================
# Run Ceremony Contribution
# =============================================================================

log_step "STEP 7/9: Execute Ceremony Contribution"

log_info "Running ceremony contribution..."
log_warn "This will generate cryptographic randomness - DO NOT INTERRUPT!"
echo ""

# Run the ceremony script
bun run zk:ceremony contribute

log_success "Contribution completed!"

# Find the attestation file
cd "$CEREMONY_DIR"
ATTESTATION_FILE=$(ls attestations/*_${PUBKEY_ADDRESS}*.txt 2>/dev/null | head -1 || true)

if [ -z "$ATTESTATION_FILE" ]; then
    # Try with shorter address match
    ATTESTATION_FILE=$(ls attestations/*.txt 2>/dev/null | tail -1 || true)
fi

if [ -n "$ATTESTATION_FILE" ]; then
    log_info "Attestation file created: $ATTESTATION_FILE"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    cat "$ATTESTATION_FILE"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    ATTESTATION_HASH=$(grep "Attestation Hash:" "$ATTESTATION_FILE" | awk '{print $3}' || echo "")
fi

# =============================================================================
# Commit, Push, and Create PR
# =============================================================================

log_step "STEP 8/9: Commit, Push, and Create Pull Request"

# Stage all changes
git add .

# Show what will be committed
log_info "Changes to be committed:"
git status --short

# Commit
git commit -m "contrib: contribution from $PUBKEY_ADDRESS"
log_success "Changes committed"

# Push to fork
log_info "Pushing to your fork..."
git push -u origin "$CONTRIBUTION_BRANCH"
log_success "Pushed to origin/$CONTRIBUTION_BRANCH"

# Create PR
log_info "Creating pull request..."

PR_BODY="## Contribution from \`$PUBKEY_ADDRESS\`

### Attestation
\`\`\`
$(cat "$ATTESTATION_FILE" 2>/dev/null || echo "See attestations/ directory")
\`\`\`

### Verification
- Contributor address: \`$PUBKEY_ADDRESS\`
- Branch: \`$CONTRIBUTION_BRANCH\`
- Attestation hash: \`$ATTESTATION_HASH\`

---
*Automated contribution via ceremony_contribute.sh*"

PR_URL=$(gh pr create \
    --repo "$CEREMONY_REPO" \
    --base main \
    --head "$GITHUB_USERNAME:$CONTRIBUTION_BRANCH" \
    --title "Contribution from $SHORT_ADDRESS" \
    --body "$PR_BODY" \
    2>&1) || {
    log_warn "Could not create PR automatically"
    log_info "Please create the PR manually at:"
    log_info "https://github.com/$CEREMONY_REPO/compare/main...$GITHUB_USERNAME:$CONTRIBUTION_BRANCH"
    PR_URL="manual"
}

if [ "$PR_URL" != "manual" ]; then
    log_success "Pull request created!"
    log_info "PR URL: $PR_URL"
fi

cd ..

# =============================================================================
# Cleanup and Return to Original Branch
# =============================================================================

log_step "STEP 9/9: Cleanup and Restore"

# Clean up ceremony directory (security requirement)
log_info "Cleaning up ceremony directory (security requirement)..."
rm -rf "$CEREMONY_DIR"
log_success "Ceremony directory deleted"

# Return to original branch
log_info "Returning to original branch: $ORIGINAL_BRANCH"
git checkout "$ORIGINAL_BRANCH"

# Restore stashed changes if we stashed them
if [ "$STASHED_CHANGES" = true ]; then
    log_info "Restoring stashed changes..."
    git stash pop
    log_success "Stashed changes restored"
fi

# =============================================================================
# Final Summary
# =============================================================================

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}                    CONTRIBUTION COMPLETE!                    ${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${CYAN}Your Address:${NC}      $PUBKEY_ADDRESS"
echo -e "  ${CYAN}PR Status:${NC}         ${PR_URL:-Pending manual creation}"
echo -e "  ${CYAN}Current Branch:${NC}    $(git branch --show-current)"
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo "  1. Wait for the maintainer to review and merge your PR"
echo "  2. Once merged, your contribution is part of the ceremony!"
echo ""
echo -e "${GREEN}Thank you for contributing to the Demos Network security!${NC}"
echo ""
