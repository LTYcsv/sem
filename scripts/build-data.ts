// xlsx → data/game_data.json.
// Запуск: npm run data [-- путь/к/файлу.xlsx]
// По умолчанию берётся «Копия foresight_game_data.xlsx» с рабочего стола (или из XLSX_PATH).
// Колонки и строки ищутся по заголовкам, поэтому добавление строк/колонок в таблицу не ломает скрипт.
import ExcelJS from 'exceljs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { City, CostRule, GameData, IndicatorKey, Joker, Measure, ModelRules, PositiveRule, Vector } from '../engine/src/types.ts';
import { INDICATORS } from '../engine/src/types.ts';
import { validateData } from '../engine/src/validate.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const xlsxPath =
  process.argv[2] ?? process.env.XLSX_PATH ?? join(homedir(), 'Desktop', 'Копия foresight_game_data.xlsx');
if (!existsSync(xlsxPath)) {
  console.error(`Не найден файл ${xlsxPath}. Укажите путь: npm run data -- путь.xlsx`);
  process.exit(1);
}

const INDICATOR_LABELS: Record<string, IndicatorKey> = {
  'экономика': 'econ',
  'социальная устойчивость': 'social',
  'инфраструктура': 'infra',
  'экология': 'eco',
  'человеческий капитал': 'human',
  'адаптивность': 'adapt',
};

const warnings: string[] = [];
const unconfirmed: GameData['meta']['unconfirmed'] = [];
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

function raw(cell: ExcelJS.Cell): unknown {
  const v = cell.value as any;
  if (v && typeof v === 'object') {
    if ('result' in v) return v.result;
    if ('richText' in v) return v.richText.map((r: any) => r.text).join('');
    if ('text' in v) return v.text;
  }
  return v;
}
const text = (cell: ExcelJS.Cell) => String(raw(cell) ?? '').trim();
const isYellow = (cell: ExcelJS.Cell) => {
  const f = cell.fill as any;
  const argb: string = f?.fgColor?.argb ?? '';
  return f?.pattern === 'solid' && /^FF(FFF2CC|FFFF00|FFEB9C|FFE699|FFFFCC|FFF4CC)$/i.test(argb);
};
function num(cell: ExcelJS.Cell, what: string): number {
  const v = raw(cell);
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').replace('−', '-'));
  if (!Number.isFinite(n)) throw new Error(`${what}: ожидалось число в ${cell.address}, получено «${v}»`);
  return n;
}
/** Отображаемое значение с учётом формата ячейки (проценты). */
function display(cell: ExcelJS.Cell): string {
  const v = raw(cell);
  if (typeof v !== 'number') return String(v ?? '').trim();
  const fmt = cell.numFmt ?? '';
  if (fmt.includes('%')) {
    const dec = /0\.(0+)%/.exec(fmt)?.[1].length ?? 0;
    const s = (v * 100).toFixed(dec).replace('.', ',');
    const signed = fmt.startsWith('+') && v > 0 ? '+' + s : s.replace('-', '−');
    return signed + '%';
  }
  return String(v).replace('.', ',');
}
function markYellow(ws: ExcelJS.Worksheet, cell: ExcelJS.Cell, what: string) {
  if (isYellow(cell)) unconfirmed.push({ sheet: ws.name, cell: cell.address, text: what });
}
function sheet(wb: ExcelJS.Workbook, name: string) {
  const ws = wb.worksheets.find((w) => norm(w.name) === norm(name));
  if (!ws) throw new Error(`В xlsx нет листа «${name}»`);
  return ws;
}
/** Строка с заголовками: первая строка, где есть все нужные заголовки. */
function header(ws: ExcelJS.Worksheet, needed: string[]): { row: number; col: (h: string) => number } {
  for (let r = 1; r <= Math.min(ws.rowCount, 20); r++) {
    const map = new Map<string, number>();
    ws.getRow(r).eachCell((c, col) => map.set(norm(raw(c)), col));
    if (needed.every((h) => [...map.keys()].some((k) => k.startsWith(norm(h))))) {
      return {
        row: r,
        col: (h: string) => {
          const k = [...map.keys()].find((k) => k.startsWith(norm(h)));
          if (!k) throw new Error(`Лист «${ws.name}»: нет колонки «${h}»`);
          return map.get(k)!;
        },
      };
    }
  }
  throw new Error(`Лист «${ws.name}»: не найдена строка заголовков (${needed.join(', ')})`);
}
const cityKey = (s: string) => norm(s.replace(/^\d+\.\s*/, ''));

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(xlsxPath);

// ---------- Города ----------
const wsC = sheet(wb, 'Города');
const hC = header(wsC, ['Показатель']);
const cityCols: { col: number; name: string }[] = [];
wsC.getRow(hC.row).eachCell((c, col) => {
  if (col > hC.col('Показатель') && text(c)) cityCols.push({ col, name: text(c).replace(/^\d+\.\s*/, '') });
});
const rowsByLabel = new Map<string, number>();
for (let r = hC.row + 1; r <= wsC.rowCount; r++) {
  const l = norm(text(wsC.getCell(r, hC.col('Показатель'))));
  if (l) rowsByLabel.set(l, r);
}
const rowOf = (label: string) => {
  const r = rowsByLabel.get(norm(label));
  if (!r) throw new Error(`Лист «Города»: нет строки «${label}»`);
  return r;
};
const GENERAL = ['Население, тыс. чел.', 'Динамика населения за 5 лет', 'Доля населения 65+', 'Безработица', 'Ключевая специализация'];
const indicatorLabels = new Map<IndicatorKey, string>();
for (const [l, r] of rowsByLabel) {
  const k = INDICATOR_LABELS[l];
  if (k) indicatorLabels.set(k, text(wsC.getCell(r, hC.col('Показатель'))));
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const cities: City[] = cityCols.map(({ col, name }, i) => {
  const start = {} as Vector;
  for (const k of INDICATORS) {
    const label = indicatorLabels.get(k);
    if (!label) throw new Error(`Лист «Города»: нет строки показателя ${k}`);
    const cell = wsC.getCell(rowOf(label), col);
    start[k] = num(cell, `${name} / ${label}`);
    markYellow(wsC, cell, `${name}: ${label}`);
  }
  const general = GENERAL.filter((g) => rowsByLabel.has(norm(g))).map((g) => {
    const cell = wsC.getCell(rowOf(g), col);
    markYellow(wsC, cell, `${name}: ${g}`);
    return { label: g, value: display(cell) };
  });
  return {
    id: `c${i + 1}`,
    name: titleCase(name),
    type: text(wsC.getCell(rowOf('Тип города'), col)),
    general,
    startBudget: num(wsC.getCell(rowOf('Стартовый бюджет, у.е.'), col), `${name} бюджет`),
    start,
    unique: [],
    situation: '',
    signals: [],
    vulnerabilities: [],
  };
});
const cityByName = (s: string) => {
  const c = cities.find((c) => cityKey(c.name) === cityKey(s));
  if (!c) throw new Error(`Неизвестный город «${s}»`);
  return c;
};

// ---------- Уникальные показатели ----------
const wsU = sheet(wb, 'Уникальные показатели');
const hU = header(wsU, ['Город', 'Показатель', 'Значение']);
for (let r = hU.row + 1; r <= wsU.rowCount; r++) {
  const cn = text(wsU.getCell(r, hU.col('Город')));
  if (!cn) continue;
  const valueCell = wsU.getCell(r, hU.col('Значение'));
  const label = text(wsU.getCell(r, hU.col('Показатель')));
  markYellow(wsU, valueCell, `${cn}: ${label}`);
  const note = text(wsU.getCell(r, hU.col('Пояснение')));
  cityByName(cn).unique.push({ label, value: display(valueCell), ...(note ? { note } : {}) });
}

// ---------- Описания и сигналы ----------
const wsD = sheet(wb, 'Описания и сигналы');
const hD = header(wsD, ['Город', 'Раздел', 'Текст']);
for (let r = hD.row + 1; r <= wsD.rowCount; r++) {
  const cn = text(wsD.getCell(r, hD.col('Город')));
  if (!cn) continue;
  const city = cityByName(cn);
  const section = norm(text(wsD.getCell(r, hD.col('Раздел'))));
  const t = text(wsD.getCell(r, hD.col('Текст')));
  const visible = norm(text(wsD.getCell(r, hD.col('Видно')))) !== 'нет';
  if (section.startsWith('уязвимост') || !visible) {
    city.vulnerabilities.push(t);
    markYellow(wsD, wsD.getCell(r, hD.col('Текст')), `${cn}: уязвимость «${t}»`);
  } else if (section.startsWith('ситуац')) city.situation = t;
  else if (section.startsWith('сигнал')) city.signals.push(t);
  else warnings.push(`«Описания и сигналы», строка ${r}: неизвестный раздел «${section}» пропущен`);
}

// ---------- Меры ----------
const wsM = sheet(wb, 'Меры');
const hM = header(wsM, ['Код', 'Мера', 'Полная цена', 'Сейчас', 'Позже']);
const measures: Measure[] = [];
for (let r = hM.row + 1; r <= wsM.rowCount; r++) {
  const code = text(wsM.getCell(r, hM.col('Код')));
  if (!/^M\d+$/i.test(code)) continue;
  const effects = {} as Vector;
  for (const k of INDICATORS) {
    const cell = wsM.getCell(r, hM.col(indicatorLabels.get(k)!));
    effects[k] = raw(cell) == null || raw(cell) === '' ? 0 : num(cell, `${code} эффект ${k}`);
    markYellow(wsM, cell, `${code}: эффект «${indicatorLabels.get(k)}»`);
  }
  measures.push({
    code: code.toUpperCase(),
    name: text(wsM.getCell(r, hM.col('Мера'))),
    full: num(wsM.getCell(r, hM.col('Полная цена')), code),
    now: num(wsM.getCell(r, hM.col('Сейчас')), code),
    later: num(wsM.getCell(r, hM.col('Позже')), code),
    conditionalAllowed: norm(text(wsM.getCell(r, hM.col('Можно условной')))) === 'да',
    triggerExample: text(wsM.getCell(r, hM.col('Пример триггера'))).replace(/^—$/, ''),
    description: text(wsM.getCell(r, hM.col('Эффект (описание)'))),
    effects,
  });
}

// ---------- Джокеры ----------
const jokerRules = JSON.parse(readFileSync(join(root, 'data', 'joker_rules.json'), 'utf8'));
const wsJ = sheet(wb, 'Джокеры');
const hJ = header(wsJ, ['Код', 'Корзина', 'Название']);
const jokers: Joker[] = [];
const numbersIn = (s: string) => new Set((s.match(/\d+/g) ?? []).map(Number));
function ruleNumbers(o: unknown, out: number[] = []): number[] {
  if (Array.isArray(o)) o.forEach((x) => ruleNumbers(x, out));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'number') out.push(Math.abs(v));
    else if (k !== 'eligible' && k !== 'all' && k !== 'any' && k !== 'none') ruleNumbers(v, out);
  }
  return out;
}
for (let r = hJ.row + 1; r <= wsJ.rowCount; r++) {
  const code = text(wsJ.getCell(r, hJ.col('Код')));
  if (!/^J/.test(code)) continue;
  const basketText = norm(text(wsJ.getCell(r, hJ.col('Корзина'))));
  const name = text(wsJ.getCell(r, hJ.col('Название')));
  const description = text(wsJ.getCell(r, hJ.col('Описание')));
  const ruleText = text(wsJ.getCell(r, hJ.col('Как подготовка')));
  const allText = `${description} ${ruleText}`;
  const nums = numbersIn(allText);
  const check = (rule: unknown) => {
    for (const n of ruleNumbers(rule)) if (n !== 0 && !nums.has(n))
      warnings.push(`${code}: число ${n} из data/joker_rules.json не встречается в тексте xlsx — проверьте правило`);
  };
  if (basketText.startsWith('негатив')) {
    const rule = jokerRules.negative[code];
    if (!rule) throw new Error(`Нет формального правила для ${code} в data/joker_rules.json`);
    check(rule);
    const baseCost = num(wsJ.getCell(r, hJ.col('Базовая стоимость')), `${code} стоимость`);
    jokers.push({ code, basket: 'negative', name, description, ruleText, baseCost, rules: rule.rules as CostRule[] });
  } else {
    const rule = jokerRules.positive[code] as PositiveRule | undefined;
    if (!rule) throw new Error(`Нет формального правила для ${code} в data/joker_rules.json`);
    check(rule);
    const indCell = wsJ.getCell(r, hJ.col('Показатель бонуса'));
    const valCell = wsJ.getCell(r, hJ.col('Бонус, баллов'));
    markYellow(wsJ, indCell, `${code}: показатель бонуса`);
    markYellow(wsJ, valCell, `${code}: размер бонуса`);
    const ind = INDICATOR_LABELS[norm(text(indCell))];
    const val = typeof raw(valCell) === 'number' ? (raw(valCell) as number) : 0;
    jokers.push({ code, basket: 'positive', name, description, ruleText, bonus: ind && val ? { indicator: ind, value: val } : null, rule });
  }
}
for (const basket of ['negative', 'positive'] as const)
  for (const code of Object.keys(jokerRules[basket]))
    if (!jokers.some((j) => j.code === code)) warnings.push(`data/joker_rules.json: ${code} нет в xlsx — правило не используется`);

// ---------- Правила модели ----------
const wsR = sheet(wb, 'Правила модели');
const params = new Map<string, ExcelJS.Cell>();
for (let r = 1; r <= wsR.rowCount; r++) {
  const k = norm(text(wsR.getCell(r, 1)));
  if (k) params.set(k, wsR.getCell(r, 2));
}
const param = (label: string) => {
  const key = [...params.keys()].find((k) => k.startsWith(norm(label)));
  if (!key) throw new Error(`Лист «Правила модели»: нет параметра «${label}»`);
  return params.get(key)!;
};
const indParam = (label: string) => {
  const k = INDICATOR_LABELS[norm(text(param(label)))];
  if (!k) throw new Error(`«${label}»: неизвестный показатель «${text(param(label))}»`);
  return k;
};
// Показатель для бонуса за резерв указан в комментарии («Начисляется к Адаптивности»).
const bonusComment = norm(wsR.getCell(param('Бонус за остаток резерва').row, 3).value);
const bonusInd = Object.entries(INDICATOR_LABELS).find(([l]) => bonusComment.includes(l.slice(0, 6)))?.[1] ?? 'adapt';
const rules: ModelRules = {
  startBudget: num(param('Стартовый бюджет'), 'Стартовый бюджет'),
  conditionalShare: num(param('Доля эффекта подготовленной условной меры'), 'Доля эффекта'),
  penaltyStep: num(param('Шаг штрафа за дефицит'), 'Шаг штрафа'),
  penaltyIndicator: indParam('Показатель, из которого списывается штраф'),
  reserveBonusStep: num(param('Бонус за остаток резерва'), 'Бонус за резерв'),
  reserveBonusMax: num(param('Максимум бонуса за резерв'), 'Максимум бонуса'),
  reserveBonusIndicator: bonusInd,
  min: num(param('Минимальное значение показателя'), 'Минимум'),
  max: num(param('Максимальное значение показателя'), 'Максимум'),
};

const data: GameData = {
  meta: { source: xlsxPath.split('/').pop()!, generatedAt: new Date().toISOString(), unconfirmed, warnings },
  indicators: INDICATORS.map((key) => ({ key, label: indicatorLabels.get(key)! })),
  rules,
  cities,
  measures,
  jokers,
};
const errors = validateData(data);
if (errors.length) {
  console.error('ОШИБКИ В ДАННЫХ:\n- ' + errors.join('\n- '));
  process.exit(1);
}
writeFileSync(join(root, 'data', 'game_data.json'), JSON.stringify(data, null, 2) + '\n');
console.log(`data/game_data.json: городов ${cities.length}, мер ${measures.length}, джокеров ${jokers.length} ` +
  `(негативных ${jokers.filter((j) => j.basket === 'negative').length}), неподтверждённых ячеек ${unconfirmed.length}`);
for (const w of warnings) console.warn('ПРЕДУПРЕЖДЕНИЕ: ' + w);
