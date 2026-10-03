import { useEffect, useState, type ReactNode } from 'react';

export function Toast({ msg, kind, onDone }: { msg: string | null; kind?: 'err' | 'ok'; onDone: () => void }) {
  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(onDone, kind === 'err' ? 5000 : 2500);
    return () => clearTimeout(id);
  }, [msg]);
  if (!msg) return null;
  return <div className={`toast ${kind === 'err' ? 'err' : ''}`} role="status">{msg}</div>;
}

export function useToast() {
  const [t, setT] = useState<{ msg: string; kind?: 'err' | 'ok' } | null>(null);
  return {
    show: (msg: string, kind?: 'err' | 'ok') => setT({ msg, kind }),
    node: <Toast msg={t?.msg ?? null} kind={t?.kind} onDone={() => setT(null)} />,
  };
}

export function Confirm({ text, onYes, onNo, yes = 'Да', danger }: { text: ReactNode; onYes: () => void; onNo: () => void; yes?: string; danger?: boolean }) {
  return (
    <div className="modal" onClick={onNo}>
      <div onClick={(e) => e.stopPropagation()}>
        <div style={{ marginBottom: 18 }}>{text}</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onNo}>Отмена</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onYes}>{yes}</button>
        </div>
      </div>
    </div>
  );
}

export const EduBadge = () => <span className="badge edu">УЧЕБНЫЕ ДАННЫЕ · город вымышленный</span>;

export function Errors({ list, title = 'Чтобы завершить шаг досрочно, нужно:' }: { list: string[]; title?: string }) {
  if (!list.length) return null;
  return (
    <div className="alert warn">
      <b>{title}</b>
      <ul>{list.map((e) => <li key={e}>{e}</li>)}</ul>
    </div>
  );
}

export function SaveStatus({ st }: { st: 'saved' | 'dirty' | 'saving' | 'error' }) {
  const txt = { saved: 'Сохранено ✓', dirty: 'Есть несохранённые правки…', saving: 'Сохраняю…', error: 'Нет связи — повторю сохранение' }[st];
  return <span className={`small ${st === 'error' ? 'neg' : 'muted'}`}>{txt}</span>;
}

export const plural = (n: number, one: string, few: string, many: string) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
};
