import { Fragment, useState } from 'react';
import { DIAG_LABELS, DIAG_SLOTS, countSentences, scenarioPoles, type Inputs, type TeamView } from '@sem/engine';
import { useAutosave } from '../api';
import { Confirm, EduBadge, Errors, SaveStatus } from '../ui';
import type { Act, StepProps } from './TeamApp';

/** Нижняя панель шага: список недостающего и кнопка «Готово». */
export function FinishBar({ v, act, toast, flush, label = 'Готово — к следующему шагу', note }: StepProps & { flush?: () => Promise<boolean>; label?: string; note?: string }) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setAsk(false);
    setBusy(true);
    if (flush) await flush();
    const r = await act({ type: 'finish' });
    setBusy(false);
    if (r.errors?.length) toast('Шаг ещё не готов: ' + r.errors[0], 'err');
    else if (!r.ok) toast(r.error ?? 'Ошибка', 'err');
  };
  return (
    <div className="card" style={{ marginTop: 18 }}>
      <Errors list={v.stepErrors} />
      <Errors list={v.stepWarnings} title="Не заполнено (можно перейти и так):" tone="info" />
      <div className="spread">
        <span className="muted small">{note ?? 'Когда время шага закончится, сервер сам переведёт команду дальше с тем, что введено.'}</span>
        <button className="btn primary big" disabled={busy || v.stepErrors.length > 0} onClick={() => setAsk(true)}>{label}</button>
      </div>
      {ask && <Confirm text={<><b>Перейти к следующему шагу?</b><p className="muted">Вернуться к этому шагу будет нельзя.{v.stepWarnings.length > 0 && ` Не заполнено пунктов: ${v.stepWarnings.length}.`}</p></>} yes="Перейти" onYes={go} onNo={() => setAsk(false)} />}
    </div>
  );
}

export function CityCard({ city }: { city: NonNullable<TeamView['city']> }) {
  return (
    <div className="card">
      <div className="spread"><h2 style={{ margin: 0 }}>{city.name}</h2><EduBadge /></div>
      <p className="muted"><b>{city.type}</b></p>
      <p>{city.situation}</p>
      <div className="grid2">
        <div>
          <h3>Общие показатели</h3>
          <table className="t"><tbody>{city.general.map((g) => <tr key={g.label}><td>{g.label}</td><td className="r"><b>{g.value}</b></td></tr>)}</tbody></table>
          <h3 style={{ marginTop: 14 }}>Особенности города</h3>
          <table className="t"><tbody>{city.unique.map((u) => <tr key={u.label}><td>{u.label}</td><td className="r"><b>{u.value}</b>{u.note ? <span className="small muted"> {u.note}</span> : ''}</td></tr>)}</tbody></table>
        </div>
        <div>
          <h3>Информационные сигналы</h3>
          <ol style={{ margin: 0, paddingLeft: '1.3em' }}>{city.signals.map((s) => <li key={s} style={{ marginBottom: 6 }}>{s}</li>)}</ol>
        </div>
      </div>
    </div>
  );
}

export function CityStep(p: StepProps) {
  const { v, act } = p;
  const [d, setD, st, flush] = useAutosave(v.inputs.diagnostics, `${v.team.id}:city`, (x) => act({ type: 'saveInputs', section: 'diagnostics', data: x }));
  const set = (k: keyof Inputs['diagnostics'], i: number, val: string) => setD((prev) => ({ ...prev, [k]: prev[k].map((x, j) => (j === i ? val : x)) }));
  const hints: Record<string, string> = {
    trends: 'Устойчивое изменение, которое уже идёт (например, старение населения)',
    drivers: 'Сила, которая толкает изменения (технологии, политика, рынок)',
    weakSignals: 'Ранний, пока малозаметный признак возможных перемен',
    problems: 'Главная проблема города сегодня',
  };
  return (
    <div className="wrap">
      {v.city && <CityCard city={v.city} />}
      {v.game.diagnosticsEnabled && (
        <div className="card">
          <div className="spread"><h2 style={{ margin: 0 }}>Мини-диагностика</h2><SaveStatus st={st} /></div>
          <p className="muted">Опирайтесь на данные и сигналы карточки. Это основа для матрицы неопределённостей.</p>
          <div className="grid2">
            {(Object.keys(DIAG_SLOTS) as (keyof typeof DIAG_SLOTS)[]).map((k) => (
              <div key={k}>
                <label className="f">{DIAG_LABELS[k]} <span className="small muted">({DIAG_SLOTS[k][0] === DIAG_SLOTS[k][1] ? DIAG_SLOTS[k][0] : `${DIAG_SLOTS[k][0]}–${DIAG_SLOTS[k][1]}`})</span></label>
                <div className="stack">{d[k].map((x, i) => <input key={i} className="t" value={x} maxLength={300} placeholder={i === 0 ? hints[k] : `${i + 1}.`} onChange={(e) => set(k, i, e.target.value)} />)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      <FinishBar {...p} flush={flush} />
    </div>
  );
}

export function MatrixStep(p: StepProps) {
  const { v, act } = p;
  const [m, setM, st, flush] = useAutosave(v.inputs.matrix, `${v.team.id}:matrix`, (x) => act({ type: 'saveInputs', section: 'matrix', data: x }));
  const set = (i: 0 | 1, k: 'name' | 'poleA' | 'poleB' | 'why', val: string) =>
    setM((prev) => ({ axes: prev.axes.map((a, j) => (j === i ? { ...a, [k]: val } : a)) as Inputs['matrix']['axes'] }));
  const a = m.axes;
  return (
    <div className="wrap">
      <div className="card">
        <div className="spread"><h2 style={{ margin: 0 }}>Матрица 2×2: критические неопределённости</h2><SaveStatus st={st} /></div>
        <p className="muted">Критическая неопределённость — фактор, который <b>сильно влияет</b> на город и <b>непонятно</b>, куда повернёт. Выберите две независимые и задайте по два противоположных полюса.</p>
        <div className="grid2">
          {([0, 1] as const).map((i) => (
            <div key={i} className="stack">
              <h3>Неопределённость {i + 1} <span className="small muted">({i === 0 ? 'строки' : 'столбцы'} матрицы)</span></h3>
              <div><label className="f">Название</label><input className="t" maxLength={120} value={a[i].name} onChange={(e) => set(i, 'name', e.target.value)} placeholder="например, темп автоматизации" /></div>
              <div className="grid2" style={{ gap: 10 }}>
                <div><label className="f">Полюс А</label><input className="t" maxLength={120} value={a[i].poleA} onChange={(e) => set(i, 'poleA', e.target.value)} placeholder="быстрый" /></div>
                <div><label className="f">Полюс Б</label><input className="t" maxLength={120} value={a[i].poleB} onChange={(e) => set(i, 'poleB', e.target.value)} placeholder="медленный" /></div>
              </div>
              <div><label className="f">Почему критична (кратко)</label><textarea className="t" maxLength={600} value={a[i].why} onChange={(e) => set(i, 'why', e.target.value)} /></div>
            </div>
          ))}
        </div>
      </div>
      <div className="card">
        <h3>Так получатся четыре сценария</h3>
        <MatrixGrid axes={a} render={(i) => <b>Сценарий {i + 1}</b>} />
      </div>
      <FinishBar {...p} flush={flush} />
    </div>
  );
}

export function MatrixGrid({ axes, render }: { axes: Inputs['matrix']['axes']; render: (i: number) => React.ReactNode }) {
  const pl = (ax: 0 | 1, k: 'poleA' | 'poleB') => axes[ax][k] || (k === 'poleA' ? 'полюс А' : 'полюс Б');
  return (
    <div className="matrix">
      <div className="ax small">{axes[0].name || 'Неопр. 1'} ↓ / {axes[1].name || 'Неопр. 2'} →</div>
      <div className="ax">{pl(1, 'poleA')}</div><div className="ax">{pl(1, 'poleB')}</div>
      {[0, 1].map((row) => (
        <Fragment key={row}>
          <div className="ax">{pl(0, row === 0 ? 'poleA' : 'poleB')}</div>
          {[0, 1].map((col) => <div key={col} className="q">{render(row * 2 + col)}</div>)}
        </Fragment>
      ))}
    </div>
  );
}

export function ScenariosStep(p: StepProps) {
  const { v, act } = p;
  const [s, setS, st, flush] = useAutosave(v.inputs.scenarios, `${v.team.id}:scenarios`, (x) => act({ type: 'saveInputs', section: 'scenarios', data: x }));
  const axes = v.inputs.matrix.axes;
  const pole = (ax: 0 | 1, k: 'poleA' | 'poleB') => axes[ax][k] || (k === 'poleA' ? 'полюс А' : 'полюс Б');
  const set = (i: number, k: 'title' | 'text', val: string) => setS((prev) => prev.map((x, j) => (j === i ? { ...x, [k]: val } : x)));
  return (
    <div className="wrap">
      <div className="card">
        <div className="spread"><h2 style={{ margin: 0 }}>Четыре сценария будущего</h2><SaveStatus st={st} /></div>
        <p className="muted">Каждый сценарий — пересечение полюсов. Дайте яркое название и опишите в <b>2–3 предложениях</b>: что происходит с жителями, бизнесом и властью.</p>
      </div>
      <MatrixGrid axes={axes} render={(i) => {
        const n = countSentences(s[i].text);
        const pp = scenarioPoles(i);
        return (
          <div className="stack">
            <div className="tiny">{pole(0, pp.a)} × {pole(1, pp.b)}</div>
            <input className="t" maxLength={120} value={s[i].title} placeholder={`Название сценария ${i + 1}`} onChange={(e) => set(i, 'title', e.target.value)} />
            <textarea className="t" style={{ minHeight: 150 }} maxLength={2000} value={s[i].text} onChange={(e) => set(i, 'text', e.target.value)} placeholder="Что происходит в городе в этом будущем?" />
            <div className={`small ${n >= 3 ? '' : 'neg'}`}>Предложений: {n} из 3{n >= 3 ? ' ✓' : ''}</div>
          </div>
        );
      }} />
      <FinishBar {...p} flush={flush} />
    </div>
  );
}

export function DefenseStep(p: StepProps) {
  const { v, act } = p;
  const [d, setD, st, flush] = useAutosave(v.inputs.defense, `${v.team.id}:defense`, (x) => act({ type: 'saveInputs', section: 'defense', data: x }));
  return (
    <div className="wrap">
      <div className="card">
        <div className="spread"><h2 style={{ margin: 0 }}>Защита решения</h2><SaveStatus st={st} /></div>
        <p className="muted">Эти ответы попадут на первую страницу PDF — по нему представитель команды будет выступать.</p>
        <label className="f">Три устойчивых решения (полезны в разных сценариях)</label>
        <div className="stack">{d.solutions.map((x, i) => <input key={i} className="t" value={x} maxLength={600} placeholder={`${i + 1}.`} onChange={(e) => setD({ ...d, solutions: d.solutions.map((y, j) => (j === i ? e.target.value : y)) })} />)}</div>
        <label className="f" style={{ marginTop: 14 }}>Самый значимый джокер и почему</label>
        <textarea className="t" maxLength={800} value={d.joker} onChange={(e) => setD({ ...d, joker: e.target.value })} />
        <label className="f" style={{ marginTop: 14 }}>Главный урок</label>
        <textarea className="t" maxLength={800} value={d.lesson} onChange={(e) => setD({ ...d, lesson: e.target.value })} />
      </div>
      <FinishBar {...p} flush={flush} label="Завершить и сформировать PDF" />
    </div>
  );
}

export function Members({ v, act }: { v: TeamView; act: Act; toast: StepProps['toast'] }) {
  const init = [...v.inputs.members, '', '', '', '', ''].slice(0, 5);
  const [m, setM, st] = useAutosave(init, `${v.team.id}:members`, (x) => act({ type: 'saveInputs', section: 'members', data: x.map((s) => s.trim()) }));
  return (
    <div>
      <div className="spread"><h3 style={{ margin: 0 }}>Участники команды <span className="small muted">(по желанию, нужно для оценивания)</span></h3><SaveStatus st={st} /></div>
      <div className="grid2" style={{ marginTop: 10 }}>
        {m.map((x, i) => <input key={i} className="t" value={x} maxLength={60} placeholder={`Участник ${i + 1}: фамилия и имя`} onChange={(e) => setM(m.map((y, j) => (j === i ? e.target.value : y)))} />)}
      </div>
    </div>
  );
}
