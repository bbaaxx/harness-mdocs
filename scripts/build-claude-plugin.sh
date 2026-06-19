#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/src/surfaces/claude-code/plugin"
ASSETS_DIR="$REPO_ROOT/src/surfaces/claude-code/assets"

echo "Building harness-mdocs..."
cd "$REPO_ROOT"
npm run build

echo "Copying dist/ into plugin directory..."
# Remove stale dist inside plugin
rm -rf "$PLUGIN_DIR/dist"
# Copy only the subsets needed at runtime
mkdir -p "$PLUGIN_DIR/dist"
cp -R "$REPO_ROOT/dist/cli"          "$PLUGIN_DIR/dist/cli"
cp -R "$REPO_ROOT/dist/core"         "$PLUGIN_DIR/dist/core"
mkdir -p "$PLUGIN_DIR/dist/surfaces"
cp -R "$REPO_ROOT/dist/surfaces/claude-code" "$PLUGIN_DIR/dist/surfaces/claude-code"

echo "Syncing skill and agent files from assets/..."
# Skills
for skill in mdocs-workflow mdocs-initiative mdocs-orchestrator; do
  mkdir -p "$PLUGIN_DIR/skills/$skill"
  cp "$ASSETS_DIR/skills/$skill/SKILL.md" "$PLUGIN_DIR/skills/$skill/SKILL.md"
done

# Agents
mkdir -p "$PLUGIN_DIR/agents"
cp "$ASSETS_DIR/agents/mdocs-orchestrator.md" "$PLUGIN_DIR/agents/mdocs-orchestrator.md"

echo "Plugin build complete."
ls -la "$PLUGIN_DIR/dist/cli/hooks/"
