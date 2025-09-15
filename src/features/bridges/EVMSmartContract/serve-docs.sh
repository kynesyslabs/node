#!/bin/bash

# LiquidityTank Contract Documentation Server
# Serves the auto-generated NatSpec documentation from Foundry

echo "🔧 Starting LiquidityTank contract documentation server..."
echo "📋 Documentation includes:"
echo "   - Complete function reference with parameters"
echo "   - Event definitions and descriptions"
echo "   - Custom errors and explanations"
echo "   - Struct definitions with field details"
echo "   - State variables documentation"
echo ""
echo "🌐 Serving at: http://localhost:3001"
echo "🔍 Search functionality available with 'S' or '/'"
echo "📖 Navigation with arrow keys or sidebar"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

# Navigate to the contract directory and serve documentation
cd "$(dirname "$0")"
forge doc --serve --port 3001