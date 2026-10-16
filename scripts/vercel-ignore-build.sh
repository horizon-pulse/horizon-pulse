#!/usr/bin/env bash
# Vercel Ignored Build Step helper for horizon-pulse.
# Exit 0 = SKIP this build. Exit 1 = CONTINUE (build).
# Fail open: any unexpected condition continues the build.
#
# Policy: on production only, skip when EVERY changed path is on the
# explicit non-runtime allowlist. Mixed commits always build. Preview/dev always build.
# Odin Class A PASS 10/16: no wildcard *.md; explicit files + docs/ + tests/
# (+ scripts/ and .github/ kept from draft for test-only / CI-only commits).
set -u

ENV="${VERCEL_ENV:-}"
if [ "$ENV" != "production" ]; then
  exit 1
fi

# Explicit non-runtime allowlist. Anything else => build.
# Note: vercel.json / package.json / app/ / lib/ / public/ / mcp/ are NOT allowed.
is_non_runtime() {
  local f="$1"
  case "$f" in
    scripts/*|docs/*|tests/*|.github/*) return 0 ;;
    README.md|CHANGELOG.md|LICENSE|THIRD-PARTY-NOTICES|THIRD-PARTY-NOTICES.md|examples/README.md) return 0 ;;
  esac
  return 1
}

# Box / CI harness only: IGNORE_BUILD_TEST_FILES=newline-separated paths.
# When set, skips git diff (still requires production env). Empty PREV still fails open below unless IGNORE_BUILD_TEST_SKIP_PREV=1.
if [ -n "${IGNORE_BUILD_TEST_FILES+x}" ] && [ "${IGNORE_BUILD_TEST_MODE:-}" = "1" ]; then
  PREV="${VERCEL_GIT_PREVIOUS_SHA:-}"
  if [ -z "$PREV" ] && [ "${IGNORE_BUILD_TEST_SKIP_PREV:-}" != "1" ]; then
    exit 1
  fi
  if [ -z "${IGNORE_BUILD_TEST_FILES}" ]; then
    exit 1
  fi
  mapfile -t FILES <<< "${IGNORE_BUILD_TEST_FILES}"
  for f in "${FILES[@]}"; do
    [ -z "$f" ] && continue
    if ! is_non_runtime "$f"; then
      exit 1
    fi
  done
  exit 0
fi

PREV="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$PREV" ]; then
  # First production deploy or missing baseline — build.
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  exit 1
fi

# Ensure PREV is resolvable; otherwise fail open.
if ! git cat-file -e "${PREV}^{commit}" 2>/dev/null; then
  exit 1
fi

mapfile -t FILES < <(git diff --name-only "$PREV" HEAD 2>/dev/null) || exit 1

if [ "${#FILES[@]}" -eq 0 ]; then
  # Empty diff is unusual on a push; fail open.
  exit 1
fi

for f in "${FILES[@]}"; do
  [ -z "$f" ] && continue
  if ! is_non_runtime "$f"; then
    exit 1
  fi
done

exit 0
