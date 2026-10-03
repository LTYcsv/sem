// Состояние игры, шаги, таймеры и действия. Сервер — единственный источник правды.
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  DEFAULT_DURATIONS_MIN, PHASES, emptyDecisions, emptyInputs, evaluate, roundOf, validateStep, countSentences,
  type AdminAction, type AdminTeam, type AdminView, type Balance, type Decisions, type Evaluation, type GameData, type GradeKey,
  type Inputs, type Marks, type Mode, type Phase, type PortfolioRow, type PositiveJoker, type TeamAction, type TeamView, type TimedPhase,
  type NegativeJoker, GRADE_CRITERIA,
} from '@sem/engine';
import type { Store } from './db.ts';

export interface TeamState {
  id: string;
  name: string;
  token: string;
  deviceReset: boolean;
  joinedAt: number;
  lastActivity: number;
  phase: Phase;
  deadline: number | null;
  pausedRemaining: number | null;
  phaseStartedAt: number;
  decisions: Decisions;
  inputs: Inputs;
  phaseLog: { phase: Phase; at: number; reason: string }[];
}
export interface GameState {
  id: string;
  pin: string;
  createdAt: number;
  status: 'lobby' | 'running' | 'finished';
  settings: { durationsMin: Record<TimedPhase, number>; diagnosticsEnabled: boolean };
  teams: TeamState[];
  announcement: { id: string; text: string; at: number } | null;
  grades: Record<string, Record<string, Partial<Record<GradeKey, number>>>>;
}

export class GameError extends Error {}
const MAX_TEAMS = 4;
const MAX_TEXT = 2000;

const clip = (s: unknown, n = MAX_TEXT) => String(s ?? '').slice(0, n);
const clipArr = (a: unknown, len: number, n = MAX_TEXT) => Array.from({ length: len }, (_, i) => clip(Array.isArray(a) ? a[i] : '', n));

export class GameManager {
  game: GameState | null;
  /** id команды → число активных подключений */
  connections = new Map<string, number>();
  onChange: () => void = () => {};
  private timer: NodeJS.Timeout | null = null;

  constructor(public data: GameData, private store: Store) {
    this.game = store.activeGame<GameState>();
    if (this.game) this.recoverTimers();
  }

  // ---------- служебное ----------

  /** После перезапуска сервера таймеры продолжаются с момента остановки. */
  private recoverTimers() {
    const lastAlive = Number(this.store.get('lastAlive') ?? Date.now());
    const downtime = Math.max(0, Date.now() - lastAlive);
    for (const t of this.game!.teams) if (t.deadline) t.deadline += downtime;
    this.save();
  }
  startLoop() {
    this.timer = setInterval(() => this.tick(), 500);
    setInterval(() => this.store.set('lastAlive', String(Date.now())), 2000).unref();
    this.store.set('lastAlive', String(Date.now()));
  }
  stopLoop() { if (this.timer) clearInterval(this.timer); }
  save() { if (this.game) this.store.saveGame(this.game, true, this.game); }
  private changed() { this.save(); this.onChange(); }

  tick(now = Date.now()) {
    const g = this.game;
    if (!g || g.status !== 'running') return;
    let changed = false;
    for (const t of g.teams) {
      if (t.deadline !== null && t.deadline <= now && t.phase !== 'done') {
        this.advance(t, 'таймер');
        changed = true;
      }
    }
    if (changed) {
      if (g.teams.every((t) => t.phase === 'done')) g.status = 'finished';
      this.changed();
    }
  }

  private durationMs(p: Phase) {
    if (p === 'lobby' || p === 'done') return 0;
    return Math.round((this.game!.settings.durationsMin[p] ?? DEFAULT_DURATIONS_MIN[p]) * 60_000);
  }

  private enterPhase(t: TeamState, p: Phase, reason: string) {
    const now = Date.now();
    const wasPaused = t.pausedRemaining !== null;
    t.phase = p;
    t.phaseStartedAt = now;
    t.phaseLog.push({ phase: p, at: now, reason });
    const dur = this.durationMs(p);
    if (p === 'done' || p === 'lobby') { t.deadline = null; t.pausedRemaining = null; }
    else if (wasPaused) { t.deadline = null; t.pausedRemaining = dur; }
    else { t.deadline = now + dur; t.pausedRemaining = null; }
    if (p === 'jokerNeg' && !t.decisions.negJoker) t.decisions.negJoker = this.draw(t, 'negative');
    if (p === 'jokerPos' && !t.decisions.posJoker) t.decisions.posJoker = this.draw(t, 'positive');
  }

  /** Переход на следующий шаг с завершением текущего. */
  advance(t: TeamState, reason: string) {
    const i = PHASES.indexOf(t.phase);
    if (t.phase === 'done' || t.phase === 'lobby') return;
    if (t.phase === 'jokerPos' && !t.decisions.posDecision) t.decisions.posDecision = { use: false };
    if (t.phase === 'closing') this.commitClosing(t);
    this.enterPhase(t, PHASES[i + 1], reason);
    if (this.game!.teams.every((x) => x.phase === 'done')) this.game!.status = 'finished';
  }

  private commitClosing(t: TeamState) {
    const ev = evaluate(this.data, t.decisions, { texts: false });
    const closing: NonNullable<Decisions['closing']> = {};
    for (const it of ev.items) {
      if (it.status !== 'conditional') continue;
      const c = t.inputs.closing[it.code];
      closing[it.code] = { launch: c?.launch === true, reason: c?.reason ?? '' };
    }
    t.decisions.closing = closing;
  }

  /** Случайный джокер корзины, ещё не вытянутый другими командами этой игры. */
  private draw(t: TeamState, basket: 'negative' | 'positive'): string {
    const taken = new Set(this.game!.teams.filter((x) => x.id !== t.id).map((x) => (basket === 'negative' ? x.decisions.negJoker : x.decisions.posJoker)));
    const all = this.data.jokers.filter((j) => j.basket === basket).map((j) => j.code);
    const free = all.filter((c) => !taken.has(c));
    const pool = free.length ? free : all;
    return pool[randomInt(pool.length)];
  }

  private requireGame(): GameState {
    if (!this.game) throw new GameError('Игра не создана');
    return this.game;
  }
  teamByToken(token: string) { return this.game?.teams.find((t) => t.token === token) ?? null; }
  private team(id: string) {
    const t = this.requireGame().teams.find((x) => x.id === id);
    if (!t) throw new GameError('Команда не найдена');
    return t;
  }
  private targets(target: string) { return target === 'all' ? this.requireGame().teams : [this.team(target)]; }

  // ---------- создание и вход ----------

  createGame(): GameState {
    if (this.game) this.store.saveGame(this.game, false, this.game);
    this.store.deactivateAll();
    const pin = String(randomInt(100000, 1000000));
    this.game = {
      id: randomUUID(), pin, createdAt: Date.now(), status: 'lobby',
      settings: { durationsMin: { ...DEFAULT_DURATIONS_MIN }, diagnosticsEnabled: true },
      teams: [], announcement: null, grades: {},
    };
    this.changed();
    return this.game;
  }

  join(pin: string, rawName: string): { token: string; teamId: string } {
    const g = this.game;
    if (!g || g.pin !== String(pin).trim()) throw new GameError('Игра с таким PIN не найдена');
    const name = rawName.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (name.length < 2) throw new GameError('Введите название команды (от 2 символов)');
    const same = g.teams.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (same) {
      if (!same.deviceReset) throw new GameError('Команда с таким названием уже в игре. Если это ваша команда и вы сменили устройство — попросите ведущего «сбросить устройство».');
      same.token = randomBytes(18).toString('base64url');
      same.deviceReset = false;
      same.lastActivity = Date.now();
      this.changed();
      return { token: same.token, teamId: same.id };
    }
    if (g.status !== 'lobby') throw new GameError('Игра уже началась — новые команды не принимаются');
    if (g.teams.length >= MAX_TEAMS) throw new GameError(`В игре уже ${MAX_TEAMS} команды — мест нет`);
    const t: TeamState = {
      id: randomUUID().slice(0, 8), name, token: randomBytes(18).toString('base64url'), deviceReset: false,
      joinedAt: Date.now(), lastActivity: Date.now(), phase: 'lobby', deadline: null, pausedRemaining: null, phaseStartedAt: Date.now(),
      decisions: emptyDecisions(''), inputs: emptyInputs(), phaseLog: [{ phase: 'lobby', at: Date.now(), reason: 'вход' }],
    };
    g.teams.push(t);
    this.changed();
    return { token: t.token, teamId: t.id };
  }

  // ---------- действия команды ----------

  teamAction(token: string, a: TeamAction): { errors?: string[] } {
    const g = this.requireGame();
    const t = this.teamByToken(token);
    if (!t) throw new GameError('Сессия команды недействительна — войдите снова');
    t.lastActivity = Date.now();
    const round = roundOf(t.phase);
    const res: { errors?: string[] } = {};
    switch (a.type) {
      case 'saveInputs': {
        const allowed: Record<string, Phase[]> = {
          members: PHASES.filter((p) => p !== 'done') as Phase[], diagnostics: ['city'], matrix: ['matrix'], scenarios: ['scenarios'], defense: ['defense'],
        };
        if (!allowed[a.section]?.includes(t.phase)) throw new GameError('Этот раздел сейчас нельзя изменить');
        const d = a.data as any;
        if (a.section === 'members') t.inputs.members = (Array.isArray(d) ? d : []).slice(0, 6).map((s: unknown) => clip(s, 60));
        if (a.section === 'diagnostics') t.inputs.diagnostics = {
          trends: clipArr(d?.trends, 4, 300), drivers: clipArr(d?.drivers, 3, 300), weakSignals: clipArr(d?.weakSignals, 2, 300), problems: clipArr(d?.problems, 3, 300),
        };
        if (a.section === 'matrix') t.inputs.matrix = {
          axes: [0, 1].map((i) => ({ name: clip(d?.axes?.[i]?.name, 120), poleA: clip(d?.axes?.[i]?.poleA, 120), poleB: clip(d?.axes?.[i]?.poleB, 120), why: clip(d?.axes?.[i]?.why, 600) })) as Inputs['matrix']['axes'],
        };
        if (a.section === 'scenarios') t.inputs.scenarios = [0, 1, 2, 3].map((i) => ({ title: clip(d?.[i]?.title, 120), text: clip(d?.[i]?.text, 2000) }));
        if (a.section === 'defense') t.inputs.defense = { solutions: clipArr(d?.solutions, 3, 600), joker: clip(d?.joker, 800), lesson: clip(d?.lesson, 800) };
        break;
      }
      case 'setMeasure': {
        if (round === null) throw new GameError('Меры можно менять только на шагах «Бюджет» и «Корректировка»');
        const m = this.data.measures.find((x) => x.code === a.code);
        if (!m) throw new GameError('Нет такой меры');
        const owner = t.decisions.rounds.findIndex((r) => a.code in r);
        if (owner !== -1 && owner !== round) throw new GameError('Мера уже в портфеле с прошлого шага — её режим изменить нельзя');
        if (this.cancelledCodes(t).has(a.code)) throw new GameError('От этой меры уже отказались — повторно купить нельзя');
        if (a.mode === 'conditional' && !m.conditionalAllowed) throw new GameError(`${m.code} не может быть условной`);
        const before = { ...t.decisions.rounds[round] };
        if (a.mode === 'none') delete t.decisions.rounds[round][a.code];
        else t.decisions.rounds[round][a.code] = a.mode as Mode;
        const ev = evaluate(this.data, t.decisions, { texts: false });
        const err = ev.errors.find((e) => /потрачено больше|уже в портфеле|не может быть/.test(e));
        if (err) {
          t.decisions.rounds[round] = before;
          throw new GameError(round === 0 ? 'Не хватает бюджета: на этом шаге нельзя потратить больше 100 у.е.' : 'Не хватает резерва на эту меру');
        }
        if (a.mode !== 'none' && !t.decisions.marks[a.code]) t.decisions.marks[a.code] = { scenarios: [false, false, false, false], trigger: '' };
        break;
      }
      case 'cancelMeasure': {
        if (round !== 1 && round !== 2) throw new GameError('Снять меру можно только в корректировке');
        const ev = evaluate(this.data, t.decisions, { texts: false });
        const it = ev.items.find((i) => i.code === a.code);
        if (!it || it.round === round || it.round === 'pos' || (it.status !== 'conditional' && it.status !== 'full'))
          throw new GameError('Снять можно только полную или условную меру прошлых шагов (меры, запущенные джокером, не снимаются)');
        if (ev.locked.includes(a.code)) throw new GameError(`${a.code} удешевила негативный джокер — снимать нельзя`);
        t.decisions.cancels[round - 1].push(a.code);
        break;
      }
      case 'setMarks': {
        if (round === null) throw new GameError('Отметки сценариев меняются на шагах «Бюджет» и «Корректировка»');
        if (!t.decisions.rounds.some((r) => a.code in r) && !this.jokerAdded(t).has(a.code)) throw new GameError('Мера не в портфеле');
        const sc = [0, 1, 2, 3].map((i) => !!a.scenarios?.[i]) as Marks;
        t.decisions.marks[a.code] = { scenarios: sc, trigger: clip(a.trigger, 300) };
        break;
      }
      case 'posDecide': {
        if (t.phase !== 'jokerPos') throw new GameError('Сейчас не шаг положительного джокера');
        if (t.decisions.posDecision) throw new GameError('Решение уже принято');
        const ev = evaluate(this.data, t.decisions, { texts: false });
        if (a.use) {
          if (!ev.pos?.available) throw new GameError(`Использовать нельзя: ${ev.pos?.reason ?? ''}`);
          if (ev.pos.choices && !ev.pos.choices.some((c) => c.code === a.measure)) throw new GameError('Выберите меру для гранта');
        }
        t.decisions.posDecision = { use: !!a.use, ...(a.use && a.measure ? { measure: a.measure } : {}) };
        if (a.use && a.measure && !t.decisions.marks[a.measure]) t.decisions.marks[a.measure] = { scenarios: [false, false, false, false], trigger: '' };
        if (a.use && ev.pos?.kind === 'partner') {
          const code = (this.data.jokers.find((j) => j.code === t.decisions.posJoker) as PositiveJoker).rule as any;
          if (code.measure && !t.decisions.marks[code.measure]) t.decisions.marks[code.measure] = { scenarios: [false, false, false, false], trigger: '' };
        }
        this.advance(t, 'решение по джокеру');
        break;
      }
      case 'closingSet': {
        if (t.phase !== 'closing') throw new GameError('Сейчас не шаг закрытия');
        const ev = evaluate(this.data, t.decisions, { texts: false });
        if (!ev.items.some((i) => i.code === a.code && i.status === 'conditional')) throw new GameError('Это не ожидающая условная мера');
        t.inputs.closing[a.code] = { launch: a.launch === null ? null : !!a.launch, reason: clip(a.reason, 600) };
        if (this.data.rules.closingNoDebt && a.launch) {
          const pre = evaluate(this.data, { ...t.decisions, closing: this.closingDraft(t) }, { texts: false });
          if (pre.errors.length) { t.inputs.closing[a.code].launch = false; throw new GameError('Не хватает резерва на запуск'); }
        }
        break;
      }
      case 'finish': {
        if (t.phase === 'lobby' || t.phase === 'done') throw new GameError('Нечего завершать');
        const errors = this.stepErrors(t);
        if (errors.length) { res.errors = errors; return res; }
        this.advance(t, 'команда нажала «Готово»');
        break;
      }
      default:
        throw new GameError('Неизвестное действие');
    }
    void g;
    this.changed();
    return res;
  }

  private cancelledCodes(t: TeamState) { return new Set(t.decisions.cancels.flat()); }
  private jokerAdded(t: TeamState) {
    const ev = evaluate(this.data, t.decisions, { texts: false });
    return new Set(ev.items.filter((i) => i.round === 'pos').map((i) => i.code));
  }
  private closingDraft(t: TeamState): NonNullable<Decisions['closing']> {
    return Object.fromEntries(Object.entries(t.inputs.closing).map(([k, v]) => [k, { launch: v.launch === true, reason: v.reason }]));
  }

  stepErrors(t: TeamState): string[] {
    const ev = evaluate(this.data, t.decisions, { texts: false });
    return validateStep(t.phase, t.inputs, {
      diagnosticsEnabled: this.game!.settings.diagnosticsEnabled,
      portfolio: this.portfolio(t, ev),
      posDecided: !!t.decisions.posDecision,
      posAvailable: !!ev.pos?.available,
      minFull: this.data.rules.minFullMeasures ?? 0,
    });
  }

  // ---------- действия ведущего ----------

  adminAction(a: AdminAction) {
    if (a.type === 'createGame') { this.createGame(); return; }
    const g = this.requireGame();
    const now = Date.now();
    switch (a.type) {
      case 'start': {
        if (g.status !== 'lobby') throw new GameError('Игра уже запущена');
        if (!g.teams.length) throw new GameError('Нет ни одной команды');
        const cities = this.data.cities.map((c) => c.id);
        for (let i = cities.length - 1; i > 0; i--) { const j = randomInt(i + 1); [cities[i], cities[j]] = [cities[j], cities[i]]; }
        g.teams.forEach((t, i) => { t.decisions = emptyDecisions(cities[i % cities.length]); this.enterPhase(t, 'city', 'старт игры'); });
        g.status = 'running';
        break;
      }
      case 'pause':
        for (const t of this.targets(a.target)) if (t.deadline !== null) { t.pausedRemaining = Math.max(0, t.deadline - now); t.deadline = null; }
        break;
      case 'resume':
        for (const t of this.targets(a.target)) if (t.pausedRemaining !== null) { t.deadline = now + t.pausedRemaining; t.pausedRemaining = null; }
        break;
      case 'addMinute':
        for (const t of this.targets(a.target)) {
          if (t.deadline !== null) t.deadline += 60_000;
          else if (t.pausedRemaining !== null) t.pausedRemaining += 60_000;
        }
        break;
      case 'skip':
        for (const t of this.targets(a.target)) this.advance(t, 'ведущий пропустил шаг');
        break;
      case 'forceJoker':
        for (const t of this.targets(a.target)) {
          const i = PHASES.indexOf(t.phase);
          const target: Phase | null = i < PHASES.indexOf('jokerNeg') ? 'jokerNeg' : i < PHASES.indexOf('jokerPos') ? 'jokerPos' : null;
          if (!target || t.phase === 'lobby') continue;
          while (t.phase !== target) this.advance(t, 'ведущий открыл джокер');
        }
        break;
      case 'announce':
        g.announcement = a.text.trim() ? { id: randomUUID().slice(0, 8), text: clip(a.text, 500), at: now } : null;
        break;
      case 'resetDevice': {
        const t = this.team(a.teamId);
        t.token = randomBytes(18).toString('base64url');
        t.deviceReset = true;
        break;
      }
      case 'resetTeam': {
        const t = this.team(a.teamId);
        const members = t.inputs.members;
        t.inputs = { ...emptyInputs(), members };
        t.decisions = emptyDecisions(t.decisions.cityId);
        t.phaseLog.push({ phase: t.phase, at: now, reason: 'сброс прогресса ведущим' });
        if (g.status === 'lobby') { t.phase = 'lobby'; t.deadline = null; }
        else { t.pausedRemaining = null; this.enterPhase(t, 'city', 'сброс прогресса ведущим'); g.status = 'running'; }
        break;
      }
      case 'removeTeam': {
        if (g.status !== 'lobby') throw new GameError('Удалить команду можно только до старта; во время игры используйте «Сбросить»');
        g.teams = g.teams.filter((t) => t.id !== a.teamId);
        break;
      }
      case 'settings': {
        if (a.durationsMin) for (const [k, v] of Object.entries(a.durationsMin)) {
          const n = Number(v);
          if (k in g.settings.durationsMin && n >= 0.1 && n <= 60) g.settings.durationsMin[k as TimedPhase] = Math.round(n * 10) / 10;
        }
        if (typeof a.diagnosticsEnabled === 'boolean') g.settings.diagnosticsEnabled = a.diagnosticsEnabled;
        break;
      }
      case 'grade': {
        if (!GRADE_CRITERIA.some((c) => c.key === a.key)) throw new GameError('Неизвестный критерий');
        const v = a.value === null ? null : Math.round(Number(a.value) * 2) / 2;
        if (v !== null && !(v >= 0 && v <= 10)) throw new GameError('Оценка от 0 до 10');
        const byTeam = (g.grades[a.teamId] ??= {});
        const byMember = (byTeam[clip(a.member, 60)] ??= {});
        if (v === null) delete byMember[a.key]; else byMember[a.key] = v;
        break;
      }
      case 'finishGame':
        for (const t of g.teams) while (t.phase !== 'done' && t.phase !== 'lobby') this.advance(t, 'ведущий завершил игру');
        g.status = 'finished';
        break;
      default:
        throw new GameError('Неизвестное действие');
    }
    this.changed();
  }

  // ---------- представления ----------

  evaluationFor(t: TeamState, texts = true): Evaluation | null {
    if (!t.decisions.cityId) return null;
    const d = t.phase === 'closing' ? { ...t.decisions, closing: this.closingDraft(t) } : t.decisions;
    return evaluate(this.data, d, { texts });
  }
  /** Для итога: решения закрытия уже зафиксированы. */
  finalEvaluation(t: TeamState): Evaluation | null {
    if (!t.decisions.cityId || !t.decisions.closing) return null;
    return evaluate(this.data, t.decisions);
  }

  portfolio(t: TeamState, ev: Evaluation): PortfolioRow[] {
    const round = roundOf(t.phase);
    return ev.items.map((it) => {
      const m = this.data.measures.find((x) => x.code === it.code)!;
      const marks = t.decisions.marks[it.code] ?? { scenarios: [false, false, false, false] as Marks, trigger: '' };
      const locked = ev.locked.includes(it.code);
      return {
        code: it.code, name: m.name, status: it.status, mode: it.initialMode, round: it.round, paid: it.paid, laterDue: it.laterDue, laterDiscount: it.laterDiscount,
        editable: round !== null && it.round === round,
        cancellable: (round === 1 || round === 2) && (it.status === 'conditional' || it.status === 'full') && it.round !== round && it.round !== 'pos' && !locked,
        locked, refund: it.refund,
        refundIfRemoved: it.status === 'full' ? Math.floor(m.full * (this.data.rules.fullRefundShare ?? 0)) : 0,
        scenarios: marks.scenarios, trigger: marks.trigger,
      };
    });
  }

  private balance(t: TeamState, ev: Evaluation): Balance {
    const city = this.data.cities.find((c) => c.id === t.decisions.cityId)!;
    const round = roundOf(t.phase);
    let canSpend = 0;
    if (round === 0) canSpend = Math.max(0, ev.reserve);
    else if (round !== null) canSpend = Math.max(0, ev.reserve);
    return {
      start: city.startBudget, spent: ev.spent, reserve: ev.reserve, laterCommitments: ev.laterCommitments,
      forecast: ev.forecast, forecastPenalty: ev.forecastPenalty, canSpend, ledger: ev.ledger,
    };
  }

  private jokerViews(t: TeamState, ev: Evaluation) {
    const jn = t.decisions.negJoker ? (this.data.jokers.find((j) => j.code === t.decisions.negJoker) as NegativeJoker) : null;
    const jp = t.decisions.posJoker ? (this.data.jokers.find((j) => j.code === t.decisions.posJoker) as PositiveJoker) : null;
    const label = (k: string) => this.data.indicators.find((i) => i.key === k)?.label ?? k;
    return {
      negJoker: jn && ev.neg ? { code: jn.code, name: jn.name, description: jn.description, ruleText: jn.ruleText, basket: 'negative' as const, cost: ev.neg.cost, base: ev.neg.base, explanation: ev.neg.explanation } : null,
      posJoker: jp && ev.pos ? {
        code: jp.code, name: jp.name, description: jp.description, ruleText: jp.ruleText, basket: 'positive' as const,
        offer: { ...ev.pos, used: undefined, decided: undefined } as any, decided: ev.pos.decided, used: ev.pos.used, measure: ev.pos.measure,
        bonusText: jp.bonus ? `+${jp.bonus.value} к показателю «${label(jp.bonus.indicator)}»` : '',
      } : null,
    };
  }

  teamView(t: TeamState): TeamView {
    const g = this.game!;
    const ev = this.evaluationFor(t);
    const city = this.data.cities.find((c) => c.id === t.decisions.cityId);
    // На закрытии портфель показываем без черновика решений: условные меры остаются «ожидающими»
    const evRaw = ev && t.phase === 'closing' ? evaluate(this.data, t.decisions) : ev;
    const portfolio = evRaw ? this.portfolio(t, evRaw) : [];
    const jokers = ev ? this.jokerViews(t, ev) : { negJoker: null, posJoker: null };
    let closingPreview: TeamView['closingPreview'] = null;
    if (ev && (t.phase === 'closing' || t.phase === 'defense' || t.phase === 'done')) {
      const deficit = Math.max(0, -ev.reserve);
      closingPreview = { reserve: ev.reserve, deficit, penalty: deficit ? Math.ceil(deficit / this.data.rules.penaltyStep) : 0 };
    }
    return {
      serverNow: Date.now(),
      game: { pin: g.pin, status: g.status, diagnosticsEnabled: g.settings.diagnosticsEnabled, teamsJoined: g.teams.length, announcement: g.announcement },
      team: {
        id: t.id, name: t.name, phase: t.phase, deadline: t.deadline,
        remainingMs: t.deadline !== null ? Math.max(0, t.deadline - Date.now()) : t.pausedRemaining,
        paused: t.pausedRemaining !== null, durationMs: this.durationMs(t.phase),
      },
      rules: {
        penaltyStep: this.data.rules.penaltyStep, reserveBonusStep: this.data.rules.reserveBonusStep, reserveBonusMax: this.data.rules.reserveBonusMax,
        conditionalSharePct: Math.round(this.data.rules.conditionalShare * 100),
        minFull: this.data.rules.minFullMeasures ?? 0, refundPct: Math.round((this.data.rules.fullRefundShare ?? 0) * 100),
      },
      inputs: t.inputs,
      city: city && t.phase !== 'lobby' ? { id: city.id, name: city.name, type: city.type, general: city.general, unique: city.unique, situation: city.situation, signals: city.signals } : null,
      catalog: this.data.measures.map(({ effects: _e, ...m }) => m),
      portfolio,
      balance: ev ? this.balance(t, ev) : null,
      ...jokers,
      closingPreview,
      stepErrors: t.phase === 'lobby' || t.phase === 'done' ? [] : this.stepErrors(t),
      pdfReady: t.phase === 'done',
    };
  }

  adminView(lanUrls: string[], joinUrl: string): AdminView {
    const g = this.game;
    const past = this.store.listGames().filter((r) => !r.active).map((r) => {
      const s = JSON.parse(r.state) as GameState;
      return { id: r.id, pin: r.pin, createdAt: r.created_at, status: s.status, teams: s.teams.length };
    });
    const dataInfo = {
      source: this.data.meta.source, generatedAt: this.data.meta.generatedAt, unconfirmed: this.data.meta.unconfirmed.length,
      warnings: this.data.meta.warnings, overrides: this.data.meta.overrides ?? [], indicators: this.data.indicators,
    };
    if (!g) return { serverNow: Date.now(), lanUrls, joinUrl, game: null, teams: [], data: dataInfo, pastGames: past };
    const teams: AdminTeam[] = g.teams.map((t) => {
      const ev = this.evaluationFor(t);
      const city = this.data.cities.find((c) => c.id === t.decisions.cityId);
      const tv = this.teamView(t);
      const fin = this.finalEvaluation(t);
      return {
        id: t.id, name: t.name, members: t.inputs.members, connected: (this.connections.get(t.id) ?? 0) > 0, lastActivity: t.lastActivity, joinedAt: t.joinedAt,
        deviceReset: t.deviceReset, phase: t.phase, deadline: t.deadline, remainingMs: tv.team.remainingMs, paused: tv.team.paused,
        city: city ? { id: city.id, name: city.name, type: city.type, general: city.general, unique: city.unique, situation: city.situation, signals: city.signals, vulnerabilities: city.vulnerabilities, start: city.start } : null,
        inputs: t.inputs, portfolio: tv.portfolio, balance: tv.balance, negJoker: tv.negJoker, posJoker: tv.posJoker,
        final: fin?.final ?? null, stepErrors: tv.stepErrors,
      };
      void ev;
    });
    return {
      serverNow: Date.now(), lanUrls, joinUrl,
      game: { id: g.id, pin: g.pin, status: g.status, createdAt: g.createdAt, settings: g.settings, announcement: g.announcement, grades: g.grades },
      teams, data: dataInfo, pastGames: past,
    };
  }
}

export { countSentences };
