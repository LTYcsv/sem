// Эталоны для итогового PDF: лучшие варианты для города и пары джокеров и оценка результата команды.
// Таблица считается заранее скриптом `npm run benchmarks` → data/benchmarks.json.
import type { Decisions, GameData } from './types.ts';

export interface BenchVariant {
  /** Δ суммы шести показателей. */
  delta: number;
  decisions: Decisions;
}

export interface BenchPair {
  /** Перцентили Δ случайных стратегий с этими джокерами: q[0] — минимум, q[50] — медиана, q[100] — максимум. */
  q: number[];
  /** Лучший найденный вариант, если бы джокеры были известны заранее. */
  hindsight: BenchVariant;
  /** Устойчивый портфель города (лучший в среднем по всем парам), сыгранный с этими джокерами. */
  robust: BenchVariant;
}

export interface Benchmarks {
  dataHash: string;
  generatedAt: string;
  samples: number;
  pairs: number;
  /** Ключ — `${cityId}|${neg}|${pos}`. */
  table: Record<string, BenchPair>;
  /** Средняя Δ устойчивого портфеля по всем парам джокеров. */
  robustMean: Record<string, number>;
}

export const benchKey = (cityId: string, neg: string, pos: string) => `${cityId}|${neg}|${pos}`;

/** Отпечаток правил и чисел, от которых зависят эталоны (FNV-1a). Меняется — таблицу надо пересчитать. */
export function dataHash(data: GameData): string {
  const src = JSON.stringify({ rules: data.rules, measures: data.measures, jokers: data.jokers, cities: data.cities.map((c) => ({ id: c.id, start: c.start, startBudget: c.startBudget })) });
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Доля случайных стратегий с теми же джокерами, которые набрали меньше или столько же. */
export function percentileOf(q: number[], v: number): number {
  if (v < q[0]) return 0;
  if (v >= q[q.length - 1]) return 1;
  let i = 0;
  while (i < q.length - 1 && q[i + 1] <= v) i++;
  const span = q[i + 1] - q[i];
  return (i + (span > 0 ? (v - q[i]) / span : 0)) / (q.length - 1);
}

export interface ResultGrade {
  /** 1–10. */
  score: number;
  level: string;
  percentile: number;
  best: number;
  gap: number;
}

export const GRADE_LEVELS: [number, string][] = [[10, 'отлично'], [8, 'сильный результат'], [6, 'хороший результат'], [4, 'средний результат'], [1, 'слабый результат']];

/**
 * Оценка результата модели по 10-балльной шкале — относительно стратегий с теми же джокерами:
 * ниже медианы — 1–5, медиана…90-й перцентиль — 5–8, от 90-го перцентиля до лучшего варианта — 8–10.
 */
export function gradeResult(delta: number, pair: BenchPair): ResultGrade {
  const q = pair.q;
  const best = Math.max(pair.hindsight.delta, q[q.length - 1]);
  const p = percentileOf(q, delta);
  let x: number;
  if (delta >= best) x = 10;
  else if (p >= 0.9) x = 8 + (2 * (delta - q[90])) / Math.max(1e-9, best - q[90]);
  else if (p >= 0.5) x = 5 + (3 * (p - 0.5)) / 0.4;
  else x = 1 + (4 * p) / 0.5;
  const score = Math.max(1, Math.min(10, Math.round(x)));
  return { score, level: GRADE_LEVELS.find(([min]) => score >= min)![1], percentile: p, best, gap: Math.max(0, best - delta) };
}
