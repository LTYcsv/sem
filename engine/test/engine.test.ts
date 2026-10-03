import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { evaluate, emptyDecisions, negativeCost, partialEffects, validateData } from '../src/index.ts';
import type { Decisions, GameData, NegativeJoker } from '../src/index.ts';

const loaded: GameData = JSON.parse(readFileSync(new URL('../../data/game_data.json', import.meta.url), 'utf8'));
// Механику проверяем на исходных правилах xlsx (шаг штрафа 5, без переноса); принятая правка — отдельный блок ниже.
const data: GameData = { ...loaded, rules: { ...loaded.rules, penaltyStep: 5, penaltySpill: false } };
const accepted: GameData = { ...loaded, rules: { ...loaded.rules, penaltyStep: 4, penaltySpill: true } };
const city = (name: string) => data.cities.find((c) => c.name === name)!;
const neg = (code: string) => data.jokers.find((j) => j.code === code) as NegativeJoker;
const has = (...m: string[]) => new Set(m);
const dec = (cityName: string, patch: Partial<Decisions> = {}): Decisions => ({ ...emptyDecisions(city(cityName).id), ...patch });

describe('данные', () => {
  it('валидны: Сейчас + Позже = Полная, ссылки на меры существуют', () => {
    expect(validateData(data)).toEqual([]);
    for (const m of data.measures) expect(m.now + m.later).toBe(m.full);
  });
  it('M4 не может быть условной', () => {
    expect(data.measures.find((m) => m.code === 'M4')!.conditionalAllowed).toBe(false);
  });
});

describe('негативные джокеры', () => {
  it('J-1 Паводок: 25 / M3→8 / M13→15 / обе→5', () => {
    expect(negativeCost(neg('J-1'), has()).cost).toBe(25);
    expect(negativeCost(neg('J-1'), has('M3')).cost).toBe(8);
    expect(negativeCost(neg('J-1'), has('M13')).cost).toBe(15);
    expect(negativeCost(neg('J-1'), has('M3', 'M13')).cost).toBe(5);
    expect(negativeCost(neg('J-1'), has('M3')).explanation).toMatch(/^25 → 8 у\.е\. из-за M3/);
  });
  it('J-2 Кибератака: M10 без M4 дороже (20), M4 → 5 даже вместе с M10', () => {
    expect(negativeCost(neg('J-2'), has('M10')).cost).toBe(20);
    expect(negativeCost(neg('J-2'), has('M10', 'M4')).cost).toBe(5);
    expect(negativeCost(neg('J-2'), has()).cost).toBe(15);
  });
  it('J-4: M2 → 20, M7 → 20, обе → 10', () => {
    expect(negativeCost(neg('J-4'), has('M2')).cost).toBe(20);
    expect(negativeCost(neg('J-4'), has('M7')).cost).toBe(20);
    expect(negativeCost(neg('J-4'), has('M2', 'M7')).cost).toBe(10);
  });
  it('J-5: сочетание M1+M16 не описано → минимальная цена 7', () => {
    expect(negativeCost(neg('J-5'), has('M1', 'M16')).cost).toBe(7);
    expect(negativeCost(neg('J-5'), has('M16')).cost).toBe(15);
  });
  it('J-8: M13+M7 → 7, M15 → 10, M13 → 12', () => {
    expect(negativeCost(neg('J-8'), has('M13', 'M7')).cost).toBe(7);
    expect(negativeCost(neg('J-8'), has('M13', 'M15')).cost).toBe(7);
    expect(negativeCost(neg('J-8'), has('M15')).cost).toBe(10);
    expect(negativeCost(neg('J-8'), has('M13')).cost).toBe(12);
  });
  it('J-7 Бюджетный шок: 15 при любом портфеле', () => {
    expect(negativeCost(neg('J-7'), has('M1', 'M2', 'M3', 'M4')).cost).toBe(15);
  });
  it('условная мера тоже считается «есть»; стоимость списывается автоматически', () => {
    const ev = evaluate(data, dec('Промград', { rounds: [{ M3: 'conditional' }, {}, {}], negJoker: 'J-1' }));
    expect(ev.neg!.cost).toBe(8);
    expect(ev.reserve).toBe(100 - 7 - 8);
  });
  it('нехватка резерва уводит его в минус (дефицит)', () => {
    const ev = evaluate(data, dec('Промград', { rounds: [{ M1: 'full', M7: 'full', M11: 'full' }, {}, {}], negJoker: 'J-4' }));
    // 100 − 95 = 5; J-4 при M7 → 20; резерв −15
    expect(ev.reserve).toBe(-15);
  });
});

describe('условные меры', () => {
  it('половина эффекта с округлением к нулю', () => {
    expect(partialEffects({ econ: 1, social: 2, infra: -1, eco: -1, human: 2, adapt: 0 }, 0.5))
      .toEqual({ econ: 0, social: 1, infra: 0, eco: 0, human: 1, adapt: 0 });
  });
  it('незапущенная даёт половину, запущенная — полный эффект и платит «Позже»', () => {
    const base = dec('Моноград', { rounds: [{ M2: 'conditional', M6: 'conditional' }, {}, {}], negJoker: 'J-7', posJoker: 'J0', posDecision: { use: false } });
    const ev = evaluate(data, { ...base, closing: { M2: { launch: true }, M6: { launch: false } } });
    // 100 − 5 − 5 − 15(J-7) − 15(Позже M2) = 60
    expect(ev.reserve).toBe(60);
    const m2 = ev.items.find((i) => i.code === 'M2')!;
    const m6 = ev.items.find((i) => i.code === 'M6')!;
    expect(m2.status).toBe('launched');
    expect(m2.effects).toEqual(data.measures.find((m) => m.code === 'M2')!.effects);
    expect(m6.status).toBe('notLaunched');
    expect(m6.effects).toEqual({ econ: 1, social: 0, infra: 0, eco: 0, human: 0, adapt: 0 });
  });
  it('отказ от условной меры: подготовка не возвращается, эффекта нет, для джокера меры «нет»', () => {
    const ev = evaluate(data, dec('Промград', {
      rounds: [{ M13: 'conditional' }, {}, {}], cancels: [['M13'], []], negJoker: 'J-1', posJoker: 'J+7', posDecision: { use: true }, closing: {},
    }));
    const it13 = ev.items.find((i) => i.code === 'M13')!;
    expect(it13.status).toBe('cancelled');
    expect(it13.effects.eco).toBe(0);
    expect(ev.neg!.cost).toBe(15); // джокер открыт до отказа — M13 ещё была
    expect(ev.pos!.available).toBe(false); // J+7 после отказа недоступен
    expect(ev.reserve).toBe(100 - 5 - 15);
  });
  it('M4 нельзя сделать условной', () => {
    const ev = evaluate(data, dec('Промград', { rounds: [{ M4: 'conditional' }, {}, {}] }));
    expect(ev.errors.join()).toMatch(/M4 не может быть условной/);
  });
  it('на шаге «Бюджет» нельзя потратить больше 100', () => {
    const ev = evaluate(data, dec('Промград', { rounds: [{ M1: 'full', M7: 'full', M11: 'full', M2: 'full' }, {}, {}] }));
    expect(ev.errors.join()).toMatch(/больше стартового/);
  });
  it('прогноз на закрытии = резерв − «Позже» ожидающих мер, штраф по прогнозу', () => {
    const ev = evaluate(data, dec('Промград', { rounds: [{ M1: 'full', M7: 'full', M11: 'conditional', M16: 'conditional' }, {}, {}] }));
    // 100 − 30 − 30 − 10 − 8 = 22; Позже 25 + 22 = 47 → прогноз −25 → штраф 5
    expect(ev.reserve).toBe(22);
    expect(ev.laterCommitments).toBe(47);
    expect(ev.forecast).toBe(-25);
    expect(ev.forecastPenalty).toBe(5);
  });
});

describe('положительные джокеры', () => {
  const base = (patch: Partial<Decisions>) => dec('Моноград', { negJoker: 'J-7', ...patch });
  it('J+1: с M7 стоит 10 вместо 20, бонус +2 к Экономике', () => {
    const ev = evaluate(data, base({ rounds: [{ M7: 'conditional' }, {}, {}], posJoker: 'J+1', posDecision: { use: true }, closing: { M7: { launch: false } } }));
    expect(ev.pos!.cost).toBe(10);
    expect(ev.final!.jokerBonus.econ).toBe(2);
    expect(ev.reserve).toBe(100 - 8 - 15 - 10);
  });
  it('J+1: не хватает денег → возможность теряется, использовать нельзя', () => {
    const ev = evaluate(data, base({ rounds: [{ M1: 'full', M7: 'full', M11: 'full' }, {}, {}], posJoker: 'J+1', posDecision: { use: true } }));
    expect(ev.pos!.available).toBe(false);
    expect(ev.errors.join()).toMatch(/недоступен/);
  });
  it('J+2 грант: команда платит 10 и мера M1 запускается полностью', () => {
    const ev = evaluate(data, base({ posJoker: 'J+2', posDecision: { use: true, measure: 'M1' }, closing: {} }));
    const m1 = ev.items.find((i) => i.code === 'M1')!;
    expect(m1.status).toBe('grant');
    expect(m1.effects.infra).toBe(2);
    expect(ev.reserve).toBe(100 - 15 - 10);
    expect(ev.pos!.choices!.find((c) => c.code === 'M1')!.grantCovers).toBe(20);
    expect(ev.final!.jokerBonus.infra).toBe(2);
  });
  it('J+2 грант на условную меру: «Позже» больше не платится', () => {
    const ev = evaluate(data, base({ rounds: [{ M3: 'conditional' }, {}, {}], posJoker: 'J+2', posDecision: { use: true, measure: 'M3' }, closing: {} }));
    expect(ev.items.find((i) => i.code === 'M3')!.status).toBe('grant');
    expect(ev.reserve).toBe(100 - 7 - 15 - 10);
  });
  it('J+3: «Позже» M8 на закрытии дешевле на 8 (19 → 11)', () => {
    const ev = evaluate(data, base({ rounds: [{ M8: 'conditional' }, {}, {}], posJoker: 'J+3', posDecision: { use: true }, closing: { M8: { launch: true } } }));
    expect(ev.items.find((i) => i.code === 'M8')!.paid).toBe(6 + 11);
    expect(ev.reserve).toBe(100 - 6 - 15 - 11);
  });
  it('J+3 без M8/M12 недоступен', () => {
    const ev = evaluate(data, base({ posJoker: 'J+3' }));
    expect(ev.pos!.available).toBe(false);
  });
  it('J+5 без M14: запуск M14 сразу за 20', () => {
    const ev = evaluate(data, base({ posJoker: 'J+5', posDecision: { use: true }, closing: {} }));
    expect(ev.items.find((i) => i.code === 'M14')!.status).toBe('grant');
    expect(ev.reserve).toBe(100 - 15 - 20);
    expect(ev.final!.jokerBonus.human).toBe(2);
  });
  it('J+4: с M10 бесплатно, без мер — 12', () => {
    expect(evaluate(data, base({ rounds: [{ M10: 'conditional' }, {}, {}], posJoker: 'J+4' })).pos!.cost).toBe(0);
    expect(evaluate(data, base({ posJoker: 'J+4' })).pos!.cost).toBe(12);
  });
  it('J0: ничего не происходит', () => {
    const ev = evaluate(data, base({ posJoker: 'J0', posDecision: { use: false }, closing: {} }));
    expect(ev.pos!.available).toBe(false);
    expect(ev.reserve).toBe(85);
  });
});

describe('итоговые показатели', () => {
  it('штраф: каждые 5 у.е. дефицита (вверх) −1 к Экономике', () => {
    // Промград: M1+M7+M11 полные = 95, J-4 → 20 → резерв −15 → штраф 3
    const ev = evaluate(data, dec('Промград', { rounds: [{ M1: 'full', M7: 'full', M11: 'full' }, {}, {}], negJoker: 'J-4', posJoker: 'J0', closing: {} }));
    expect(ev.final!.deficit).toBe(15);
    expect(ev.final!.penalty).toBe(3);
    // Экономика: 8 − 1 (M1) + 2 (M7) + 1 (M11) − 3 = 7
    expect(ev.final!.final.econ).toBe(7);
  });
  it('штраф округляется вверх: дефицит 11 → −3', () => {
    const ev = evaluate(data, dec('Моноград', { rounds: [{ M1: 'full', M7: 'full', M16: 'full' }, {}, {}], negJoker: 'J-3', posJoker: 'J0', closing: {} }));
    // 100 − 90 = 10; J-3 = 20 → −10 → штраф 2
    expect(ev.final!.penalty).toBe(2);
    const ev2 = evaluate(data, dec('Моноград', { rounds: [{ M1: 'full', M7: 'full', M16: 'full', M13: 'conditional' }, {}, {}], negJoker: 'J-4', posJoker: 'J0', closing: { M13: { launch: false } } }));
    // 100 − 95 = 5; J-4 при M7 = 20 → −15 → 3
    expect(ev2.final!.penalty).toBe(3);
  });
  it('бонус за резерв: +1 Адаптивности за 10 у.е., максимум +2', () => {
    const r = (spend: Record<string, 'full'>) => evaluate(data, dec('Моноград', { rounds: [spend, {}, {}], negJoker: 'J-7', posJoker: 'J0', closing: {} })).final!;
    expect(r({}).reserveBonus).toBe(2); // 85
    expect(r({ M1: 'full', M7: 'full', M2: 'full' }).reserveBonus).toBe(0); // 100−80−15 = 5
    expect(r({ M1: 'full', M7: 'full' }).reserveBonus).toBe(2); // 25
    expect(r({ M1: 'full', M7: 'full', M13: 'full' }).reserveBonus).toBe(0); // 5
    expect(r({ M1: 'full', M2: 'full', M6: 'full' }).reserveBonus).toBe(1); // 100−68−15 = 17
  });
  it('значения ограничены 1–10', () => {
    // Новая долина: Адаптивность 8 + M4 (+2) + M10 (+2) + бонус резерва → не больше 10
    const ev = evaluate(data, dec('Новая долина', { rounds: [{ M4: 'full', M10: 'full', M13: 'full' }, {}, {}], negJoker: 'J-7', posJoker: 'J0', closing: {} }));
    expect(ev.final!.raw.adapt).toBeGreaterThan(10);
    expect(ev.final!.final.adapt).toBe(10);
    for (const v of Object.values(ev.final!.final)) { expect(v).toBeGreaterThanOrEqual(1); expect(v).toBeLessThanOrEqual(10); }
  });
  it('индекс устойчивости: доля мер с отметкой ≥ 3 из 4 сценариев', () => {
    const ev = evaluate(data, dec('Промград', {
      rounds: [{ M1: 'full', M2: 'conditional', M13: 'full' }, {}, {}],
      marks: {
        M1: { scenarios: [true, true, true, false], trigger: '' },
        M2: { scenarios: [true, false, false, false], trigger: 'x' },
        M13: { scenarios: [true, true, true, true], trigger: '' },
      },
      negJoker: 'J-7', posJoker: 'J0', closing: { M2: { launch: false } },
    }));
    expect(ev.final!.resilienceIndex).toBeCloseTo(2 / 3);
  });
  it('индекс города = среднее шести показателей', () => {
    const ev = evaluate(data, dec('Моноград', { negJoker: 'J-7', posJoker: 'J0', closing: {} }));
    const f = ev.final!;
    expect(f.cityIndex).toBeCloseTo(Object.values(f.final).reduce((a, b) => a + b, 0) / 6);
    expect(f.startIndex).toBeCloseTo(26 / 6);
  });
});

describe('принятая правка: шаг 4 и перенос штрафа', () => {
  it('в собранных данных действуют шаг 4 и перенос', () => {
    expect(loaded.rules.penaltyStep).toBe(4);
    expect(loaded.rules.penaltySpill).toBe(true);
  });
  it('дефицит 15 → штраф 4 (вверх от 15/4)', () => {
    const ev = evaluate(accepted, dec('Промград', { rounds: [{ M1: 'full', M7: 'full', M11: 'full' }, {}, {}], negJoker: 'J-4', posJoker: 'J0', closing: {} }));
    expect(ev.final!.penalty).toBe(4);
    expect(ev.final!.final.econ).toBe(8 - 1 + 2 + 1 - 4);
    expect(ev.final!.spilled).toBe(0);
  });
  it('остаток штрафа ниже 1 переносится на наибольшие другие показатели', () => {
    // Моноград: Экономика 4. Всё условно (99) → резерв 1; J-4 (M2+M7 → 10) → −9; запуск всего в долг
    const allCond: Record<string, 'conditional'> = {};
    for (const m of accepted.measures) if (m.conditionalAllowed) allCond[m.code] = 'conditional';
    const closing = Object.fromEntries(Object.keys(allCond).map((c) => [c, { launch: true }]));
    const ev = evaluate(accepted, dec('Моноград', { rounds: [allCond, {}, {}], negJoker: 'J-4', posJoker: 'J0', closing }));
    const f = ev.final!;
    expect(f.final.econ).toBe(1);
    expect(f.spilled).toBeGreaterThan(0);
    // Позже всех условных = 272; резерв 1 − 10 − 272 = −281 → штраф ⌈281/4⌉ = 71;
    // Экономика 4 + 9 (эффекты) − 71 = −58 → 59 баллов не помещаются и переносятся — хватает, чтобы опустить всё до 1.
    expect(f.reserve).toBe(-281);
    expect(f.penalty).toBe(71);
    expect(f.deltaSum).toBe(6 - 26);
    for (const v of Object.values(f.final)) expect(v).toBeGreaterThanOrEqual(1);
    // без переноса тот же портфель даёт заметно больший прирост — именно это и закрывает правка
    const evOld = evaluate(data, dec('Моноград', { rounds: [allCond, {}, {}], negJoker: 'J-4', posJoker: 'J0', closing }));
    expect(evOld.final!.deltaSum).toBeGreaterThan(f.deltaSum + 10);
  });
});
