import { useEffect, useRef, useState, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { Ack } from '@sem/engine';

export const TEAM_TOKEN = 'foresight.teamToken';
export const ADMIN_TOKEN = 'foresight.adminToken';

export const storage = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* */ } },
};

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
  return j as T;
}

export type ConnState = 'connecting' | 'online' | 'offline';

/** Подключение к серверу: состояние приходит целиком при каждом изменении. */
export function useLive<V extends { serverNow: number }>(auth: { role: 'team' | 'admin'; token: string } | null, onAuthError: (msg: string) => void) {
  const [state, setState] = useState<V | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [offset, setOffset] = useState(0);
  const sock = useRef<Socket | null>(null);
  const authErr = useRef(onAuthError);
  authErr.current = onAuthError;

  useEffect(() => {
    if (!auth) return;
    const s = io({ auth, transports: ['websocket', 'polling'], reconnectionDelayMax: 3000 });
    sock.current = s;
    s.on('connect', () => setConn('online'));
    s.on('disconnect', () => setConn('offline'));
    s.on('connect_error', () => setConn('offline'));
    s.on('state', (v: V) => { setOffset(v.serverNow - Date.now()); setState(v); });
    s.on('auth_error', (m: string) => authErr.current(m));
    return () => { s.close(); sock.current = null; };
  }, [auth?.role, auth?.token]);

  const act = useCallback(<A extends object>(a: A) => new Promise<Ack>((res) => {
    const s = sock.current;
    if (!s || !s.connected) return res({ ok: false, error: 'Нет связи с сервером — изменения не сохранены, повторите через пару секунд' });
    const timer = setTimeout(() => res({ ok: false, error: 'Сервер не ответил' }), 8000);
    s.emit('action', a, (ack: Ack) => { clearTimeout(timer); res(ack); });
  }), []);

  return { state, conn, act, offset };
}

/** Тик раз в 250 мс для таймеров. */
export function useNow(offset: number) {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + offset), 250);
    return () => clearInterval(id);
  }, [offset]);
  return now;
}

export function remaining(deadline: number | null, pausedMs: number | null, now: number) {
  if (deadline !== null) return Math.max(0, deadline - now);
  return pausedMs;
}
export function fmtTime(ms: number | null) {
  if (ms === null) return '—';
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export const money = (n: number) => (n < 0 ? `−${-n}` : String(n));

/**
 * Автосохранение: локальная копия раздела, отправка через delay мс после последней правки.
 * Возвращает [значение, setter, статус, flush].
 */
export function useAutosave<T>(initial: T, resetKey: string, save: (v: T) => Promise<Ack>, delay = 1500) {
  const [value, setValue] = useState<T>(initial);
  const [status, setStatus] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const pending = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  // новое «окно» (другой шаг/команда) — берём значение с сервера
  useEffect(() => { setValue(initial); setStatus('saved'); pending.current = null; }, [resetKey]);

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const v = pending.current;
    if (v === null) return true;
    pending.current = null;
    setStatus('saving');
    const r = await saveRef.current(v);
    setStatus(r.ok ? (pending.current ? 'dirty' : 'saved') : 'error');
    if (!r.ok) pending.current = pending.current ?? v;
    return r.ok;
  }, []);

  const update = useCallback((v: T | ((p: T) => T)) => {
    setValue((prev) => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      pending.current = next;
      return next;
    });
    setStatus('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, delay);
  }, [delay, flush]);

  // повтор при ошибке связи
  useEffect(() => {
    if (status !== 'error') return;
    const id = setTimeout(() => { void flush(); }, 3000);
    return () => clearTimeout(id);
  }, [status, flush]);
  useEffect(() => () => { void flush(); }, [flush]);

  return [value, update, status, flush] as const;
}
