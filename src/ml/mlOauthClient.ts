import crypto from 'node:crypto';
import { config } from '../config';
import { logger } from '../logger';
import { clearMlToken, loadMlToken, saveMlToken, StoredMlToken } from './mlTokenStore';

export class MlNotAuthenticatedError extends Error {
  constructor() {
    super('Aplicativo ainda nao autorizado no Mercado Livre. Acesse /oauth/ml/login para conectar.');
    this.name = 'MlNotAuthenticatedError';
  }
}

const pendingStates = new Set<string>();

export function buildMlAuthorizationUrl(): string {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.add(state);
  setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000).unref();

  const url = new URL(config.mlAuthUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.mlClientId);
  url.searchParams.set('redirect_uri', config.mlRedirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

export function isValidMlState(state: string | undefined): boolean {
  if (!state) return false;
  const ok = pendingStates.has(state);
  if (ok) pendingStates.delete(state);
  return ok;
}

function persistFromTokenResponse(data: any): StoredMlToken {
  const now = Date.now();
  const expiresInSec = Number(data.expires_in ?? 6 * 60 * 60);

  const token: StoredMlToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessExpiresAt: now + expiresInSec * 1000,
    userId: data.user_id,
    obtainedAt: now,
  };
  saveMlToken(token);
  return token;
}

export async function exchangeMlCodeForToken(code: string): Promise<StoredMlToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.mlClientId,
    client_secret: config.mlClientSecret,
    redirect_uri: config.mlRedirectUri,
    code,
  });

  const res = await fetch(config.mlTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Falha ao trocar codigo por token do Mercado Livre: ${res.status} ${JSON.stringify(data)}`);
  }
  logger.info(`[ML OAUTH] Novo token obtido via authorization_code (userId=${data.user_id})`);
  return persistFromTokenResponse(data);
}

/** Margem: considera "ainda valido" um token que so expira daqui a mais de 2 min. */
const REFRESH_SKIP_MARGIN_MS = 2 * 60 * 1000;

async function doRefresh(): Promise<StoredMlToken> {
  const current = loadMlToken();
  if (!current) throw new MlNotAuthenticatedError();

  // Se o token vigente (relido do disco) ainda esta valido, nao renova.
  if (Date.now() < current.accessExpiresAt - REFRESH_SKIP_MARGIN_MS) {
    return current;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.mlClientId,
    client_secret: config.mlClientSecret,
    refresh_token: current.refreshToken,
  });

  const res = await fetch(config.mlTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fresh = loadMlToken();
    if (fresh && fresh.refreshToken !== current.refreshToken && Date.now() < fresh.accessExpiresAt - REFRESH_SKIP_MARGIN_MS) {
      logger.warn('[ML OAUTH] Refresh falhou, mas ja havia token novo no disco — usando-o.');
      return fresh;
    }
    logger.error('[ML OAUTH] Falha ao renovar token (refresh token pode ter sido revogado):', res.status, data);
    clearMlToken();
    throw new MlNotAuthenticatedError();
  }
  logger.info('[ML OAUTH] Token renovado com sucesso');
  return persistFromTokenResponse(data);
}

let refreshPromise: Promise<StoredMlToken> | null = null;

export function refreshMlAccessToken(): Promise<StoredMlToken> {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function ensureValidMlToken(): Promise<string> {
  const current = loadMlToken();
  if (!current) throw new MlNotAuthenticatedError();

  const marginMs = 60 * 1000;
  if (Date.now() >= current.accessExpiresAt - marginMs) {
    const renewed = await refreshMlAccessToken();
    return renewed.accessToken;
  }
  return current.accessToken;
}

export function getMlAuthStatus(): { authenticated: boolean; accessExpiresAt?: number; userId?: number } {
  const current = loadMlToken();
  if (!current) return { authenticated: false };
  return { authenticated: true, accessExpiresAt: current.accessExpiresAt, userId: current.userId };
}
