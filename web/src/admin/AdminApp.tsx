import { useMemo, useState } from 'react';
import {
  GRADE_CRITERIA, PHASE_LABELS, TIMED_PHASES, DIAG_LABELS, scenarioPoles,
  type AdminAction, type AdminTeam, type AdminView, type Ack, type GradeKey, type TimedPhase,
} from '@sem/engine';
import { ADMIN_TOKEN, fmtTime, money, postJson, remaining, storage, useLive, useNow } from '../api';
import { Confirm, useToast } from '../ui';

type Act = (a: AdminAction) => Promise<Ack>;

function Login({ onToken }: { onToken: (t: string) => void }) {
  const [login, setLogin] = useState('admin');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try { const r = await postJson<{ token: string }>('/api/admin/login', { login, password }); storage.set(ADMIN_TOKEN, r.token); onToken(r.token); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="narrow"><div className="card">
      <h1>Вход ведущего</h1>
      <form onSubmit={submit} className="stack">
        <div><label className="f">Логин</label><input className="t" value={login} onChange={(e) => setLogin(e.target.value)} /></div>
        <div><label className="f">Пароль</label><input className="t" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></div>
        {err && <div className="alert err">{err}</div>}
        <button className="btn primary big">Войти</button>
        <p className="small muted">Логин и пароль задаются в файле .env (ADMIN_LOGIN, ADMIN_PASSWORD).</p>
      </form>
    </div></div>
  );
}

const ago = (ts: number, now: number) => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s} с назад` : s < 3600 ? `${Math.floor(s / 60)} мин назад` : `${Math.floor(s / 3600)} ч назад`;
};
const empty = (s?: string) => (s && s.trim() ? s : <span className="empty">не заполнено</span>);

function Controls({ v, act, ask }: { v: AdminView; act: Act; ask: (text: string, fn: () => void) => void }) {
  const g = v.game!;
  const [text, setText] = useState('');
  return (
    <div className="card">
      <div className="row">
        {g.status === 'lobby' && <button className="btn primary big" disabled={!v.teams.length} onClick={() => ask(v.teams.length < 4 ? `В игре ${v.teams.length} из 4 команд. Начать всё равно?` : 'Начать игру? Командам раздадут города.', () => act({ type: 'start' }))}>▶ Старт игры</button>}
        {g.status !== 'lobby' && <>
          <button className="btn" onClick={() => act({ type: 'pause', target: 'all' })}>⏸ Пауза всем</button>
          <button className="btn" onClick={() => act({ type: 'resume', target: 'all' })}>▶ Продолжить всем</button>
          <button className="btn" onClick={() => act({ type: 'addMinute', target: 'all' })}>+1 минута всем</button>
          <button className="btn" onClick={() => ask('Пропустить текущий шаг у ВСЕХ команд?', () => act({ type: 'skip', target: 'all' }))}>⏭ Пропустить шаг всем</button>
          <button className="btn" onClick={() => ask('Открыть следующий джокер у ВСЕХ команд? Текущие шаги до джокера будут закрыты.', () => act({ type: 'forceJoker', target: 'all' }))}>Открыть джокер всем</button>
          <button className="btn" onClick={() => ask('Завершить игру у всех команд? Шаги будут закрыты с тем, что введено.', () => act({ type: 'finishGame' }))}>⏹ Завершить игру</button>
        </>}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <input className="t" style={{ flex: 1 }} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder="Объявление на экраны команд (например, «Осталось 2 минуты»)" />
        <button className="btn primary" disabled={!text.trim()} onClick={() => { void act({ type: 'announce', text }); setText(''); }}>📣 Отправить</button>
        {g.announcement && <button className="btn" onClick={() => act({ type: 'announce', text: '' })}>Убрать объявление</button>}
      </div>
      {g.announcement && <div className="small muted" style={{ marginTop: 6 }}>Сейчас на экранах: «{g.announcement.text}»</div>}
    </div>
  );
}

function Overview({ v, act, ask, open, now }: { v: AdminView; act: Act; ask: (t: string, fn: () => void) => void; open: (id: string) => void; now: number }) {
  const t0 = storage.get(ADMIN_TOKEN) ?? '';
  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <table className="t">
        <thead><tr><th>Команда</th><th>Город</th><th>Шаг</th><th className="r">Таймер</th><th className="r">Резерв</th><th className="r">Прогноз</th><th>Активность</th><th>Управление</th></tr></thead>
        <tbody>
          {v.teams.map((t) => {
            const ms = remaining(t.deadline, t.paused ? t.remainingMs : null, now);
            return (
              <tr key={t.id}>
                <td><span className={`dot ${t.connected ? 'on' : 'off'}`} title={t.connected ? 'на связи' : 'не подключена'} /> <b>{t.name}</b>
                  {t.deviceReset && <div className="badge bad">ждёт входа с нового устройства</div>}
                  <div className="tiny">{t.members.filter(Boolean).join(', ')}</div></td>
                <td>{t.city?.name ?? '—'}</td>
                <td>{PHASE_LABELS[t.phase]}{t.stepErrors.length > 0 && t.phase !== 'lobby' && <div className="tiny">не хватает: {t.stepErrors.length}</div>}</td>
                <td className="r mono">{t.phase === 'lobby' || t.phase === 'done' ? '—' : <>{t.paused ? '⏸ ' : ''}{fmtTime(ms)}</>}</td>
                <td className={`r mono ${t.balance && t.balance.reserve < 0 ? 'neg' : ''}`}>{t.balance ? money(t.balance.reserve) : '—'}</td>
                <td className={`r mono ${t.balance && t.balance.forecast < 0 ? 'neg' : ''}`}>{t.balance ? money(t.balance.forecast) : '—'}</td>
                <td className="small">{ago(t.lastActivity, now)}</td>
                <td>
                  <div className="row" style={{ gap: 4 }}>
                    <button className="btn sm primary" onClick={() => open(t.id)}>Подробнее</button>
                    {t.phase !== 'lobby' && t.phase !== 'done' && <>
                      <button className="btn sm" onClick={() => act({ type: t.paused ? 'resume' : 'pause', target: t.id })}>{t.paused ? '▶' : '⏸'}</button>
                      <button className="btn sm" onClick={() => act({ type: 'addMinute', target: t.id })}>+1 мин</button>
                      <button className="btn sm" onClick={() => ask(`Пропустить шаг «${PHASE_LABELS[t.phase]}» у команды «${t.name}»?`, () => act({ type: 'skip', target: t.id }))}>⏭</button>
                      <button className="btn sm" onClick={() => ask(`Открыть следующий джокер команде «${t.name}»?`, () => act({ type: 'forceJoker', target: t.id }))}>Джокер</button>
                    </>}
                    {t.final && <a className="btn sm" href={`/api/admin/pdf/${t.id}?t=${t0}`} target="_blank" rel="noreferrer">PDF</a>}
                    <button className="btn sm" onClick={() => ask(`Сбросить устройство команды «${t.name}»? Текущий экран отключится, команда сможет войти снова по PIN и тому же названию — прогресс сохранится.`, () => act({ type: 'resetDevice', teamId: t.id }))}>Сброс устройства</button>
                    {v.game!.status === 'lobby'
                      ? <button className="btn sm" onClick={() => ask(`Удалить команду «${t.name}»?`, () => act({ type: 'removeTeam', teamId: t.id }))}>Удалить</button>
                      : <button className="btn sm" onClick={() => ask(`Сбросить ВЕСЬ прогресс команды «${t.name}»? Ввод и бюджет будут стёрты, команда начнёт с шага «Город».`, () => act({ type: 'resetTeam', teamId: t.id }))}>Сброс прогресса</button>}
                  </div>
                </td>
              </tr>
            );
          })}
          {!v.teams.length && <tr><td colSpan={8} className="empty">Команды ещё не подключились.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function TeamDetail({ t, v, close }: { t: AdminTeam; v: AdminView; close: () => void }) {
  const [tab, setTab] = useState('city');
  const label = (k: string) => v.data.indicators.find((i) => i.key === k)?.label ?? k;
  const tabs: [string, string][] = [['city', 'Город'], ['diag', 'Диагностика'], ['matrix', 'Матрица и сценарии'], ['budget', 'Портфель и журнал'], ['jokers', 'Джокеры'], ['defense', 'Закрытие и защита'], ['final', 'Итог']];
  const ax = t.inputs.matrix.axes;
  return (
    <>
      <div className="scrim" onClick={close} />
      <div className="drawer">
        <div className="spread"><h2 style={{ margin: 0 }}>{t.name} {t.city ? `· ${t.city.name}` : ''}</h2><button className="btn" onClick={close}>Закрыть</button></div>
        <p className="muted small">Только просмотр. Шаг: {PHASE_LABELS[t.phase]}. Участники: {t.members.filter(Boolean).join(', ') || '—'}</p>
        <div className="tabs">{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
        {tab === 'city' && (t.city ? <div className="stack">
          <p>{t.city.situation}</p>
          <div className="alert warn"><b>Уязвимости (только для ведущих):</b><ul>{t.city.vulnerabilities.map((x) => <li key={x}>{x}</li>)}</ul></div>
          <h3>Стартовые показатели (1–10)</h3>
          <table className="t"><tbody>{Object.entries(t.city.start).map(([k, n]) => <tr key={k}><td>{label(k)}</td><td className="r"><b>{n}</b></td></tr>)}</tbody></table>
          <h3>Сигналы</h3><ol>{t.city.signals.map((s) => <li key={s}>{s}</li>)}</ol>
        </div> : <p className="empty">Город выдаётся при старте.</p>)}
        {tab === 'diag' && <div className="grid2">{(Object.keys(DIAG_LABELS) as (keyof typeof DIAG_LABELS)[]).map((k) => (
          <div key={k}><h3>{DIAG_LABELS[k]}</h3>{t.inputs.diagnostics[k].filter((x) => x.trim()).length ? <ul>{t.inputs.diagnostics[k].filter((x) => x.trim()).map((x, i) => <li key={i}>{x}</li>)}</ul> : <span className="empty">не заполнено</span>}</div>))}</div>}
        {tab === 'matrix' && <div className="stack">
          {ax.map((a, i) => <div key={i}><b>Неопределённость {i + 1}:</b> {empty(a.name)} — {empty(a.poleA)} ↔ {empty(a.poleB)}<div className="small">Почему критична: {empty(a.why)}</div></div>)}
          {t.inputs.scenarios.map((s, i) => {
            const pp = scenarioPoles(i);
            return <div key={i} className="card"><div className="tiny">{ax[0][pp.a] || '—'} × {ax[1][pp.b] || '—'}</div><h3>{i + 1}. {empty(s.title)}</h3><div style={{ whiteSpace: 'pre-wrap' }}>{empty(s.text)}</div></div>;
          })}
        </div>}
        {tab === 'budget' && <div className="stack">
          <table className="t"><thead><tr><th>Мера</th><th>Статус</th><th className="r">Уплачено</th><th className="r">«Позже»</th><th>Сценарии</th><th>Триггер</th></tr></thead>
            <tbody>{t.portfolio.map((r) => <tr key={r.code}><td><b>{r.code}</b> {r.name}</td><td>{r.status}</td><td className="r">{r.paid}</td><td className="r">{r.status === 'conditional' ? r.laterDue : '—'}</td><td>{r.scenarios.map((x, i) => (x ? i + 1 : '·')).join(' ')}</td><td className="small">{r.trigger || '—'}</td></tr>)}</tbody></table>
          {t.balance && <div className="kv"><span>Резерв</span><b>{money(t.balance.reserve)}</b><span>Обязательства «Позже»</span><b>{t.balance.laterCommitments}</b><span>Прогноз на закрытии</span><b>{money(t.balance.forecast)}</b></div>}
          <h3>Журнал</h3>
          <table className="t"><tbody>{t.balance?.ledger.map((l, i) => <tr key={i}><td className="small">{l.text}</td><td className="r">{l.amount ? money(l.amount) : ''}</td><td className="r"><b>{money(l.balance)}</b></td></tr>)}</tbody></table>
        </div>}
        {tab === 'jokers' && <div className="stack">
          {t.negJoker ? <div className="card"><b>{t.negJoker.code} «{t.negJoker.name}»</b><p>{t.negJoker.description}</p><b>{t.negJoker.explanation}</b></div> : <p className="empty">Негативный джокер ещё не открыт.</p>}
          {t.posJoker ? <div className="card"><b>{t.posJoker.code} «{t.posJoker.name}»</b><p>{t.posJoker.description}</p>
            <div>{t.posJoker.decided ? (t.posJoker.used ? `Использован${t.posJoker.measure ? ` (мера ${t.posJoker.measure})` : ''}` : 'Пропущен / недоступен') : 'Решение не принято'} — {t.posJoker.offer.reason}</div></div> : <p className="empty">Положительный джокер ещё не открыт.</p>}
        </div>}
        {tab === 'defense' && <div className="stack">
          <h3>Закрытие</h3>
          {Object.keys(t.inputs.closing).length ? <ul>{Object.entries(t.inputs.closing).map(([k, c]) => <li key={k}><b>{k}</b>: {c.launch === null ? 'не решено' : c.launch ? 'запускаем' : 'не запускаем'} — {empty(c.reason)}</li>)}</ul> : <span className="empty">нет решений</span>}
          <h3>Защита</h3>
          <ol>{t.inputs.defense.solutions.map((s, i) => <li key={i}>{empty(s)}</li>)}</ol>
          <p><b>Значимый джокер:</b> {empty(t.inputs.defense.joker)}</p>
          <p><b>Главный урок:</b> {empty(t.inputs.defense.lesson)}</p>
        </div>}
        {tab === 'final' && (t.final ? <div className="stack">
          <table className="t"><thead><tr><th>Показатель</th><th className="r">Было</th><th className="r">Стало</th><th className="r">Δ</th></tr></thead>
            <tbody>{Object.keys(t.final.final).map((k) => <tr key={k}><td>{label(k)}</td><td className="r">{(t.final!.start as any)[k]}</td><td className="r"><b>{(t.final!.final as any)[k]}</b></td><td className="r">{(t.final!.delta as any)[k]}</td></tr>)}</tbody></table>
          <div className="kv">
            <span>Индекс города</span><b>{t.final.startIndex.toFixed(1)} → {t.final.cityIndex.toFixed(1)}</b>
            <span>Индекс устойчивости</span><b>{Math.round(t.final.resilienceIndex * 100)}%</b>
            <span>Итоговый резерв</span><b>{money(t.final.reserve)}</b>
            <span>Штраф / бонус резерва</span><b>−{t.final.penalty} / +{t.final.reserveBonus}</b>
          </div>
        </div> : <p className="empty">Итог появится после закрытия бюджета.</p>)}
      </div>
    </>
  );
}

function Grades({ v, act }: { v: AdminView; act: Act }) {
  const g = v.game!;
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<Record<string, string[]>>({});
  const t0 = storage.get(ADMIN_TOKEN) ?? '';
  return (
    <div className="stack">
      <div className="spread"><p className="muted" style={{ margin: 0 }}>Шкала 0–10 по каждому критерию; итог — среднее заполненных. Имена берутся из списка, который ввела команда.</p>
        <a className="btn" href={`/api/admin/grades.csv?t=${t0}`}>⬇ Оценки CSV</a></div>
      {v.teams.map((t) => {
        const names = [...new Set([...t.members.filter((m) => m.trim()), ...Object.keys(g.grades[t.id] ?? {}), ...(added[t.id] ?? [])])];
        return (
          <div className="card" key={t.id} style={{ overflowX: 'auto' }}>
            <h3>{t.name} {t.city ? `· ${t.city.name}` : ''}</h3>
            <table className="t">
              <thead><tr><th>Участник</th>{GRADE_CRITERIA.map((c) => <th key={c.key} className="r">{c.label}</th>)}<th className="r">Итог</th></tr></thead>
              <tbody>{names.map((n) => {
                const gr = g.grades[t.id]?.[n] ?? {};
                const vals = GRADE_CRITERIA.map((c) => gr[c.key]).filter((x): x is number => typeof x === 'number');
                return (
                  <tr key={n}><td><b>{n}</b></td>
                    {GRADE_CRITERIA.map((c) => <td key={c.key} className="r"><GradeInput value={gr[c.key]} onChange={(val) => act({ type: 'grade', teamId: t.id, member: n, key: c.key as GradeKey, value: val })} /></td>)}
                    <td className="r"><b>{vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1).replace('.', ',') : '—'}</b></td></tr>
                );
              })}</tbody>
            </table>
            <div className="row" style={{ marginTop: 8 }}>
              <input className="t" style={{ maxWidth: 320 }} placeholder="Добавить участника" value={extra[t.id] ?? ''} onChange={(e) => setExtra({ ...extra, [t.id]: e.target.value })} />
              <button className="btn sm" disabled={!extra[t.id]?.trim()} onClick={() => { setAdded({ ...added, [t.id]: [...(added[t.id] ?? []), extra[t.id].trim()] }); setExtra({ ...extra, [t.id]: '' }); }}>Добавить</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
function GradeInput({ value, onChange }: { value?: number; onChange: (v: number | null) => void }) {
  const [s, setS] = useState(value === undefined ? '' : String(value));
  return <input className="grade-in" inputMode="decimal" value={s} onChange={(e) => setS(e.target.value)}
    onBlur={() => { const n = s.trim() === '' ? null : Number(s.replace(',', '.')); if (n === null || (n >= 0 && n <= 10)) onChange(n); else setS(value === undefined ? '' : String(value)); }} />;
}

function Settings({ v, act }: { v: AdminView; act: Act }) {
  const g = v.game!;
  return (
    <div className="card">
      <h3>Длительность шагов, минут</h3>
      <div className="grid4">{TIMED_PHASES.map((p) => (
        <label key={p}><span className="small">{PHASE_LABELS[p]}</span>
          <input className="t" type="number" min={0.5} max={60} step={0.5} defaultValue={g.settings.durationsMin[p]}
            onBlur={(e) => act({ type: 'settings', durationsMin: { [p]: Number(e.target.value) } as Partial<Record<TimedPhase, number>> })} /></label>))}</div>
      <p className="small muted">Новая длительность применяется со следующего шага каждой команды. Чтобы продлить текущий шаг, используйте «+1 минута».</p>
      <label className="row" style={{ marginTop: 10 }}><input type="checkbox" checked={g.settings.diagnosticsEnabled} onChange={(e) => act({ type: 'settings', diagnosticsEnabled: e.target.checked })} style={{ width: 22, height: 22 }} />
        <b>Мини-диагностика на шаге «Город»</b> (тренды, драйверы, слабые сигналы, проблемы)</label>
      <h3 style={{ marginTop: 18 }}>Данные игры</h3>
      <div className="kv small"><span>Источник</span><span>{v.data.source}</span><span>Собрано</span><span>{new Date(v.data.generatedAt).toLocaleString('ru-RU')}</span><span>Неподтверждённых ячеек</span><span>{v.data.unconfirmed}</span></div>
      {v.data.warnings.length > 0 && <div className="alert warn small"><ul>{v.data.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
    </div>
  );
}

function Lobby({ v }: { v: AdminView }) {
  const g = v.game!;
  const slots = [0, 1, 2, 3].map((i) => v.teams[i]);
  return (
    <div className="card">
      <div className="spread" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="muted">Откройте на ноутбуке команды</div>
          <div style={{ fontSize: '2rem', fontWeight: 700 }}>{v.joinUrl.replace(/\/$/, '')}</div>
          <div className="muted" style={{ marginTop: 10 }}>PIN игры</div>
          <div className="hero-pin">{g.pin.slice(0, 3)} {g.pin.slice(3)}</div>
          {v.lanUrls.length > 1 && <div className="small muted" style={{ marginTop: 8 }}>Другие адреса: {v.lanUrls.slice(1).join(', ')}</div>}
        </div>
        <img className="qr" src={`/api/qr.svg?text=${encodeURIComponent(v.joinUrl + '?pin=' + g.pin)}`} alt="QR-код для входа" />
      </div>
      <div className="lobby-teams" style={{ marginTop: 18 }}>
        {slots.map((t, i) => <div key={i} className={t ? 'on' : ''}>{t ? <>{t.connected ? '🟢' : '⚪'} {t.name}</> : <span className="muted">команда {i + 1}…</span>}</div>)}
      </div>
    </div>
  );
}

export function AdminApp() {
  const [token, setToken] = useState(() => storage.get(ADMIN_TOKEN));
  const auth = useMemo(() => (token ? { role: 'admin' as const, token } : null), [token]);
  const { state: v, conn, act, offset } = useLive<AdminView>(auth, () => { storage.del(ADMIN_TOKEN); setToken(null); });
  const now = useNow(offset);
  const [tab, setTab] = useState('overview');
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ text: string; fn: () => void } | null>(null);
  const toast = useToast();
  if (!token) return <Login onToken={setToken} />;
  if (!v) return <div className="narrow"><div className="card">Подключение…</div></div>;
  const run: Act = async (a) => { const r = await (act as Act)(a); if (!r.ok) toast.show(r.error ?? 'Ошибка', 'err'); return r; };
  const ask = (text: string, fn: () => void) => setConfirm({ text, fn });
  const g = v.game;
  const t0 = token;
  const openTeam = v.teams.find((t) => t.id === openId);
  return (
    <div className="wrap">
      <div className="spread">
        <h1 style={{ margin: 0 }}>Ведущий · форсайт-сессия {g && <span className="badge info" style={{ fontSize: '1rem' }}>PIN {g.pin}</span>} {g && <span className="badge gray">{{ lobby: 'лобби', running: 'идёт', finished: 'завершена' }[g.status]}</span>}</h1>
        <div className="row">
          {conn !== 'online' && <span className="badge bad">нет связи</span>}
          <button className="btn" onClick={() => ask(g ? 'Создать НОВУЮ игру? Текущая будет сохранена в архиве, команды должны будут войти по новому PIN.' : 'Создать игру?', () => run({ type: 'createGame' }))}>Новая игра</button>
          <button className="btn ghost" onClick={() => { storage.del(ADMIN_TOKEN); setToken(null); }}>Выйти</button>
        </div>
      </div>
      {v.data.overrides.length > 0 && <div className="alert warn small">Правила переопределены поверх xlsx: {v.data.overrides.join('; ')}</div>}
      {!g ? (
        <div className="card" style={{ marginTop: 16 }}><h2>Игры нет</h2><p>Создайте игру — появится PIN и QR-код для команд.</p><button className="btn primary big" onClick={() => run({ type: 'createGame' })}>Создать игру</button></div>
      ) : (
        <>
          <div className="tabs" style={{ marginTop: 16 }}>
            {[['overview', 'Обзор'], ['join', 'Вход команд (PIN, QR)'], ['grades', 'Оценивание'], ['export', 'Результаты'], ['settings', 'Настройки']].map(([k, l]) =>
              <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
          </div>
          {tab === 'overview' && <>
            {g.status === 'lobby' && <Lobby v={v} />}
            <Controls v={v} act={run} ask={ask} />
            <Overview v={v} act={run} ask={ask} open={setOpenId} now={now} />
          </>}
          {tab === 'join' && <Lobby v={v} />}
          {tab === 'grades' && <Grades v={v} act={run} />}
          {tab === 'export' && <div className="card stack">
            <h3>Выгрузки</h3>
            <div className="row">
              <a className="btn primary" href={`/api/admin/all.zip?t=${t0}`}>⬇ ZIP: PDF всех команд + CSV</a>
              <a className="btn" href={`/api/admin/results.csv?t=${t0}`}>⬇ Результаты CSV</a>
              <a className="btn" href={`/api/admin/export.json?t=${t0}`}>⬇ Всё в JSON</a>
              <a className="btn" href={`/api/admin/grades.csv?t=${t0}`}>⬇ Оценки CSV</a>
            </div>
            <h3>PDF команд</h3>
            <div className="row">{v.teams.map((t) => t.final
              ? <a key={t.id} className="btn" href={`/api/admin/pdf/${t.id}?t=${t0}`} target="_blank" rel="noreferrer">{t.name}</a>
              : <span key={t.id} className="badge gray">{t.name}: ещё не закрыла бюджет</span>)}</div>
            {v.pastGames.length > 0 && <><h3>Прошлые игры (сохранены в базе)</h3><ul className="small">{v.pastGames.map((p) => <li key={p.id}>PIN {p.pin} · {new Date(p.createdAt).toLocaleString('ru-RU')} · команд: {p.teams} · {p.status}</li>)}</ul></>}
          </div>}
          {tab === 'settings' && <Settings v={v} act={run} />}
        </>
      )}
      {openTeam && <TeamDetail t={openTeam} v={v} close={() => setOpenId(null)} />}
      {confirm && <Confirm text={confirm.text} onNo={() => setConfirm(null)} onYes={() => { confirm.fn(); setConfirm(null); }} />}
      {toast.node}
    </div>
  );
}
