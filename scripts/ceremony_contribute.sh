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

# The upstream ceremony repository where contributions are submitted
CEREMONY_REPO="kynesyslabs/zk_ceremony"
# Local directory name for cloning the ceremony repo
CEREMONY_DIR="zk_ceremony"
# Track the user's original branch to restore at the end
ORIGINAL_BRANCH=""
# GitHub username (fetched via gh CLI)
GITHUB_USERNAME=""
# Path to the user's public key file
PUBKEY_FILE=""
# The user's public key address (0x...)
PUBKEY_ADDRESS=""
# Branch name for this contribution (based on address)
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

# Run apt command with docker conflict auto-fix
run_apt() {
    local apt_output
    local apt_exit_code

    apt_output=$(sudo apt "$@" 2>&1)
    apt_exit_code=$?

    if [ $apt_exit_code -ne 0 ]; then
        # Check for docker Signed-By conflict
        if echo "$apt_output" | grep -q "Conflicting values set for option Signed-By"; then
            log_warn "Docker apt source conflict detected, fixing..."
            sudo rm -f /etc/apt/sources.list.d/docker.sources 2>/dev/null || true
            sudo rm -f /etc/apt/sources.list.d/docker.list 2>/dev/null || true
            sudo apt update
            # Retry the original command
            sudo apt "$@"
            return $?
        else
            echo "$apt_output"
            return $apt_exit_code
        fi
    else
        echo "$apt_output"
        return 0
    fi
}

# Run bun install with permission error auto-fix
run_bun_install() {
    local bun_output
    local bun_exit_code

    bun_output=$(bun install 2>&1)
    bun_exit_code=$?

    if [ $bun_exit_code -ne 0 ]; then
        # Check for permission/authorization errors
        if echo "$bun_output" | grep -qiE "permission|EACCES|authorization|denied"; then
            log_warn "Permission error detected, cleaning node_modules and retrying..."
            sudo rm -rf node_modules
            bun install
            return $?
        else
            echo "$bun_output"
            return $bun_exit_code
        fi
    else
        echo "$bun_output"
        return 0
    fi
}

# Error handler: restores git state and cleans up on script failure
# This is registered with 'trap' to run automatically on any error (set -e)
cleanup_on_error() {
    log_error "An error occurred. Attempting to restore original state..."

    # Return to node repo root if we're in the ceremony subdirectory
    if [ -d "../$CEREMONY_DIR" ]; then
        cd ..
    fi

    # Try to go back to original branch
    if [ -n "$ORIGINAL_BRANCH" ]; then
        git checkout "$ORIGINAL_BRANCH" 2>/dev/null || true
    fi

    # Remove ceremony directory if it was created by this script
    # The .created_by_script marker file prevents deleting user's existing directories
    if [ -d "$CEREMONY_DIR" ] && [ -f "$CEREMONY_DIR/.created_by_script" ]; then
        log_warn "Removing incomplete ceremony directory..."
        rm -rf "$CEREMONY_DIR"
    fi

    # Restore stashed changes if we stashed them at script start
    if [ "$STASHED_CHANGES" = true ]; then
        log_info "Restoring stashed changes..."
        git stash pop 2>/dev/null || true
    fi

    log_info "Please check the error above and try again."
    exit 1
}

# Register cleanup_on_error to run on any command failure (due to set -e)
trap cleanup_on_error ERR

# =============================================================================
# Pre-flight Checks
# =============================================================================

log_step "STEP 1/9: Pre-flight Checks"

# Get sudo authorization upfront so we don't have to ask later
log_info "Requesting sudo authorization (may be needed later)..."
sudo -v || {
    log_error "sudo authorization failed or was denied"
    log_info "Some operations may require sudo. Please ensure you have sudo access."
    exit 1
}
log_success "sudo authorization obtained"

# Run apt update early to catch docker conflict and other issues upfront
log_info "Updating apt cache..."
run_apt update >/dev/null 2>&1 || true
log_success "apt cache updated"

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
    log_info ""
    log_info "Installing GitHub CLI for Debian/Ubuntu..."
    log_info ""

    if confirm "Do you want to install GitHub CLI now?"; then
        log_info "Adding GitHub CLI repository..."

        # Install prerequisites (wget needed to fetch GitHub CLI GPG key)
        if ! type -p wget >/dev/null; then
            run_apt update && run_apt install wget -y
        fi
        sudo mkdir -p -m 755 /etc/apt/keyrings
        # Download GitHub CLI GPG key to temp file, then install it
        out=$(mktemp)
        wget -nv -O"$out" https://cli.github.com/packages/githubcli-archive-keyring.gpg
        cat "$out" | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
        rm -f "$out"  # Clean up temp file
        sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
        run_apt update
        run_apt install gh -y

        if ! command -v gh &> /dev/null; then
            log_error "GitHub CLI installation failed!"
            log_info "Please install manually from: https://cli.github.com/"
            exit 1
        fi

        log_success "GitHub CLI installed successfully!"
        log_info ""
        log_info "Now you need to authenticate with GitHub."
        log_info "Running: gh auth login"
        log_info ""

        gh auth login

        if ! gh auth status &> /dev/null; then
            log_error "GitHub authentication failed or was cancelled."
            log_info "Please run 'gh auth login' manually and try again."
            exit 1
        fi

        log_success "GitHub CLI authenticated!"

        # Configure git user for commits
        log_info "Configuring git user..."
        git config --global user.email "demos@node.id"
        git config --global user.name "demos"
        log_success "Git user configured"
    else
        log_info ""
        log_info "To install GitHub CLI manually on Debian/Ubuntu, run:"
        log_info ""
        echo -e "${CYAN}(type -p wget >/dev/null || (sudo apt update && sudo apt-get install wget -y)) && \\
sudo mkdir -p -m 755 /etc/apt/keyrings && \\
out=\$(mktemp) && wget -nv -O\$out https://cli.github.com/packages/githubcli-archive-keyring.gpg && \\
cat \$out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null && \\
sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \\
echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \\
sudo apt update && \\
sudo apt install gh -y${NC}"
        log_info ""
        log_info "Then run: gh auth login"
        log_info "And re-run this script."
        exit 1
    fi
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

# Check npx is installed (needed for snarkjs commands)
if ! command -v npx &> /dev/null; then
    log_warn "npx is not installed!"
    log_info "npx is required for ZK ceremony operations (snarkjs)."
    log_info ""

    # Try mise first if available
    if command -v mise &> /dev/null; then
        log_info "Found mise, attempting to install Node 20..."
        mise use -g node@20

        # Refresh PATH to pick up mise-installed node/npx
        hash -r 2>/dev/null || true
        eval "$(mise env)" 2>/dev/null || true

        if command -v npx &> /dev/null; then
            log_success "Node 20 (with npx) installed via mise!"
        else
            log_warn "mise installation didn't provide npx, falling back to apt..."
        fi
    fi

    # Fall back to apt if npx still not available
    if ! command -v npx &> /dev/null; then
        if confirm "Do you want to install npm (which includes npx) via apt now?"; then
            log_info "Installing npm..."
            run_apt update && run_apt install npm -y

            # Refresh PATH to pick up newly installed npm/npx
            hash -r 2>/dev/null || true
            export PATH="/usr/bin:$PATH"

            if ! command -v npx &> /dev/null; then
                log_error "npm installation failed!"
                log_info "Please install manually: sudo apt install npm"
                log_info "Then re-run this script."
                exit 1
            fi

            log_success "npm (with npx) installed successfully!"
        else
            log_info ""
            log_info "To install npm manually, run:"
            log_info "  sudo apt install npm"
            log_info ""
            log_info "Then re-run this script."
            exit 1
        fi
    fi
fi

log_success "npx is available"

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

# Look for existing publickey file (try ed25519 format first, then legacy format)
# We check ed25519 first as it's the newer format, then fall back to legacy publickey_0x* format
PUBKEY_FILE=$(ls publickey_ed25519_* 2>/dev/null | head -1 || true)
if [ -z "$PUBKEY_FILE" ]; then
    # Use grep to exclude ed25519 files from legacy match (publickey_* would also match publickey_ed25519_*)
    PUBKEY_FILE=$(ls publickey_* 2>/dev/null | grep -v "ed25519" | head -1 || true)
fi

if [ -z "$PUBKEY_FILE" ]; then
    log_warn "No publickey_* or publickey_ed25519_* file found"
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

# Extract address from filename for branch naming (support both formats)
if [[ "$PUBKEY_FILE" =~ publickey_ed25519_(0x[a-fA-F0-9]+) ]]; then
    PUBKEY_ADDRESS="${BASH_REMATCH[1]}"
elif [[ "$PUBKEY_FILE" =~ publickey_(0x[a-fA-F0-9]+) ]]; then
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
# The zk_ids branch contains the ceremony contribution scripts and ZK setup.
# We need to be on this branch to run the contribution process.

log_step "STEP 4/9: Switch to zk_ids Branch"

# Fetch latest from remote to ensure we have all branches
log_info "Fetching latest changes..."
git fetch origin

# Check if zk_ids branch exists (locally or on remote)
if ! git show-ref --verify --quiet refs/heads/zk_ids && ! git show-ref --verify --quiet refs/remotes/origin/zk_ids; then
    log_error "Branch zk_ids not found!"
    log_info "Please ensure the zk_ids branch exists in the repository"
    exit 1
fi

# Switch to zk_ids and pull latest changes
git checkout zk_ids
git pull origin zk_ids

log_success "Switched to zk_ids branch"

# Install dependencies if needed (node_modules missing or package.json updated)
if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules" ]; then
    log_info "Installing dependencies..."
    run_bun_install
    log_success "Dependencies installed"
fi

# =============================================================================
# Fork and Clone Ceremony Repository
# =============================================================================
# We clone the main ceremony repo, then set up the user's fork as origin.
# This allows us to push contributions to their fork and create PRs to upstream.

log_step "STEP 5/9: Setup Ceremony Repository"

# Check if ceremony directory already exists (from a previous failed run)
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
# Each contributor gets a unique branch based on their address.
# We also check if they've already contributed (one contribution per address).

log_step "STEP 6/9: Create Contribution Branch"

# Ensure we're on main and up to date with upstream
git checkout main
git pull upstream main

# Security check: verify user hasn't already contributed to this ceremony
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
# This is the core step: running the ZK ceremony contribution script.
# It generates cryptographic randomness and adds it to the ceremony.
# CRITICAL: Interrupting this process could corrupt the contribution.

log_step "STEP 7/9: Execute Ceremony Contribution"

log_info "Running ceremony contribution..."
log_warn "This will generate cryptographic randomness - DO NOT INTERRUPT!"
echo ""

# Run the ceremony script using Node 20+ (required for tsx)
# We try multiple Node version managers in order of preference: mise > nvm > system

log_info "Ensuring Node 20 is available..."
NODE_READY=false

# First, try mise if available (modern, fast, no sudo needed)
if command -v mise &> /dev/null; then
    log_info "Trying mise for Node 20..."
    mise use -g node@20 2>/dev/null || true
    eval "$(mise env)" 2>/dev/null || true

    if command -v node &> /dev/null; then
        NODE_MAJOR=$(node --version | cut -d'.' -f1 | tr -d 'v')
        if [ "$NODE_MAJOR" -ge 20 ]; then
            NODE_READY=true
            log_success "Node 20 available via mise"
        fi
    fi
fi

# Fall back to nvm if mise didn't work
if [ "$NODE_READY" = false ]; then
    # Install nvm if not available
    if [ ! -s "$HOME/.nvm/nvm.sh" ]; then
        log_info "nvm not found, installing..."
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

        # Load nvm into current shell
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

        log_success "nvm installed"
    fi

    # Load nvm and use Node 20
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

    # Install and use Node 20 via nvm
    log_info "Using nvm for Node 20..."
    nvm install 20 2>/dev/null || true
    nvm use 20 2>/dev/null || nvm use node

    if command -v node &> /dev/null; then
        NODE_MAJOR=$(node --version | cut -d'.' -f1 | tr -d 'v')
        if [ "$NODE_MAJOR" -ge 20 ]; then
            NODE_READY=true
            log_success "Node 20 available via nvm"
        fi
    fi
fi

# Final verification - fail if we still don't have Node 20+
if [ "$NODE_READY" = false ]; then
    NODE_MAJOR=$(node --version 2>/dev/null | cut -d'.' -f1 | tr -d 'v' || echo "0")
    if [ "$NODE_MAJOR" -lt 20 ]; then
        log_error "Node.js 20+ is required for the ceremony script"
        log_info "Current version: $(node --version 2>/dev/null || echo 'not installed')"
        log_info ""
        log_info "Please manually install Node 20+:"
        log_info "  mise use -g node@20  (recommended)"
        log_info "  OR: nvm install 20 && nvm use 20"
        log_info ""
        log_info "Then re-run this script."
        exit 1
    fi
fi

log_info "Using Node $(node --version)"
# Use project's local tsx to avoid version mismatches with npx
./node_modules/.bin/tsx src/features/zk/scripts/ceremony.ts contribute

log_success "Contribution completed!"

# Find the attestation file (proof of contribution)
# The ceremony script creates an attestation file with cryptographic proof
cd "$CEREMONY_DIR"
ATTESTATION_FILE=$(ls attestations/*_${PUBKEY_ADDRESS}*.txt 2>/dev/null | head -1 || true)

if [ -z "$ATTESTATION_FILE" ]; then
    # Fallback: try to find any recent attestation file if exact match not found
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
# Push the contribution to the user's fork and create a PR to the main repo.
# The PR will be reviewed by ceremony maintainers before merging.

log_step "STEP 8/9: Commit, Push, and Create Pull Request"

# Stage all ceremony changes (new contribution files)
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
# Security requirement: delete the local ceremony directory after contribution.
# The contribution has been pushed to GitHub; local copies should not persist.

log_step "STEP 9/9: Cleanup and Restore"

# Clean up ceremony directory (security: remove local copy of ceremony state)
log_info "Cleaning up ceremony directory (security requirement)..."
rm -rf "$CEREMONY_DIR"
log_success "Ceremony directory deleted"

# Return to original branch
log_info "Returning to original branch: $ORIGINAL_BRANCH"
git checkout "$ORIGINAL_BRANCH"

# If we're on testnet, pull latest changes
if [ "$ORIGINAL_BRANCH" = "testnet" ]; then
    log_info "Pulling latest testnet changes..."
    git pull origin testnet
    log_success "testnet is up to date"
fi

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
