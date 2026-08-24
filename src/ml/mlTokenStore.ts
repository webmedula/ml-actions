import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

export interface StoredMlToken {
  accessToken: string;
  refreshToken: string;
  /** epoch ms em que o access token expira */
  accessExpiresAt: number;
  /** id do usuario/vendedor no Mercado Livre (retornado no token) */
  userId?: number;
  obtainedAt: number;
}

let cached: StoredMlToken | null = null;
let cachedMtimeMs = 0;

function ensureDir(): void {
  const dir = path.dirname(config.mlTokenStorePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Le o token do disco; o cache em memoria e invalidado quando o arquivo muda (mtime). */
export function loadMlToken(): StoredMlToken | null {
  try {
    if (!fs.existsSync(config.mlTokenStorePath)) {
      cached = null;
      cachedMtimeMs = 0;
      return null;
    }
    const mtime = fs.statSync(config.mlTokenStorePath).mtimeMs;
    if (cached && mtime === cachedMtimeMs) return cached;
    const raw = fs.readFileSync(config.mlTokenStorePath, 'utf-8');
    cached = JSON.parse(raw) as StoredMlToken;
    cachedMtimeMs = mtime;
    return cached;
  } catch {
    return cached;
  }
}

export function saveMlToken(token: StoredMlToken): void {
  ensureDir();
  cached = token;
  const tmp = config.mlTokenStorePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(token, null, 2), 'utf-8');
  fs.renameSync(tmp, config.mlTokenStorePath);
  try {
    cachedMtimeMs = fs.statSync(config.mlTokenStorePath).mtimeMs;
  } catch {
    cachedMtimeMs = 0;
  }
}

export function clearMlToken(): void {
  cached = null;
  cachedMtimeMs = 0;
  try {
    if (fs.existsSync(config.mlTokenStorePath)) fs.unlinkSync(config.mlTokenStorePath);
  } catch {
    // ignore
  }
}
