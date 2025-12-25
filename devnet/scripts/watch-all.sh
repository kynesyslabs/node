#!/bin/bash
# Open a tmux session with 4 panes showing logs from all nodes
# Usage: ./scripts/watch-all.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVNET_DIR="$(dirname "$SCRIPT_DIR")"
cd "$DEVNET_DIR"

SESSION_NAME="demos-devnet"

# Check if tmux is available
if ! command -v tmux &> /dev/null; then
    echo "❌ tmux is not installed. Install it with:"
    echo "   brew install tmux    # macOS"
    echo "   apt install tmux     # Ubuntu/Debian"
    echo ""
    echo "Alternatively, use ./scripts/logs.sh to view combined logs."
    exit 1
fi

# Check if devnet is running
if ! docker compose ps --quiet 2>/dev/null | head -1 > /dev/null; then
    echo "❌ Devnet doesn't appear to be running."
    echo "   Start it with: docker compose up --build -d"
    exit 1
fi

# Kill existing session if it exists
tmux kill-session -t "$SESSION_NAME" 2>/dev/null

echo "🖥️  Opening tmux session with 4-node view..."
echo "   Press Ctrl+B then D to detach"
echo "   Run 'tmux attach -t $SESSION_NAME' to reattach"
echo ""

# Create new session with first pane (node-1)
tmux new-session -d -s "$SESSION_NAME" -n "devnet" \
    "docker compose logs -f --tail=50 node-1; read"

# Split horizontally for node-2
tmux split-window -h -t "$SESSION_NAME:devnet" \
    "docker compose logs -f --tail=50 node-2; read"

# Split first pane vertically for node-3
tmux select-pane -t "$SESSION_NAME:devnet.0"
tmux split-window -v -t "$SESSION_NAME:devnet" \
    "docker compose logs -f --tail=50 node-3; read"

# Split second pane vertically for node-4
tmux select-pane -t "$SESSION_NAME:devnet.1"
tmux split-window -v -t "$SESSION_NAME:devnet" \
    "docker compose logs -f --tail=50 node-4; read"

# Set layout to tiled (equal size panes)
tmux select-layout -t "$SESSION_NAME:devnet" tiled

# Add title bar showing which node is which
tmux set-option -t "$SESSION_NAME" pane-border-status top
tmux set-option -t "$SESSION_NAME" pane-border-format " #{pane_index}: Node logs "

# Attach to session
tmux attach-session -t "$SESSION_NAME"
