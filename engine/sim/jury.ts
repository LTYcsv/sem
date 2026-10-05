// Таблицы для жюри: какой рост какую оценку даёт в каждом городе (из data/benchmarks.json).
// Запуск: npm run jury — обновляет блоки между <!-- auto:begin --> и <!-- auto:end --> в docs/jury/*.md.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { GameData } from '../src/types.ts';
import { benchKey, dataHash, gradeResult, type Benchmarks } from '../src/benchmark.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const data: GameData = JSON.parse(readFileSync(join(root, 'data', 'game_data.json'), 'utf8'));
const b: Benchmarks = JSON.parse(readFileSync(join(root, 'data', 'benchmarks.json'), 'utf8'));
if (b.dataHash !== dataHash(data)) throw new Error('data/benchmarks.json посчитан для других правил — сначала npm run benchmarks');

const negs = data.jokers.filter((j) => j.basket === 'negative');
const poss = data.jokers.filter((j) => j.basket === 'positive');
const f1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1).replace('.', ',').replace('-', '−');
const avg = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;

function block(cityId: string): string {
  const pairs = negs.flatMap((n) => poss.map((p) => b.table[benchKey(cityId, n.code, p.code)]));
  const L: string[] = [];
  L.push('#### Какой рост какую оценку даёт (в среднем по 64 парам джокеров)', '');
  L.push('| Рост команды | ' + [6, 8, 10, 12, 14, 16, 18, 20].map((d) => `+${d}`).join(' | ') + ' |');
  L.push('|---|' + '---|'.repeat(8));
  L.push('| Оценка из 10 | ' + [6, 8, 10, 12, 14, 16, 18, 20].map((d) => f1(avg(pairs.map((p) => gradeResult(d, p).score)))).join(' | ') + ' |', '');
  L.push('Точная оценка зависит от выпавших джокеров: при тяжёлом негативном джокере тот же рост стоит выше. Она уже посчитана в PDF команды (раздел 5).', '');
  L.push('#### Ориентиры по негативному джокеру (среднее по 8 положительным)', '');
  L.push('| Негативный джокер | Медиана → 5/10 | Лучшие 10% → 8/10 | Устойчивый портфель | Лучший при известных джокерах → 10/10 |');
  L.push('|---|---|---|---|---|');
  for (const n of negs) {
    const ps = poss.map((p) => b.table[benchKey(cityId, n.code, p.code)]);
    L.push(`| ${n.code} «${n.name}» | +${f1(avg(ps.map((p) => p.q[50])))} | +${f1(avg(ps.map((p) => p.q[90])))} | +${f1(avg(ps.map((p) => p.robust.delta)))} | +${f1(avg(ps.map((p) => p.hindsight.delta)))} |`);
  }
  L.push(`| **Все пары** | **+${f1(avg(pairs.map((p) => p.q[50])))}** | **+${f1(avg(pairs.map((p) => p.q[90])))}** | **+${f1(avg(pairs.map((p) => p.robust.delta)))}** | **+${f1(avg(pairs.map((p) => p.hindsight.delta)))}** |`, '');
  L.push(`*Сгенерировано \`npm run jury\` из \`data/benchmarks.json\` (${new Date(b.generatedAt).toLocaleDateString('ru-RU')}, ${b.samples} случайных стратегий на пару джокеров).*`);
  return L.join('\n');
}

const dir = join(root, 'docs', 'jury');
for (const c of data.cities) {
  const file = readdirSync(dir).find((f) => readFileSync(join(dir, f), 'utf8').includes(`<!-- auto:begin city=${c.id} -->`));
  if (!file) { console.log(`  ${c.name}: нет файла с <!-- auto:begin city=${c.id} --> — пропущено`); continue; }
  const p = join(dir, file);
  const s = readFileSync(p, 'utf8').replace(new RegExp(`(<!-- auto:begin city=${c.id} -->)[\\s\\S]*?(<!-- auto:end -->)`), `$1\n${block(c.id)}\n$2`);
  writeFileSync(p, s);
  console.log(`  ${c.name} → docs/jury/${file}`);
}
