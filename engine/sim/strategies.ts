// Стратегии и прогон одной партии команды для симуляции экономики.
import { evaluate, partialEffects } from '../src/engine.ts';
import type { Decisions, GameData, Mode, Vector } from '../src/types.ts';
import { INDICATORS } from '../src/types.ts';

export type Closing = 'none' | 'affordable' | 'all';
export interface Strategy {
  name: string;
  /** Портфель шага «Бюджет». */
  init: Record<string, Mode>;
  /** Приоритет мер для докупки в корректировках. */
  order: string[];
  corrMode: Mode;
  /** Сколько резерва оставлять в корректировках; Infinity = не докупать. */
  keep: number;
  usePos: 'always' | 'freeOnly' | 'never';
  closing: Closing;
  /** Снятие мер в корректировке 1: нет / только при дефиците / все незаблокированные полные (возврат 80%). */
  drop: 'none' | 'deficit' | 'unlocked';
}

export interface RunResult {
  delta: number; // Δ суммы шести показателей
  deficit: number;
  reserve: number;
  penalty: number;
  /** Штраф, «съеденный» нижней границей шкалы (Экономика уже 1). */
  penaltyLostToClamp: number;
  /** Баллы, потерянные из-за верхней границы 10. */
  lostToCeiling: number;
  negCost: number;
  posUsed: boolean;
  posCost: number;
  violations: string[];
}

const sumV = (v: Vector) => INDICATORS.reduce((s, k) => s + v[k], 0);

export function playOnce(data: GameData, cityId: string, s: Strategy, neg: string, pos: string): RunResult {
  const measures = new Map(data.measures.map((m) => [m.code, m]));
  const d: Decisions = { cityId, rounds: [{ ...s.init }, {}, {}], cancels: [[], []], marks: {}, negJoker: neg };
  const fast = { texts: false };
  const correct = (round: 1 | 2) => {
    if (round === 1 && s.drop !== 'none') {
      const ev0 = evaluate(data, d, fast);
      let r = ev0.reserve;
      const removable = ev0.items.filter((i) => (i.status === 'full' || i.status === 'conditional') && !ev0.locked.includes(i.code));
      const refundOf = (c: string) => Math.floor(measures.get(c)!.full * (data.rules.fullRefundShare ?? 0));
      if (s.drop === 'unlocked') {
        for (const i of removable) if (i.status === 'full') d.cancels[0].push(i.code);
      } else {
        // при дефиците снимаем полные с наибольшим возвратом, пока резерв не станет ≥ 0
        for (const i of removable.filter((x) => x.status === 'full').sort((a, b) => refundOf(b.code) - refundOf(a.code))) {
          if (r >= 0) break;
          d.cancels[0].push(i.code);
          r += refundOf(i.code);
        }
      }
    }
    if (!Number.isFinite(s.keep)) return;
    let ev = evaluate(data, d, fast);
    let reserve = ev.reserve;
    const have = new Set(ev.items.map((i) => i.code));
    for (const code of s.order) {
      if (have.has(code)) continue;
      const m = measures.get(code)!;
      const mode: Mode = s.corrMode === 'conditional' && m.conditionalAllowed ? 'conditional' : 'full';
      const price = mode === 'full' ? m.full : m.now;
      if (reserve - price >= s.keep && reserve - price >= 0) {
        d.rounds[round][code] = mode;
        reserve -= price;
        have.add(code);
      }
    }
  };
  correct(1);
  d.posJoker = pos;
  let ev = evaluate(data, d, fast);
  const offer = ev.pos!;
  let use = offer.available && (s.usePos === 'always' || (s.usePos === 'freeOnly' && offer.cost === 0));
  let measure: string | undefined;
  if (use && offer.choices) {
    // грант: мера с наибольшим приростом баллов
    const gain = (c: string) => {
      const m = measures.get(c)!;
      const it = ev.items.find((i) => i.code === c && i.status === 'conditional');
      return sumV(m.effects) - (it ? sumV(partialEffects(m.effects, data.rules.conditionalShare)) : 0) + (it ? 0 : 0.01 * m.full);
    };
    measure = [...offer.choices].sort((a, b) => gain(b.code) - gain(a.code))[0]?.code;
    if (!measure) use = false;
  }
  d.posDecision = { use, measure };
  correct(2);
  ev = evaluate(data, d, fast);
  const closing: Decisions['closing'] = {};
  const pending = ev.items.filter((i) => i.status === 'conditional');
  if (s.closing === 'all' && !data.rules.closingNoDebt) for (const i of pending) closing[i.code] = { launch: true };
  else if (s.closing === 'all') {
    // без долга: запускаем всё, на что хватает, в порядке каталога
    let r = ev.reserve;
    for (const i of pending) { const ok = r - i.laterDue >= 0; closing[i.code] = { launch: ok }; if (ok) r -= i.laterDue; }
  }
  else if (s.closing === 'affordable') {
    let r = ev.reserve;
    const gain = (c: string) => {
      const e = measures.get(c)!.effects;
      return sumV(e) - sumV(partialEffects(e, data.rules.conditionalShare));
    };
    const sorted = [...pending].sort((a, b) => gain(b.code) / (b.laterDue || 0.1) - gain(a.code) / (a.laterDue || 0.1));
    for (const i of sorted) {
      const ok = gain(i.code) > 0 && r - i.laterDue >= 0;
      closing[i.code] = { launch: ok };
      if (ok) r -= i.laterDue;
    }
  }
  d.closing = closing;
  ev = evaluate(data, d, fast);
  const f = ev.final!;
  const violations: string[] = [];
  for (const k of INDICATORS) if (f.final[k] < data.rules.min || f.final[k] > data.rules.max) violations.push(`показатель ${k}=${f.final[k]}`);
  for (const i of ev.items) if (i.laterDue < 0 || i.paid < 0) violations.push(`${i.code}: отрицательная цена`);
  if (ev.neg!.cost < 0) violations.push('отрицательная цена джокера');
  if (ev.errors.length) violations.push(...ev.errors);
  const pi = data.rules.penaltyIndicator;
  const city = data.cities.find((c) => c.id === cityId)!;
  const beforePenalty = f.raw[pi] + f.penalty;
  const effectivePenalty = Math.min(data.rules.max, Math.max(data.rules.min, beforePenalty)) - f.final[pi] + f.spilled;
  let lostToCeiling = 0;
  for (const k of INDICATORS) {
    const noPen = f.raw[k] + (k === pi ? f.penalty : 0);
    if (noPen > data.rules.max) lostToCeiling += noPen - data.rules.max;
  }
  void city;
  return {
    delta: f.deltaSum, deficit: f.deficit, reserve: f.reserve, penalty: f.penalty,
    penaltyLostToClamp: f.penalty - effectivePenalty, lostToCeiling,
    negCost: ev.neg!.cost, posUsed: !!ev.pos?.used, posCost: ev.pos?.used ? ev.pos.cost : 0, violations,
  };
}

// ---------- генераторы стратегий ----------

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffle = <T,>(arr: T[], r: () => number) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export function randomStrategy(data: GameData, r: () => number, i: number): Strategy {
  const order = shuffle(data.measures.map((m) => m.code), r);
  const target = r() * data.rules.startBudget;
  const pFull = r();
  const init: Record<string, Mode> = {};
  let spent = 0;
  const minFull = data.rules.minFullMeasures ?? 0;
  for (const code of order.filter((c) => data.measures.find((x) => x.code === c)!.full <= 40).slice(0, minFull)) {
    init[code] = 'full';
    spent += data.measures.find((x) => x.code === code)!.full;
  }
  for (const code of order) {
    if (init[code]) continue;
    const m = data.measures.find((x) => x.code === code)!;
    const mode: Mode = r() < pFull || !m.conditionalAllowed ? 'full' : 'conditional';
    const price = mode === 'full' ? m.full : m.now;
    if (spent + price <= target) { init[code] = mode; spent += price; }
  }
  const keeps = [0, 5, 10, 15, 20, 30, Infinity];
  return {
    name: `random#${i}`,
    init,
    order: shuffle(order, r),
    corrMode: r() < 0.5 ? 'full' : 'conditional',
    keep: keeps[Math.floor(r() * keeps.length)],
    usePos: r() < 0.7 ? 'always' : r() < 0.5 ? 'freeOnly' : 'never',
    closing: (['none', 'affordable', 'all'] as const)[Math.floor(r() * 3)],
    drop: (['none', 'deficit', 'unlocked'] as const)[Math.floor(r() * 3)],
  };
}

/** Жадный выбор полных мер по приросту баллов на 1 у.е. с учётом потолка 10 для данного города. */
export function greedyStrategy(data: GameData, cityId: string, keep = 0, name = 'Жадный: баллы/у.е.'): Strategy {
  const city = data.cities.find((c) => c.id === cityId)!;
  const cur = { ...city.start };
  const init: Record<string, Mode> = {};
  let budget = data.rules.startBudget - keep;
  const gainOf = (e: Vector) => INDICATORS.reduce((s, k) => s + (Math.min(data.rules.max, cur[k] + e[k]) - cur[k]), 0);
  for (;;) {
    const best = data.measures
      .filter((m) => !init[m.code] && m.full <= budget)
      .map((m) => ({ m, v: gainOf(m.effects) / m.full }))
      .sort((a, b) => b.v - a.v)[0];
    if (!best || best.v <= 0) break;
    init[best.m.code] = 'full';
    budget -= best.m.full;
    for (const k of INDICATORS) cur[k] = Math.min(data.rules.max, cur[k] + best.m.effects[k]);
  }
  const order = data.measures.map((m) => m.code).sort((a, b) => {
    const ma = data.measures.find((m) => m.code === a)!, mb = data.measures.find((m) => m.code === b)!;
    return sumV(mb.effects) / mb.full - sumV(ma.effects) / ma.full;
  });
  return { name, init, order, corrMode: 'full', keep: Number.isFinite(keep) ? 0 : Infinity, usePos: 'always', closing: 'affordable', drop: 'none' };
}

export function namedStrategies(data: GameData, cityId: string): Strategy[] {
  const order = data.measures.map((m) => m.code);
  // «Всё условно» с обязательными двумя полными: две самые дешёвые полные (M4, M6) + всё остальное условно
  const allCond: Record<string, Mode> = { M4: 'full', M6: 'full' };
  let spent = 33;
  for (const m of data.measures) if (m.conditionalAllowed && !allCond[m.code] && spent + m.now <= 100) { allCond[m.code] = 'conditional'; spent += m.now; }
  const base = { order, corrMode: 'full' as Mode, keep: Infinity, usePos: 'always' as const, drop: 'none' as const };
  const greedy = greedyStrategy(data, cityId, 0);
  return [
    { ...base, name: 'Две полные (M4, M6) + всё условно, запуск по средствам', init: allCond, closing: 'affordable' },
    { ...base, name: 'Две полные + всё условно, запуск всего в долг', init: allCond, closing: 'all' },
    { ...base, name: 'Копить: только две дешёвые полные (M4, M6)', init: { M4: 'full', M6: 'full' }, usePos: 'freeOnly', closing: 'none' },
    { ...base, name: 'Только дешёвые M13/M4/M2 (полные)', init: { M13: 'full', M4: 'full', M2: 'full' }, usePos: 'freeOnly', closing: 'none' },
    greedy,
    greedyStrategy(data, cityId, 20, 'Жадный + резерв 20 на джокеры'),
    { ...greedy, name: 'Обход: всё полным, после джокера снять незадействованные (80%) и докупить', drop: 'unlocked', keep: 0 },
  ];
}
