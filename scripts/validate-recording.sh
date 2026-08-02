#!/usr/bin/env bash
# validate-recording.sh
# Smoke-checks that the marketing-video export pipeline is correctly wired:
#   1. useVideoPlayer exposes the hooks needed for recording (startRecording /
#      stopRecording globals are called at the right lifecycle points).
#   2. VideoTemplate accepts and forwards the onVideoEnd prop.
#   3. VideoWithControls renders the Export button and export-mode branch.
# Run from the repo root: bash scripts/validate-recording.sh

set -euo pipefail

PASS=0
FAIL=0

check() {
  local label="$1"
  local cmd="$2"
  if eval "$cmd" &>/dev/null; then
    echo "  ✓ $label"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "=== validate-recording: marketing-video export pipeline ==="
echo ""

HOOKS="artifacts/marketing-video/src/lib/video/hooks.ts"
TEMPLATE="artifacts/marketing-video/src/components/video/VideoTemplate.tsx"
CONTROLS="artifacts/marketing-video/src/components/video/VideoWithControls.tsx"

echo "-- hooks.ts --"
check "window.startRecording called on mount" \
  "grep -q 'window\.startRecording' '$HOOKS'"
check "window.stopRecording called on video end" \
  "grep -q 'window\.stopRecording' '$HOOKS'"
check "onVideoEnd option accepted" \
  "grep -q 'onVideoEnd' '$HOOKS'"
check "__replitVideoTotalDurationMs set" \
  "grep -q '__replitVideoTotalDurationMs' '$HOOKS'"

echo ""
echo "-- VideoTemplate.tsx --"
check "onVideoEnd prop declared" \
  "grep -q 'onVideoEnd' '$TEMPLATE'"
check "onVideoEnd forwarded to useVideoPlayer" \
  "grep -q 'onVideoEnd.*useVideoPlayer\|useVideoPlayer.*onVideoEnd' '$TEMPLATE'"
check "muted prop wired to audio element" \
  "grep -q 'muted={muted}' '$TEMPLATE'"
check "loop prop forwarded" \
  "grep -q 'loop' '$TEMPLATE'"

echo ""
echo "-- VideoWithControls.tsx --"
check "Export button rendered" \
  "grep -q 'Export' '$CONTROLS'"
check "export mode remounts with loop=false" \
  "grep -q 'loop={false}' '$CONTROLS'"
check "export mode remounts with muted=false" \
  "grep -q 'muted={false}' '$CONTROLS'"
check "onVideoEnd wired in export branch" \
  "grep -q 'onVideoEnd={handleVideoEnd}' '$CONTROLS'"
check "download link rendered after export" \
  "grep -q 'download=' '$CONTROLS'"
check "progress indicator shown during recording" \
  "grep -q 'exportProgress' '$CONTROLS'"

echo ""
echo "-- TOTAL: $PASS passed, $FAIL failed --"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
