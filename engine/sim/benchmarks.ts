// Эталоны для итогового PDF: для каждого города и пары джокеров — распределение результатов случайных стратегий,
// лучший вариант «если бы джокеры были известны» и устойчивый портфель города, сыгранный с этими джокерами.
// Запуск: npm run benchmarks (≈ 2–4 мин, города считаются параллельно) → data/benchmarks.json
import { readFileSync, writeFileSync } from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { GameData } from '../src/types.ts';
import { benchKey, dataHash, type BenchPair, type Benchmarks } from '../src/benchmark.ts';
import { climb, greedyStrategy, namedStrategies, playOnce, randomStrategy, rng, type Strategy } from './strategies.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLES = 5000; // случайных стратегий на пару джокеров (для перцентилей)
const ROBUST_SAMPLES = 3000; // случайных стратегий для поиска устойчивого портфеля
const data: GameData = JSON.parse(readFileSync(join(root, 'data', 'game_data.json'), 'utf8'));
const negs = data.jokers.filter((j) => j.basket === 'negative').map((j) => j.code);
const poss = data.jokers.filter((j) => j.basket === 'positive').map((j) => j.code);

function city(cityId: string, seed: number) {
  const r = rng(seed);
  const pairs = negs.flatMap((n) => poss.map((p) => [n, p] as const));
  const mean = (s: Strategy) => pairs.reduce((a, [n, p]) => a + playOnce(data, cityId, s, n, p).delta, 0) / pairs.length;

  // устойчивый портфель: лучший в среднем по всем парам (джокеры неизвестны заранее)
  const cloud = Array.from({ length: ROBUST_SAMPLES }, (_, i) => randomStrategy(data, r, i));
  const scored = cloud.map((s) => ({ s, v: mean(s) })).sort((a, b) => b.v - a.v);
  const starts = [...scored.slice(0, 8).map((x) => x.s), greedyStrategy(data, cityId, 0), greedyStrategy(data, cityId, 20), ...namedStrategies(data, cityId)];
  const robust = starts.map((s) => climb(data, s, mean)).sort((a, b) => b.v - a.v)[0];

  const table: Record<string, BenchPair> = {};
  for (const [neg, pos] of pairs) {
    const sample = Array.from({ length: SAMPLES }, (_, i) => randomStrategy(data, r, i));
    const runs = sample.map((s) => ({ s, delta: playOnce(data, cityId, s, neg, pos).delta })).sort((a, b) => a.delta - b.delta);
    const q = Array.from({ length: 101 }, (_, i) => runs[Math.min(runs.length - 1, Math.round((i / 100) * (runs.length - 1)))].delta);
    const one = (s: Strategy) => playOnce(data, cityId, s, neg, pos).delta;
    const hs = [...runs.slice(-6).map((x) => x.s), robust.s, greedyStrategy(data, cityId, 0)];
    const best = hs.map((s) => climb(data, s, one)).sort((a, b) => b.v - a.v)[0];
    const rb = playOnce(data, cityId, robust.s, neg, pos);
    const hb = playOnce(data, cityId, best.s, neg, pos);
    table[benchKey(cityId, neg, pos)] = { q, hindsight: { delta: hb.delta, decisions: hb.decisions }, robust: { delta: rb.delta, decisions: rb.decisions } };
  }
  return { table, robustMean: robust.v };
}

if (process.argv[2] === '--city') {
  const res = city(process.argv[3], Number(process.argv[4]));
  process.send!(res, () => process.exit(0));
} else {
  const t0 = Date.now();
  const parts = await Promise.all(data.cities.map((c, i) => new Promise<ReturnType<typeof city>>((ok, fail) => {
    const ch = fork(fileURLToPath(import.meta.url), ['--city', c.id, String(1000 + i)], { execArgv: ['--import', 'tsx'] });
    ch.on('message', (m) => ok(m as ReturnType<typeof city>));
    ch.on('exit', (code) => code && fail(new Error(`${c.name}: код ${code}`)));
  })));
  const out: Benchmarks = {
    dataHash: dataHash(data), generatedAt: new Date().toISOString(), samples: SAMPLES, pairs: negs.length * poss.length,
    table: Object.assign({}, ...parts.map((p) => p.table)),
    robustMean: Object.fromEntries(data.cities.map((c, i) => [c.id, Math.round(parts[i].robustMean * 100) / 100])),
  };
  writeFileSync(join(root, 'data', 'benchmarks.json'), JSON.stringify(out));
  console.log(`data/benchmarks.json: ${Object.keys(out.table).length} пар, ${Math.round((Date.now() - t0) / 1000)} с`);
  for (const c of data.cities) {
    const rows = Object.entries(out.table).filter(([k]) => k.startsWith(c.id + '|')).map(([, v]) => v);
    const avg = (f: (v: BenchPair) => number) => (rows.reduce((a, v) => a + f(v), 0) / rows.length).toFixed(1);
    console.log(`  ${c.name}: медиана ${avg((v) => v.q[50])}, устойчивый ${avg((v) => v.robust.delta)}, лучший при известных джокерах ${avg((v) => v.hindsight.delta)}`);
  }
}
