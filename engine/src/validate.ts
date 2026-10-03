import type { GameData } from './types.ts';
import { INDICATORS } from './types.ts';

/** Проверки целостности данных. Возвращает список ошибок (пустой = всё в порядке). */
export function validateData(d: GameData): string[] {
  const e: string[] = [];
  const codes = new Set(d.measures.map((m) => m.code));
  const { min, max } = d.rules;
  if (d.cities.length < 4) e.push(`Нужно минимум 4 города, найдено ${d.cities.length}`);
  for (const c of d.cities) {
    for (const k of INDICATORS)
      if (!(c.start[k] >= min && c.start[k] <= max)) e.push(`${c.name}: стартовый показатель ${k}=${c.start[k]} вне ${min}–${max}`);
    if (!c.situation) e.push(`${c.name}: нет описания ситуации`);
  }
  for (const m of d.measures) {
    if (m.now + m.later !== m.full) e.push(`${m.code}: Сейчас ${m.now} + Позже ${m.later} ≠ Полная ${m.full}`);
    if (m.now < 0 || m.later < 0) e.push(`${m.code}: отрицательная цена`);
    if (!m.conditionalAllowed && m.later !== 0) e.push(`${m.code}: не может быть условной, но «Позже» = ${m.later}`);
  }
  const refs = (code: string, list: string[] | undefined) => {
    for (const x of list ?? []) if (!codes.has(x)) e.push(`${code}: ссылка на неизвестную меру ${x}`);
  };
  const neg = d.jokers.filter((j) => j.basket === 'negative');
  const pos = d.jokers.filter((j) => j.basket === 'positive');
  if (neg.length < 4) e.push(`Негативных джокеров меньше 4 (${neg.length}) — не хватит на 4 команды без повторов`);
  if (pos.length < 4) e.push(`Положительных джокеров меньше 4 (${pos.length})`);
  for (const j of d.jokers) {
    if (j.basket === 'negative') {
      for (const r of j.rules) {
        refs(j.code, r.all); refs(j.code, r.any); refs(j.code, r.none);
        if (r.cost == null && r.delta == null) e.push(`${j.code}: правило без cost/delta`);
      }
    } else {
      const r = j.rule;
      if (r.kind === 'pay') r.rules.forEach((x) => { refs(j.code, x.all); refs(j.code, x.any); refs(j.code, x.none); });
      if (r.kind === 'laterDiscount') refs(j.code, r.any);
      if (r.kind === 'partner') refs(j.code, [r.measure]);
      if (r.kind === 'grant') {
        refs(j.code, r.eligible);
        for (const c of r.eligible) {
          const m = d.measures.find((m) => m.code === c);
          if (m && m.full - r.ownCost > r.grant) e.push(`${j.code}: грант ${r.grant} не покрывает ${c} (${m.full} − ${r.ownCost})`);
        }
      }
      if (j.bonus && !INDICATORS.includes(j.bonus.indicator)) e.push(`${j.code}: неизвестный показатель бонуса`);
    }
  }
  return e;
}
