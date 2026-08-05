#!/usr/bin/env bash
#
# Provision the public YGOPro resources the integration tests read.
# Populates the gitignored test/resources/current/ygopro tree with the base
# and classic card databases plus their Lua script directories.
#
# Source tree defaults to the sibling EDOpro-server-ts assembled resources.
# Override with SRC=/path/to/resources/current bash test/setup-test-resources.sh
set -euo pipefail

SRC="${SRC:-/home/diango/code/evolution/EDOpro-server-ts/resources/current}"
DEST="$(cd "$(dirname "$0")" && pwd)/resources/current"

if [ ! -d "$SRC/ygopro" ]; then
	echo "ERROR: source resources not found at: $SRC/ygopro" >&2
	echo "Set SRC to a valid assembled 'resources/current' tree and retry." >&2
	exit 1
fi

copy_item() {
	local rel="$1"
	local src_path="$SRC/ygopro/$rel"
	local dest_path="$DEST/ygopro/$rel"
	if [ ! -e "$src_path" ]; then
		echo "ERROR: expected source path missing: $src_path" >&2
		exit 1
	fi
	mkdir -p "$(dirname "$dest_path")"
	cp -R "$src_path" "$dest_path"
	echo "  copied $rel"
}

echo "Provisioning test resources"
echo "  SRC:  $SRC/ygopro"
echo "  DEST: $DEST/ygopro"

copy_item "base/cards.cdb"
copy_item "base/script"
copy_item "classic/classic.cdb"
copy_item "classic/script"

echo "Done."
