// Чистый модуль расчётов: без зависимостей от сервера, сети и времени.
// Одна функция evaluate() пересчитывает всё состояние команды из её решений.
import type {
  City, Cond, CostRule, Decisions, GameData, IndicatorKey, Joker, Measure, Mode, NegativeJoker, PositiveJoker, Vector,
} from './types.ts';
import { INDICATORS } from './types.ts';

export type Stage = 'budget' | 'neg' | 'corr1' | 'pos' | 'corr2' | 'closing';

/** Итоговый статус меры в портфеле. */
export type ItemStatus =
  | 'full' // полная (оплачена целиком)
  | 'grant' // полностью запущена благодаря джокеру (грант / партнёр)
  | 'conditional' // подготовлена, решение о запуске ещё не принято
  | 'launched' // условная, запущена на закрытии
  | 'notLaunched' // условная, не запущена на закрытии (половина эффекта)
  | 'cancelled'; // снята в корректировке: полная — возврат части цены, условная — «Позже» не платится; эффект урезан

export interface Item {
  code: string;
  initialMode: Mode;
  round: 0 | 1 | 2 | 'pos';
  status: ItemStatus;
  /** Уплачено командой по этой мере, у.е. */
  paid: number;
  /** «Позже» после скидок (для условных). */
  laterDue: number;
  laterDiscount: number;
  /** Возврат при снятии полной меры. */
  refund: number;
  effects: Vector;
}

export interface LedgerEntry {
  stage: Stage;
  text: string;
  amount: number; // < 0 расход
  balance: number;
  measure?: string;
}

export interface NegCost {
  code: string;
  base: number;
  cost: number;
  applied: string[] | null; // меры правила, давшего итоговую цену
  options: { measures: string[]; cost: number }[];
  explanation: string;
}

export interface PosOffer {
  code: string;
  kind: string;
  available: boolean;
  cost: number;
  reason: string;
  /** Что получит команда при использовании. */
  gain: string;
  /** Для гранта: меры, которые можно выбрать, с доплатой команды и покрытием гранта. */
  choices?: { code: string; teamPays: number; grantCovers: number }[];
}

export interface FinalResult {
  start: Vector;
  effects: Vector;
  jokerBonus: Vector;
  penalty: number;
  reserveBonus: number;
  raw: Vector;
  final: Vector;
  delta: Vector;
  deltaSum: number;
  startIndex: number;
  cityIndex: number;
  resilienceIndex: number;
  resilienceCount: number;
  itemCount: number;
  deficit: number;
  reserve: number;
  /** Сколько баллов штрафа перенесено с Экономики на другие показатели (правило penaltySpill). */
  spilled: number;
}

export interface Evaluation {
  items: Item[];
  ledger: LedgerEntry[];
  /** Текущий резерв (может быть < 0: дефицит). */
  reserve: number;
  /** Потрачено на текущий момент. */
  spent: number;
  /** Сумма «Позже» по ещё не решённым условным мерам (с учётом известных скидок). */
  laterCommitments: number;
  /** Резерв на закрытии, если запустить все условные меры. */
  forecast: number;
  /** Штраф, который получится при прогнозе. */
  forecastPenalty: number;
  neg?: NegCost;
  pos?: PosOffer & { used: boolean; decided: boolean; measure?: string };
  /** Меры, удешевившие негативный джокер: снимать нельзя. */
  locked: string[];
  /** Расходы шага «Бюджет» (нельзя больше стартового бюджета). */
  budgetSpent: number;
  errors: string[];
  final?: FinalResult;
}

// ---------- вспомогательное ----------

export const zero = (): Vector => ({ econ: 0, social: 0, infra: 0, eco: 0, human: 0, adapt: 0 });
const add = (a: Vector, b: Vector, k = 1): Vector => {
  const r = { ...a };
  for (const i of INDICATORS) r[i] += b[i] * k;
  return r;
};
/** Эффект подготовленной, но не запущенной меры: доля, округление к нулю. */
export const partialEffects = (e: Vector, share: number): Vector => {
  const r = zero();
  for (const i of INDICATORS) r[i] = Math.trunc(e[i] * share) || 0;
  return r;
};
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const sumV = (v: Vector) => INDICATORS.reduce((s, k) => s + v[k], 0);

export function condHolds(c: Cond, has: Set<string>): boolean {
  if (c.all && !c.all.every((m) => has.has(m))) return false;
  if (c.any && !c.any.some((m) => has.has(m))) return false;
  if (c.none && c.none.some((m) => has.has(m))) return false;
  return true;
}

/**
 * Цена по правилам: из всех применимых правил берётся минимальная цена;
 * если не применимо ни одно — базовая. Цена не бывает отрицательной.
 */
export function ruleCost(base: number, rules: CostRule[], has: Set<string>) {
  const options = rules
    .filter((r) => condHolds(r, has))
    .map((r) => ({ measures: [...(r.all ?? []), ...(r.any ?? []).filter((m) => has.has(m))], cost: Math.max(0, r.cost ?? base + (r.delta ?? 0)) }));
  if (!options.length) return { cost: base, applied: null as string[] | null, options };
  const best = options.reduce((a, b) => (b.cost < a.cost || (b.cost === a.cost && b.measures.length > a.measures.length) ? b : a));
  return { cost: best.cost, applied: best.measures, options };
}

export function negativeCost(j: NegativeJoker, has: Set<string>, texts = true): NegCost {
  const { cost, applied, options } = ruleCost(j.baseCost, j.rules, has);
  if (!texts) return { code: j.code, base: j.baseCost, cost, applied, options, explanation: '' };
  let explanation: string;
  if (!applied) explanation = j.rules.length ? `${j.baseCost} у.е.: в портфеле нет мер, снижающих расходы` : `${j.baseCost} у.е.: подготовка на этот джокер не влияет`;
  else if (cost > j.baseCost) {
    const r = j.rules.find((r) => condHolds(r, has) && (r.cost ?? 0) === cost)!;
    explanation = `${j.baseCost} → ${cost} у.е.: есть ${(r.all ?? []).join(', ')}, но нет ${(r.none ?? []).join(', ')}`;
  } else explanation = `${j.baseCost} → ${cost} у.е. из-за ${applied.join(' + ')}`;
  if (options.length > 1) explanation += ` (применимо несколько правил: ${options.map((o) => `${o.measures.join('+')} → ${o.cost}`).join('; ')}; берётся минимальная цена)`;
  return { code: j.code, base: j.baseCost, cost, applied, options, explanation };
}

// ---------- основной расчёт ----------

export interface EvalContext {
  data: GameData;
  measures: Map<string, Measure>;
  jokers: Map<string, Joker>;
  cities: Map<string, City>;
}
const ctxCache = new WeakMap<GameData, EvalContext>();
export function context(data: GameData): EvalContext {
  let c = ctxCache.get(data);
  if (!c) {
    c = {
      data,
      measures: new Map(data.measures.map((m) => [m.code, m])),
      jokers: new Map(data.jokers.map((j) => [j.code, j])),
      cities: new Map(data.cities.map((c) => [c.id, c])),
    };
    ctxCache.set(data, c);
  }
  return c;
}

/** Предложение положительного джокера при текущем портфеле и резерве. */
export function positiveOffer(j: PositiveJoker, items: Map<string, Item>, reserve: number, ctx: EvalContext): PosOffer {
  const active = new Set([...items.values()].filter((i) => i.status !== 'cancelled').map((i) => i.code));
  const r = j.rule;
  const bonusTxt = j.bonus ? ` +${j.bonus.value} к показателю «${ctx.data.indicators.find((i) => i.key === j.bonus!.indicator)!.label}»` : '';
  const money = (cost: number, gain: string, cond = true, condReason = ''): PosOffer => {
    if (!cond) return { code: j.code, kind: r.kind, available: false, cost, reason: condReason, gain };
    if (cost > reserve) return { code: j.code, kind: r.kind, available: false, cost, reason: `нужно ${cost} у.е., в резерве ${reserve} у.е. — возможность теряется`, gain };
    return { code: j.code, kind: r.kind, available: true, cost, reason: cost ? `стоимость ${cost} у.е. из резерва` : 'без расходов', gain };
  };
  switch (r.kind) {
    case 'none':
      return { code: j.code, kind: 'none', available: false, cost: 0, reason: 'ничего не происходит', gain: '' };
    case 'pay': {
      const { cost, applied } = ruleCost(r.cost, r.rules, active);
      const o = money(cost, `бонус${bonusTxt}`);
      if (applied && o.available) o.reason = `${r.cost} → ${cost} у.е. благодаря ${applied.join(' / ')}`;
      return o;
    }
    case 'laterDiscount': {
      const have = r.any.filter((m) => active.has(m));
      return money(0, `«Позже» ${r.any.join(' и ')} на закрытии дешевле на ${r.discount} у.е.;${bonusTxt}`, have.length > 0,
        `нужна хотя бы одна из мер ${r.any.join(', ')} — возможность теряется`);
    }
    case 'partner': {
      if (active.has(r.measure)) return money(0, `«Позже» ${r.measure} дешевле на ${r.discount} у.е.;${bonusTxt}`);
      return money(r.launchCost, `${r.measure} запускается сразу полностью за ${r.launchCost} у.е.;${bonusTxt}`);
    }
    case 'grant': {
      const choices = r.eligible
        .filter((c) => {
          const it = items.get(c);
          return !it || it.status === 'conditional' || it.status === 'cancelled';
        })
        .map((c) => {
          const m = ctx.measures.get(c)!;
          const it = items.get(c);
          const rest = it?.status === 'conditional' ? m.later : m.full;
          return { code: c, teamPays: r.ownCost, grantCovers: Math.max(0, rest - r.ownCost) };
        });
      const o = money(r.ownCost, `одна мера из списка запускается полностью, остальное покрывает грант;${bonusTxt}`, choices.length > 0,
        'все меры из списка уже запущены полностью');
      return { ...o, choices };
    }
  }
}

export function evaluate(data: GameData, d: Decisions, opts: { texts?: boolean } = {}): Evaluation {
  const texts = opts.texts !== false;
  const ctx = context(data);
  const rules = data.rules;
  const errors: string[] = [];
  const city = ctx.cities.get(d.cityId);
  if (!city) throw new Error(`Неизвестный город ${d.cityId}`);
  let reserve = city.startBudget ?? rules.startBudget;
  const ledger: LedgerEntry[] = [];
  const items = new Map<string, Item>();
  const pay = (stage: Stage, amount: number, text: string | (() => string), measure?: string) => {
    if (amount === 0 && stage !== 'neg') return;
    reserve -= amount;
    if (texts) ledger.push({ stage, text: typeof text === 'function' ? text() : text, amount: -amount, balance: reserve, measure });
  };
  const note = (stage: Stage, text: () => string, measure?: string) => {
    if (texts) ledger.push({ stage, text: text(), amount: 0, balance: reserve, measure });
  };
  const m = (c: string) => {
    const x = ctx.measures.get(c);
    if (!x) throw new Error(`Неизвестная мера ${c}`);
    return x;
  };
  const addRound = (round: 0 | 1 | 2, stage: Stage) => {
    for (const [code, mode] of Object.entries(d.rounds[round] ?? {})) {
      const ms = m(code);
      if (items.has(code)) { errors.push(`${code} уже в портфеле`); continue; }
      if (mode === 'conditional' && !ms.conditionalAllowed) { errors.push(`${code} не может быть условной`); continue; }
      const price = mode === 'full' ? ms.full : ms.now;
      items.set(code, {
        code, initialMode: mode, round, status: mode === 'full' ? 'full' : 'conditional', paid: price,
        laterDue: mode === 'full' ? 0 : ms.later, laterDiscount: 0, refund: 0, effects: zero(),
      });
      pay(stage, price, () => mode === 'full' ? `${code} «${ms.name}» — полная` : `${code} «${ms.name}» — подготовка (Сейчас)`, code);
    }
  };
  let locked = new Set<string>();
  const refundShare = rules.fullRefundShare ?? 0;
  const cancel = (idx: 0 | 1, stage: Stage) => {
    for (const code of d.cancels[idx] ?? []) {
      const it = items.get(code);
      if (!it || (it.status !== 'conditional' && it.status !== 'full')) { errors.push(`Снять можно только полную или условную меру из портфеля (${code})`); continue; }
      if (locked.has(code)) { errors.push(`${code} удешевила негативный джокер — снимать нельзя`); continue; }
      if (it.status === 'full') {
        const refund = Math.floor(m(code).full * refundShare);
        it.refund = refund;
        it.paid -= refund;
        reserve += refund;
        if (texts) ledger.push({ stage, text: `${code} — полная мера снята: возврат ${Math.round(refundShare * 100)}% (${refund} у.е.), эффект урезан`, amount: refund, balance: reserve, measure: code });
      } else {
        note(stage, () => `${code} — условная мера снята: «Позже» не платится, «Сейчас» ${it.paid} у.е. не возвращается, эффект урезан`, code);
      }
      it.status = 'cancelled';
      it.laterDue = 0;
    }
  };
  const activeSet = () => new Set([...items.values()].filter((i) => i.status !== 'cancelled').map((i) => i.code));

  // 1. Бюджет
  addRound(0, 'budget');
  const budgetSpent = (city.startBudget ?? rules.startBudget) - reserve;
  if (reserve < 0) errors.push('На шаге «Бюджет» потрачено больше стартового бюджета');

  // 2. Негативный джокер
  let neg: NegCost | undefined;
  if (d.negJoker) {
    const j = ctx.jokers.get(d.negJoker);
    if (!j || j.basket !== 'negative') throw new Error(`Неизвестный негативный джокер ${d.negJoker}`);
    const nc = negativeCost(j, activeSet(), texts);
    neg = nc;
    pay('neg', nc.cost, () => `Джокер ${j.code} «${j.name}»: ${nc.explanation}`);
    if (nc.applied && nc.cost < nc.base) locked = new Set(nc.applied);
  }

  // 3. Корректировка 1
  cancel(0, 'corr1');
  const r1Start = reserve;
  addRound(1, 'corr1');
  if (r1Start - reserve > Math.max(0, r1Start)) errors.push('В корректировке 1 потрачено больше резерва');

  // 4. Положительный джокер
  let pos: Evaluation['pos'];
  const bonus = zero();
  const discounts = new Map<string, number>();
  if (d.posJoker) {
    const j = ctx.jokers.get(d.posJoker);
    if (!j || j.basket !== 'positive') throw new Error(`Неизвестный положительный джокер ${d.posJoker}`);
    const offer = positiveOffer(j, items, reserve, ctx);
    const decided = !!d.posDecision;
    let used = false;
    if (d.posDecision?.use) {
      if (!offer.available) errors.push(`Джокер ${j.code} недоступен: ${offer.reason}`);
      else {
        const r = j.rule;
        if (r.kind === 'grant') {
          const code = d.posDecision.measure;
          const ch = offer.choices?.find((c) => c.code === code);
          if (!code || !ch) errors.push('Для гранта нужно выбрать меру из списка');
          else {
            used = true;
            const ms = m(code);
            const it = items.get(code);
            if (it) {
              it.status = 'grant'; it.laterDue = 0; it.paid += r.ownCost;
            } else {
              items.set(code, { code, initialMode: 'full', round: 'pos', status: 'grant', paid: r.ownCost, laterDue: 0, laterDiscount: 0, refund: 0, effects: zero() });
            }
            pay('pos', r.ownCost, () => `Джокер ${j.code} «${j.name}»: ${code} «${ms.name}» запущена полностью, команда платит ${r.ownCost}, грант покрывает ${ch.grantCovers}`, code);
          }
        } else if (r.kind === 'partner' && !activeSet().has(r.measure)) {
          used = true;
          const ms = m(r.measure);
          const prev = items.get(r.measure); // отменённая ранее мера запускается заново
          items.set(r.measure, { code: r.measure, initialMode: 'full', round: 'pos', status: 'grant', paid: (prev?.paid ?? 0) + r.launchCost, laterDue: 0, laterDiscount: 0, refund: 0, effects: zero() });
          pay('pos', r.launchCost, () => `Джокер ${j.code} «${j.name}»: ${r.measure} «${ms.name}» запущена сразу`, r.measure);
        } else {
          used = true;
          if (r.kind === 'partner') discounts.set(r.measure, r.discount);
          if (r.kind === 'laterDiscount') for (const c of r.any) discounts.set(c, r.discount);
          if (offer.cost) pay('pos', offer.cost, () => `Джокер ${j.code} «${j.name}»: использован (${offer.reason})`);
          else note('pos', () => `Джокер ${j.code} «${j.name}»: использован без расходов — ${offer.gain}`);
        }
        if (used && j.bonus) bonus[j.bonus.indicator] += j.bonus.value;
      }
    } else if (decided) {
      note('pos', () => `Джокер ${j.code} «${j.name}»: ${offer.available ? 'команда пропустила' : 'возможность потеряна — ' + offer.reason}`);
    }
    pos = { ...offer, used, decided, measure: d.posDecision?.measure };
  }

  // 5. Корректировка 2
  cancel(1, 'corr2');
  const r2Start = reserve;
  addRound(2, 'corr2');
  if (r2Start - reserve > Math.max(0, r2Start)) errors.push('В корректировке 2 потрачено больше резерва');

  // Скидки на «Позже»
  for (const it of items.values()) {
    if (it.status !== 'conditional') continue;
    const disc = discounts.get(it.code) ?? 0;
    const later = m(it.code).later;
    it.laterDiscount = Math.min(disc, later);
    it.laterDue = Math.max(0, later - disc);
  }

  // 6. Закрытие
  if (d.closing) {
    for (const it of items.values()) {
      if (it.status !== 'conditional') continue;
      const dec = d.closing[it.code];
      if (dec?.launch && rules.closingNoDebt && reserve - it.laterDue < 0) {
        errors.push(`${it.code}: не хватает резерва на запуск (${reserve} < ${it.laterDue})`);
        it.status = 'notLaunched';
      } else if (dec?.launch) {
        it.status = 'launched';
        it.paid += it.laterDue;
        pay('closing', it.laterDue, () => `${it.code} — запуск на закрытии (Позже ${m(it.code).later}${it.laterDiscount ? ` − скидка ${it.laterDiscount}` : ''})`, it.code);
        if (it.laterDue === 0) note('closing', () => `${it.code} — запуск на закрытии без доплаты (скидка покрыла «Позже»)`, it.code);
      } else {
        it.status = 'notLaunched';
        note('closing', () => `${it.code} — не запускаем (остаётся половина эффекта)`, it.code);
      }
    }
  }

  // Эффекты
  for (const it of items.values()) {
    const e = m(it.code).effects;
    it.effects =
      it.status === 'cancelled' ? partialEffects(e, rules.removedEffectShare ?? 0)
      : it.status === 'conditional' || it.status === 'notLaunched' ? partialEffects(e, rules.conditionalShare)
      : { ...e };
  }

  const pending = [...items.values()].filter((i) => i.status === 'conditional');
  const laterCommitments = pending.reduce((s, i) => s + i.laterDue, 0);
  const forecast = reserve - laterCommitments;
  const penaltyFor = (r: number) => (r < 0 ? Math.ceil(-r / rules.penaltyStep) : 0);
  const spent = (city.startBudget ?? rules.startBudget) - reserve;

  const ev: Evaluation = {
    items: [...items.values()], ledger, reserve, spent, laterCommitments, forecast, forecastPenalty: penaltyFor(forecast),
    neg, pos, budgetSpent, errors, locked: [...locked],
  };
  if (d.closing) {
    ev.final = finalResult(data, city, ev, bonus);
    const r = resilience(ev, d);
    ev.final.resilienceIndex = r.index;
    ev.final.resilienceCount = r.count;
  }
  return ev;
}

export function finalResult(data: GameData, city: City, ev: Evaluation, jokerBonus: Vector): FinalResult {
  const rules = data.rules;
  const effects = ev.items.reduce((s, i) => add(s, i.effects), zero());
  const deficit = Math.max(0, -ev.reserve);
  const penalty = deficit > 0 ? Math.ceil(deficit / rules.penaltyStep) : 0;
  const reserveBonus = ev.reserve > 0 ? Math.min(rules.reserveBonusMax, Math.floor(ev.reserve / rules.reserveBonusStep)) : 0;
  const raw = add(add(city.start, effects), jokerBonus);
  raw[rules.penaltyIndicator] -= penalty;
  raw[rules.reserveBonusIndicator] += reserveBonus;
  const final = zero();
  const delta = zero();
  for (const k of INDICATORS) final[k] = clamp(raw[k], rules.min, rules.max);
  let spilled = 0;
  if (rules.penaltySpill && penalty > 0) {
    const pi = rules.penaltyIndicator;
    let overflow = Math.min(penalty, Math.max(0, rules.min - raw[pi]));
    while (overflow > 0) {
      const k = INDICATORS.filter((x) => x !== pi && final[x] > rules.min).sort((a, b) => final[b] - final[a])[0];
      if (!k) break;
      final[k] -= 1;
      overflow--;
      spilled++;
    }
  }
  for (const k of INDICATORS) delta[k] = final[k] - city.start[k];
  const counted = ev.items.filter((i) => i.status !== 'cancelled');
  return {
    start: { ...city.start }, effects, jokerBonus, penalty, reserveBonus, raw, final, delta, deltaSum: sumV(delta),
    startIndex: sumV(city.start) / 6, cityIndex: sumV(final) / 6, resilienceIndex: 0, resilienceCount: 0, itemCount: counted.length,
    deficit, reserve: ev.reserve, spilled,
  };
}

/** Индекс устойчивости: доля мер портфеля (кроме отменённых), отмеченных полезными минимум в 3 из 4 сценариев. */
export function resilience(ev: Evaluation, d: Decisions, threshold = 3) {
  const counted = ev.items.filter((i) => i.status !== 'cancelled');
  const ok = counted.filter((i) => (d.marks[i.code]?.scenarios ?? []).filter(Boolean).length >= threshold).length;
  return { count: ok, total: counted.length, index: counted.length ? ok / counted.length : 0 };
}

export const emptyDecisions = (cityId: string): Decisions => ({ cityId, rounds: [{}, {}, {}], cancels: [[], []], marks: {} });
export const indicatorLabel = (data: GameData, k: IndicatorKey) => data.indicators.find((i) => i.key === k)!.label;
