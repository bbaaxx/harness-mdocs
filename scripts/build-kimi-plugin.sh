#!/usr/bin/env bash
# Bundles the Kimi Code plugin's runtime entries (MCP server + hooks) into
# self-contained scripts under src/surfaces/kimi-code/plugin/dist/. Kimi Code
# plugin hooks run with cwd = plugin root and receive KIMI_PLUGIN_ROOT, so
# every entry must have zero external requires — esbuild --bundle with no
# externals, mirroring build:claude-plugin:mcp.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/src/surfaces/kimi-code/plugin"
cd "$REPO_ROOT"

echo "Building Kimi Code plugin bundles..."
rm -rf "$PLUGIN_DIR/dist"
mkdir -p "$PLUGIN_DIR/dist/hooks"

npx esbuild src/surfaces/kimi-code/mcp-server.ts \
  --bundle --platform=node --target=node18 --format=cjs --sourcemap \
  --outfile="$PLUGIN_DIR/dist/mcp-server.js"

for hook in pre-tool-use post-tool-use session-start; do
  npx esbuild "src/surfaces/kimi-code/cli/${hook}.ts" \
    --bundle --platform=node --target=node18 --format=cjs --sourcemap \
    --outfile="$PLUGIN_DIR/dist/hooks/${hook}.js"
done

echo "Kimi Code plugin build complete."
ls -la "$PLUGIN_DIR/dist" "$PLUGIN_DIR/dist/hooks"
