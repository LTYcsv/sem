// Общие для сервера и клиента: шаги игры, проверки ввода, форматы представлений.
import type { Evaluation, ItemStatus, LedgerEntry, PosOffer } from './engine.ts';
import type { Marks, Mode } from './types.ts';

export const PHASES = ['lobby', 'city', 'matrix', 'scenarios', 'budget', 'jokerNeg', 'corr1', 'jokerPos', 'corr2', 'closing', 'defense', 'done'] as const;
export type Phase = (typeof PHASES)[number];
export type TimedPhase = Exclude<Phase, 'lobby' | 'done'>;
export const TIMED_PHASES = PHASES.filter((p) => p !== 'lobby' && p !== 'done') as TimedPhase[];

export const PHASE_LABELS: Record<Phase, string> = {
  lobby: 'Ожидание старта',
  city: 'Город и диагностика',
  matrix: 'Матрица 2×2',
  scenarios: 'Сценарии',
  budget: 'Бюджет',
  jokerNeg: 'Негативный джокер',
  corr1: 'Корректировка 1',
  jokerPos: 'Положительный джокер',
  corr2: 'Корректировка 2',
  closing: 'Закрытие бюджета',
  defense: 'Защита',
  done: 'Итог',
};
/** Номер шага для команды (0 = лобби … 10 = защита). */
export const phaseNumber = (p: Phase) => PHASES.indexOf(p);

export const DEFAULT_DURATIONS_MIN: Record<TimedPhase, number> = {
  city: 8, matrix: 5, scenarios: 7, budget: 5, jokerNeg: 2, corr1: 5, jokerPos: 2, corr2: 5, closing: 3, defense: 3,
};

export const roundOf = (p: Phase): 0 | 1 | 2 | null => (p === 'budget' ? 0 : p === 'corr1' ? 1 : p === 'corr2' ? 2 : null);

export const GRADE_CRITERIA = [
  { key: 'involvement', label: 'Включённость' },
  { key: 'analysis', label: 'Качество анализа' },
  { key: 'reasoning', label: 'Обоснованность решения' },
  { key: 'data', label: 'Использование данных' },
  { key: 'contribution', label: 'Вклад в работу команды' },
] as const;
export type GradeKey = (typeof GRADE_CRITERIA)[number]['key'];

// ---------- ввод команды ----------

export interface Axis { name: string; poleA: string; poleB: string; why: string }
export interface Inputs {
  members: string[];
  diagnostics: { trends: string[]; drivers: string[]; weakSignals: string[]; problems: string[] };
  matrix: { axes: [Axis, Axis] };
  scenarios: { title: string; text: string }[];
  closing: Record<string, { launch: boolean | null; reason: string }>;
  defense: { solutions: string[]; joker: string; lesson: string };
}
export const DIAG_SLOTS = { trends: [3, 4], drivers: [2, 3], weakSignals: [1, 2], problems: [3, 3] } as const;
export const DIAG_LABELS = { trends: 'Тренды', drivers: 'Драйверы', weakSignals: 'Слабые сигналы', problems: 'Три главные проблемы' } as const;

export const emptyAxis = (): Axis => ({ name: '', poleA: '', poleB: '', why: '' });
export const emptyInputs = (): Inputs => ({
  members: [],
  diagnostics: { trends: ['', '', '', ''], drivers: ['', '', ''], weakSignals: ['', ''], problems: ['', '', ''] },
  matrix: { axes: [emptyAxis(), emptyAxis()] },
  scenarios: [0, 1, 2, 3].map(() => ({ title: '', text: '' })),
  closing: {},
  defense: { solutions: ['', '', ''], joker: '', lesson: '' },
});

/** Сценарий i лежит на пересечении полюсов: ось 1 — A для 0,1; ось 2 — A для 0,2. */
export const scenarioPoles = (i: number) => ({ a: i < 2 ? 'poleA' : 'poleB', b: i % 2 === 0 ? 'poleA' : 'poleB' }) as const;

const words = (s: string) => (s.match(/[\p{L}\d]+/gu) ?? []).length;
/** Число предложений минимум из 3 слов. */
export function countSentences(text: string): number {
  return text
    .split(/[.!?…]+(?=\s|$)/u)
    .map((s) => s.trim())
    .filter((s) => words(s) >= 3).length;
}
const filled = (s: string | undefined) => !!s && s.trim().length >= 2;

export interface PortfolioRow {
  code: string;
  name: string;
  status: ItemStatus;
  mode: Mode;
  round: 0 | 1 | 2 | 'pos';
  paid: number;
  laterDue: number;
  laterDiscount: number;
  /** Можно ли изменить режим/убрать в текущем шаге. */
  editable: boolean;
  /** Можно ли отказаться (условная из прошлого шага). */
  cancellable: boolean;
  scenarios: Marks;
  trigger: string;
}

/** Ошибки, мешающие нажать «Готово». Пустой список = шаг можно завершить. */
export function validateStep(phase: Phase, inputs: Inputs, opts: { diagnosticsEnabled: boolean; portfolio: PortfolioRow[]; posDecided?: boolean; posAvailable?: boolean }): string[] {
  const e: string[] = [];
  if (phase === 'city' && opts.diagnosticsEnabled) {
    for (const k of Object.keys(DIAG_SLOTS) as (keyof typeof DIAG_SLOTS)[]) {
      const n = inputs.diagnostics[k].filter(filled).length;
      if (n < DIAG_SLOTS[k][0]) e.push(`${DIAG_LABELS[k]}: заполните минимум ${DIAG_SLOTS[k][0]} (сейчас ${n})`);
    }
  }
  if (phase === 'matrix') {
    inputs.matrix.axes.forEach((a, i) => {
      if (!filled(a.name)) e.push(`Неопределённость ${i + 1}: укажите название`);
      if (!filled(a.poleA) || !filled(a.poleB)) e.push(`Неопределённость ${i + 1}: укажите оба полюса`);
      if (!filled(a.why)) e.push(`Неопределённость ${i + 1}: объясните, почему она критична`);
    });
  }
  if (phase === 'scenarios') {
    inputs.scenarios.forEach((s, i) => {
      if (!filled(s.title)) e.push(`Сценарий ${i + 1}: нет названия`);
      const n = countSentences(s.text);
      if (n < 3) e.push(`Сценарий ${i + 1}: нужно минимум 3 предложения (сейчас ${n})`);
    });
  }
  if (phase === 'budget' || phase === 'corr1' || phase === 'corr2') {
    for (const r of opts.portfolio) {
      if (r.status === 'cancelled') continue;
      if (!r.scenarios.some(Boolean)) e.push(`${r.code}: отметьте хотя бы один сценарий, где мера полезна`);
      if (r.mode === 'conditional' && (r.status === 'conditional') && !filled(r.trigger)) e.push(`${r.code}: для условной меры нужен триггер`);
    }
  }
  if (phase === 'jokerPos' && opts.posAvailable && !opts.posDecided) e.push('Решите: использовать джокер или пропустить');
  if (phase === 'closing') {
    for (const r of opts.portfolio) {
      if (r.status !== 'conditional') continue;
      const c = inputs.closing[r.code];
      if (!c || c.launch === null) e.push(`${r.code}: решите — запускаем или нет`);
      else if (countSentences(c.reason) < 1 && words(c.reason) < 3) e.push(`${r.code}: обоснуйте решение триггером (1–2 предложения)`);
    }
  }
  if (phase === 'defense') {
    inputs.defense.solutions.forEach((s, i) => { if (!filled(s)) e.push(`Устойчивое решение ${i + 1}: не заполнено`); });
    if (!filled(inputs.defense.joker)) e.push('Самый значимый джокер: не заполнено');
    if (!filled(inputs.defense.lesson)) e.push('Главный урок: не заполнено');
  }
  return e;
}

// ---------- представления ----------

export interface PublicCity {
  id: string;
  name: string;
  type: string;
  general: { label: string; value: string }[];
  unique: { label: string; value: string; note?: string }[];
  situation: string;
  signals: string[];
}
export interface PublicMeasure {
  code: string; name: string; full: number; now: number; later: number;
  conditionalAllowed: boolean; triggerExample: string; description: string;
}
export interface JokerCard { code: string; name: string; description: string; ruleText: string; basket: 'negative' | 'positive' }

export interface Balance {
  start: number;
  spent: number;
  reserve: number;
  laterCommitments: number;
  forecast: number;
  forecastPenalty: number;
  /** Сколько ещё можно потратить в текущем шаге. */
  canSpend: number;
  ledger: LedgerEntry[];
}

export interface TeamView {
  serverNow: number;
  game: { pin: string; status: 'lobby' | 'running' | 'finished'; diagnosticsEnabled: boolean; teamsJoined: number; announcement: { id: string; text: string; at: number } | null };
  team: { id: string; name: string; phase: Phase; deadline: number | null; remainingMs: number | null; paused: boolean; durationMs: number };
  rules: { penaltyStep: number; reserveBonusStep: number; reserveBonusMax: number; conditionalSharePct: number };
  inputs: Inputs;
  city: PublicCity | null;
  catalog: PublicMeasure[];
  portfolio: PortfolioRow[];
  balance: Balance | null;
  negJoker: (JokerCard & { cost: number; base: number; explanation: string }) | null;
  posJoker: (JokerCard & { offer: PosOffer; decided: boolean; used: boolean; measure?: string; bonusText: string }) | null;
  closingPreview: { reserve: number; deficit: number; penalty: number } | null;
  stepErrors: string[];
  pdfReady: boolean;
}

export interface AdminTeam {
  id: string;
  name: string;
  members: string[];
  connected: boolean;
  lastActivity: number;
  joinedAt: number;
  deviceReset: boolean;
  phase: Phase;
  deadline: number | null;
  remainingMs: number | null;
  paused: boolean;
  city: (PublicCity & { vulnerabilities: string[]; start: Record<string, number> }) | null;
  inputs: Inputs;
  portfolio: PortfolioRow[];
  balance: Balance | null;
  negJoker: TeamView['negJoker'];
  posJoker: TeamView['posJoker'];
  final: Evaluation['final'] | null;
  stepErrors: string[];
}

export interface AdminView {
  serverNow: number;
  lanUrls: string[];
  joinUrl: string;
  game: null | {
    id: string; pin: string; status: 'lobby' | 'running' | 'finished'; createdAt: number;
    settings: { durationsMin: Record<TimedPhase, number>; diagnosticsEnabled: boolean };
    announcement: { id: string; text: string; at: number } | null;
    grades: Record<string, Record<string, Partial<Record<GradeKey, number>>>>;
  };
  teams: AdminTeam[];
  data: { source: string; generatedAt: string; unconfirmed: number; warnings: string[]; overrides: string[]; indicators: { key: string; label: string }[] };
  pastGames: { id: string; pin: string; createdAt: number; status: string; teams: number }[];
}

export type TeamAction =
  | { type: 'saveInputs'; section: 'members' | 'diagnostics' | 'matrix' | 'scenarios' | 'defense'; data: unknown }
  | { type: 'setMeasure'; code: string; mode: Mode | 'none' }
  | { type: 'cancelMeasure'; code: string }
  | { type: 'setMarks'; code: string; scenarios: Marks; trigger: string }
  | { type: 'posDecide'; use: boolean; measure?: string }
  | { type: 'closingSet'; code: string; launch: boolean | null; reason: string }
  | { type: 'finish' };

export type Target = 'all' | string;
export type AdminAction =
  | { type: 'createGame' }
  | { type: 'start' }
  | { type: 'pause'; target: Target }
  | { type: 'resume'; target: Target }
  | { type: 'addMinute'; target: Target }
  | { type: 'skip'; target: Target }
  | { type: 'forceJoker'; target: Target }
  | { type: 'announce'; text: string }
  | { type: 'resetDevice'; teamId: string }
  | { type: 'resetTeam'; teamId: string }
  | { type: 'removeTeam'; teamId: string }
  | { type: 'settings'; durationsMin?: Partial<Record<TimedPhase, number>>; diagnosticsEnabled?: boolean }
  | { type: 'grade'; teamId: string; member: string; key: GradeKey; value: number | null }
  | { type: 'finishGame' };

export interface Ack { ok: boolean; error?: string; errors?: string[] }
