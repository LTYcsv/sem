import { useEffect, useState } from 'react';
import { money } from '../api';
import { FinishBar } from './Steps';
import type { StepProps } from './TeamApp';

/** Карта джокера: рубашка → переворот через мгновение после открытия шага. */
function FlipCard({ kind, children }: { kind: 'neg' | 'pos'; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { const id = setTimeout(() => setOpen(true), 700); return () => clearTimeout(id); }, []);
  return (
    <div className={`flip ${open ? 'open' : ''}`}>
      <div className="inner">
        <div className={`face front k${kind}`} aria-hidden={open}>?</div>
        <div className={`face back k${kind}`} aria-hidden={!open}>{children}</div>
      </div>
    </div>
  );
}

export function JokerNegStep(p: StepProps) {
  const { v } = p;
  const j = v.negJoker;
  if (!j) return <div className="wrap"><div className="card">Вытягиваем джокер…</div></div>;
  const after = v.balance!.reserve;
  const before = after + j.cost;
  return (
    <div className="wrap">
      <h1 style={{ textAlign: 'center' }}>Неожиданное событие</h1>
      <FlipCard kind="neg">
        <div className="jcode">{j.code} · негативный джокер</div>
        <h2 style={{ fontSize: '1.9rem' }}>{j.name}</h2>
        <p>{j.description}</p>
        <div className="calc neg">{j.base === j.cost ? `${j.cost} у.е.` : `${j.base} → ${j.cost} у.е.`}</div>
        <p className="small">{j.explanation}</p>
      </FlipCard>
      <div className="card" style={{ maxWidth: 560, margin: '0 auto' }}>
        <div className="bal-row"><span>Резерв до события</span><b>{money(before)}</b></div>
        <div className="bal-row"><span>Списано автоматически</span><b className="neg">−{j.cost}</b></div>
        <div className="bal-row big"><span>Резерв сейчас</span><b className={after < 0 ? 'neg' : ''}>{money(after)}</b></div>
        {after < 0 && <p className="neg small" style={{ marginTop: 8 }}>Резерв ушёл в минус: это дефицит. Штраф — −1 балл за каждые {v.rules.penaltyStep} у.е. дефицита на закрытии.</p>}
        <p className="small muted" style={{ marginTop: 8 }}>Правило джокера: {j.ruleText}</p>
      </div>
      <FinishBar {...p} label="К корректировке" note="Обсудите: что этот шок говорит о ваших сценариях? Дальше — корректировка бюджета." />
    </div>
  );
}

export function JokerPosStep(p: StepProps) {
  const { v, act, toast } = p;
  const j = v.posJoker;
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  if (!j) return <div className="wrap"><div className="card">Вытягиваем джокер…</div></div>;
  const o = j.offer;
  const decide = async (use: boolean) => {
    setBusy(true);
    const r = await act({ type: 'posDecide', use, measure: use ? choice : undefined });
    setBusy(false);
    if (!r.ok) toast(r.error ?? 'Не получилось', 'err');
  };
  const neutral = o.kind === 'none';
  const reserve = v.balance!.reserve;
  return (
    <div className="wrap">
      <h1 style={{ textAlign: 'center' }}>{neutral ? 'Нейтральное событие' : 'Новая возможность'}</h1>
      <FlipCard kind="pos">
        <div className="jcode">{j.code} · {neutral ? 'нейтральный' : 'положительный'} джокер</div>
        <h2 style={{ fontSize: '1.9rem' }}>{j.name}</h2>
        <p>{j.description}</p>
        {!neutral && <div className="calc" style={{ color: o.available ? 'var(--ok)' : 'var(--danger)' }}>{o.available ? (o.cost ? `Цена ${o.cost} у.е.` : 'Бесплатно') : 'Недоступно'}</div>}
        <p className="small">{neutral ? 'Ничего не получаете и ничего не теряете. Не был ли портфель слишком ориентирован на редкие угрозы?' : o.reason}</p>
      </FlipCard>
      <div className="card" style={{ maxWidth: 760, margin: '0 auto' }}>
        {!neutral && (
          <>
            <h3>Расчёт</h3>
            <div className="bal-row"><span>Резерв сейчас</span><b className={reserve < 0 ? 'neg' : ''}>{money(reserve)}</b></div>
            <div className="bal-row"><span>Стоимость использования</span><b>{o.cost}</b></div>
            <div className="bal-row"><span>Резерв после использования</span><b>{money(reserve - o.cost)}</b></div>
            <p style={{ marginTop: 10 }}><b>Что получите:</b> {o.gain}{j.bonusText && !o.gain.includes(j.bonusText) ? `; ${j.bonusText}` : ''}</p>
            {o.choices && o.available && (
              <div className="stack">
                <b>Выберите меру для гранта:</b>
                {o.choices.map((c) => {
                  const m = v.catalog.find((x) => x.code === c.code)!;
                  return (
                    <label key={c.code} className={`choice ${choice === c.code ? 'on' : ''}`}>
                      <input type="radio" name="grant" checked={choice === c.code} onChange={() => setChoice(c.code)} />
                      <span><b>{c.code}</b> {m.name} — вы платите {c.teamPays}, грант покрывает {c.grantCovers}</span>
                    </label>
                  );
                })}
              </div>
            )}
            <p className="small muted" style={{ marginTop: 8 }}>Правило: {j.ruleText}</p>
          </>
        )}
        <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
          {o.available ? (
            <>
              <button className="btn big" disabled={busy} onClick={() => decide(false)}>Пропустить</button>
              <button className="btn primary big" disabled={busy || (!!o.choices && !choice)} onClick={() => decide(true)}>Использовать{o.cost ? ` за ${o.cost} у.е.` : ''}</button>
            </>
          ) : (
            <button className="btn primary big" disabled={busy} onClick={() => decide(false)}>{neutral ? 'Понятно' : 'Понятно, пропускаем'}</button>
          )}
        </div>
        <p className="small muted" style={{ textAlign: 'center' }}>Решение окончательное, после него — корректировка 2.</p>
      </div>
    </div>
  );
}
