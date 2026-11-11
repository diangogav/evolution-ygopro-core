/**
 * Goat Format rule #10 — Damage Step chain windows (fork, differential).
 *
 * goatformat.com/basics.html:
 *   10A, substep 3 (Damage Calculation part 1): "players may activate other
 *       effects that alter the ATK and/or DEF of a monster" — an ATK modifier
 *       such as Rush Recklessly is legal in the damage-calculation timing.
 *       Modern rules only admit effects that explicitly carry
 *       EFFECT_FLAG_DAMAGE_CAL there.
 *   10B: "only one Chain can occur during each substep of the Damage Step
 *       (unless the resolution of one Chain triggers some other effect)".
 *       The core already does this: every Damage Step point event enters with
 *       skip_new, so the chain-end re-entry skips the free-chain window in the
 *       same timing. Pinned here, no gate involved.
 *
 * Window map inside the Damage Step for Kojikocy attacking a face-up
 * LIGHT_VANILLA (each pair = P1 window, then P0 window; hint = TIMING_* bits):
 *   pair 1  start of the Damage Step        (no hint)
 *   pair 2  before damage calculation       (TIMING_DAMAGE_STEP, 0x2000)
 *   pair 3  damage calculation              (TIMING_DAMAGE_CAL, 0x4000)
 *   MSG_BATTLE
 *   pairs 4-5 after damage calculation / end of the Damage Step
 * When a chain is activated in pair 1 two more P0 windows appear before pair 2:
 * the response window to the chain (P0 may chain to its own card) and the
 * post-resolution window (TIMING_CHAIN_END, 0x8000), which must stay empty.
 *
 * Scenario: T1 P0 summons LIGHT_VANILLA (1100) and sets Rush Recklessly (×1 or ×2).
 *           T2 P1 summons Kojikocy (1500) and attacks LIGHT_VANILLA.
 *           Battle Step windows are auto-declined; the Damage Step is driven
 *           window by window.
 */
import path from "node:path";
import {
	BattleCmdType,
	IdleCmdType,
	YGOProMsgBattle,
	YGOProMsgChaining,
	YGOProMsgDamageStepEnd,
	YGOProMsgDamageStepStart,
	YGOProMsgSelectBattleCmd,
	YGOProMsgSelectChain,
	YGOProMsgSelectIdleCmd,
} from "ygopro-msg-encode";
import { HeadlessDuel } from "./headless-duel";
import { FIXED_SEED, buildDeck } from "./test-fixtures";

jest.setTimeout(60_000);

const FORK_WASM =
	process.env.OCGCORE_WASM ?? path.join(__dirname, "wasm", "libocgcore-edison-fork.wasm");
const DUEL_GOAT_2005 = 0x400;

const RUSH_RECKLESSLY = 70046172;
const LIGHT_VANILLA = 2863439; // 1100/1400
const KOJIKOCY = 1184620; // 1500/1200

interface Window {
	player: number;
	codes: number[];
	/** Cards the core flags as fitting this timing (clients prompt by default only when > 0). */
	special: number;
}

/** One entry per event inside the Damage Step, in order. */
type Trace = Array<{ window: Window } | { chaining: number } | { battle: true }>;

async function summon(duel: HeadlessDuel, idle: YGOProMsgSelectIdleCmd, code: number): Promise<YGOProMsgSelectIdleCmd> {
	const card = idle.summonableCards.find((c) => c.code === code);
	if (!card) throw new Error(`card ${code} not summonable; ${idle.summonableCards.map((c) => c.code).join(",")}`);
	duel.setResponse(
		idle.prepareResponse(IdleCmdType.SUMMON, {
			code: card.code,
			controller: card.controller,
			location: card.location,
			sequence: card.sequence,
		}),
	);
	return (await duel.advanceUntil(YGOProMsgSelectIdleCmd)).targetMessage;
}

async function sset(duel: HeadlessDuel, idle: YGOProMsgSelectIdleCmd, code: number): Promise<YGOProMsgSelectIdleCmd> {
	const card = idle.ssetableCards.find((c) => c.code === code);
	if (!card) throw new Error(`card ${code} not ssetable; ${idle.ssetableCards.map((c) => c.code).join(",")}`);
	duel.setResponse(
		idle.prepareResponse(IdleCmdType.SSET, {
			code: card.code,
			controller: card.controller,
			location: card.location,
			sequence: card.sequence,
		}),
	);
	return (await duel.advanceUntil(YGOProMsgSelectIdleCmd)).targetMessage;
}

async function runScenario(opts: { rrCopies: 1 | 2; activateFirstRr: boolean; extraFlags: number }): Promise<Trace> {
	const duel = await HeadlessDuel.create({
		decks: [{ main: buildDeck([LIGHT_VANILLA, ...Array(opts.rrCopies).fill(RUSH_RECKLESSLY)]) }, { main: buildDeck([KOJIKOCY]) }],
		duelRule: 1,
		seed: FIXED_SEED,
		wasmPath: FORK_WASM,
		extraFlags: opts.extraFlags,
	});
	try {
		let idle = (await duel.advanceUntil(YGOProMsgSelectIdleCmd)).targetMessage;
		idle = await summon(duel, idle, LIGHT_VANILLA);
		for (let i = 0; i < opts.rrCopies; i++) idle = await sset(duel, idle, RUSH_RECKLESSLY);
		duel.setResponse(idle.prepareResponse(IdleCmdType.TO_EP));

		idle = (await duel.advanceUntil(YGOProMsgSelectIdleCmd)).targetMessage;
		idle = await summon(duel, idle, KOJIKOCY);
		duel.setResponse(idle.prepareResponse(IdleCmdType.TO_BP));
		const bc = (await duel.advanceUntil(YGOProMsgSelectBattleCmd)).targetMessage;
		const atk = bc.attackableCards.find((c) => c.code === KOJIKOCY);
		if (!atk) throw new Error("Kojikocy cannot attack");
		duel.setResponse(
			bc.prepareResponse(BattleCmdType.ATTACK, {
				code: atk.code,
				controller: atk.controller,
				location: atk.location,
				sequence: atk.sequence,
			}),
		);
		await duel.advanceUntil(YGOProMsgDamageStepStart);

		const trace: Trace = [];
		let activated = 0;
		for (let guard = 0; guard < 60; guard++) {
			const { targetMessage, allMessages } = await duel.advanceUntilOneOf([YGOProMsgSelectChain, YGOProMsgDamageStepEnd]);
			for (const m of allMessages) {
				if (m instanceof YGOProMsgChaining) trace.push({ chaining: m.code });
				else if (m instanceof YGOProMsgBattle) trace.push({ battle: true });
			}
			if (targetMessage instanceof YGOProMsgDamageStepEnd) break;
			const sc = targetMessage as YGOProMsgSelectChain;
			trace.push({ window: { player: sc.player, codes: sc.chains.map((c) => c.code), special: sc.specialCount } });
			const rr = sc.chains.find((c) => c.code === RUSH_RECKLESSLY);
			if (opts.activateFirstRr && activated === 0 && rr) {
				activated++;
				duel.setResponse(
					sc.prepareResponse({ code: rr.code, controller: rr.controller, location: rr.location, sequence: rr.sequence, desc: rr.desc }),
				);
			} else {
				duel.setResponse(sc.defaultResponse());
			}
		}
		return trace;
	} finally {
		await duel.cleanup();
	}
}

/** P0 windows before MSG_BATTLE. */
function p0WindowEntriesBeforeBattle(trace: Trace): Window[] {
	const out: Window[] = [];
	for (const e of trace) {
		if ("battle" in e) break;
		if ("window" in e && e.window.player === 0) out.push(e.window);
	}
	return out;
}

/** P0 windows before MSG_BATTLE, as lists of offered codes. */
function p0WindowsBeforeBattle(trace: Trace): number[][] {
	return p0WindowEntriesBeforeBattle(trace).map((w) => w.codes);
}

describe("Goat rule #10A — ATK/DEF modifiers during damage calculation (fork, differential)", () => {
	it("without DUEL_GOAT_2005: Set Rush Recklessly is offered before damage calculation but not in the damage-calculation window", async () => {
		const windows = p0WindowsBeforeBattle(await runScenario({ rrCopies: 1, activateFirstRr: false, extraFlags: 0 }));
		expect(windows).toHaveLength(3);
		expect(windows[0]).toContain(RUSH_RECKLESSLY);
		expect(windows[1]).toContain(RUSH_RECKLESSLY);
		expect(windows[2]).not.toContain(RUSH_RECKLESSLY);
	});

	it("with DUEL_GOAT_2005: Set Rush Recklessly is also offered in the damage-calculation window", async () => {
		const windows = p0WindowsBeforeBattle(await runScenario({ rrCopies: 1, activateFirstRr: false, extraFlags: DUEL_GOAT_2005 }));
		expect(windows).toHaveLength(3);
		expect(windows[2]).toContain(RUSH_RECKLESSLY);
	});

	it("with DUEL_GOAT_2005: an ATK modifier hinted for the Damage Step counts as fitting the damage-calculation timing, so clients prompt by default", async () => {
		// Rush Recklessly declares TIMING_DAMAGE_STEP; the damage-calculation
		// window carries TIMING_DAMAGE_CAL. Without the match the core reports
		// special 0 and clients auto-pass unless the player forces every prompt.
		const windows = p0WindowEntriesBeforeBattle(await runScenario({ rrCopies: 1, activateFirstRr: false, extraFlags: DUEL_GOAT_2005 }));
		expect(windows).toHaveLength(3);
		expect(windows[2].codes).toEqual([RUSH_RECKLESSLY]);
		expect(windows[2].special).toBe(1);
	});
});

describe("Goat rule #10B — one chain per Damage Step timing (already satisfied by the core)", () => {
	for (const [label, extraFlags] of [
		["without DUEL_GOAT_2005", 0],
		["with DUEL_GOAT_2005", DUEL_GOAT_2005],
	] as const) {
		it(`${label}: after the first Rush Recklessly resolves, the second is not offered again in that timing`, async () => {
			const trace = await runScenario({ rrCopies: 2, activateFirstRr: true, extraFlags });
			expect(trace.some((e) => "chaining" in e && e.chaining === RUSH_RECKLESSLY)).toBe(true);
			const windows = p0WindowsBeforeBattle(trace);
			expect(windows).toHaveLength(5);
			expect(windows[0]).toEqual([RUSH_RECKLESSLY, RUSH_RECKLESSLY]); // pair 1: activation
			expect(windows[1]).toEqual([RUSH_RECKLESSLY]); // response to the chain (chain link 2)
			expect(windows[2]).toEqual([]); // post-resolution window of the same timing: no new chain
			expect(windows[3]).toEqual([RUSH_RECKLESSLY]); // pair 2: next timing
			// pair 3 (damage calculation): 10A decides
			expect(windows[4]).toEqual(extraFlags ? [RUSH_RECKLESSLY] : []);
		});
	}
});
