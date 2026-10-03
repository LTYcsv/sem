// Итоговый PDF команды: HTML-шаблон → Chromium (Playwright). Шрифт PT Sans встроен (base64), интернет не нужен.
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { INDICATORS, PHASE_LABELS, scenarioPoles, type Evaluation, type GameData, type IndicatorKey } from '@sem/engine';
import type { GameState, TeamState } from './game.ts';
import { ROOT } from './config.ts';

const fontDir = join(ROOT, 'node_modules', '@fontsource', 'pt-sans', 'files');
const font = (f: string) => readFileSync(join(fontDir, f)).toString('base64');
let fontCss = '';
function fonts() {
  if (fontCss) return fontCss;
  const face = (w: number, subset: string, range: string) =>
    `@font-face{font-family:'PT Sans';font-weight:${w};src:url(data:font/woff2;base64,${font(`pt-sans-${subset}-${w}-normal.woff2`)}) format('woff2');unicode-range:${range}}`;
  const cyr = 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116';
  const lat = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD,U+2190-21FF,U+2260-22FF';
  fontCss = [400, 700].flatMap((w) => [face(w, 'cyrillic', cyr), face(w, 'latin', lat)]).join('\n');
  return fontCss;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const txt = (s: string | undefined) => (s && s.trim() ? esc(s).replace(/\n/g, '<br>') : '<span class="empty">не заполнено</span>');
const sign = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
const num = (n: number, d = 1) => n.toFixed(d).replace('.', ',').replace('-', '−');
const money = (n: number) => (n < 0 ? `−${-n}` : String(n));

const STATUS: Record<string, string> = {
  full: 'полная', grant: 'запущена джокером', conditional: 'условная', launched: 'условная → запущена', notLaunched: 'условная → не запущена', cancelled: 'отказ',
};
const STAGE: Record<string, string> = { budget: 'Бюджет', neg: 'Негативный джокер', corr1: 'Корректировка 1', pos: 'Положительный джокер', corr2: 'Корректировка 2', closing: 'Закрытие' };

/** Дамббелл «было → стало» по шести показателям (SVG, печать). */
function chart(data: GameData, ev: Evaluation) {
  const f = ev.final!;
  const W = 700, rowH = 30, left = 200, right = 110, top = 28;
  const H = top + rowH * INDICATORS.length + 26;
  const x = (v: number) => left + ((v - 1) / 9) * (W - left - right);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Показатели было → стало">`;
  for (let v = 1; v <= 10; v++) {
    s += `<line x1="${x(v)}" x2="${x(v)}" y1="${top - 8}" y2="${H - 22}" stroke="#e7e6e2" stroke-width="1"/>`;
    s += `<text x="${x(v)}" y="${H - 8}" font-size="11" fill="#6b6a66" text-anchor="middle">${v}</text>`;
  }
  s += `<circle cx="${left}" cy="10" r="5" fill="#fff" stroke="#8a8984" stroke-width="2"/><text x="${left + 10}" y="14" font-size="12" fill="#52514e">было</text>`;
  s += `<circle cx="${left + 70}" cy="10" r="6" fill="#2a78d6"/><text x="${left + 81}" y="14" font-size="12" fill="#52514e">стало</text>`;
  INDICATORS.forEach((k, i) => {
    const y = top + i * rowH + rowH / 2;
    const a = f.start[k], b = f.final[k], d = b - a;
    const label = data.indicators.find((ind) => ind.key === k)!.label;
    s += `<text x="0" y="${y + 4}" font-size="13" fill="#0b0b0b">${esc(label)}</text>`;
    if (d !== 0) s += `<line x1="${x(a)}" x2="${x(b)}" y1="${y}" y2="${y}" stroke="#2a78d6" stroke-width="3" stroke-linecap="round" opacity="0.55"/>`;
    s += `<circle cx="${x(a)}" cy="${y}" r="5.5" fill="#fff" stroke="#8a8984" stroke-width="2"/>`;
    s += `<circle cx="${x(b)}" cy="${y}" r="7" fill="#2a78d6" stroke="#fcfcfb" stroke-width="2"/>`;
    s += `<text x="${W}" y="${y + 4}" font-size="13" fill="#0b0b0b" text-anchor="end" font-weight="700">${a} → ${b} <tspan fill="#52514e" font-weight="400">(${sign(d)})</tspan></text>`;
  });
  return s + '</svg>';
}

export function reportHtml(data: GameData, g: GameState, t: TeamState, ev: Evaluation): string {
  const city = data.cities.find((c) => c.id === t.decisions.cityId)!;
  const f = ev.final!;
  const label = (k: IndicatorKey) => data.indicators.find((i) => i.key === k)!.label;
  const ax = t.inputs.matrix.axes;
  const pole = (axis: 0 | 1, p: 'poleA' | 'poleB') => esc(ax[axis][p] || (p === 'poleA' ? 'полюс А' : 'полюс Б'));
  const measures = new Map(data.measures.map((m) => [m.code, m]));
  const negJ = data.jokers.find((j) => j.code === t.decisions.negJoker);
  const posJ = data.jokers.find((j) => j.code === t.decisions.posJoker);
  const pi = data.rules.penaltyIndicator;

  const portfolioRows = ev.items.map((it) => {
    const m = measures.get(it.code)!;
    const marks = t.decisions.marks[it.code]?.scenarios ?? [false, false, false, false];
    const sc = marks.map((v, i) => (v ? `<b>${i + 1}</b>` : `<span class="off">${i + 1}</span>`)).join(' ');
    const trig = t.decisions.marks[it.code]?.trigger;
    const reason = t.decisions.closing?.[it.code]?.reason;
    return `<tr><td><b>${it.code}</b> ${esc(m.name)}</td><td>${STATUS[it.status]}</td><td class="r">${it.paid}</td>
      <td>${it.initialMode === 'conditional' ? txt(trig) : '—'}${reason ? `<div class="sub">Закрытие: ${esc(reason)}</div>` : ''}</td><td class="sc">${sc}</td></tr>`;
  }).join('');

  const ledgerRows = ev.ledger.map((l) => `<tr><td>${STAGE[l.stage]}</td><td>${esc(l.text)}</td><td class="r">${l.amount ? money(l.amount) : '—'}</td><td class="r ${l.balance < 0 ? 'neg' : ''}">${money(l.balance)}</td></tr>`).join('');

  const notes: string[] = [];
  if (f.penalty) notes.push(`<b>Штраф за дефицит:</b> дефицит ${f.deficit} у.е. → −${f.penalty} (каждые ${data.rules.penaltyStep} у.е., округление вверх) к показателю «${label(pi)}»${f.spilled ? `; ${f.spilled} балл(а) не поместились (показатель уже ${data.rules.min}) и сняты с наибольших других показателей` : ''}.`);
  if (f.reserveBonus) notes.push(`<b>Бонус за резерв:</b> остаток ${f.reserve} у.е. → +${f.reserveBonus} к показателю «${label(data.rules.reserveBonusIndicator)}» (+1 за каждые ${data.rules.reserveBonusStep} у.е., максимум +${data.rules.reserveBonusMax}).`);
  if (!f.penalty && !f.reserveBonus) notes.push(`Ни штрафа, ни бонуса за резерв: итоговый резерв ${f.reserve} у.е.`);
  for (const k of INDICATORS) if (f.jokerBonus[k]) notes.push(`<b>Бонус джокера ${posJ?.code}:</b> ${sign(f.jokerBonus[k])} к показателю «${label(k)}».`);
  const capped = INDICATORS.filter((k) => f.raw[k] > data.rules.max).map((k) => `«${label(k)}» (${f.raw[k]} → ${data.rules.max})`);
  if (capped.length) notes.push(`<b>Потолок шкалы:</b> ${capped.join(', ')}.`);

  const effectsRow = INDICATORS.map((k) => `<td class="r">${sign(f.effects[k])}</td>`).join('');
  const diag = t.inputs.diagnostics;
  const list = (a: string[]) => (a.filter((s) => s.trim()).length ? `<ul>${a.filter((s) => s.trim()).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '<span class="empty">не заполнено</span>');

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(t.name)} — итог</title><style>
${fonts()}
@page{size:A4;margin:14mm 13mm 14mm 13mm}
*{box-sizing:border-box}
body{font-family:'PT Sans',sans-serif;color:#0b0b0b;font-size:11.5pt;line-height:1.35;margin:0}
h1{font-size:24pt;margin:0 0 2mm}
h2{font-size:15pt;margin:7mm 0 3mm;border-bottom:2px solid #2a78d6;padding-bottom:1mm}
h3{font-size:12.5pt;margin:4mm 0 1.5mm}
.badge{display:inline-block;background:#fff3cd;border:1px solid #e0b100;color:#5c4400;border-radius:4px;padding:1mm 2.5mm;font-size:9.5pt;font-weight:700}
.meta{color:#52514e;font-size:10.5pt}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:3mm;margin:4mm 0}
.tile{border:1px solid #d9d8d3;border-radius:6px;padding:3mm}
.defense ol{margin-bottom:0}
.tile .k{font-size:9.5pt;color:#52514e}.tile .v{font-size:20pt;font-weight:700;line-height:1.1}.tile .s{font-size:9.5pt;color:#52514e}
.neg{color:#b42318}
table{width:100%;border-collapse:collapse;font-size:10pt}
th,td{border-bottom:1px solid #e7e6e2;padding:1.4mm 1.5mm;text-align:left;vertical-align:top}
th{background:#f3f2ef;font-weight:700}
.r{text-align:right;white-space:nowrap}.sc{white-space:nowrap}.off{color:#c3c2b7}
.sub{color:#52514e;font-size:9pt;margin-top:.8mm}
.empty{color:#a3a29c;font-style:italic}
.defense{border:2px solid #2a78d6;border-radius:8px;padding:3mm 4mm;margin-top:3mm;background:#f5f9fe}
.defense ol{margin:1mm 0 2mm 5mm;padding:0}
.matrix{display:grid;grid-template-columns:22mm 1fr 1fr;grid-template-rows:auto 1fr 1fr;gap:2mm}
.matrix .ax{font-size:9.5pt;color:#52514e;display:flex;align-items:center;justify-content:center;text-align:center}
.matrix .q{border:1px solid #d9d8d3;border-radius:6px;padding:2.5mm;font-size:10pt;min-height:40mm}
.matrix .q h4{margin:0 0 1mm;font-size:11.5pt}
.matrix .q .p{font-size:8.5pt;color:#52514e;margin-bottom:1mm}
.joker{border:1px solid #d9d8d3;border-radius:6px;padding:2.5mm 3mm;margin-bottom:2mm;break-inside:avoid}
.page{break-before:page}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:5mm}
ul{margin:1mm 0 1mm 5mm;padding:0}
.foot{margin-top:5mm;font-size:8.5pt;color:#6b6a66}
</style></head><body>
<span class="badge">УЧЕБНЫЕ ДАННЫЕ — город и показатели вымышленные</span>
<h1>${esc(t.name)} · ${esc(city.name)}</h1>
<div class="meta">${esc(city.type)}. Форсайт-сессия «Современные системы целевого управления в РФ».
${t.inputs.members.filter(Boolean).length ? `<br>Участники: ${t.inputs.members.filter(Boolean).map(esc).join(', ')}` : ''}</div>

<div class="tiles">
  <div class="tile"><div class="k">Индекс города</div><div class="v">${num(f.startIndex)} → ${num(f.cityIndex)}</div><div class="s">Δ ${sign(Math.round((f.cityIndex - f.startIndex) * 10) / 10).replace('.', ',')} (среднее шести показателей)</div></div>
  <div class="tile"><div class="k">Сумма показателей</div><div class="v">${sign(f.deltaSum)}</div><div class="s">изменение «было → стало»</div></div>
  <div class="tile"><div class="k">Индекс устойчивости портфеля</div><div class="v">${Math.round(f.resilienceIndex * 100)}%</div><div class="s">${f.resilienceCount} из ${f.itemCount} мер полезны в ≥ 3 из 4 сценариев</div></div>
  <div class="tile"><div class="k">Итоговый резерв</div><div class="v ${f.reserve < 0 ? 'neg' : ''}">${money(f.reserve)} у.е.</div><div class="s">${f.deficit ? `дефицит ${f.deficit} → штраф −${f.penalty}` : f.reserveBonus ? `бонус +${f.reserveBonus} к Адаптивности` : 'без штрафа и бонуса'}</div></div>
</div>

<h3>Шесть показателей: было → стало</h3>
<div style="margin:0 0 2mm">${chart(data, ev)}</div>
<div class="defense">
  <div class="cols">
    <div><b>Три устойчивых решения</b><ol>${t.inputs.defense.solutions.map((s) => `<li>${txt(s)}</li>`).join('')}</ol></div>
    <div><b>Самый значимый джокер и почему</b><div>${txt(t.inputs.defense.joker)}</div>
    <b style="display:block;margin-top:2mm">Главный урок</b><div>${txt(t.inputs.defense.lesson)}</div></div>
  </div>
</div>

<h3>Как сложился итог</h3>
<table><tr><th>Составляющая</th>${INDICATORS.map((k) => `<th class="r">${esc(label(k))}</th>`).join('')}</tr>
<tr><td>Старт (карточка города)</td>${INDICATORS.map((k) => `<td class="r">${f.start[k]}</td>`).join('')}</tr>
<tr><td>Эффекты мер</td>${effectsRow}</tr>
<tr><td>Бонус джокера</td>${INDICATORS.map((k) => `<td class="r">${f.jokerBonus[k] ? sign(f.jokerBonus[k]) : '—'}</td>`).join('')}</tr>
<tr><td>Штраф / бонус резерва / перенос</td>${INDICATORS.map((k) => {
    const spill = k === pi ? 0 : Math.min(data.rules.max, Math.max(data.rules.min, f.raw[k])) - f.final[k];
    const v = (k === pi ? -f.penalty : 0) + (k === data.rules.reserveBonusIndicator ? f.reserveBonus : 0) - spill;
    return `<td class="r">${v ? sign(v) : '—'}</td>`;
  }).join('')}</tr>
<tr><th>Итог (шкала ${data.rules.min}–${data.rules.max})</th>${INDICATORS.map((k) => `<th class="r">${f.final[k]}</th>`).join('')}</tr></table>
<div style="margin-top:2mm">${notes.map((n) => `<div>${n}</div>`).join('')}</div>

<div class="page"></div>
<h2>Сценарная матрица</h2>
<div class="cols" style="margin-bottom:3mm">${ax.map((a, i) => `<div><b>Неопределённость ${i + 1}: ${txt(a.name)}</b><div class="sub">Полюса: ${txt(a.poleA)} ↔ ${txt(a.poleB)}</div><div>Почему критична: ${txt(a.why)}</div></div>`).join('')}</div>
<div class="matrix">
  <div></div><div class="ax"><b>${pole(1, 'poleA')}</b></div><div class="ax"><b>${pole(1, 'poleB')}</b></div>
  ${[0, 1].map((row) => `<div class="ax"><b>${pole(0, row === 0 ? 'poleA' : 'poleB')}</b></div>${[0, 1].map((col) => {
    const i = row * 2 + col;
    const s = t.inputs.scenarios[i];
    const p = scenarioPoles(i);
    return `<div class="q"><div class="p">Сценарий ${i + 1}: ${pole(0, p.a)} × ${pole(1, p.b)}</div><h4>${txt(s.title)}</h4>${txt(s.text)}</div>`;
  }).join('')}`).join('')}
</div>

${g.settings.diagnosticsEnabled ? `<h3>Диагностика</h3><div class="cols">
  <div><b>Тренды</b>${list(diag.trends)}<b>Драйверы</b>${list(diag.drivers)}</div>
  <div><b>Слабые сигналы</b>${list(diag.weakSignals)}<b>Три главные проблемы</b>${list(diag.problems)}</div></div>` : ''}

<div class="page"></div>
<h2>Итоговый портфель мер</h2>
<table><tr><th>Мера</th><th>Режим</th><th class="r">Уплачено, у.е.</th><th>Триггер / обоснование</th><th>Сценарии</th></tr>${portfolioRows || '<tr><td colspan="5" class="empty">мер нет</td></tr>'}</table>
<div class="sub">Сценарии: жирная цифра — команда отметила меру полезной в этом сценарии. Незапущенная условная мера даёт ${Math.round(data.rules.conditionalShare * 100)}% эффекта (округление к нулю).</div>

<h2>Джокеры</h2>
${negJ ? `<div class="joker"><b>${negJ.code} «${esc(negJ.name)}»</b> (негативный). ${esc(negJ.description)}<div>Цена: <b>${esc(ev.neg?.explanation)}</b></div></div>` : ''}
${posJ ? `<div class="joker"><b>${posJ.code} «${esc(posJ.name)}»</b> (${posJ.basket === 'positive' && posJ.code !== 'J0' ? 'положительный' : 'нейтральный'}). ${esc(posJ.description)}
  <div>${ev.pos?.used ? `<b>Использован</b>: ${esc(ev.pos.reason)}; ${esc(ev.pos.gain)}${ev.pos.measure ? ` (мера ${ev.pos.measure})` : ''}` : ev.pos?.available ? '<b>Команда пропустила</b> возможность' : `Возможность не использована: ${esc(ev.pos?.reason)}`}</div></div>` : ''}

<h2>Журнал бюджета</h2>
<table><tr><th>Шаг</th><th>Операция</th><th class="r">Сумма</th><th class="r">Резерв</th></tr>
<tr><td>Старт</td><td>Стартовый бюджет</td><td class="r"></td><td class="r">${city.startBudget}</td></tr>${ledgerRows}</table>

<div class="foot">Учебная модель, а не прогноз. Сформировано ${new Date().toLocaleString('ru-RU')}. Последний шаг команды: ${PHASE_LABELS[t.phase]}.</div>
</body></html>`;
}

export class PdfService {
  private browser: Promise<Browser> | null = null;
  constructor(private dir: string) { mkdirSync(dir, { recursive: true }); }

  private launch(): Promise<Browser> {
    if (!this.browser) {
      this.browser = (async () => {
        const errors: string[] = [];
        for (const opts of [{}, { channel: 'chrome' }, { channel: 'msedge' }] as const) {
          try { return await chromium.launch({ ...opts, headless: true }); } catch (e) { errors.push(String((e as Error).message).split('\n')[0]); }
        }
        this.browser = null;
        throw new Error('Не удалось запустить Chromium для PDF. Выполните `npx playwright install chromium` или установите Google Chrome. ' + errors.join(' | '));
      })();
    }
    return this.browser;
  }

  async render(key: string, html: string): Promise<Buffer> {
    const hash = createHash('sha1').update(html.replace(/Сформировано [^.]*\./, '')).digest('hex').slice(0, 12);
    const file = join(this.dir, `${key}-${hash}.pdf`);
    if (existsSync(file)) return readFileSync(file);
    const browser = await this.launch();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(() => (document as any).fonts.ready);
      const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      writeFileSync(file, pdf);
      return pdf;
    } finally {
      await page.close();
    }
  }
  async close() { if (this.browser) (await this.browser).close(); }
}
