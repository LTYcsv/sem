import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// .env в корне проекта (KEY=VALUE, # комментарии). Переменные окружения имеют приоритет.
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  adminLogin: process.env.ADMIN_LOGIN ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  dbPath: process.env.DB_PATH ?? join(ROOT, 'data', 'game.sqlite'),
  dataPath: process.env.GAME_DATA ?? join(ROOT, 'data', 'game_data.json'),
  webDist: join(ROOT, 'web', 'dist'),
  pdfDir: join(ROOT, 'out', 'pdf'),
};

/** IPv4-адреса в локальной сети (Wi-Fi/Ethernet), без внутренних и link-local. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.') && !/^(utun|bridge|vmnet|docker|veth)/.test(name)) out.push(a.address);
    }
  }
  return out;
}
