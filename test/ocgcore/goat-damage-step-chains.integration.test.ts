/**
 * Goat Format rule #10 probes — Damage Step chain windows.
 *
 * goatformat.com/basics.html:
 *   10A, substep 3 (Damage Calculation part 1): "players may activate other
 *       effects that alter the ATK and/or DEF of a monster" — an ATK modifier
 *       such as Rush Recklessly is legal in the damage-calculation timing.
 *   10B: "only one Chain can occur during each substep of the Damage Step
 *       (unless the resolution of one Chain triggers some other effect)".
 *       Example: Limiter Removal negated during damage calculation → no second
 *       Limiter Removal before the battle is decided.
 *
 * Probe A (10A): with one Set Rush Recklessly, list every pre-MSG_BATTLE
 *   SelectChain window inside the Damage Step and whether RR is offered in it.
 *   The last pre-MSG_BATTLE window pair is the TIMING_DAMAGE_CAL window
 *   (processor.cpp case 24). Modern core: RR (EFFECT_FLAG_DAMAGE_STEP only)
 *   should be absent there.
 *
 * Probe B (10B): with two Set Rush Recklessly, activate the first one in the
 *   first window where it is offered and record whether the second copy is
 *   offered again before the next substep marker (HINT_EVENT 41/42 and
 *   MSG_BATTLE are the substep boundaries). Modern core re-opens the window
 *   after a chain resolves in the same timing; Goat wants no re-offer.
 *
 * Scenario: T1 P0 summons LIGHT_VANILLA (1100) and sets RR (×1 or ×2).
 *           T2 P1 summons Kojikocy (1500) and attacks LIGHT_VANILLA.
 */
import {
	BattleCmdType,
	IdleCmdType,
	YGOProMsgBattle,
	YGOProMsgChaining,
	YGOProMsgDamageStepEnd,
	YGOProMsgDamageStepStart,
	YGOProMsgHint,
	YGOProMsgSelectBattleCmd,
	YGOProMsgSelectChain,
	YGOProMsgSelectIdleCmd,
} from "ygopro-msg-encode";
import { HeadlessDuel } from "./headless-duel";
import { FIXED_SEED, buildDeck } from "./test-fixtures";

jest.setTimeout(60_000);

const RUSH_RECKLESSLY = 70046172;
const LIGHT_VANILLA = 2863439; // 1100/1400
const KOJIKOCY = 1184620; // 1500/1200

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
	if (!card) {
		throw new Error(
			`card ${code} not ssetable; ssetable=[${idle.ssetableCards.map((c) => c.code).join(",")}] ` +
				`summonable=[${idle.summonableCards.map((c) => c.code).join(",")}] hand=${duel.queryHandCount(0)} ` +
				`canBp=${JSON.stringify((idle as unknown as Record<string, unknown>).enableBp)}`,
		);
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

type Trace = string[];

async function runScenario(opts: { rrCopies: 1 | 2; activateFirstRr: boolean; duelRule: number }): Promise<Trace> {
	const duel = await HeadlessDuel.create({
		decks: [{ main: buildDeck([LIGHT_VANILLA, ...Array(opts.rrCopies).fill(RUSH_RECKLESSLY)]) }, { main: buildDeck([KOJIKOCY]) }],
		duelRule: opts.duelRule,
		seed: FIXED_SEED,
	});
	try {
		// T1 P0
		let idle = (await duel.advanceUntil(YGOProMsgSelectIdleCmd)).targetMessage;
		idle = await summon(duel, idle, LIGHT_VANILLA);
		for (let i = 0; i < opts.rrCopies; i++) idle = await sset(duel, idle, RUSH_RECKLESSLY);
		duel.setResponse(idle.prepareResponse(IdleCmdType.TO_EP));
		// T2 P1
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
		// Battle Step windows (before DamageStepStart) are auto-declined by the built-in responder.
		await duel.advanceUntil(YGOProMsgDamageStepStart);

		// Drive the Damage Step window by window.
		const trace: Trace = [];
		let activated = 0;
		for (let guard = 0; guard < 60; guard++) {
			const { targetMessage, allMessages } = await duel.advanceUntilOneOf([
				YGOProMsgSelectChain,
				YGOProMsgDamageStepEnd,
			]);
			for (const m of allMessages) {
				if (m instanceof YGOProMsgChaining) trace.push(`CHAINING ${m.code}`);
				else if (m instanceof YGOProMsgBattle) trace.push("MSG_BATTLE");
				else if (m instanceof YGOProMsgHint && m.type === 4 && m.player === 0) trace.push(`HINT_EVENT ${m.desc}`);
			}
			if (targetMessage instanceof YGOProMsgDamageStepEnd) break;
			const sc = targetMessage as YGOProMsgSelectChain;
			trace.push(`SelectChain p${sc.player} [${sc.chains.map((c) => `${c.code}@${c.location}.${c.sequence}`).join(",")}]`);
			const rr = sc.chains.find((c) => c.code === RUSH_RECKLESSLY);
			if (opts.activateFirstRr && activated === 0 && rr) {
				activated++;
				trace.push(`  -> activate ${rr.code}@${rr.location}.${rr.sequence}`);
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

describe("Goat rule #10 probes — Damage Step windows", () => {
	it("Probe A (10A): where is Rush Recklessly offered, duelRule 1, no activation", async () => {
		const trace = await runScenario({ rrCopies: 1, activateFirstRr: false, duelRule: 1 });
		// eslint-disable-next-line no-console
		console.log("Probe A duelRule=1:\n" + trace.join("\n"));
		expect(trace).toContain("MSG_BATTLE");
	});

	it("Probe B (10B): two RR, activate the first inside the Damage Step; is the second re-offered in the same timing? duelRule 1", async () => {
		const trace = await runScenario({ rrCopies: 2, activateFirstRr: true, duelRule: 1 });
		// eslint-disable-next-line no-console
		console.log("Probe B duelRule=1:\n" + trace.join("\n"));
		expect(trace.some((l) => l.startsWith("CHAINING"))).toBe(true);
	});

	it("Probe B reference: duelRule 5", async () => {
		const trace = await runScenario({ rrCopies: 2, activateFirstRr: true, duelRule: 5 });
		// eslint-disable-next-line no-console
		console.log("Probe B duelRule=5:\n" + trace.join("\n"));
		expect(trace.some((l) => l.startsWith("CHAINING"))).toBe(true);
	});
});
