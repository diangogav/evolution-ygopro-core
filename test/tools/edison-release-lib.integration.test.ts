/**
 * Pure-function coverage for `tools/edison-release-lib.sh`, the sourced
 * (never executed) bash library the upstream-sync and auto-tag workflows use
 * to compute the next release tag and to diff a WASM binary's ABI surface.
 *
 * Every function is driven through a real `bash -c 'source ... && call'`
 * subprocess rather than re-implemented in TypeScript, so this test exercises
 * the exact script the CI workflows source.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const repoRoot = path.resolve(__dirname, "../..");
const libPath = "tools/edison-release-lib.sh";

function runBash(script: string): { stdout: string; stderr: string; status: number | null } {
	const result = spawnSync("bash", ["-c", `source ${libPath} && ${script}`], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	return {
		stdout: result.stdout.trim(),
		stderr: result.stderr.trim(),
		status: result.status,
	};
}

/**
 * Builds a minimal, valid WASM module by hand (no external tools), so the
 * fixture's ABI surface is fully known and controllable:
 *   - one type: `() -> ()`
 *   - one import: `env.log` (func, using that type)
 *   - one locally defined function (using that type)
 *   - one export: `<exportName>` (func, the locally defined function)
 * `new WebAssembly.Module(bytes)` validates the fixture inside this test, so
 * a broken builder fails here loudly instead of producing a silently-invalid
 * fixture for the library under test.
 */
function buildMinimalWasm(exportName: string): Buffer {
	function leb128u(value: number): number[] {
		const bytes: number[] = [];
		let n = value;
		do {
			let byte = n & 0x7f;
			n >>>= 7;
			if (n !== 0) byte |= 0x80;
			bytes.push(byte);
		} while (n !== 0);
		return bytes;
	}
	function encodeString(value: string): number[] {
		const bytes = Array.from(Buffer.from(value, "utf8"));
		return [...leb128u(bytes.length), ...bytes];
	}
	function section(id: number, content: number[]): number[] {
		return [id, ...leb128u(content.length), ...content];
	}
	function vec(items: number[][]): number[] {
		return [...leb128u(items.length), ...items.flat()];
	}

	const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]; // "\0asm" version 1
	const typeSection = section(1, [0x01, 0x60, 0x00, 0x00]); // 1 type: () -> ()
	const importSection = section(
		2,
		vec([[...encodeString("env"), ...encodeString("log"), 0x00, 0x00]]), // import env.log: func type 0
	);
	const functionSection = section(3, vec([[0x00]])); // 1 defined func, type 0
	const exportSection = section(
		7,
		vec([[...encodeString(exportName), 0x00, 0x01]]), // export <name>: func index 1 (after the import)
	);
	const codeSection = section(10, vec([[0x02, 0x00, 0x0b]])); // 1 body: 0 locals, `end`

	const bytes = Buffer.from([
		...header,
		...typeSection,
		...importSection,
		...functionSection,
		...exportSection,
		...codeSection,
	]);

	// Prove the fixture is a valid module before handing it to the library.
	new WebAssembly.Module(bytes);
	return bytes;
}

describe("edison-release-lib.sh", () => {
	describe("next_edison_tag", () => {
		it("bumps the minor version and resets the patch to 0", () => {
			const result = runBash("next_edison_tag v1.1.0-edison");
			expect(result.status).toBe(0);
			expect(result.stdout).toBe("v1.2.0-edison");
		});

		it("starts at v1.0.0-edison when given no prior tag", () => {
			const result = runBash('next_edison_tag ""');
			expect(result.status).toBe(0);
			expect(result.stdout).toBe("v1.0.0-edison");
		});

		it("rejects a tag that does not match vX.Y.Z-edison and exits 1", () => {
			const result = runBash("next_edison_tag not-a-tag");
			expect(result.status).toBe(1);
			expect(result.stderr).not.toBe("");
		});
	});

	describe("wasm_abi_signature", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "edison-abi-"));
		});

		afterEach(() => {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("prints a deterministic sorted list of imports and exports with kinds", () => {
			const wasmPath = path.join(tmpDir, "fixture.wasm");
			fs.writeFileSync(wasmPath, buildMinimalWasm("main"));

			const result = runBash(`wasm_abi_signature ${wasmPath}`);
			expect(result.status).toBe(0);
			expect(result.stdout.split("\n")).toEqual(["export main function", "import env.log function"]);
		});

		it("reports a missing file on stderr and exits 1", () => {
			const result = runBash(`wasm_abi_signature ${path.join(tmpDir, "missing.wasm")}`);
			expect(result.status).toBe(1);
			expect(result.stderr).not.toBe("");
		});
	});

	describe("wasm_abi_diff", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "edison-abi-diff-"));
		});

		afterEach(() => {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("exits 0 with no diff when both binaries have the same ABI signature", () => {
			const aPath = path.join(tmpDir, "a.wasm");
			const bPath = path.join(tmpDir, "b.wasm");
			fs.writeFileSync(aPath, buildMinimalWasm("main"));
			fs.writeFileSync(bPath, buildMinimalWasm("main"));

			const result = runBash(`wasm_abi_diff ${aPath} ${bPath}`);
			expect(result.status).toBe(0);
			expect(result.stdout).toBe("");
		});

		it("exits 1 and prints a diff mentioning the changed export name", () => {
			const oldPath = path.join(tmpDir, "old.wasm");
			const newPath = path.join(tmpDir, "new.wasm");
			fs.writeFileSync(oldPath, buildMinimalWasm("main"));
			fs.writeFileSync(newPath, buildMinimalWasm("main_renamed"));

			const result = runBash(`wasm_abi_diff ${oldPath} ${newPath}`);
			expect(result.status).toBe(1);
			expect(result.stdout).toContain("main_renamed");
		});
	});
});
