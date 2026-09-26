#!/usr/bin/env bash
# Pure functions for the Edison fork release chain. Sourced, never executed
# directly: `source tools/edison-release-lib.sh && <function> <args>`.
# Safe under `set -euo pipefail` callers — every function returns a clean
# 0/1 status and never leaves the caller's shell options changed.
#
# Consumed by:
#   - .github/workflows/edison-upstream-watch.yml (ABI diff against the
#     current release asset)
#   - .github/workflows/edison-auto-tag.yml (next release tag)
#   - tools/build-edison.sh (EDISON_REPIN mode does not need this file, but
#     ships alongside it)
#
# Covered by test/tools/edison-release-lib.integration.test.ts.

# next_edison_tag <latest-tag>
#
# Prints the next Edison release tag as a minor bump with the patch reset to
# 0: `v1.1.0-edison` -> `v1.2.0-edison`. An empty input (no prior tag) prints
# `v1.0.0-edison`. Anything else that does not match `vX.Y.Z-edison` is
# rejected: printed to stderr, function returns 1.
next_edison_tag() {
	local input="${1:-}"

	if [ -z "$input" ]; then
		echo "v1.0.0-edison"
		return 0
	fi

	if [[ "$input" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)-edison$ ]]; then
		local major="${BASH_REMATCH[1]}"
		local minor="${BASH_REMATCH[2]}"
		echo "v${major}.$((minor + 1)).0-edison"
		return 0
	fi

	echo "next_edison_tag: '$input' does not match vX.Y.Z-edison" >&2
	return 1
}

# wasm_abi_signature <wasm-file>
#
# Prints a deterministic, sorted, one-per-line ABI surface of the given WASM
# module: `import <module>.<name> <kind>` for every import, `export <name>
# <kind>` for every export. Obtained through node's WebAssembly.Module
# introspection — no external tools (wasm-objdump, etc.) required, since node
# is guaranteed on both the CI runners and locally. Two binaries with the same
# ABI produce byte-identical output, which is what makes this diffable.
wasm_abi_signature() {
	local wasm_file="${1:-}"

	if [ -z "$wasm_file" ] || [ ! -f "$wasm_file" ]; then
		echo "wasm_abi_signature: file not found: $wasm_file" >&2
		return 1
	fi

	node -e '
		const fs = require("fs");
		const bytes = fs.readFileSync(process.argv[1]);
		let mod;
		try {
			mod = new WebAssembly.Module(bytes);
		} catch (err) {
			console.error(`wasm_abi_signature: not a valid WASM module: ${err.message}`);
			process.exit(1);
		}
		const lines = [];
		for (const imp of WebAssembly.Module.imports(mod)) {
			lines.push(`import ${imp.module}.${imp.name} ${imp.kind}`);
		}
		for (const exp of WebAssembly.Module.exports(mod)) {
			lines.push(`export ${exp.name} ${exp.kind}`);
		}
		lines.sort();
		for (const line of lines) console.log(line);
	' "$wasm_file"
}

# wasm_abi_diff <old-wasm> <new-wasm>
#
# Prints a unified diff between the two binaries' ABI signatures. Returns 0
# when the signatures are identical, 1 when they differ — the exact exit-code
# semantics of `diff`, preserved explicitly (rather than relying on whatever
# `set -e` would do with the raw `diff` exit status) because callers source
# this file under `set -euo pipefail` and must be able to branch on the
# result without the script aborting.
wasm_abi_diff() {
	local old_wasm="${1:-}"
	local new_wasm="${2:-}"
	local old_sig_file new_sig_file status

	old_sig_file="$(mktemp)"
	new_sig_file="$(mktemp)"

	if ! wasm_abi_signature "$old_wasm" >"$old_sig_file"; then
		rm -f "$old_sig_file" "$new_sig_file"
		return 1
	fi
	if ! wasm_abi_signature "$new_wasm" >"$new_sig_file"; then
		rm -f "$old_sig_file" "$new_sig_file"
		return 1
	fi

	status=0
	diff -u "$old_sig_file" "$new_sig_file" || status=$?

	rm -f "$old_sig_file" "$new_sig_file"
	return "$status"
}
