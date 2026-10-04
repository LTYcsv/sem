// Симуляция экономики: npm run sim [-- --n 20000 --set penaltyStep=3 --tag after]
// Для каждого города: N случайных стратегий × все пары (негативный, положительный джокер),
// именованные стратегии, локальный поиск оптимума, регрессия вклада мер.
// Результаты: out/sim-<tag>.json и docs/economy/ECONOMY_SIM[-tag].md (таблицы).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { GameData, Mode } from '../src/types.ts';
import { greedyStrategy, namedStrategies, playOnce, randomStrategy, rng, type Strategy } from './strategies.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const arg = (k: string, def?: string) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : def;
};
const N = Number(arg('n', '20000'));
const tag = arg('tag', 'base')!;
const sets = arg('set', '')!;

function loadData(): GameData {
  const data: GameData = JSON.parse(readFileSync(join(root, 'data', 'game_data.json'), 'utf8'));
  for (const kv of sets.split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    if (k.includes('.')) {
      // правка эффекта меры: M6.econ=1 или цены: M13.full=25
      const [code, field] = k.split('.');
      const city = data.cities.find((c) => c.id === code);
      if (city) { (city.start as any)[field] = Number(v); continue; }
      const m = data.measures.find((m) => m.code === code)!;
      if (field in m.effects) (m.effects as any)[field] = Number(v);
      else (m as any)[field] = Number(v);
    } else (data.rules as any)[k] = v === 'true' ? true : v === 'false' ? false : isNaN(Number(v)) ? v : Number(v);
  }
  return data;
}

// ======================= рабочий процесс (один город) =======================
async function worker(cityId: string) {
  const data = loadData();
  const negs = data.jokers.filter((j) => j.basket === 'negative').map((j) => j.code);
  const poss = data.jokers.filter((j) => j.basket === 'positive').map((j) => j.code);
  const P = negs.length * poss.length;
  const r = rng(12345 + cityId.charCodeAt(1));
  const codes = data.measures.map((m) => m.code);
  let violations = 0;
  const violationExamples: string[] = [];

  const evalStrategy = (s: Strategy, per?: Float32Array, off = 0) => {
    let sum = 0, min = Infinity, deficitCases = 0, deficitSum = 0, lostClamp = 0, lostCeil = 0;
    let k = 0;
    for (const n of negs) for (const p of poss) {
      const res = playOnce(data, cityId, s, n, p);
      if (res.violations.length) { violations++; if (violationExamples.length < 5) violationExamples.push(`${s.name} ${n} ${p}: ${res.violations.join('; ')}`); }
      sum += res.delta;
      min = Math.min(min, res.delta);
      if (res.deficit > 0) { deficitCases++; deficitSum += res.deficit; }
      lostClamp += res.penaltyLostToClamp;
      lostCeil += res.lostToCeiling;
      if (per) per[off + k] = res.delta;
      k++;
    }
    return { mean: sum / P, min, deficitShare: deficitCases / P, meanDeficit: deficitSum / P, lostClamp: lostClamp / P, lostCeil: lostCeil / P };
  };

  // --- облако случайных стратегий
  const strategies: Strategy[] = [];
  const per = new Float32Array(N * P);
  const means = new Float64Array(N);
  const meta: { closing: string; keep: number; spentInit: number; deficitShare: number; meanDeficit: number }[] = [];
  let lostClampTotal = 0, lostCeilTotal = 0;
  for (let i = 0; i < N; i++) {
    const s = randomStrategy(data, r, i);
    strategies.push(s);
    const e = evalStrategy(s, per, i * P);
    means[i] = e.mean;
    lostClampTotal += e.lostClamp;
    lostCeilTotal += e.lostCeil;
    const spentInit = Object.entries(s.init).reduce((a, [c, m]) => {
      const ms = data.measures.find((x) => x.code === c)!;
      return a + (m === 'full' ? ms.full : ms.now);
    }, 0);
    meta.push({ closing: s.closing, keep: s.keep, spentInit, deficitShare: e.deficitShare, meanDeficit: e.meanDeficit });
  }
  const sortedMeans = [...means].sort((a, b) => a - b);
  const pct = (v: number) => {
    let lo = 0, hi = sortedMeans.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedMeans[mid] <= v) lo = mid + 1; else hi = mid; }
    return lo / sortedMeans.length;
  };
  const q = (p: number) => sortedMeans[Math.min(sortedMeans.length - 1, Math.floor(p * sortedMeans.length))];

  // перцентиль по каждой паре джокеров
  const pairSorted: Float32Array[] = [];
  for (let k = 0; k < P; k++) {
    const col = new Float32Array(N);
    for (let i = 0; i < N; i++) col[i] = per[i * P + k];
    col.sort();
    pairSorted.push(col);
  }
  const pairPct = (k: number, v: number) => {
    const col = pairSorted[k];
    let lo = 0, hi = col.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (col[mid] <= v) lo = mid + 1; else hi = mid; }
    return lo / col.length;
  };
  const pairMax = pairSorted.map((c) => c[c.length - 1]);

  // --- локальный поиск оптимума (ожидание по всем парам джокеров)
  const objective = (s: Strategy) => evalStrategy(s).mean;
  const neighbors = function* (s: Strategy): Generator<Strategy> {
    for (const c of codes) {
      const m = data.measures.find((x) => x.code === c)!;
      for (const mode of ['none', 'full', 'conditional'] as const) {
        if (mode === 'conditional' && !m.conditionalAllowed) continue;
        const cur = s.init[c] ?? 'none';
        if (cur === mode) continue;
        const init = { ...s.init };
        if (mode === 'none') delete init[c]; else init[c] = mode as Mode;
        const spent = Object.entries(init).reduce((a, [cc, mm]) => {
          const ms = data.measures.find((x) => x.code === cc)!;
          return a + (mm === 'full' ? ms.full : ms.now);
        }, 0);
        const fulls = Object.values(init).filter((x) => x === 'full').length;
        if (spent <= data.rules.startBudget && fulls >= (data.rules.minFullMeasures ?? 0)) yield { ...s, init };
      }
    }
    for (const keep of [0, 5, 10, 15, 20, 30, Infinity]) if (keep !== s.keep) yield { ...s, keep };
    for (const drop of ['none', 'deficit', 'unlocked'] as const) if (drop !== s.drop) yield { ...s, drop };
    for (const closing of ['none', 'affordable', 'all'] as const) if (closing !== s.closing) yield { ...s, closing };
    for (const usePos of ['always', 'freeOnly', 'never'] as const) if (usePos !== s.usePos) yield { ...s, usePos };
    yield { ...s, corrMode: s.corrMode === 'full' ? 'conditional' : 'full' };
  };
  const climb = (s0: Strategy) => {
    let s = s0, v = objective(s), improved = true, iter = 0;
    while (improved && iter++ < 60) {
      improved = false;
      for (const nb of neighbors(s)) {
        const nv = objective(nb);
        if (nv > v + 1e-9) { s = nb; v = nv; improved = true; break; }
      }
    }
    return { s, v };
  };
  const topIdx = [...means.keys()].sort((a, b) => means[b] - means[a]);
  const starts = [...topIdx.slice(0, 12).map((i) => strategies[i]), greedyStrategy(data, cityId, 0), greedyStrategy(data, cityId, 20)];
  for (let i = 0; i < 6; i++) starts.push(randomStrategy(data, r, -i));
  const optima = starts.map(climb).sort((a, b) => b.v - a.v);
  const best = optima[0];
  const bestEval = evalStrategy(best.s);

  // --- именованные стратегии
  const named = namedStrategies(data, cityId).map((s) => {
    const p = new Float32Array(P);
    const e = evalStrategy(s, p);
    let pairPctSum = 0, pairBest = 0;
    for (let k = 0; k < P; k++) { pairPctSum += pairPct(k, p[k]); if (p[k] >= pairMax[k]) pairBest++; }
    return { name: s.name, init: s.init, ...e, percentile: pct(e.mean), meanPairPercentile: pairPctSum / P, pairsAtMax: pairBest, gapToBest: best.v - e.mean };
  });

  // --- регрессия: ожидаемая Δ ~ режимы мер + политики
  const feats: string[] = [];
  for (const c of codes) { feats.push(`${c}:full`); if (data.measures.find((m) => m.code === c)!.conditionalAllowed) feats.push(`${c}:cond`); }
  feats.push('closing:affordable', 'closing:all', 'keep:finite', 'usePos:always', 'usePos:freeOnly', 'corr:conditional', 'drop:deficit', 'drop:unlocked');
  const X = (s: Strategy) => {
    const x = [1];
    for (const f of feats) {
      const [a, b] = f.split(':');
      if (a.startsWith('M')) x.push((s.init[a] === 'full' && b === 'full') || (s.init[a] === 'conditional' && b === 'cond') ? 1 : 0);
      else if (a === 'closing') x.push(s.closing === b ? 1 : 0);
      else if (a === 'keep') x.push(Number.isFinite(s.keep) ? 1 : 0);
      else if (a === 'usePos') x.push(s.usePos === b ? 1 : 0);
      else if (a === 'corr') x.push(s.corrMode === 'conditional' ? 1 : 0);
      else if (a === 'drop') x.push(s.drop === b ? 1 : 0);
    }
    return x;
  };
  const D = feats.length + 1;
  const XtX = Array.from({ length: D }, () => new Float64Array(D));
  const Xty = new Float64Array(D);
  for (let i = 0; i < N; i++) {
    const x = X(strategies[i]);
    for (let a = 0; a < D; a++) { if (!x[a]) continue; Xty[a] += x[a] * means[i]; for (let b = 0; b < D; b++) XtX[a][b] += x[a] * x[b]; }
  }
  for (let a = 0; a < D; a++) XtX[a][a] += 1e-6;
  const beta = solve(XtX.map((r) => [...r]), [...Xty]);
  const coef = Object.fromEntries(feats.map((f, i) => [f, beta[i + 1]]));

  // частота мер в топ-1% и в оптимуме
  const top1 = topIdx.slice(0, Math.max(1, Math.floor(N * 0.01))).map((i) => strategies[i]);
  const freqTop = Object.fromEntries(codes.map((c) => [c, {
    full: top1.filter((s) => s.init[c] === 'full').length / top1.length,
    cond: top1.filter((s) => s.init[c] === 'conditional').length / top1.length,
  }]));
  const freqAll = Object.fromEntries(codes.map((c) => [c, strategies.filter((s) => s.init[c]).length / N]));

  // --- джокеры: средняя Δ и цена по облаку
  const jokerStats: Record<string, { meanDelta: number }> = {};
  for (const [ji, n] of negs.entries()) {
    let s = 0;
    for (let i = 0; i < N; i++) for (let pj = 0; pj < poss.length; pj++) s += per[i * P + ji * poss.length + pj];
    jokerStats[n] = { meanDelta: s / (N * poss.length) };
  }
  for (const [pj, p] of poss.entries()) {
    let s = 0;
    for (let i = 0; i < N; i++) for (let ji = 0; ji < negs.length; ji++) s += per[i * P + ji * poss.length + pj];
    jokerStats[p] = { meanDelta: s / (N * negs.length) };
  }

  // --- долг: та же стратегия с закрытием «запускать всё» против «по средствам»
  let pairs = 0, debtBetter = 0, ddSum = 0, extraDefSum = 0, ddPerUe: number[] = [];
  for (let i = 0; i < Math.min(N, 4000); i++) {
    const s = strategies[i];
    if (!Object.values(s.init).includes('conditional')) continue;
    const a = evalStrategy({ ...s, closing: 'affordable' });
    const b = evalStrategy({ ...s, closing: 'all' });
    const extra = b.meanDeficit - a.meanDeficit;
    if (extra < 1) continue;
    pairs++;
    if (b.mean > a.mean) debtBetter++;
    ddSum += b.mean - a.mean;
    extraDefSum += extra;
    ddPerUe.push((b.mean - a.mean) / extra);
  }
  ddPerUe.sort((a, b) => a - b);

  return {
    cityId,
    sortedMeans: sortedMeans.filter((_, i) => i % Math.max(1, Math.floor(N / 2000)) === 0),
    N, P,
    violations, violationExamples,
    cloud: { mean: means.reduce((a, b) => a + b, 0) / N, p10: q(0.1), p50: q(0.5), p90: q(0.9), p99: q(0.99), max: sortedMeans[N - 1],
      lostClamp: lostClampTotal / N, lostCeil: lostCeilTotal / N },
    best: { value: best.v, strategy: { ...best.s, keep: String(best.s.keep) }, eval: bestEval, others: optima.slice(1, 5).map((o) => ({ value: o.v, init: o.s.init, closing: o.s.closing, keep: String(o.s.keep) })) },
    named,
    coef,
    freqTop, freqAll,
    jokerStats,
    debt: { pairs, debtBetterShare: pairs ? debtBetter / pairs : 0, meanGain: pairs ? ddSum / pairs : 0, meanExtraDeficit: pairs ? extraDefSum / pairs : 0,
      perUeMedian: ddPerUe[Math.floor(ddPerUe.length / 2)] ?? 0, perUeP90: ddPerUe[Math.floor(ddPerUe.length * 0.9)] ?? 0 },
    byClosing: Object.fromEntries((['none', 'affordable', 'all'] as const).map((c) => {
      const idx = meta.map((m, i) => (m.closing === c ? i : -1)).filter((i) => i >= 0);
      return [c, { mean: idx.reduce((a, i) => a + means[i], 0) / idx.length, deficitShare: idx.reduce((a, i) => a + meta[i].deficitShare, 0) / idx.length }];
    })),
    bySpendInit: [0, 20, 40, 60, 80].map((lo) => {
      const idx = meta.map((m, i) => (m.spentInit >= lo && m.spentInit < lo + 20 + (lo === 80 ? 1 : 0) ? i : -1)).filter((i) => i >= 0);
      return { range: `${lo}–${lo + 20}`, n: idx.length, mean: idx.reduce((a, i) => a + means[i], 0) / (idx.length || 1) };
    }),
  };
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    [b[i], b[p]] = [b[p], b[i]];
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / A[i][i];
      if (!f) continue;
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
    x[i] = s / A[i][i];
  }
  return x;
}

// ======================= главный процесс =======================
type CityRes = Awaited<ReturnType<typeof worker>>;
let crossMatrix: number[][] = [];

async function main() {
  const data = loadData();
  const t0 = Date.now();
  const results: CityRes[] = await Promise.all(
    data.cities.map(
      (c) =>
        new Promise<CityRes>((res, rej) => {
          const child = fork(fileURLToPath(import.meta.url), ['--worker', c.id, ...args], { execArgv: ['--import', 'tsx'] });
          child.on('message', (m) => res(m as CityRes));
          child.on('error', rej);
          child.on('exit', (code) => code && rej(new Error('worker exit ' + code)));
        }),
    ),
  );
  // перекрёстная проверка: лучшая стратегия города A на городе B
  const negs = data.jokers.filter((j) => j.basket === 'negative').map((j) => j.code);
  const poss = data.jokers.filter((j) => j.basket === 'positive').map((j) => j.code);
  const cross: number[][] = results.map((ra) => {
    const s: Strategy = { ...(ra.best.strategy as any), keep: Number(ra.best.strategy.keep) };
    return results.map((rb) => {
      let sum = 0;
      for (const n of negs) for (const p of poss) sum += playOnce(data, rb.cityId, s, n, p).delta;
      return sum / (negs.length * poss.length);
    });
  });
  (results as any).cross = cross;
  crossMatrix = cross;
  mkdirSync(join(root, 'out'), { recursive: true });
  writeFileSync(join(root, 'out', `sim-${tag}.json`), JSON.stringify({ sets, N, results }, null, 1));
  const md = report(data, results, (Date.now() - t0) / 1000);
  const file = join(root, 'docs', 'economy', tag === 'base' ? 'ECONOMY_SIM.md' : `ECONOMY_SIM-${tag}.md`);
  writeFileSync(file, md);
  console.log(md.split('\n').slice(0, 60).join('\n'));
  console.log(`\n→ ${file}`);
}

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');
const f2 = (x: number) => x.toFixed(2);
const pc = (x: number) => Math.round(x * 100) + '%';

function pctOf(r: CityRes, v: number) {
  const s = (r as any).sortedMeans as number[] | undefined;
  if (!s) return 0;
  let lo = 0, hi = s.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (s[mid] <= v) lo = mid + 1; else hi = mid; }
  return lo / s.length;
}

function report(data: GameData, R: CityRes[], secs: number): string {
  const name = (id: string) => data.cities.find((c) => c.id === id)!.name;
  const sumStart = (id: string) => Object.values(data.cities.find((c) => c.id === id)!.start).reduce((a, b) => a + b, 0);
  const L: string[] = [];
  L.push(`# Результаты симуляции экономики${sets ? ` (изменения: \`${sets}\`)` : ''}`, '');
  L.push(`Сгенерировано \`npm run sim${args.length ? ' -- ' + args.join(' ') : ''}\`, ${new Date().toISOString().slice(0, 16).replace('T', ' ')}, ${f1(secs)} с.`);
  L.push(`На город: ${R[0].N} случайных стратегий × ${R[0].P} пар джокеров = ${(R[0].N * R[0].P).toLocaleString('ru')} партий; всего ${(R[0].N * R[0].P * R.length).toLocaleString('ru')}.`);
  L.push('Метрика: **Δ** = изменение суммы шести показателей (итог − старт), ожидание по всем парам джокеров. Δ индекса города = Δ / 6.', '');

  L.push('## 1. Инварианты', '');
  L.push(`- Сейчас + Позже = Полная: ${data.measures.every((m) => m.now + m.later === m.full) ? 'выполнено для всех мер' : 'НАРУШЕНО'}.`);
  L.push(`- Нарушений (показатель вне ${data.rules.min}–${data.rules.max}, отрицательная цена, ошибки движка) во всех партиях: **${R.reduce((a, r) => a + r.violations, 0)}**.`);
  for (const r of R) for (const v of r.violationExamples) L.push(`  - ${v}`);
  L.push('');

  L.push('## 2. Распределение результатов по городам', '');
  L.push('| Город | Сумма старт | Δ средн. (случайные) | p10 | p50 | p90 | p99 | Лучшая найденная Δ | Потеряно на потолке 10, баллов | Штраф, «съеденный» нижней границей |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of R) L.push(`| ${name(r.cityId)} | ${sumStart(r.cityId)} | ${f2(r.cloud.mean)} | ${f2(r.cloud.p10)} | ${f2(r.cloud.p50)} | ${f2(r.cloud.p90)} | ${f2(r.cloud.p99)} | ${f2(r.best.value)} | ${f2(r.cloud.lostCeil)} | ${f2(r.cloud.lostClamp)} |`);
  L.push('');

  L.push('## 3. Именованные стратегии', '');
  L.push('Перцентиль — место ожидаемой Δ среди случайных стратегий города (100% = лучше всех). «Пар на максимуме» — в скольких из 64 пар джокеров стратегия не хуже лучшей случайной.', '');
  L.push('| Город | Стратегия | Δ ожид. | Δ мин. | Перцентиль | Средн. перцентиль по парам | Пар на максимуме | Отставание от лучшей | Доля партий с дефицитом |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of R) for (const s of r.named) L.push(`| ${name(r.cityId)} | ${s.name} | ${f2(s.mean)} | ${s.min} | ${pc(s.percentile)} | ${pc(s.meanPairPercentile)} | ${s.pairsAtMax} | ${f2(s.gapToBest)} | ${pc(s.deficitShare)} |`);
  L.push('');
  L.push('### Лучшие найденные стратегии (локальный поиск)', '');
  for (const r of R) {
    const b = r.best;
    const port = Object.entries(b.strategy.init).map(([c, m]) => `${c}${m === 'full' ? '' : '(усл.)'}`).join(', ');
    L.push(`- **${name(r.cityId)}**: Δ = ${f2(b.value)}; портфель: ${port || '—'}; снятие после джокера: ${b.strategy.drop}; докупка: ${b.strategy.keep === 'Infinity' ? 'нет' : 'оставлять ' + b.strategy.keep} (${b.strategy.corrMode === 'full' ? 'полные' : 'условные'}); закрытие: ${b.strategy.closing}; положительный джокер: ${b.strategy.usePos}; доля партий с дефицитом ${pc(b.eval.deficitShare)}, средний дефицит ${f1(b.eval.meanDeficit)} у.е.`);
    for (const o of b.others.slice(0, 2)) L.push(`  - другой локальный оптимум: Δ = ${f2(o.value)}; ${Object.entries(o.init).map(([c, m]) => `${c}${m === 'full' ? '' : '(усл.)'}`).join(', ')}; закрытие ${o.closing}`);
  }
  L.push('');

  L.push('### Перекрёстная проверка: лучшая стратегия города (строка) на другом городе (столбец)', '');
  L.push('Если бы существовала доминирующая стратегия, строка одного города была бы близка к лучшему значению во всех столбцах.', '');
  L.push('| Стратегия \\ город | ' + R.map((r) => name(r.cityId)).join(' | ') + ' |', '|---|' + R.map(() => '---|').join(''));
  crossMatrix.forEach((row, i) => L.push(`| лучшая для ${name(R[i].cityId)} | ${row.map((v, j) => `${f2(v)} (${pc(R[j].cloud.p50 ? pctOf(R[j], v) : 0)})`).join(' | ')} |`));
  L.push('', 'В скобках — перцентиль среди случайных стратегий города-столбца.', '');

  L.push('## 4. Дефицит против вложений', '');
  L.push('Та же стратегия: закрытие «запускать всё (в долг)» против «запускать, пока хватает резерва».', '');
  L.push('| Город | Пар стратегий | Долг выгоднее | Средний выигрыш от долга, Δ | Доп. дефицит, у.е. | Δ на 1 у.е. долга (медиана) | p90 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const r of R) L.push(`| ${name(r.cityId)} | ${r.debt.pairs} | ${pc(r.debt.debtBetterShare)} | ${f2(r.debt.meanGain)} | ${f1(r.debt.meanExtraDeficit)} | ${f2(r.debt.perUeMedian)} | ${f2(r.debt.perUeP90)} |`);
  L.push('');
  L.push('Средняя Δ случайных стратегий по политике закрытия:', '');
  L.push('| Город | не запускать | по средствам | всё в долг |', '|---|---|---|---|');
  for (const r of R) L.push(`| ${name(r.cityId)} | ${f2(r.byClosing.none.mean)} | ${f2(r.byClosing.affordable.mean)} | ${f2(r.byClosing.all.mean)} |`);
  L.push('');
  L.push('Средняя Δ по объёму трат на шаге «Бюджет» (у.е.):', '');
  L.push('| Город | ' + R[0].bySpendInit.map((b) => b.range).join(' | ') + ' |', '|---|' + R[0].bySpendInit.map(() => '---|').join(''));
  for (const r of R) L.push(`| ${name(r.cityId)} | ${r.bySpendInit.map((b) => f2(b.mean)).join(' | ')} |`);
  L.push('');

  L.push('## 5. Вклад мер (регрессия ожидаемой Δ на режимы мер шага «Бюджет»)', '');
  L.push('Коэффициент — средний прирост Δ от включения меры в данном режиме при прочих равных; «на 1 у.е.» — коэффициент / цена (полная или «Сейчас»).', '');
  L.push('| Мера | Цена | ' + R.map((r) => `${name(r.cityId)} полн.`).join(' | ') + ' | ' + R.map((r) => `${name(r.cityId)} усл.`).join(' | ') + ' | Полн. на 1 у.е. (среднее) | В топ-1% (среднее) | В джокерах |');
  L.push('|---|---|' + R.map(() => '---|').join('') + R.map(() => '---|').join('') + '---|---|---|');
  const jokerRefs = (c: string) => data.jokers.filter((j) => JSON.stringify(j.basket === 'negative' ? j.rules : j.rule).includes(`"${c}"`)).map((j) => j.code);
  for (const m of data.measures) {
    const cf = R.map((r) => r.coef[`${m.code}:full`]);
    const cc = R.map((r) => r.coef[`${m.code}:cond`]);
    const perUe = cf.reduce((a, b) => a + b, 0) / R.length / m.full;
    const top = R.reduce((a, r) => a + r.freqTop[m.code].full + r.freqTop[m.code].cond, 0) / R.length;
    L.push(`| ${m.code} ${m.name} | ${m.full} (${m.now}+${m.later}) | ${cf.map(f2).join(' | ')} | ${cc.map((x) => (x == null ? '—' : f2(x))).join(' | ')} | ${f2(perUe)} | ${pc(top)} | ${jokerRefs(m.code).join(', ') || '—'} |`);
  }
  L.push('');
  L.push('Политики: ' + ['closing:affordable', 'closing:all', 'keep:finite', 'usePos:always', 'usePos:freeOnly', 'corr:conditional', 'drop:deficit', 'drop:unlocked']
    .map((f) => `${f} = ${R.map((r) => f2(r.coef[f])).join(' / ')}`).join('; ') + ' (по городам).', '');

  L.push('## 6. Джокеры: средняя Δ случайных стратегий при выпадении джокера', '');
  L.push('| Джокер | ' + R.map((r) => name(r.cityId)).join(' | ') + ' |', '|---|' + R.map(() => '---|').join(''));
  for (const j of data.jokers) L.push(`| ${j.code} ${j.name} | ${R.map((r) => f2(r.jokerStats[j.code].meanDelta)).join(' | ')} |`);
  L.push('');
  return L.join('\n');
}

if (args[0] === '--worker') {
  worker(args[1]).then((res) => {
    process.send!(res, () => process.exit(0));
  });
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
