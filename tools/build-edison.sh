#!/usr/bin/env bash
# Reproducible build of the Edison ocgcore fork WASM.
#
# Produces build/bin/wasm_cjs/Release/libocgcore.wasm, bit-identical to the
# artifact shipped to EDOpro-server-ts (sha256 pinned in EXPECTED_SHA below).
#
# The build is deterministic: same source commit + same emsdk = same bytes.
# Run from the repo root, on the `edison` branch (or any checkout of the fork).
#
# Prereqs: docker. Nothing else is needed on the host — Lua is downloaded and
# both premake5 and emmake run inside containers so the host toolchain/glibc
# never affects the output.
#
# EDISON_REPIN=1 opt-in mode: instead of asserting on a mismatch, rewrite this
# script's own EXPECTED_SHA to the actual sha, print `repinned: <sha>`, and
# exit 0. Used by the upstream-sync CI to re-pin after a clean rebase, so the
# sync PR builds green instead of arriving with a known-failing sha assert.
# Default behavior (EDISON_REPIN unset) is unchanged: assert and exit 1 on a
# mismatch. EDISON_SHA_OUT, if set, also gets the sha written to it alone (no
# surrounding text), so a caller can read the result without parsing logs.
set -euo pipefail

EDISON_REPIN="${EDISON_REPIN:-}"
EDISON_SHA_OUT="${EDISON_SHA_OUT:-}"

EXPECTED_SHA="60f5721700faea5f2a24fa714aff972add2a5fcec6590e45a36540ac081e23a5"
EMSDK_IMAGE="emscripten/emsdk:3.1.7"   # ABI-compatible with koishipro-core.js 1.5.2 JS glue
LUA_VERSION="5.4.8"

# Resolve this script's own absolute path before changing directory, so the
# EDISON_REPIN re-pin step below can find it regardless of the invoking cwd.
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

# Resolve to the repo root (this script lives in tools/).
cd "$(dirname "$0")/.."

# 1. Lua sources (the core links against Lua 5.4.x).
if [ ! -d lua ]; then
  wget -qO - "https://www.lua.org/ftp/lua-${LUA_VERSION}.tar.gz" | tar zxf -
  mv "lua-${LUA_VERSION}" lua
  cp premake/lua.lua lua/premake5.lua
fi
ln -sf premake/dll.lua .

# 2. premake5 (gmake generator). The beta8 binary needs glibc >= 2.38 (newer
#    than both the emsdk image and debian:12), so run it in ubuntu:24.04
#    (glibc 2.39). This step only emits makefiles — it does not affect the
#    final WASM bytes, which come solely from emsdk:3.1.7 + the source.
docker run --rm -v "$PWD":/src -w /src ubuntu:24.04 bash -c '
  set -e
  apt-get update -qq && apt-get install -y -qq wget ca-certificates >/dev/null
  wget -qO /tmp/premake.tar.gz https://github.com/premake/premake-core/releases/download/v5.0.0-beta8/premake-5.0.0-beta8-linux.tar.gz
  tar xzf /tmp/premake.tar.gz -C /usr/local/bin premake5
  chmod +x /usr/local/bin/premake5
  premake5 gmake --file=dll.lua --os=emscripten
'

# 3. Compile the WASM inside the pinned emsdk image.
docker run --rm -v "$PWD":/src -w /src/build "$EMSDK_IMAGE" \
  bash -c 'emmake make config=release_wasm_cjs -j"$(nproc)"'

# 4. Verify reproducibility (or re-pin, in EDISON_REPIN mode).
OUT="build/bin/wasm_cjs/Release/libocgcore.wasm"
ACTUAL_SHA="$(sha256sum "$OUT" | cut -d' ' -f1)"
echo "built:    $OUT"
echo "sha256:   $ACTUAL_SHA"

if [ -n "$EDISON_SHA_OUT" ]; then
  printf '%s' "$ACTUAL_SHA" > "$EDISON_SHA_OUT"
fi

if [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ]; then
  echo "MATCH: reproducible build confirmed."
  exit 0
fi

if [ -n "$EDISON_REPIN" ]; then
  # sed -i on this script's own path is safe: sed writes the edited content
  # to a new temp file and renames it over the old path, while bash already
  # holds the original inode open (it read this whole script into memory
  # before running any of it), so the running interpreter is unaffected by
  # the rename.
  sed -i "s/^EXPECTED_SHA=\"[0-9a-f]\{64\}\"/EXPECTED_SHA=\"${ACTUAL_SHA}\"/" "$SELF"
  echo "repinned: $ACTUAL_SHA"
  exit 0
fi

echo "MISMATCH: expected $EXPECTED_SHA" >&2
echo "The toolchain or source drifted — do NOT ship this binary until reconciled." >&2
exit 1
