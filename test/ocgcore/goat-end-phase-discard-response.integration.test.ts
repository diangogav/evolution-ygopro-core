/**
 * Goat Format rule #19 probe — responding to the end-of-turn hand-size discard.
 *
 * goatformat.com/basics.html, rule #19: "players may simply respond to the
 * end-of-turn discard in whatever ways they wish." Example 1 activates a Set
 * Forced Requisition in response to the discard and lets a Night Assailant
 * discarded for a cost trigger afterwards. Example 2 lets a Manticore of
 * Darkness discarded for hand size use its effect in that same End Phase.
 *
 * What the core does today (processor.cpp, PROCESSOR_PHASE_EVENT steps 20-22):
 * the forced discard is a single send_to with
 * REASON_RULE + REASON_DISCARD + REASON_ADJUST, followed by one more
 * PROCESSOR_POINT_EVENT pass. This probe observes what that pass offers.
 *
 * Observations recorded between the hand-size SelectCard and MSG_NEW_TURN:
 *   - every SelectChain window: player and offered codes
 *   - every MSG_CHAINING: which card triggered
 *
 * Scenario (startHand=7, drawCount=1):
 *   P0 opening hand = deck[0..6]: NIGHT_ASSAILANT, FORCED_REQUISITION, RUSH_RECKLESSLY, 4 pads.
 *   T1 P0: draw → 8. SSet Forced Requisition, SSet Rush Recklessly → 6 in hand. End.
 *   T2 P1: pass.
 *   T3 P0: draw → 7 in hand. End turn → hand limit 6 → discard 1.
 *   The discard responder picks Night Assailant, whose TRIGGER_F on
 *   EVENT_TO_GRAVE has no reason filter (only IsPreviousLocation(HAND)).
 *
 * Cards:
 *   FORCED_REQUISITION 74923978  Continuous Trap, activates on EVENT_DISCARD (no reason filter)
 *   RUSH_RECKLESSLY    70046172  Quick-Play, generic set card (free-chain window detector)
 *   NIGHT_ASSAILANT    16226786  TRIGGER_F on EVENT_TO_GRAVE from hand
 */
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

const FORCED_REQUISITION = 74923978;
const RUSH_RECKLESSLY = 70046172;
const NIGHT_ASSAILANT = 16226786;
const LOCATION_HAND = 0x02;

const P0_DECK = buildDeck([NIGHT_ASSAILANT, FORCED_REQUISITION, RUSH_RECKLESSLY]);
const P1_DECK = buildDeck([]);

interface WindowObservation {
	kind: "SelectChain" | "Chaining" | "SelectCard";
	player?: number;
	codes: number[];
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
	const r = await duel.advanceUntil(YGOProMsgSelectIdleCmd);
	return r.targetMessage;
}

async function runScenario(duelRule: number): Promise<{
	discardSeen: boolean;
	afterDiscard: WindowObservation[];
	handAfterDiscard: number;
}> {
	let discardSeen = false;
	const afterDiscard: WindowObservation[] = [];

	const duel = await HeadlessDuel.create({
		decks: [{ main: P0_DECK }, { main: P1_DECK }],
		duelRule,
		seed: FIXED_SEED,
		startHand: 7,
		autoResponder: (msg: YGOProMsgResponseBase): Uint8Array | undefined => {
			if (msg instanceof YGOProMsgSelectCard) {
				const allInHand = msg.cards.every((c) => c.location === LOCATION_HAND);
				// P1 also starts with 7 cards and discards at its own T2 End Phase; ignore it.
				if (allInHand && msg.cards[0]?.controller === 1) {
					const n = msg.cards.length - 6;
					return msg.prepareResponse(
						msg.cards.slice(0, n).map((c) => ({ code: c.code, controller: c.controller, location: c.location, sequence: c.sequence })),
					);
				}
				if (allInHand) {
					discardSeen = true;
					const na = msg.cards.find((c) => c.code === NIGHT_ASSAILANT);
					if (!na) {
						throw new Error(
							`Night Assailant not in hand at discard time; hand=[${msg.cards.map((c) => c.code).join(",")}]`,
						);
					}
					return msg.prepareResponse([
						{ code: na.code, controller: na.controller, location: na.location, sequence: na.sequence },
					]);
				}
			}
			if (msg instanceof YGOProMsgSelectChain && discardSeen) {
				afterDiscard.push({
					kind: "SelectChain",
					player: msg.player,
					codes: msg.chains.map((c) => c.code),
				});
				return msg.defaultResponse();
			}
			return undefined;
		},
	});

	try {
		// T1 P0: set both cards, end turn
		const r1 = await duel.advanceUntil(YGOProMsgSelectIdleCmd);
		const idle2 = await sset(duel, r1.targetMessage, FORCED_REQUISITION);
		const idle3 = await sset(duel, idle2, RUSH_RECKLESSLY);
		duel.setResponse(idle3.prepareResponse(IdleCmdType.TO_EP));

		// T2 P1: pass
		const r2 = await duel.advanceUntil(YGOProMsgSelectIdleCmd);
		duel.setResponse(r2.targetMessage.prepareResponse(IdleCmdType.TO_EP));

		// T3 P0: end turn with 7 in hand
		const r3 = await duel.advanceUntil(YGOProMsgSelectIdleCmd);
		expect(duel.queryHandCount(0)).toBe(7);
		duel.setResponse(r3.targetMessage.prepareResponse(IdleCmdType.TO_EP));

		// Advance to the next turn, collecting everything.
		const r4 = await duel.advanceUntil(YGOProMsgNewTurn);
		const msgs: YGOProMsgBase[] = r4.allMessages;
		const discardIdx = msgs.findIndex(
			(m) =>
				m instanceof YGOProMsgSelectCard &&
				m.cards.every((c) => c.location === LOCATION_HAND && c.controller === 0),
		);
		expect(discardIdx).toBeGreaterThanOrEqual(0);
		for (const m of msgs.slice(discardIdx + 1)) {
			if (m instanceof YGOProMsgChaining) {
				afterDiscard.push({ kind: "Chaining", codes: [m.code] });
			}
		}
		return { discardSeen, afterDiscard, handAfterDiscard: duel.queryHandCount(0) };
	} finally {
		await duel.cleanup();
	}
}

describe("Goat rule #19 probe — what the core offers after the hand-size discard", () => {
	it("duelRule 1: after the forced discard the core opens a chain window and fires discard triggers", async () => {
		const result = await runScenario(1);
		// eslint-disable-next-line no-console
		console.log("duelRule=1 after-discard observations:", JSON.stringify(result));
		expect(result.discardSeen).toBe(true);
		expect(result.handAfterDiscard).toBe(6);

		// A free-chain window is offered to P0 after the discard, with the Set
		// Forced Requisition (EVENT_DISCARD activation) available.
		const p0Windows = result.afterDiscard.filter((o) => o.kind === "SelectChain" && o.player === 0);
		expect(p0Windows.some((w) => w.codes.includes(FORCED_REQUISITION))).toBe(true);

		// Night Assailant discarded for hand size triggers (EVENT_TO_GRAVE from hand).
		expect(result.afterDiscard.some((o) => o.kind === "Chaining" && o.codes.includes(NIGHT_ASSAILANT))).toBe(true);
	});
});
