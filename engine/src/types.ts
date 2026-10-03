// Типы данных игры (формат data/game_data.json) и решений команды.

export const INDICATORS = ['econ', 'social', 'infra', 'eco', 'human', 'adapt'] as const;
export type IndicatorKey = (typeof INDICATORS)[number];
export type Vector = Record<IndicatorKey, number>;

export interface ModelRules {
  startBudget: number;
  /** Доля эффекта подготовленной, но не запущенной условной меры (0.5). */
  conditionalShare: number;
  /** у.е. дефицита на −1 балл (округление вверх). */
  penaltyStep: number;
  penaltyIndicator: IndicatorKey;
  /** у.е. остатка резерва на +1 балл. */
  reserveBonusStep: number;
  reserveBonusMax: number;
  reserveBonusIndicator: IndicatorKey;
  min: number;
  max: number;
  /** Кандидат правки: штраф, который не помещается в Экономику (она уже на минимуме), списывается с наибольших других показателей. */
  penaltySpill?: boolean;
  /** Кандидат правки: на закрытии запускать условную меру можно только если хватает резерва (без добровольного долга). */
  closingNoDebt?: boolean;
}

export interface City {
  id: string;
  name: string;
  type: string;
  general: { label: string; value: string }[];
  startBudget: number;
  start: Vector;
  unique: { label: string; value: string; note?: string }[];
  situation: string;
  signals: string[];
  /** Только для ведущих. */
  vulnerabilities: string[];
}

export interface Measure {
  code: string;
  name: string;
  full: number;
  now: number;
  later: number;
  conditionalAllowed: boolean;
  triggerExample: string;
  description: string;
  effects: Vector;
}

/** Условие правила: все из all есть, хотя бы одна из any есть, ни одной из none нет. */
export interface Cond {
  all?: string[];
  any?: string[];
  none?: string[];
}
export interface CostRule extends Cond {
  cost?: number;
  delta?: number;
}

export type PositiveRule =
  | { kind: 'pay'; cost: number; rules: CostRule[] }
  | { kind: 'grant'; ownCost: number; grant: number; eligible: string[] }
  | { kind: 'laterDiscount'; any: string[]; discount: number }
  | { kind: 'partner'; measure: string; discount: number; launchCost: number }
  | { kind: 'none' };

interface JokerBase {
  code: string;
  name: string;
  description: string;
  ruleText: string;
  /** Пометка разработчика из xlsx (только для ведущих). */
  designerNote?: string;
}
export interface NegativeJoker extends JokerBase {
  basket: 'negative';
  baseCost: number;
  rules: CostRule[];
}
export interface PositiveJoker extends JokerBase {
  basket: 'positive';
  bonus: { indicator: IndicatorKey; value: number } | null;
  rule: PositiveRule;
}
export type Joker = NegativeJoker | PositiveJoker;

export interface GameData {
  meta: {
    source: string;
    generatedAt: string;
    unconfirmed: { sheet: string; cell: string; text: string }[];
    warnings: string[];
    overrides?: string[];
  };
  indicators: { key: IndicatorKey; label: string }[];
  rules: ModelRules;
  cities: City[];
  measures: Measure[];
  jokers: Joker[];
}

// ---------- Решения команды ----------

export type Mode = 'full' | 'conditional';
export type Marks = [boolean, boolean, boolean, boolean];

export interface Decisions {
  cityId: string;
  /** Меры, добавленные на шаге «Бюджет» (0) и в корректировках 1 и 2. Мера встречается не более одного раза. */
  rounds: [Record<string, Mode>, Record<string, Mode>, Record<string, Mode>];
  /** Отказ от условной меры в корректировке 1 или 2 (подготовка не возвращается). */
  cancels: [string[], string[]];
  /** Отметки «полезна в сценариях 1–4» и триггер условной меры. */
  marks: Record<string, { scenarios: Marks; trigger: string }>;
  negJoker?: string;
  posJoker?: string;
  posDecision?: { use: boolean; measure?: string };
  /** Решения на закрытии по условным мерам; наличие объекта = бюджет закрыт. */
  closing?: Record<string, { launch: boolean; reason?: string }>;
}
