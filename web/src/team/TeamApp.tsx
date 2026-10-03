import { useEffect, useMemo, useState } from 'react';
import { PHASES, PHASE_LABELS, type TeamAction, type TeamView, type Ack } from '@sem/engine';
import { TEAM_TOKEN, fmtTime, postJson, remaining, storage, useLive, useNow } from '../api';
import { useToast } from '../ui';
import { CityStep, MatrixStep, ScenariosStep, DefenseStep, Members } from './Steps';
import { BudgetStep } from './Budget';
import { JokerNegStep, JokerPosStep } from './Jokers';
import { ClosingStep } from './Closing';

export type Act = (a: TeamAction) => Promise<Ack>;
export interface StepProps { v: TeamView; act: Act; toast: (m: string, k?: 'err' | 'ok') => void }

function Join({ notice }: { notice: string }) {
  const params = new URLSearchParams(location.search);
  const [pin, setPin] = useState(params.get('pin') ?? '');
  const [name, setName] = useState('');
  const [err, setErr] = useState(notice);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await postJson<{ token: string }>('/api/join', { pin: pin.replace(/\D/g, ''), name });
      storage.set(TEAM_TOKEN, r.token);
      location.replace('/');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="narrow">
      <div className="card">
        <h1>Форсайт-сессия</h1>
        <p className="muted">Сценарии развития территории и устойчивые решения. Введите PIN с экрана ведущего и название команды — регистрация не нужна.</p>
        <form onSubmit={submit} className="stack">
          <div>
            <label className="f" htmlFor="pin">PIN игры</label>
            <input id="pin" className="t pin" inputMode="numeric" autoComplete="off" maxLength={7} value={pin} onChange={(e) => setPin(e.target.value)} placeholder="000000" autoFocus />
          </div>
          <div>
            <label className="f" htmlFor="nm">Название команды</label>
            <input id="nm" className="t" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="например, «Штаб будущего»" />
          </div>
          {err && <div className="alert err">{err}</div>}
          <button className="btn primary big" disabled={busy || pin.replace(/\D/g, '').length !== 6 || name.trim().length < 2}>Войти в игру</button>
        </form>
      </div>
    </div>
  );
}

function Topbar({ v, offset }: { v: TeamView; offset: number }) {
  const now = useNow(offset);
  const ms = remaining(v.team.deadline, v.team.paused ? v.team.remainingMs : null, now);
  const idx = PHASES.indexOf(v.team.phase);
  const steps = PHASES.slice(1, -1);
  return (
    <div className="topbar">
      <div className="in">
        <div>
          <div className="title">{v.team.name}{v.city ? ` · ${v.city.name}` : ''}</div>
          <div className="step small">{v.team.phase === 'lobby' || v.team.phase === 'done' ? PHASE_LABELS[v.team.phase] : `Шаг ${idx} из 10 · ${PHASE_LABELS[v.team.phase]}`}</div>
        </div>
        <div className="progress" aria-hidden>{steps.map((p, i) => <span key={p} className={i + 1 < idx ? 'done' : i + 1 === idx ? 'cur' : ''} />)}</div>
        {v.team.phase !== 'lobby' && v.team.phase !== 'done' && (
          <div className={`timer ${v.team.paused ? 'paused' : ms !== null && ms < 60_000 ? 'low' : ''}`} title="Время шага ведёт сервер">
            {v.team.paused ? '⏸ ' : ''}{fmtTime(ms)}
          </div>
        )}
      </div>
    </div>
  );
}

function Announcement({ a }: { a: TeamView['game']['announcement'] }) {
  const [hidden, setHidden] = useState(() => storage.get('foresight.ann') ?? '');
  if (!a || hidden === a.id) return null;
  return (
    <div className="announce" role="alert">
      <div className="in"><span>📣 {a.text}</span><button className="btn sm" onClick={() => { storage.set('foresight.ann', a.id); setHidden(a.id); }}>Понятно</button></div>
    </div>
  );
}

function Lobby({ v, act, toast }: StepProps) {
  return (
    <div className="wrap">
      <div className="card">
        <h1>Команда «{v.team.name}» в игре</h1>
        <p className="muted">Ждём старта. В игре команд: <b>{v.game.teamsJoined}</b> из 4. Когда ведущий запустит игру, вы получите свой город.</p>
        <div className="alert info">
          <b>Как устроена игра (2 минуты):</b>
          <ol style={{ margin: '6px 0 0 1.2em', padding: 0 }}>
            <li>Изучите город и найдите тренды, драйверы и слабые сигналы.</li>
            <li>Выберите две критические неопределённости — получится матрица 2×2 и 4 сценария будущего.</li>
            <li>Распределите 100 у.е. на меры: <b>полная</b> — платите всё сейчас и получаете полный эффект; <b>условная</b> — платите малую часть сейчас, остальное — в конце, если сработает ваш триггер.</li>
            <li>Город получит два неожиданных события (джокеры). Подготовленные меры удешевляют реакцию.</li>
            <li>В конце решаете, какие условные меры запускать. Дефицит бюджета штрафуется: −1 балл за каждые {v.rules.penaltyStep} у.е. Итог и показатели — в PDF.</li>
          </ol>
        </div>
      </div>
      <div className="card"><Members v={v} act={act} toast={toast} /></div>
    </div>
  );
}

function Done({ v }: { v: TeamView }) {
  const token = storage.get(TEAM_TOKEN) ?? '';
  return (
    <div className="wrap">
      <div className="card" style={{ textAlign: 'center' }}>
        <h1>Игра завершена 🎉</h1>
        <p className="muted">Итоговый отчёт команды: матрица, сценарии, портфель, джокеры, показатели «было → стало». Его показывает представитель команды на защите.</p>
        {v.pdfReady && <a className="btn primary big" href={`/api/team/pdf?token=${encodeURIComponent(token)}`} target="_blank" rel="noreferrer">Открыть PDF</a>}
        <p className="small muted" style={{ marginTop: 14 }}>Формирование PDF занимает несколько секунд.</p>
      </div>
    </div>
  );
}

export function TeamApp() {
  const [token, setToken] = useState(() => storage.get(TEAM_TOKEN));
  const [notice, setNotice] = useState('');
  const auth = useMemo(() => (token ? { role: 'team' as const, token } : null), [token]);
  const { state: v, conn, act, offset } = useLive<TeamView>(auth, (m) => { storage.del(TEAM_TOKEN); setNotice(m); setToken(null); });
  const toast = useToast();
  useEffect(() => { document.title = v ? `${v.team.name} — форсайт` : 'Форсайт-сессия'; }, [v?.team.name]);

  if (!token) return <Join notice={notice} />;
  if (!v) return <div className="narrow"><div className="card">Подключение к серверу…</div></div>;
  const p: StepProps = { v, act: act as Act, toast: toast.show };
  const screens: Record<string, React.ReactElement> = {
    lobby: <Lobby {...p} />, city: <CityStep {...p} />, matrix: <MatrixStep {...p} />, scenarios: <ScenariosStep {...p} />,
    budget: <BudgetStep {...p} />, corr1: <BudgetStep {...p} />, corr2: <BudgetStep {...p} />,
    jokerNeg: <JokerNegStep {...p} />, jokerPos: <JokerPosStep {...p} />, closing: <ClosingStep {...p} />, defense: <DefenseStep {...p} />, done: <Done v={v} />,
  };
  return (
    <>
      <Topbar v={v} offset={offset} />
      <Announcement a={v.game.announcement} />
      {conn !== 'online' && <div className="alert err" style={{ margin: 0, borderRadius: 0, textAlign: 'center' }}>Нет связи с сервером — переподключаюсь… Введённое сохранится после восстановления связи.</div>}
      <div key={v.team.phase}>{screens[v.team.phase]}</div>
      {toast.node}
    </>
  );
}
