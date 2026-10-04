// End-to-end: поднимает сервер на временной БД, эмулирует ведущего и 4 команды, проходит всю игру.
// Запуск: npm run e2e   (нужен собранный data/game_data.json; для PDF — Chromium или Google Chrome)
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io, type Socket } from 'socket.io-client';
import type { AdminView, TeamView, TeamAction, AdminAction, Ack } from '../engine/src/protocol.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18080 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), 'foresight-e2e-'));
const env = { ...process.env, PORT: String(PORT), DB_PATH: join(tmp, 'e2e.sqlite'), ADMIN_LOGIN: 'admin', ADMIN_PASSWORD: 'e2e-pass', HOST: '127.0.0.1' };

let passed = 0;
const failures: string[] = [];
function check(cond: unknown, msg: string) {
  if (cond) { passed++; console.log('  ✓ ' + msg); } else { failures.push(msg); console.log('  ✗ ' + msg); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ChildProcess;
async function startServer() {
  server = spawn(process.execPath, ['--import', 'tsx', join(root, 'server/src/main.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr!.on('data', (d) => process.stderr.write('[server] ' + d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) return; } catch { /* ждём */ }
    await sleep(150);
  }
  throw new Error('Сервер не стартовал');
}
async function stopServer() {
  server.kill('SIGTERM');
  await new Promise((r) => server.once('exit', r));
}
const post = async (path: string, body: unknown) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};

class Client<V> {
  socket!: Socket;
  state: V | null = null;
  private waiters: ((v: V) => void)[] = [];
  constructor(private auth: object) {}
  connect() {
    return new Promise<void>((res, rej) => {
      this.socket = io(BASE, { auth: this.auth, transports: ['websocket'], forceNew: true });
      this.socket.on('state', (s: V) => { this.state = s; this.waiters.splice(0).forEach((w) => w(s)); });
      this.socket.on('auth_error', (e: string) => rej(new Error(e)));
      this.socket.once('state', () => res());
    });
  }
  /** Действие + ожидание следующего состояния от сервера (рассылка идёт сразу после ответа). */
  act(a: object): Promise<Ack> {
    return new Promise((r) => {
      const next = new Promise<void>((res) => { this.waiters.push(() => res()); setTimeout(res, 400); });
      this.socket.emit('action', a, (ack: Ack) => (ack.ok ? next.then(() => r(ack)) : r(ack)));
    });
  }
  async until(pred: (v: V) => boolean, ms = 8000): Promise<V> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.state && pred(this.state)) return this.state;
      await new Promise<void>((r) => { this.waiters.push(() => r()); setTimeout(r, 200); });
    }
    throw new Error('Не дождались состояния');
  }
  close() { this.socket.close(); }
}
type TeamC = Client<TeamView> & { act(a: TeamAction): Promise<Ack> };
type AdminC = Client<AdminView> & { act(a: AdminAction): Promise<Ack> };

const sentences = (n: number, topic: string) => Array.from({ length: n }, (_, i) => `В сценарии ${topic} событие номер ${i + 1} меняет жизнь города.`).join(' ');

async function main() {
  console.log(`E2E: сервер на ${BASE}, БД ${env.DB_PATH}`);
  await startServer();

  console.log('\n[1] Вход ведущего и создание игры');
  check((await post('/api/admin/login', { login: 'admin', password: 'wrong' })).status === 401, 'неверный пароль отклонён');
  const login = await post('/api/admin/login', { login: 'admin', password: 'e2e-pass' });
  check(login.status === 200 && login.json.token, 'ведущий вошёл');
  const adminToken = login.json.token as string;
  const admin = new Client<AdminView>({ role: 'admin', token: adminToken }) as AdminC;
  await admin.connect();
  await admin.act({ type: 'createGame' });
  const pin = (await admin.until((s) => !!s.game)).game!.pin;
  check(/^\d{6}$/.test(pin), `PIN из 6 цифр: ${pin}`);
  const qr = await fetch(BASE + '/api/qr.svg');
  check(qr.ok && (await qr.text()).includes('<svg'), 'QR-код отдаётся');

  console.log('\n[2] Подключение команд');
  check((await post('/api/join', { pin: '000000', name: 'X' })).status === 400, 'неверный PIN отклонён');
  const names = ['Альфа', 'Бета', 'Гамма', 'Дельта'];
  const tokens: string[] = [];
  for (const n of names) {
    const r = await post('/api/join', { pin, name: n });
    tokens.push(r.json.token);
  }
  check(tokens.every(Boolean), '4 команды вошли');
  const fifth = await post('/api/join', { pin, name: 'Эпсилон' });
  check(fifth.status === 400 && /4 команды/.test(fifth.json.error), `пятое устройство отклонено: «${fifth.json.error}»`);
  check((await post('/api/join', { pin, name: 'альфа' })).status === 400, 'повтор названия отклонён');
  const teams = tokens.map((t) => new Client<TeamView>({ role: 'team', token: t }) as TeamC);
  await Promise.all(teams.map((t) => t.connect()));
  check(teams.every((t) => t.state!.team.phase === 'lobby'), 'все в лобби');
  await teams[0].act({ type: 'saveInputs', section: 'members', data: ['Иванов И.', 'Петрова А.', 'Сидоров К.', 'Козлова М.'] });

  console.log('\n[3] Старт: города без повторов');
  await admin.act({ type: 'settings', durationsMin: { matrix: 0.1 } });
  await admin.act({ type: 'start' });
  await Promise.all(teams.map((t) => t.until((s) => s.team.phase === 'city')));
  const cities = teams.map((t) => t.state!.city!.name);
  check(new Set(cities).size === 4, `города разные: ${cities.join(', ')}`);
  const tv = JSON.stringify(teams[0].state);
  const gd = JSON.parse(readFileSync(join(root, 'data/game_data.json'), 'utf8'));
  const vulns: string[] = gd.cities.flatMap((c: any) => c.vulnerabilities);
  check(!/vulnerabilit/i.test(tv) && !vulns.some((v) => tv.includes(v)), 'команда не видит уязвимости');
  check(!/"effects"|"start":\{/.test(tv), 'команда не видит показатели 1–10 и эффекты мер');
  check(!/"J[-+]\d|"J0"/.test(tv), 'команда не видит джокеры до открытия');
  check(teams[0].state!.city!.situation.length > 50 && teams[0].state!.city!.signals.length === 6, 'карточка города: ситуация и 6 сигналов');

  console.log('\n[4] Диагностика, матрица (с проверкой таймера), сценарии');
  let r: Awaited<ReturnType<typeof teams[0]['act']>>;
  check(teams[0].state!.stepErrors.length === 0 && teams[0].state!.stepWarnings.length > 0, `пустая диагностика не блокирует, а подсказывает (подсказок: ${teams[0].state!.stepWarnings.length})`);
  for (const t of teams) {
    await t.act({ type: 'saveInputs', section: 'diagnostics', data: { trends: ['Старение', 'Автоматизация', 'Удалёнка', ''], drivers: ['Инвестиции', 'Миграция', ''], weakSignals: ['Коворкинг', ''], problems: ['Отток', 'Износ', 'Бюджет'] } });
    r = await t.act({ type: 'finish' });
  }
  check(r.ok, 'диагностика заполнена — шаг завершён');
  await Promise.all(teams.map((t) => t.until((s) => s.team.phase === 'matrix')));
  for (const t of teams.slice(1)) {
    await t.act({ type: 'saveInputs', section: 'matrix', data: { axes: [
      { name: 'Темп автоматизации', poleA: 'быстрый', poleB: 'медленный', why: 'определяет занятость' },
      { name: 'Климатические риски', poleA: 'растут', poleB: 'стабильны', why: 'определяют расходы бюджета' }] } });
    await t.act({ type: 'finish' });
  }
  // Команда 1 не нажимает «Готово»: шаг матрицы (6 с) должен закрыться по таймеру сервера
  await teams[0].until((s) => s.team.phase === 'scenarios', 15000);
  check(true, 'матрица команды 1 закрыта по таймеру сервера (6 с)');
  for (const [i, t] of teams.entries()) {
    await t.act({ type: 'saveInputs', section: 'scenarios', data: [0, 1, 2, 3].map((k) => ({ title: `Сценарий ${k + 1}`, text: sentences(k === 3 && i === 0 ? 2 : 3, String(k + 1)) })) });
  }
  await teams[0].until((s) => s.stepWarnings.some((e) => /Сценарий 4: рекомендуем 3 предложения \(сейчас 2\)/.test(e)));
  check(teams[0].state!.stepErrors.length === 0, 'сценарий из 2 предложений — подсказка, а не запрет');
  for (const t of teams) r = await t.act({ type: 'finish' });
  check(r.ok, 'команда с коротким сценарием переходит дальше');
  await Promise.all(teams.map((t) => t.until((s) => s.team.phase === 'budget')));
  check(teams.every((t) => t.state!.team.phase === 'budget'), 'все на шаге «Бюджет»');

  console.log('\n[5] Бюджет');
  const plans: Record<string, 'full' | 'conditional'>[] = [
    { M4: 'full', M13: 'conditional', M2: 'conditional', M6: 'full', M5: 'conditional', M8: 'conditional' },
    { M3: 'conditional', M13: 'conditional', M7: 'full', M14: 'full', M9: 'conditional' },
    { M1: 'full', M7: 'full', M11: 'full' },
    { M12: 'full', M10: 'conditional', M15: 'conditional', M16: 'conditional', M2: 'full' },
  ];
  await teams[3].act({ type: 'setMeasure', code: 'M2', mode: 'full' });
  await teams[3].act({ type: 'setMarks', code: 'M2', scenarios: [true, false, false, false], trigger: '' });
  r = await teams[3].act({ type: 'finish' });
  check(!r.ok && r.errors!.some((e) => /минимум 2 полные/.test(e)), 'бюджет с одной полной мерой не закрывается (нужно минимум 2)');
  for (const [i, t] of teams.entries()) {
    for (const [code, mode] of Object.entries(plans[i])) {
      const a = await t.act({ type: 'setMeasure', code, mode });
      if (!a.ok) console.log('    setMeasure', code, a.error);
      await t.act({ type: 'setMarks', code, scenarios: [true, true, i % 2 === 0, code === 'M4'], trigger: mode === 'conditional' ? `Если показатель ${code} превысит порог` : '' });
    }
  }
  r = await teams[2].act({ type: 'setMeasure', code: 'M2', mode: 'full' });
  check(!r.ok && /больше 100/.test(r.error!), `перерасход отклонён: «${r.error}»`);
  r = await teams[0].act({ type: 'setMeasure', code: 'M4', mode: 'conditional' });
  check(!r.ok, 'M4 условной быть не может');
  const b0 = teams[0].state!.balance!;
  check(b0.spent === 15 + 5 + 5 + 18 + 5 + 6 && b0.reserve === 100 - b0.spent, `баланс команды 1: потрачено ${b0.spent}, резерв ${b0.reserve}`);
  check(b0.laterCommitments === 15 + 15 + 15 + 19 && b0.forecast === b0.reserve - b0.laterCommitments, `обязательства «Позже» ${b0.laterCommitments}, прогноз ${b0.forecast}`);
  const viewBudget = JSON.stringify(teams[0].state);
  check(!/"econ"|Экономика":/.test(viewBudget), 'на шаге бюджета нет показателей 1–10');

  console.log('\n[6] Негативный джокер: автоматическое списание');
  for (const t of teams) await t.act({ type: 'finish' });
  await Promise.all(teams.map((t) => t.until((s) => s.team.phase === 'jokerNeg' && !!s.negJoker)));
  const negs = teams.map((t) => t.state!.negJoker!);
  check(new Set(negs.map((n) => n.code)).size === 4, `негативные джокеры без повторов: ${negs.map((n) => n.code).join(', ')}`);
  for (const [i, t] of teams.entries()) {
    const s = t.state!;
    const negEntry = s.balance!.ledger.find((l) => l.stage === 'neg');
    check(!JSON.stringify(s).includes('уточнить'), `команда ${i + 1}: служебные пометки xlsx скрыты`);
    check(s.balance!.reserve === 100 - s.balance!.spent && negEntry?.amount === -s.negJoker!.cost, `команда ${i + 1}: ${s.negJoker!.code} — ${s.negJoker!.explanation}; резерв ${s.balance!.reserve}`);
  }

  console.log('\n[7] Корректировка 1: отказ от условной и докупка');
  for (const t of teams) await t.act({ type: 'finish' });
  await Promise.all(teams.map((t) => t.until((s) => s.team.phase === 'corr1')));
  r = await teams[0].act({ type: 'cancelMeasure', code: 'M8' });
  const m8 = teams[0].state!.portfolio.find((p) => p.code === 'M8')!;
  check(r.ok && m8.status === 'cancelled' && m8.paid === 6 && m8.laterDue === 0, 'снятие условной M8: «Сейчас» 6 у.е. не вернулось, «Позже» больше не числится');
  for (const [i, t] of teams.entries()) {
    const locked = t.state!.portfolio.find((p) => p.locked);
    if (locked) {
      r = await t.act({ type: 'cancelMeasure', code: locked.code });
      check(!r.ok && /удешевила/.test(r.error!), `команда ${i + 1}: ${locked.code} покрыла ${t.state!.negJoker!.code} — снять нельзя`);
    }
    const full = t.state!.portfolio.find((p) => p.status === 'full' && !p.locked && p.round === 0);
    if (full && i < 2) {
      const before = t.state!.balance!.reserve;
      r = await t.act({ type: 'cancelMeasure', code: full.code });
      const after = t.state!.portfolio.find((p) => p.code === full.code)!;
      check(r.ok && after.refund === full.refundIfRemoved && t.state!.balance!.reserve === before + full.refundIfRemoved,
        `команда ${i + 1}: снятие полной ${full.code} вернуло ${after.refund} у.е. (60%), резерв ${before} → ${t.state!.balance!.reserve}`);
    }
  }
  r = await teams[2].act({ type: 'setMeasure', code: 'M13', mode: 'full' });
  check(!r.ok || teams[2].state!.balance!.reserve >= 0, 'докупка только из резерва');
  if (teams[0].state!.balance!.reserve >= 5) {
    r = await teams[0].act({ type: 'setMeasure', code: 'M10', mode: 'conditional' });
    await teams[0].act({ type: 'setMarks', code: 'M10', scenarios: [true, true, true, false], trigger: 'Если цифровых сервисов станет больше половины' });
    check(r.ok, 'докупка M10 условно в корректировке');
  }

  console.log('\n[8] Перезапуск сервера посреди игры');
  const before = teams.map((t) => ({ phase: t.state!.team.phase, rem: t.state!.team.remainingMs!, reserve: t.state!.balance!.reserve }));
  teams.forEach((t) => t.close());
  admin.close();
  await stopServer();
  await sleep(1500);
  await startServer();
  await Promise.all(teams.map((t) => t.connect()));
  await admin.connect();
  const after = teams.map((t) => ({ phase: t.state!.team.phase, rem: t.state!.team.remainingMs!, reserve: t.state!.balance!.reserve }));
  check(after.every((a, i) => a.phase === before[i].phase && a.reserve === before[i].reserve), 'после перезапуска шаг и резерв сохранились');
  check(after.every((a, i) => before[i].rem - a.rem < 6000), `таймер не сбился при простое (потеря ≤ ${Math.max(...after.map((a, i) => before[i].rem - a.rem))} мс)`);

  console.log('\n[9] Управление ведущего');
  const rem0 = teams[1].state!.team.remainingMs!;
  await admin.act({ type: 'addMinute', target: teams[1].state!.team.id });
  await teams[1].until((s) => (s.team.remainingMs ?? 0) > rem0 + 50_000);
  check(true, '+1 минута одной команде');
  await admin.act({ type: 'pause', target: 'all' });
  await teams[1].until((s) => s.team.paused);
  const pr = teams[1].state!.team.remainingMs!;
  await sleep(1200);
  check(teams[1].state!.team.paused && teams[1].state!.team.remainingMs === pr, 'пауза останавливает таймер');
  await admin.act({ type: 'resume', target: 'all' });
  await admin.act({ type: 'announce', text: 'Осталось 2 минуты!' });
  await teams[3].until((s) => s.game.announcement?.text === 'Осталось 2 минуты!');
  check(true, 'объявление доставлено на экран команды');
  const adm = await admin.until((s) => s.teams.length === 4);
  check(adm.teams.every((t) => t.city!.vulnerabilities.length === 5) && adm.teams.every((t) => t.connected), 'ведущий видит уязвимости и подключение всех команд');

  console.log('\n[10] Положительный джокер');
  await admin.act({ type: 'forceJoker', target: teams[3].state!.team.id });
  for (const t of teams.slice(0, 3)) await t.act({ type: 'finish' });
  await Promise.all(teams.map((t) => t.until((s) => s.team.phase === 'jokerPos' && !!s.posJoker)));
  const poss = teams.map((t) => t.state!.posJoker!);
  check(new Set(poss.map((p) => p.code)).size === 4, `положительные джокеры без повторов: ${poss.map((p) => p.code).join(', ')}`);
  for (const [i, t] of teams.entries()) {
    const p = t.state!.posJoker!;
    if (p.offer.available) {
      r = await t.act({ type: 'posDecide', use: true, measure: p.offer.choices?.[0]?.code });
      check(r.ok, `команда ${i + 1}: ${p.code} использован (${p.offer.reason}; ${p.offer.gain})`);
    } else {
      r = await t.act({ type: 'finish' });
      check(r.ok, `команда ${i + 1}: ${p.code} недоступен — ${p.offer.reason}`);
    }
  }
  await Promise.all(teams.map((t) => t.until((s) => s.team.phase === 'corr2')));

  console.log('\n[11] Корректировка 2 и закрытие');
  for (const t of teams) {
    for (const p of t.state!.portfolio) if (!p.scenarios.some(Boolean) && p.status !== 'cancelled') await t.act({ type: 'setMarks', code: p.code, scenarios: [true, false, true, false], trigger: p.trigger });
    r = await t.act({ type: 'finish' });
    if (!r.ok) console.log('    corr2', r.errors);
  }
  await Promise.all(teams.map((t) => t.until((s) => s.team.phase === 'closing')));
  check(teams[0].state!.stepErrors.length === 0 && teams[0].state!.stepWarnings.some((e) => /запускаем или нет/.test(e)), 'закрытие подсказывает про нерешённые условные меры, но не блокирует');
  for (const t of teams) {
    const pending = t.state!.portfolio.filter((p) => p.status === 'conditional');
    for (const [k, p] of pending.entries()) await t.act({ type: 'closingSet', code: p.code, launch: k % 2 === 0, reason: k % 2 === 0 ? 'Триггер сработал: порог превышен в двух сценариях.' : 'Триггер не сработал, мера остаётся в резерве.' });
    const cp = t.state!.closingPreview!;
    check(cp.deficit === Math.max(0, -cp.reserve), `${t.state!.team.name}: итоговый резерв ${cp.reserve}, дефицит ${cp.deficit}, штраф ${cp.penalty}`);
    r = await t.act({ type: 'finish' });
    if (!r.ok) console.log('    closing', t.state!.team.name, r.error ?? r.errors);
  }
  await Promise.all(teams.map((t) => t.until((s) => s.team.phase === 'defense')));

  console.log('\n[12] Защита и PDF');
  for (const t of teams) {
    await t.act({ type: 'saveInputs', section: 'defense', data: { solutions: ['Сине-зелёная инфраструктура', 'Переподготовка кадров', 'Резерв на шоки'], joker: 'Паводок — показал цену неподготовленности.', lesson: 'Условные меры с триггерами дешевле ошибок прогноза.' } });
    r = await t.act({ type: 'finish' });
    if (!r.ok) console.log('    defense', t.state!.team.name, t.state!.team.phase, r.error ?? r.errors);
  }
  await Promise.all(teams.map((t) => t.until((s) => s.team.phase === 'done')));
  check(teams.every((t) => t.state!.pdfReady), 'все команды завершили игру');
  const pdfRes = await fetch(`${BASE}/api/team/pdf?token=${encodeURIComponent(tokens[0])}`);
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  check(pdfRes.ok && pdfBuf.subarray(0, 4).toString() === '%PDF', `PDF команды сформирован (${Math.round(pdfBuf.length / 1024)} КБ)`);
  check(/PTSans|PT Sans/.test(pdfBuf.toString('latin1')), 'шрифт PT Sans встроен в PDF');
  const pdfPath = join(tmp, 'team1.pdf');
  writeFileSync(pdfPath, pdfBuf);
  if (existsSync('/opt/homebrew/bin/pdftotext') || existsSync('/usr/bin/pdftotext') || existsSync('/usr/local/bin/pdftotext')) {
    const text = execFileSync('pdftotext', ['-enc', 'UTF-8', pdfPath, '-']).toString('utf8');
    check(text.includes('УЧЕБНЫЕ ДАННЫЕ') && text.includes('Рост города') && text.includes('Индекс города') && text.includes('Альфа'), 'русский текст в PDF извлекается (pdftotext)');
    check(text.includes('Иванов И.'), 'участники команды в PDF');
    check(text.includes('Стартовая позиция города') && text.includes('Лучшие возможные варианты') && /\d+\s*\/ 10/.test(text), 'в PDF есть стартовая позиция, лучшие варианты и оценка');
  } else console.log('  · pdftotext не найден — проверка извлечения текста пропущена');
  const zip = await fetch(`${BASE}/api/admin/all.zip?t=${adminToken}`);
  const zipBuf = Buffer.from(await zip.arrayBuffer());
  check(zip.ok && zipBuf.subarray(0, 2).toString() === 'PK' && zipBuf.toString('latin1').split('.pdf').length - 1 >= 4, `ZIP с PDF всех команд (${Math.round(zipBuf.length / 1024)} КБ)`);
  const res = await (await fetch(`${BASE}/api/admin/results.csv?t=${adminToken}`)).text();
  check(res.split('\r\n').filter(Boolean).length === 5, 'results.csv: заголовок + 4 команды');
  const json = await (await fetch(`${BASE}/api/admin/export.json?t=${adminToken}`)).json() as any;
  check(json.game.teams.length === 4 && !JSON.stringify(json).includes(tokens[0]), 'export.json без токенов команд');

  console.log('\n[13] Оценивание');
  const tid = teams[0].state!.team.id;
  await admin.act({ type: 'grade', teamId: tid, member: 'Иванов И.', key: 'involvement', value: 9 });
  await admin.act({ type: 'grade', teamId: tid, member: 'Иванов И.', key: 'analysis', value: 8 });
  r = await admin.act({ type: 'grade', teamId: tid, member: 'Иванов И.', key: 'data', value: 11 });
  check(!r.ok, 'оценка 11 отклонена');
  const grades = await (await fetch(`${BASE}/api/admin/grades.csv?t=${adminToken}`)).text();
  check(grades.includes('Иванов И.;9;8;;;;8,5'), 'grades.csv: итог = среднее заполненных критериев (8,5)');

  console.log('\n[14] Сброс устройства');
  await admin.act({ type: 'resetDevice', teamId: teams[1].state!.team.id });
  const rejoin = await post('/api/join', { pin, name: 'Бета' });
  check(rejoin.status === 200 && rejoin.json.token !== tokens[1], 'после сброса команда входит с нового устройства');

  teams.forEach((t) => t.close());
  admin.close();
  await stopServer();
  console.log(`\nИтог: ${passed} проверок пройдено, ${failures.length} не пройдено.`);
  if (failures.length) { console.log('Не пройдено:\n- ' + failures.join('\n- ')); process.exit(1); }
  console.log(`PDF команды 1 сохранён: ${pdfPath}`);
}

main().catch(async (e) => {
  console.error('E2E упал:', e);
  try { server?.kill('SIGTERM'); } catch { /* */ }
  process.exit(1);
});
