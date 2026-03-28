#!/usr/bin/env bash
set -euo pipefail

# Lore installer
# Usage:
#   bash install.sh                    # Clone to ~/.codex/plugins/lore-source + register marketplace
#   bash install.sh --codex-plugin     # Same as above (explicit)
#   bash install.sh --local            # Use current directory as plugin source (for contributors)

PLUGIN_NAME="lore"
REPO_URL="https://github.com/yimwoo/lore"
SOURCE_DIR="$HOME/.codex/plugins/lore-source"
MARKETPLACE_FILE="$HOME/.agents/plugins/marketplace.json"

LOCAL_MODE=false
for arg in "$@"; do
  case "$arg" in
    --local) LOCAL_MODE=true ;;
    --codex-plugin) ;; # default behavior
    --help|-h)
      echo "Lore Installer"
      echo ""
      echo "Usage:"
      echo "  bash install.sh                  Install as Codex plugin (clone to ~/.codex/plugins/lore-source)"
      echo "  bash install.sh --local          Use current directory as plugin source (contributors)"
      echo ""
      exit 0
      ;;
  esac
done

# Determine plugin path
if [ "$LOCAL_MODE" = true ]; then
  PLUGIN_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  MARKETPLACE_FILE=".agents/plugins/marketplace.json"
  echo "Local mode: using $PLUGIN_PATH as plugin source"
else
  PLUGIN_PATH="$SOURCE_DIR"

  if [ -d "$SOURCE_DIR/.git" ]; then
    echo "Updating existing source checkout at $SOURCE_DIR..."
    cd "$SOURCE_DIR"
    git fetch origin
    git reset --hard origin/main
    cd - > /dev/null
  else
    echo "Cloning Lore to $SOURCE_DIR..."
    mkdir -p "$(dirname "$SOURCE_DIR")"
    git clone "$REPO_URL" "$SOURCE_DIR"
  fi
fi

# Install dependencies
echo "Installing dependencies..."
cd "$PLUGIN_PATH"
npm install --silent
cd - > /dev/null

# Register in marketplace
MARKETPLACE_DIR="$(dirname "$MARKETPLACE_FILE")"
mkdir -p "$MARKETPLACE_DIR"

if [ -f "$MARKETPLACE_FILE" ]; then
  # Check if lore entry already exists
  if command -v jq &> /dev/null; then
    HAS_ECHO=$(jq -r '.plugins[]? | select(.name == "lore") | .name' "$MARKETPLACE_FILE" 2>/dev/null || echo "")
    if [ "$HAS_ECHO" = "lore" ]; then
      echo "Marketplace entry for lore already exists. Updating path..."
      TEMP_FILE=$(mktemp)
      jq --arg path "$PLUGIN_PATH" '(.plugins[] | select(.name == "lore")).source.path = $path' "$MARKETPLACE_FILE" > "$TEMP_FILE"
      mv "$TEMP_FILE" "$MARKETPLACE_FILE"
    else
      echo "Adding lore to existing marketplace..."
      TEMP_FILE=$(mktemp)
      jq --arg path "$PLUGIN_PATH" '.plugins += [{"name":"lore","source":{"source":"local","path":$path},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Productivity"}]' "$MARKETPLACE_FILE" > "$TEMP_FILE"
      mv "$TEMP_FILE" "$MARKETPLACE_FILE"
    fi
  else
    echo ""
    echo "WARNING: jq not found. Cannot auto-update marketplace.json."
    echo "Please manually add the lore entry to $MARKETPLACE_FILE"
    echo "(See README.md for the marketplace entry format)"
  fi
else
  echo "Creating marketplace file at $MARKETPLACE_FILE..."
  cat > "$MARKETPLACE_FILE" << MARKETPLACE
{
  "name": "local",
  "plugins": [
    {
      "name": "lore",
      "source": {
        "source": "local",
        "path": "$PLUGIN_PATH"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
MARKETPLACE
fi

echo ""
echo "Lore installed successfully."
echo ""
echo "Next steps:"
echo "  1. Restart Codex"
echo "  2. Open the plugin directory, switch to Local Plugins, and install Lore"
echo "  3. MCP recall tools are bundled with the plugin install"
echo "  4. Start promoting knowledge:"
echo ""
echo "     node --import tsx $PLUGIN_PATH/src/cli.ts promote \\"
echo "       --kind domain_rule \\"
echo "       --title \"Use snake_case\" \\"
echo "       --content \"All DB columns must use snake_case.\""
echo ""
echo "Plugin source: $PLUGIN_PATH"
echo "Marketplace:   $MARKETPLACE_FILE"
