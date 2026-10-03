import { useState } from 'react';
import { roundOf, type Marks, type PortfolioRow, type PublicMeasure, type TeamView } from '@sem/engine';
import { money, useAutosave } from '../api';
import { Confirm, SaveStatus, plural } from '../ui';
import { FinishBar } from './Steps';
import type { Act, StepProps } from './TeamApp';

const STATUS: Record<string, string> = {
  full: 'полная', grant: 'запущена джокером', conditional: 'условная', launched: 'запущена', notLaunched: 'не запущена', cancelled: 'отказ',
};

export function BalancePanel({ v, title = 'Баланс' }: { v: TeamView; title?: string }) {
  const b = v.balance!;
  const deficit = Math.max(0, -b.forecast);
  return (
    <div className="card balance">
      <h3>{title}</h3>
      <div className="bal-row"><span>Старт</span><b>{b.start}</b></div>
      <div className="bal-row"><span>Потрачено сейчас</span><b>{b.spent}</b></div>
      <div className="bal-row big"><span>Резерв</span><b className={b.reserve < 0 ? 'neg' : ''}>{money(b.reserve)}</b></div>
      <div className="bal-row"><span>Обязательства «Позже»</span><b>{b.laterCommitments}</b></div>
      <div className="bal-row big"><span>Прогноз на закрытии</span><b className={b.forecast < 0 ? 'neg' : ''}>{money(b.forecast)}</b></div>
      <div className="small" style={{ marginTop: 6 }}>
        {b.forecast < 0
          ? <span className="neg"><b>Дефицит {deficit} у.е.</b>, если запустить все условные меры → штраф −{b.forecastPenalty} {plural(b.forecastPenalty, 'балл', 'балла', 'баллов')} (−1 за каждые {v.rules.penaltyStep} у.е.).</span>
          : <span className="muted">Прогноз — если на закрытии запустить все условные меры.</span>}
      </div>
      <details style={{ marginTop: 10 }} open>
        <summary className="small"><b>Журнал операций</b> ({b.ledger.length})</summary>
        <div className="ledger">
          {[...b.ledger].reverse().map((l, i) => (
            <div key={i}><span>{l.text}</span><span className="mono">{l.amount ? money(l.amount) : ''}</span><b className={`mono ${l.balance < 0 ? 'neg' : ''}`}>{money(l.balance)}</b></div>
          ))}
          {!b.ledger.length && <span className="muted">Пока операций нет.</span>}
        </div>
      </details>
    </div>
  );
}

function MarksEditor({ row, v, act, editable }: { row: PortfolioRow; v: TeamView; act: Act; editable: boolean }) {
  const [m, setM, st] = useAutosave({ scenarios: row.scenarios, trigger: row.trigger }, `${row.code}:${v.team.phase}`,
    (x) => act({ type: 'setMarks', code: row.code, scenarios: x.scenarios, trigger: x.trigger }), 900);
  const titles = v.inputs.scenarios.map((s, i) => s.title || `Сценарий ${i + 1}`);
  const needTrigger = row.status === 'conditional';
  return (
    <div>
      <div className="small" style={{ marginTop: 8 }}><b>Полезна в сценариях:</b> {!m.scenarios.some(Boolean) && <span className="neg">отметьте хотя бы один</span>}</div>
      <div className="marks">
        {titles.map((t, i) => (
          <button type="button" key={i} disabled={!editable} className={`mark ${m.scenarios[i] ? 'on' : ''}`} onClick={() => setM({ ...m, scenarios: m.scenarios.map((x, j) => (j === i ? !x : x)) as Marks })}>
            {m.scenarios[i] ? '✓' : '○'} {i + 1}. {t.length > 28 ? t.slice(0, 27) + '…' : t}
          </button>
        ))}
      </div>
      {needTrigger && (
        <div style={{ marginTop: 8 }}>
          <label className="f small">Триггер запуска {!m.trigger.trim() && <span className="neg">(обязательно)</span>}</label>
          <input className="t" disabled={!editable} maxLength={300} value={m.trigger} onChange={(e) => setM({ ...m, trigger: e.target.value })} placeholder="При каком наблюдаемом условии запускаем меру?" />
        </div>
      )}
      <div style={{ textAlign: 'right' }}><SaveStatus st={st} /></div>
    </div>
  );
}

function MeasureCard({ m, row, v, act, toast }: { m: PublicMeasure; row?: PortfolioRow } & StepProps) {
  const [confirm, setConfirm] = useState(false);
  const round = roundOf(v.team.phase);
  const set = async (mode: 'none' | 'full' | 'conditional') => {
    const r = await act({ type: 'setMeasure', code: m.code, mode });
    if (!r.ok) toast(r.error ?? 'Не получилось', 'err');
  };
  const cancel = async () => {
    setConfirm(false);
    const r = await act({ type: 'cancelMeasure', code: m.code });
    if (!r.ok) toast(r.error ?? 'Не получилось', 'err');
  };
  const cur = row?.editable ? row.mode : row ? null : 'none';
  const cls = row ? (row.status === 'cancelled' ? 'cancelled' : row.mode === 'conditional' && row.status === 'conditional' ? 'conditional' : 'full') : '';
  const reserve = v.balance!.reserve + (row?.editable ? row.paid : 0);
  return (
    <div className={`measure ${cls}`}>
      <div className="head">
        <div><span className="code">{m.code}</span><b>{m.name}</b></div>
        {row && !row.editable && <span className={`badge ${row.status === 'cancelled' ? 'bad' : 'gray'}`}>{STATUS[row.status]}{row.round === 'pos' ? ' (джокер)' : ' · с прошлого шага'}</span>}
      </div>
      <div className="small muted" style={{ margin: '4px 0 8px' }}>{m.description}</div>
      <div className="prices">
        Полная: <b>{m.full}</b> у.е. {m.conditionalAllowed ? <>· Условная: <b>{m.now}</b> сейчас + <b>{m.later}</b> позже</> : '· условной быть не может'}
        {row && row.laterDiscount > 0 && <span className="badge ok" style={{ marginLeft: 6 }}>скидка на «Позже» −{row.laterDiscount}</span>}
      </div>
      {m.triggerExample && <div className="tiny" style={{ marginTop: 4 }}>Пример триггера: {m.triggerExample}</div>}
      <div className="spread" style={{ marginTop: 10 }}>
        {cur !== null ? (
          <div className="seg" role="group" aria-label={`Режим ${m.code}`}>
            <button className={cur === 'none' ? 'on' : ''} onClick={() => set('none')}>Нет</button>
            <button className={cur === 'full' ? 'on' : ''} disabled={cur !== 'full' && reserve < m.full} onClick={() => set('full')}>Полная · {m.full}</button>
            <button className={cur === 'conditional' ? 'on' : ''} disabled={!m.conditionalAllowed || (cur !== 'conditional' && reserve < m.now)} onClick={() => set('conditional')}>Условная · {m.now}</button>
          </div>
        ) : <span />}
        {row?.cancellable && <button className="btn sm" onClick={() => setConfirm(true)}>Отказаться от условной</button>}
      </div>
      {row && row.status !== 'cancelled' && <MarksEditor row={row} v={v} act={act} editable={round !== null} />}
      {confirm && <Confirm danger yes="Отказаться" onNo={() => setConfirm(false)} onYes={cancel}
        text={<><b>Отказаться от {m.code}?</b><p>Подготовка <b>{row!.paid} у.е.</b> не вернётся, эффекта меры не будет. Это нельзя отменить.</p></>} />}
    </div>
  );
}

export function BudgetStep(p: StepProps) {
  const { v } = p;
  const [filter, setFilter] = useState<'all' | 'mine'>('all');
  const rows = new Map(v.portfolio.map((r) => [r.code, r]));
  const list = v.catalog.filter((m) => filter === 'all' || rows.has(m.code));
  const round = roundOf(v.team.phase)!;
  const titles = ['Бюджет: распределите 100 у.е.', 'Корректировка 1', 'Корректировка 2'];
  return (
    <div className="wrap">
      <div className="budget">
        <div>
          <div className="card">
            <h2>{titles[round]}</h2>
            {round === 0 ? (
              <p className="muted">Для каждой меры выберите режим. <b>Полная</b> — платите всё сейчас, полный эффект. <b>Условная</b> — платите «Сейчас», а «Позже» — только на закрытии, если сработает триггер; без запуска мера даёт половину эффекта. Подготовленные меры удешевляют реакцию на неожиданные события. На этом шаге нельзя потратить больше 100 у.е.</p>
            ) : (
              <p className="muted">Можно докупить меры <b>на оставшийся резерв</b> и отказаться от условной меры прошлых шагов (подготовка не возвращается). Полную меру отменить нельзя. Отметки сценариев и триггеры можно уточнить.</p>
            )}
            {round > 0 && v.negJoker && <div className="alert err small">Негативный джокер <b>{v.negJoker.code} «{v.negJoker.name}»</b>: {v.negJoker.explanation}</div>}
            {round === 2 && v.posJoker && <div className="alert info small">Джокер <b>{v.posJoker.code} «{v.posJoker.name}»</b>: {v.posJoker.used ? 'использован' : 'не использован'}.</div>}
            <div className="filters">
              <button className={`btn sm ${filter === 'all' ? 'primary' : ''}`} onClick={() => setFilter('all')}>Все меры ({v.catalog.length})</button>
              <button className={`btn sm ${filter === 'mine' ? 'primary' : ''}`} onClick={() => setFilter('mine')}>В портфеле ({v.portfolio.filter((r) => r.status !== 'cancelled').length})</button>
            </div>
          </div>
          <div className="measures" style={{ marginTop: 14 }}>
            {list.map((m) => <MeasureCard key={m.code} m={m} row={rows.get(m.code)} {...p} />)}
          </div>
          <FinishBar {...p} />
        </div>
        <BalancePanel v={v} />
      </div>
    </div>
  );
}
