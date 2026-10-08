#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?Usage: bash tools/verify-macos-app.sh /path/to/HotClip.app}"

# Reject missing resource seals and invalid nested signatures before publishing.
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app_path"

signature_info="$(/usr/bin/codesign --display --verbose=4 "$app_path" 2>&1)"
if ! /usr/bin/grep -Fxq 'Identifier=com.hotclip.app' <<< "$signature_info"; then
  echo "Expected a HotClip bundle signature, not the original Electron signature" >&2
  exit 1
fi

if [[ ! -f "$app_path/Contents/_CodeSignature/CodeResources" ]]; then
  echo "Missing macOS bundle resource seal" >&2
  exit 1
fi

echo "HotClip bundle and nested signatures verified (Apple notarization is separate)"
