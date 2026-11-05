/**
 * Goat Format rule #19 — responding to the end-of-turn hand-size discard.
 *
 * goatformat.com/basics.html, rule #19: "players may simply respond to the
 * end-of-turn discard in whatever ways they wish." Example 1 activates a Set
 * Forced Requisition in response to the discard; example 2 lets a Manticore of
 * Darkness discarded for hand size use its effect in that same End Phase.
 *
 * Edison / 2010 (edisonformat.com rule differences): the discard is the last
 * action of the turn; only a mandatory Trigger Effect it causes may start a
 * chain. The stock core already does exactly that: after the discard
 * (processor.cpp phase-event steps 20-22) it runs one more point event, so
 * triggers fire and may be answered, but the free-chain window is skipped
 * while `core.hand_adjusted` is set.
 *
 * DUEL_GOAT_2005 keeps the free-chain window open after the discard. These
 * tests are differential: same scenario, with and without the option, on the
 * fork binary.
 *
 * Scenario (startHand=7, drawCount=1):
 *   P0 opening hand = deck[0..6]: NIGHT_ASSAILANT, FORCED_REQUISITION, JAR_OF_GREED, 4 pads.
 *   T1 P0: draw → 8. SSet Forced Requisition, SSet Jar of Greed → 6 in hand. End.
 *   T2 P1: pass (P1 also starts with 7 and discards 2 at its own End Phase).
 *   T3 P0: draw → 7 in hand. End turn → hand limit 6 → discard 1.
 *
 * Cards:
 *   FORCED_REQUISITION 74923978  Continuous Trap, activates on EVENT_DISCARD (no reason filter)
 *   JAR_OF_GREED       83968380  Normal Trap, Set: only reachable through the free-chain window
 *                                (Rush Recklessly cannot serve here: it needs a face-up monster target)
 *   NIGHT_ASSAILANT    16226786  TRIGGER_F on EVENT_TO_GRAVE from hand (mandatory trigger)
 *   VANILLA_PAD        549481    no effect: discarding it raises no trigger
 */
import path from "node:path";
import {
	IdleCmdType,
	YGOProMsgChaining,
	YGOProMsgNewTurn,
	YGOProMsgSelectCard,
	YGOProMsgSelectChain,
	YGOProMsgSelectIdleCmd,
} from "ygopro-msg-encode";
import type { YGOProMsgBase, YGOProMsgResponseBase } from "ygopro-msg-encode";
import { HeadlessDuel } from "./headless-duel";
import { FIXED_SEED, buildDeck } from "./test-fixtures";

jest.setTimeout(60_000);

const FORK_WASM =
	process.env.OCGCORE_WASM ?? path.join(__dirname, "wasm", "libocgcore-edison-fork.wasm");
const DUEL_GOAT_2005 = 0x400;

const FORCED_REQUISITION = 74923978;
const JAR_OF_GREED = 83968380;
const NIGHT_ASSAILANT = 16226786;
const VANILLA_PAD = 549481;
const LOCATION_HAND = 0x02;

const P0_DECK = buildDeck([NIGHT_ASSAILANT, FORCED_REQUISITION, JAR_OF_GREED]);
const P1_DECK = buildDeck([]);

interface Observation {
	kind: "SelectChain" | "Chaining";
	player?: number;
	codes: number[];
	/** Cards the core flags as fitting this timing (clients prompt by default only when > 0). */
	special?: number;
}

interface Result {
	afterDiscard: Observation[];
	handAfterDiscard: number;
}

async function sset(duel: HeadlessDuel, idle: YGOProMsgSelectIdleCmd, code: number): Promise<YGOProMsgSelectIdleCmd> {
	const card = idle.ssetableCards.find((c) => c.code === code);
	if (!card) {
		throw new Error(`card ${code} not ssetable; ssetable: ${idle.ssetableCards.map((c) => c.code).join(",")}`);
	}
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

async function runScenario(opts: { extraFlags: number; discardCode: number }): Promise<Result> {
	let discardSeen = false;
	const afterDiscard: Observation[] = [];

	const duel = await HeadlessDuel.create({
		decks: [{ main: P0_DECK }, { main: P1_DECK }],
		duelRule: 1,
		seed: FIXED_SEED,
		startHand: 7,
		wasmPath: FORK_WASM,
		extraFlags: opts.extraFlags,
		autoResponder: (msg: YGOProMsgResponseBase): Uint8Array | undefined => {
			if (msg instanceof YGOProMsgSelectCard) {
				const allInHand = msg.cards.every((c) => c.location === LOCATION_HAND);
				if (allInHand && msg.cards[0]?.controller === 1) {
					const n = msg.cards.length - 6;
					return msg.prepareResponse(
						msg.cards.slice(0, n).map((c) => ({ code: c.code, controller: c.controller, location: c.location, sequence: c.sequence })),
					);
				}
				if (allInHand) {
					discardSeen = true;
					const pick = msg.cards.find((c) => c.code === opts.discardCode);
					if (!pick) throw new Error(`card ${opts.discardCode} not in hand; hand=[${msg.cards.map((c) => c.code).join(",")}]`);
					return msg.prepareResponse([
						{ code: pick.code, controller: pick.controller, location: pick.location, sequence: pick.sequence },
					]);
				}
			}
			if (msg instanceof YGOProMsgSelectChain && discardSeen) {
				afterDiscard.push({ kind: "SelectChain", player: msg.player, codes: msg.chains.map((c) => c.code), special: msg.specialCount });
				return msg.defaultResponse();
			}
			return undefined;
		},
	});

	try {
		const r1 = await duel.advanceUntil(YGOProMsgSelectIdleCmd);
		const idle2 = await sset(duel, r1.targetMessage, FORCED_REQUISITION);
		const idle3 = await sset(duel, idle2, JAR_OF_GREED);
		duel.setResponse(idle3.prepareResponse(IdleCmdType.TO_EP));

		const r2 = await duel.advanceUntil(YGOProMsgSelectIdleCmd);
		duel.setResponse(r2.targetMessage.prepareResponse(IdleCmdType.TO_EP));

		const r3 = await duel.advanceUntil(YGOProMsgSelectIdleCmd);
		expect(duel.queryHandCount(0)).toBe(7);
		duel.setResponse(r3.targetMessage.prepareResponse(IdleCmdType.TO_EP));

		const r4 = await duel.advanceUntil(YGOProMsgNewTurn);
		const msgs: YGOProMsgBase[] = r4.allMessages;
		const discardIdx = msgs.findIndex(
			(m) =>
				m instanceof YGOProMsgSelectCard &&
				m.cards.every((c) => c.location === LOCATION_HAND && c.controller === 0),
		);
		expect(discardIdx).toBeGreaterThanOrEqual(0);
		expect(discardSeen).toBe(true);
		for (const m of msgs.slice(discardIdx + 1)) {
			if (m instanceof YGOProMsgChaining) afterDiscard.push({ kind: "Chaining", codes: [m.code] });
		}
		return { afterDiscard, handAfterDiscard: duel.queryHandCount(0) };
	} finally {
		await duel.cleanup();
	}
}

const p0Offers = (r: Result): number[][] =>
	r.afterDiscard.filter((o) => o.kind === "SelectChain" && o.player === 0).map((o) => o.codes);

describe("Goat rule #19 — response window after the hand-size discard (fork, differential)", () => {
	describe("discarding a card with no trigger", () => {
		it("without DUEL_GOAT_2005 (Edison/2010): no chain window opens after the discard", async () => {
			const r = await runScenario({ extraFlags: 0, discardCode: VANILLA_PAD });
			expect(r.handAfterDiscard).toBe(6);
			expect(r.afterDiscard).toEqual([]);
		});

		it("with DUEL_GOAT_2005: the free-chain window opens and the Set Jar of Greed is offered", async () => {
			const r = await runScenario({ extraFlags: DUEL_GOAT_2005, discardCode: VANILLA_PAD });
			expect(r.handAfterDiscard).toBe(6);
			expect(p0Offers(r).some((codes) => codes.includes(JAR_OF_GREED))).toBe(true);
			// Forced Requisition activates on EVENT_DISCARD; the discard event is still live.
			expect(p0Offers(r).some((codes) => codes.includes(FORCED_REQUISITION))).toBe(true);
		});

		it("with DUEL_GOAT_2005: every card offered after the discard counts as fitting the timing, so clients prompt by default", async () => {
			// Jar of Greed declares no hint timing; in a plain End Phase window the
			// core reports it as not fitting (special 0) and clients auto-pass.
			// Responding to the discard is a Goat play, so that window is special.
			const r = await runScenario({ extraFlags: DUEL_GOAT_2005, discardCode: VANILLA_PAD });
			const windows = r.afterDiscard.filter((o) => o.kind === "SelectChain" && o.player === 0 && o.codes.includes(JAR_OF_GREED));
			expect(windows.length).toBeGreaterThan(0);
			for (const w of windows) expect(w.special).toBe(w.codes.length);
		});
	});

	describe("discarding Night Assailant (mandatory trigger)", () => {
		it("without DUEL_GOAT_2005: the mandatory trigger chains and Set cards may be chained to it", async () => {
			// The 2010 rule lets only negating effects and Counter Traps answer that
			// chain; the core does not narrow the response window, so any Set card
			// is offered here. That residual gap is Edison's, not Goat's.
			const r = await runScenario({ extraFlags: 0, discardCode: NIGHT_ASSAILANT });
			expect(r.afterDiscard.some((o) => o.kind === "Chaining" && o.codes.includes(NIGHT_ASSAILANT))).toBe(true);
			expect(p0Offers(r).some((codes) => codes.includes(FORCED_REQUISITION))).toBe(true);
			expect(p0Offers(r).some((codes) => codes.includes(JAR_OF_GREED))).toBe(true);
		});

		it("with DUEL_GOAT_2005: the trigger chains and the Set Jar of Greed is offered as well", async () => {
			const r = await runScenario({ extraFlags: DUEL_GOAT_2005, discardCode: NIGHT_ASSAILANT });
			expect(r.afterDiscard.some((o) => o.kind === "Chaining" && o.codes.includes(NIGHT_ASSAILANT))).toBe(true);
			expect(p0Offers(r).some((codes) => codes.includes(JAR_OF_GREED))).toBe(true);
		});
	});
});
