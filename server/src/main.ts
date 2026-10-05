import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { Server as IOServer, type Socket } from 'socket.io';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { zipSync, strToU8 } from 'fflate';
import { validateData, GRADE_CRITERIA, INDICATORS, type AdminAction, type GameData, type TeamAction } from '@sem/engine';
import { config, lanAddresses } from './config.ts';
import { Store } from './db.ts';
import { GameError, GameManager, type GameState, type TeamState } from './game.ts';
import { PdfService, loadBenchmarks, reportHtml } from './pdf.ts';

const data: GameData = JSON.parse(readFileSync(config.dataPath, 'utf8'));
const dataErrors = validateData(data);
if (dataErrors.length) {
  console.error('Ошибки в данных игры:\n- ' + dataErrors.join('\n- '));
  process.exit(1);
}
if (!config.adminPassword) {
  console.error('В .env не задан ADMIN_PASSWORD. Скопируйте .env.example в .env и задайте пароль.');
  process.exit(1);
}

const store = new Store(config.dbPath);
const manager = new GameManager(data, store);
const pdf = new PdfService(config.pdfDir);
const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

const lanUrls = () => lanAddresses().map((ip) => `http://${ip}:${config.port}/`);
const joinUrl = () => lanUrls()[0] ?? `http://localhost:${config.port}/`;

// ---------- авторизация ведущего ----------
const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const isAdmin = (token: unknown) => typeof token === 'string' && token.length > 10 && store.hasSession(token);
const adminToken = (req: any) => String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || String(req.query?.t ?? '');

app.post('/api/admin/login', async (req, reply) => {
  const { login, password } = (req.body ?? {}) as { login?: string; password?: string };
  if (!safeEq(String(login ?? ''), config.adminLogin) || !safeEq(String(password ?? ''), config.adminPassword)) {
    await new Promise((r) => setTimeout(r, 400));
    return reply.code(401).send({ error: 'Неверный логин или пароль' });
  }
  const token = randomBytes(24).toString('base64url');
  store.addSession(token);
  return { token };
});
app.get('/api/admin/check', async (req, reply) => (isAdmin(adminToken(req)) ? { ok: true } : reply.code(401).send({ error: 'Нужен вход' })));

app.post('/api/join', async (req, reply) => {
  const { pin, name } = (req.body ?? {}) as { pin?: string; name?: string };
  try {
    return manager.join(String(pin ?? ''), String(name ?? ''));
  } catch (e) {
    if (e instanceof GameError) return reply.code(400).send({ error: e.message });
    throw e;
  }
});

app.get('/api/health', async () => ({ ok: true, game: manager.game?.pin ?? null }));

app.get('/api/qr.svg', async (req, reply) => {
  const text = String((req.query as any).text ?? joinUrl()).slice(0, 300);
  const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return reply.type('image/svg+xml').send(svg);
});

// ---------- PDF и выгрузки ----------
async function teamPdf(t: TeamState): Promise<Buffer> {
  const ev = manager.finalEvaluation(t);
  if (!ev?.final) throw new GameError('Итог ещё не готов: команда не прошла закрытие бюджета');
  return pdf.render(`${manager.game!.id.slice(0, 8)}-${t.id}`, reportHtml(data, manager.game!, t, ev));
}
const pdfName = (t: TeamState) => `${t.name.replace(/[^\p{L}\d _-]/gu, '').trim() || t.id}.pdf`;
const sendPdf = (reply: any, t: TeamState, buf: Buffer, download: boolean) =>
  reply.type('application/pdf').header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(pdfName(t))}`).send(buf);

app.get('/api/team/pdf', async (req, reply) => {
  const t = manager.teamByToken(String((req.query as any).token ?? ''));
  if (!t) return reply.code(401).send({ error: 'Команда не найдена' });
  if (t.phase !== 'done') return reply.code(400).send({ error: 'PDF будет доступен после шага «Защита»' });
  try { return sendPdf(reply, t, await teamPdf(t), false); } catch (e) { return reply.code(500).send({ error: (e as Error).message }); }
});

const requireAdmin = (req: any, reply: any) => {
  if (!isAdmin(adminToken(req))) { reply.code(401).send({ error: 'Нужен вход ведущего' }); return false; }
  if (!manager.game) { reply.code(404).send({ error: 'Игра не создана' }); return false; }
  return true;
};
app.get('/api/admin/pdf/:teamId', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const t = manager.game!.teams.find((x) => x.id === (req.params as any).teamId);
  if (!t) return reply.code(404).send({ error: 'Команда не найдена' });
  try { return sendPdf(reply, t, await teamPdf(t), (req.query as any).download === '1'); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});

const csv = (rows: (string | number)[][]) =>
  '﻿' + rows.map((r) => r.map((c) => { const s = String(c ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(';')).join('\r\n') + '\r\n';
const dec = (n: number) => String(Math.round(n * 100) / 100).replace('.', ',');

function resultsCsv(g: GameState) {
  const labels = data.indicators.map((i) => i.label);
  const head = ['Команда', 'Участники', 'Город', 'Шаг', ...labels.map((l) => `${l}: было`), ...labels.map((l) => `${l}: стало`), 'Δ суммы', 'Индекс города: было', 'Индекс города: стало',
    'Индекс устойчивости, %', 'Итоговый резерв', 'Дефицит', 'Штраф', 'Бонус за резерв', 'Негативный джокер', 'Цена джокера', 'Положительный джокер', 'Использован', 'Меры'];
  const rows = g.teams.map((t) => {
    const ev = manager.finalEvaluation(t) ?? manager.evaluationFor(t);
    const city = data.cities.find((c) => c.id === t.decisions.cityId);
    const f = ev?.final;
    return [t.name, t.inputs.members.filter(Boolean).join(', '), city?.name ?? '', t.phase,
      ...INDICATORS.map((k) => city?.start[k] ?? ''), ...INDICATORS.map((k) => f?.final[k] ?? ''), f?.deltaSum ?? '', f ? dec(f.startIndex) : '', f ? dec(f.cityIndex) : '',
      f ? Math.round(f.resilienceIndex * 100) : '', ev?.reserve ?? '', f?.deficit ?? '', f?.penalty ?? '', f?.reserveBonus ?? '',
      t.decisions.negJoker ?? '', ev?.neg?.cost ?? '', t.decisions.posJoker ?? '', ev?.pos?.used ? 'да' : 'нет',
      ev?.items.map((i) => `${i.code}(${i.status})`).join(' ') ?? ''];
  });
  return csv([head, ...rows]);
}
function gradesCsv(g: GameState) {
  const head = ['Команда', 'Участник', ...GRADE_CRITERIA.map((c) => c.label), 'Итог (0–10)'];
  const rows: (string | number)[][] = [];
  for (const t of g.teams) {
    const names = new Set([...t.inputs.members.filter((m) => m.trim()), ...Object.keys(g.grades[t.id] ?? {})]);
    for (const m of names) {
      const gr = g.grades[t.id]?.[m] ?? {};
      const vals = GRADE_CRITERIA.map((c) => gr[c.key]).filter((v): v is number => typeof v === 'number');
      rows.push([t.name, m, ...GRADE_CRITERIA.map((c) => (gr[c.key] ?? '') as any), vals.length ? dec(vals.reduce((a, b) => a + b, 0) / vals.length) : '']);
    }
  }
  return csv([head, ...rows]);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

app.get('/api/admin/export.json', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const g = manager.game!;
  const out = {
    exportedAt: new Date().toISOString(), data: { source: data.meta.source, generatedAt: data.meta.generatedAt, rules: data.rules },
    game: { ...g, teams: g.teams.map((t) => { const { token: _t, ...rest } = t; return { ...rest, evaluation: manager.finalEvaluation(t) ?? manager.evaluationFor(t) }; }) },
  };
  return reply.type('application/json').header('Content-Disposition', `attachment; filename="foresight-${g.pin}-${stamp()}.json"`).send(JSON.stringify(out, null, 2));
});
app.get('/api/admin/results.csv', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="results-${manager.game!.pin}.csv"`).send(resultsCsv(manager.game!));
});
app.get('/api/admin/grades.csv', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="grades-${manager.game!.pin}.csv"`).send(gradesCsv(manager.game!));
});
app.get('/api/admin/all.zip', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const g = manager.game!;
  const files: Record<string, Uint8Array> = {
    'results.csv': strToU8(resultsCsv(g)),
    'grades.csv': strToU8(gradesCsv(g)),
  };
  const missing: string[] = [];
  for (const t of g.teams) {
    try { files[`pdf/${pdfName(t)}`] = new Uint8Array(await teamPdf(t)); } catch (e) { missing.push(`${t.name}: ${(e as Error).message}`); }
  }
  if (missing.length) files['НЕТ_PDF.txt'] = strToU8(missing.join('\n'));
  return reply.type('application/zip').header('Content-Disposition', `attachment; filename="foresight-${g.pin}-${stamp()}.zip"`).send(Buffer.from(zipSync(files)));
});

// ---------- статика SPA ----------
if (existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
  const index = readFileSync(`${config.webDist}/index.html`, 'utf8');
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/socket.io')) return reply.type('text/html').send(index);
    return reply.code(404).send({ error: 'Не найдено' });
  });
} else {
  app.get('/', async () => 'Интерфейс не собран: выполните npm run build (или npm start).');
}

// ---------- Socket.IO ----------
await app.ready();
const io = new IOServer(app.server, { cors: { origin: true }, serveClient: false });

io.on('connection', (socket: Socket) => {
  const auth = socket.handshake.auth as { role?: string; token?: string };
  if (auth.role === 'admin') {
    if (!isAdmin(auth.token)) { socket.emit('auth_error', 'Нужен вход ведущего'); socket.disconnect(true); return; }
    socket.join('admin');
    socket.emit('state', manager.adminView(lanUrls(), joinUrl()));
    socket.on('action', (a: AdminAction, ack?: (r: unknown) => void) => {
      try { manager.adminAction(a); ack?.({ ok: true }); } catch (e) { ack?.({ ok: false, error: e instanceof GameError ? e.message : 'Ошибка сервера' }); if (!(e instanceof GameError)) console.error(e); }
    });
    return;
  }
  const t = auth.token ? manager.teamByToken(auth.token) : null;
  if (!t) { socket.emit('auth_error', 'Сессия команды не найдена — войдите по PIN заново'); socket.disconnect(true); return; }
  socket.data.teamId = t.id;
  socket.data.token = auth.token;
  socket.join(`team:${t.id}`);
  manager.connections.set(t.id, (manager.connections.get(t.id) ?? 0) + 1);
  socket.emit('state', manager.teamView(t));
  scheduleBroadcast();
  socket.on('action', (a: TeamAction, ack?: (r: unknown) => void) => {
    try {
      const r = manager.teamAction(socket.data.token, a);
      ack?.({ ok: !r.errors?.length, errors: r.errors });
    } catch (e) {
      ack?.({ ok: false, error: e instanceof GameError ? e.message : 'Ошибка сервера' });
      if (!(e instanceof GameError)) console.error(e);
    }
  });
  socket.on('disconnect', () => {
    manager.connections.set(t.id, Math.max(0, (manager.connections.get(t.id) ?? 1) - 1));
    scheduleBroadcast();
  });
});

let pending = false;
function scheduleBroadcast() {
  if (pending) return;
  pending = true;
  setImmediate(() => {
    pending = false;
    const g = manager.game;
    for (const [, s] of io.sockets.sockets) {
      if (!s.data.teamId) continue;
      const t = g?.teams.find((x) => x.id === s.data.teamId && x.token === s.data.token);
      if (!t) { s.emit('auth_error', 'Устройство отключено ведущим — войдите по PIN заново'); s.disconnect(true); continue; }
      s.emit('state', manager.teamView(t));
    }
    io.to('admin').emit('state', manager.adminView(lanUrls(), joinUrl()));
  });
}
manager.onChange = scheduleBroadcast;
manager.startLoop();
setInterval(() => io.to('admin').emit('state', manager.adminView(lanUrls(), joinUrl())), 5000).unref();

await app.listen({ port: config.port, host: config.host });
const urls = lanUrls();
console.log('\n  Форсайт-игра запущена');
console.log(`  Ведущий:  http://localhost:${config.port}/admin   (логин: ${config.adminLogin})`);
for (const u of urls) console.log(`  Команды:  ${u}`);
if (!urls.length) console.log('  ⚠ Не найден адрес в локальной сети — подключите Wi-Fi/Ethernet.');
if (data.meta.overrides?.length) console.log(`  Правила переопределены: ${data.meta.overrides.join('; ')}`);
if (!loadBenchmarks(data)) console.log('  ⚠ Эталоны для PDF (лучшие варианты и оценка) не рассчитаны для текущих правил — выполните `npm run benchmarks`.');
console.log('');

const shutdown = async () => { manager.save(); store.set('lastAlive', String(Date.now())); await pdf.close().catch(() => {}); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
