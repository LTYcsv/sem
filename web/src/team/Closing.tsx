import { useState } from 'react';
import type { PortfolioRow } from '@sem/engine';
import { money } from '../api';
import { SaveStatus, plural } from '../ui';
import { FinishBar } from './Steps';
import type { StepProps } from './TeamApp';

function Decision({ row, p }: { row: PortfolioRow; p: StepProps }) {
  const { v, act, toast } = p;
  const saved = v.inputs.closing[row.code];
  const [launch, setLaunch] = useState<boolean | null>(saved?.launch ?? null);
  const [reason, setReason] = useState(saved?.reason ?? '');
  const [st, setSt] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const m = v.catalog.find((x) => x.code === row.code)!;
  const send = async (l: boolean | null, r: string) => {
    setSt('saving');
    const res = await act({ type: 'closingSet', code: row.code, launch: l, reason: r });
    setSt(res.ok ? 'saved' : 'error');
    if (!res.ok) toast(res.error ?? 'Не сохранилось', 'err');
  };
  const choose = (l: boolean) => { setLaunch(l); void send(l, reason); };
  const type = (r: string) => {
    setReason(r);
    setSt('dirty');
    if (timer) clearTimeout(timer);
    setTimer(setTimeout(() => void send(launch, r), 1000));
  };
  return (
    <div className={`measure ${launch ? 'full' : launch === false ? '' : 'conditional'}`}>
      <div className="head">
        <div><span className="code">{row.code}</span><b>{m.name}</b></div>
        <span className="prices">«Позже»: <b>{row.laterDue}</b> у.е.{row.laterDiscount ? ` (было ${m.later}, скидка −${row.laterDiscount})` : ''}</span>
      </div>
      {row.trigger && <div className="small muted" style={{ margin: '4px 0' }}>Почему готовили: <b>{row.trigger}</b></div>}
      <div className="seg" style={{ marginTop: 6 }}>
        <button className={launch === true ? 'on' : ''} onClick={() => choose(true)}>Запускаем (−{row.laterDue})</button>
        <button className={launch === false ? 'on' : ''} onClick={() => choose(false)}>Не запускаем</button>
      </div>
      <label className="f small" style={{ marginTop: 10 }}>Почему? <span className="muted">(по желанию)</span></label>
      <textarea className="t" style={{ minHeight: 60 }} maxLength={600} value={reason} onChange={(e) => type(e.target.value)} placeholder="Почему запускаем или не запускаем" />
      <div style={{ textAlign: 'right' }}><SaveStatus st={st} /></div>
    </div>
  );
}

export function ClosingStep(p: StepProps) {
  const { v } = p;
  const pending = v.portfolio.filter((r) => r.status === 'conditional');
  const cp = v.closingPreview;
  const reserveBefore = v.balance!.reserve + pending.filter((r) => v.inputs.closing[r.code]?.launch).reduce((s, r) => s + r.laterDue, 0);
  return (
    <div className="wrap">
      <div className="budget">
        <div>
          <div className="card">
            <h2>Закрытие бюджета</h2>
            <p className="muted">По каждой условной мере решите: запускаем (платим «Позже» с учётом скидок) или нет. Незапущенная мера даёт {v.rules.conditionalSharePct}% эффекта.</p>
            {!pending.length && <div className="alert info">Условных мер нет — решать нечего, можно перейти к защите.</div>}
          </div>
          {v.rules.closingIncome > 0 && <div className="card income" style={{ marginTop: 14 }}>
            <div className="jcode">Бюджет следующего года</div>
            <div className="calc">+{v.rules.closingIncome} у.е.</div>
            <p>Вам пришёл бюджет следующего года на {v.rules.closingIncome} у.е. Его можно потратить на запуск подготовленных мер, а остаток уходит в резерв. Неподготовленную меру на закрытии купить нельзя.</p>
          </div>}
          <div className="stack" style={{ marginTop: 14 }}>{pending.map((r) => <Decision key={r.code} row={r} p={p} />)}</div>
          <FinishBar {...p} label="Закрыть бюджет" note="Не принятое до конца времени решение = «не запускаем»." />
        </div>
        <div className="card balance">
          <h3>Итог бюджета</h3>
          {v.rules.closingIncome > 0 && <div className="bal-row"><span>в т. ч. бюджет следующего года</span><b>+{v.rules.closingIncome}</b></div>}
          <div className="bal-row"><span>Резерв до запусков</span><b className={reserveBefore < 0 ? 'neg' : ''}>{money(reserveBefore)}</b></div>
          <div className="bal-row"><span>Запуски «Позже»</span><b>−{reserveBefore - (cp?.reserve ?? reserveBefore)}</b></div>
          <div className="bal-row big"><span>Итоговый баланс</span><b className={(cp?.reserve ?? 0) < 0 ? 'neg' : ''}>{money(cp?.reserve ?? reserveBefore)}</b></div>
          {cp && cp.deficit > 0
            ? <div className="alert err small"><b>Дефицит {cp.deficit} у.е.</b> → штраф −{cp.penalty} {plural(cp.penalty, 'балл', 'балла', 'баллов')} (−1 за каждые {v.rules.penaltyStep} у.е., округление вверх).</div>
            : <div className="alert info small">Дефицита нет. Остаток резерва даёт бонус: +1 за каждые {v.rules.reserveBonusStep} у.е., максимум +{v.rules.reserveBonusMax}.</div>}
        </div>
      </div>
    </div>
  );
}
