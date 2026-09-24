import { config } from '../config';
import { logger } from '../logger';
import { ensureValidMlToken } from './mlOauthClient';

/**
 * Cliente do Mercado Livre deste servico. Diferente do cliente do ml-analytics, este SABE ESCREVER:
 * cria anuncio, grava descricao e altera estoque/status. E o unico lugar do projeto que faz isso.
 */

export class MlApiError extends Error {
  status: number;
  /** Lista `cause` que o ML devolve em erros de validacao de anuncio ("falta o atributo X"). */
  causas: string[];
  /** Corpo cru da resposta de erro. Guardado porque o ML as vezes so diz "body.invalid_fields"
   * na mensagem e o detalhe util esta em outro lugar do JSON. */
  corpo: unknown;
  /** As mesmas causas, com o `type` que o ML manda (error/warning). */
  causasTipadas: CausaMl[];
  constructor(status: number, message: string, causas: string[] = [], corpo?: unknown, causasTipadas: CausaMl[] = []) {
    super(message);
    this.name = 'MlApiError';
    this.status = status;
    this.causas = causas;
    this.corpo = corpo;
    this.causasTipadas = causasTipadas;
  }
}

/**
 * O ML devolve `cause` ora como array de strings, ora como objetos {code, message}, e as vezes
 * aninhado em `cause[].causes`. Junta code E message quando os dois existem: so o code
 * ("body.invalid_fields") nao diz qual campo esta errado, e so a message as vezes vem vazia.
 */
/**
 * O ML NAO e consistente sobre qual campo carrega o texto legivel. Ja veio assim:
 *   { message: "body.invalid_fields", error: "The fields [title] are invalid for requested call." }
 * ou seja, `message` com o codigo e `error` com a frase. Em outras respostas e o contrario.
 * Regra: quem tem espaco e a frase; o outro e o codigo. Junta os dois quando existirem.
 */
export function mensagemDeErro(data: any, status: number): string {
  const campos = [data?.message, data?.error].filter((c: any) => typeof c === 'string' && c.trim());
  const frase = campos.find((c: string) => /\s/.test(c.trim()));
  const codigo = campos.find((c: string) => c !== frase);
  if (frase && codigo) return `${codigo}: ${frase}`;
  return frase || codigo || `Erro HTTP ${status}`;
}

/**
 * Uma causa de erro/aviso do ML, com o `type` preservado.
 *
 * Ate a v14 o `type` era descartado, e isso custou caro: o `/items/validate` responde 400
 * `validation_error` mesmo quando TODAS as causas sao `warning` (confirmado em 2026-09-24 no
 * MLB7418169626: 8 causas, todas warning, e 400). Sem o tipo, aviso e recusa eram indistinguiveis.
 */
export interface CausaMl {
  /** 'desconhecido' quando o ML nao manda `type` — tratado como erro, por seguranca. */
  tipo: 'error' | 'warning' | 'desconhecido';
  codigo: string | null;
  mensagem: string | null;
  /** "codigo: mensagem" — o formato que o painel sempre mostrou. */
  texto: string;
}

export function extrairCausasTipadas(data: any): CausaMl[] {
  const out: CausaMl[] = [];

  const visitar = (c: any): void => {
    if (!c) return;
    if (typeof c === 'string') {
      out.push({ tipo: 'desconhecido', codigo: null, mensagem: c, texto: c });
      return;
    }
    if (Array.isArray(c)) {
      c.forEach(visitar);
      return;
    }
    const codigo = typeof c.code === 'string' && c.code.trim() ? c.code : null;
    const mensagem = typeof c.message === 'string' && c.message.trim() ? c.message : null;
    const texto = Array.from(new Set([codigo, mensagem].filter(Boolean))).join(': ');
    if (texto) {
      const t = typeof c.type === 'string' ? c.type.toLowerCase() : '';
      const tipo = t === 'error' ? 'error' : t === 'warning' ? 'warning' : 'desconhecido';
      out.push({ tipo, codigo, mensagem, texto });
    }
    if (c.causes) visitar(c.causes);
    if (c.cause) visitar(c.cause);
  };

  visitar(data?.cause);
  visitar(data?.causes);
  return out;
}

function extrairCausas(data: any): string[] {
  return extrairCausasTipadas(data).map((c) => c.texto);
}

export interface ResultadoValidacao {
  /** Pode seguir para a sondagem: nenhuma causa e erro. */
  ok: boolean;
  /**
   * O ML respondeu 400 mas SO com avisos. `ok` e true, mas a evidencia e mais fraca que um 2xx —
   * por isso a execucao passa a exigir sondagem antes (salvaguarda 7 do README).
   */
  soAvisos: boolean;
  /** Causas que bloqueiam (type error, ou sem type). */
  erros: string[];
  /** Causas type warning: informam, nao bloqueiam. */
  avisos: string[];
  causas: CausaMl[];
  status?: number;
  bruto?: unknown;
}

/**
 * Decide se uma resposta do `/items/validate` bloqueia.
 *
 * Regra de aceite de um 400 e RESTRITA de proposito: so vale quando o ML diz `validation_error`,
 * manda ao menos uma causa, e TODAS sao `warning`. Qualquer outro 400, causa sem `type`, ou 400
 * sem causas continua sendo recusa.
 */
export function interpretarValidacao(status: number, data: any): ResultadoValidacao {
  if (status >= 200 && status < 300) {
    return { ok: true, soAvisos: false, erros: [], avisos: [], causas: [], status };
  }
  const causas = extrairCausasTipadas(data);
  const avisos = causas.filter((c) => c.tipo === 'warning').map((c) => c.texto);
  const bloqueantes = causas.filter((c) => c.tipo !== 'warning').map((c) => c.texto);
  const soAvisos = status === 400 && data?.error === 'validation_error' && causas.length > 0 && bloqueantes.length === 0;
  if (soAvisos) {
    return { ok: true, soAvisos: true, erros: [], avisos, causas, status, bruto: data };
  }
  const erros = bloqueantes.length ? bloqueantes : [mensagemDeErro(data, status)];
  return { ok: false, soAvisos: false, erros, avisos, causas, status, bruto: data };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const REQUEST_TIMEOUT_MS = 20000;
const MAX_429_RETRIES = 2;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new MlApiError(504, `Chamada a API do Mercado Livre excedeu ${REQUEST_TIMEOUT_MS / 1000}s sem resposta`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

interface MlRequestOpts {
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
}

async function mlRequest<T>(path: string, opts: MlRequestOpts = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  let retried401 = false;
  let rateLimitRetries = 0;

  for (;;) {
    const token = await ensureValidMlToken();

    const res = await fetchWithTimeout(`${config.mlApiBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });

    if (res.status === 401 && !retried401) {
      retried401 = true;
      logger.warn('[ML API] 401 recebido, tentando renovar token e repetir a chamada...');
      continue;
    }

    // Retry de 429 SO em leitura. Num POST, o 429 pode ter chegado depois do ML ja ter criado o
    // recurso — repetir criaria um anuncio duplicado. Melhor falhar e deixar o operador reavaliar.
    if (res.status === 429 && method === 'GET' && rateLimitRetries < MAX_429_RETRIES) {
      rateLimitRetries++;
      await sleep(1500 * rateLimitRetries);
      continue;
    }

    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;

    if (!res.ok) {
      throw new MlApiError(res.status, mensagemDeErro(data, res.status), extrairCausas(data), data, extrairCausasTipadas(data));
    }

    return data as T;
  }
}

// --- leitura ---

export async function getMlUserId(): Promise<number> {
  const me = await mlRequest<{ id: number }>('/users/me');
  return me.id;
}

/** Item COMPLETO: precisamos de atributos, fotos, frete, variacoes pra montar o clone. */
export async function getItemFull(itemId: string): Promise<any> {
  return mlRequest<any>(`/items/${itemId}`);
}

/** Descricao em texto plano. Alguns anuncios nao tem: devolve null em vez de estourar. */
export async function getItemDescription(itemId: string): Promise<string | null> {
  try {
    const d = await mlRequest<{ plain_text?: string; text?: string }>(`/items/${itemId}/description`);
    return d?.plain_text ?? d?.text ?? null;
  } catch (err: any) {
    if (err instanceof MlApiError && err.status === 404) return null;
    throw err;
  }
}

export interface MlRating {
  ratingAverage: number | null;
  total: number | null;
  /** Qual rota respondeu — ajuda a diagnosticar permissao do app. */
  rota: string;
  /** Produto do usuario (MLBU...) sob o qual o ML agrupa as opinioes deste anuncio. */
  userProductId: string | null;
  /** Chave de agrupamento lida do review: MLBU... = so suas; MLB... = catalogo compartilhado. */
  chaveDoPool: string | null;
}

export function parseRatingPayload(r: any): { ratingAverage: number | null; total: number | null } | null {
  if (!r || typeof r !== 'object') return null;
  const avg = r.rating_average ?? r.paging?.rating_average ?? null;
  const total = r.paging?.total ?? r.total ?? (Array.isArray(r.reviews) ? r.reviews.length : null);
  if (avg == null && total == null) return null;
  return { ratingAverage: avg != null ? Number(avg) : null, total: total != null ? Number(total) : null };
}

/** Nota/total de opinioes. O ML restringiu esse recurso; tenta as rotas conhecidas e devolve null. */
export async function getRating(id: string): Promise<MlRating | null> {
  for (const rota of [`/reviews/item/${id}`, `/reviews/search?item_id=${id}`]) {
    try {
      const bruto = await mlRequest<any>(rota);
      const parsed = parseRatingPayload(bruto);
      if (parsed) {
        const primeiro = Array.isArray(bruto?.reviews) && bruto.reviews.length ? bruto.reviews[0] : null;
        return { ...parsed, rota, userProductId: bruto?.user_product_id ?? null, chaveDoPool: primeiro?.secondary_key ?? null };
      }
    } catch {
      // tenta a proxima rota
    }
  }
  return null;
}

// --- ESCRITA (tudo abaixo altera dados reais da conta) ---

/** Valida um payload de anuncio SEM criar nada. E a rede de seguranca da simulacao. */
export async function validateItemPayload(payload: unknown): Promise<ResultadoValidacao> {
  try {
    await mlRequest<any>('/items/validate', { method: 'POST', body: payload });
    return interpretarValidacao(204, undefined);
  } catch (err: any) {
    if (err instanceof MlApiError) {
      // Sempre devolve o corpo cru junto: quando o ML responde so "body.invalid_fields", e o unico
      // lugar onde da pra descobrir qual campo ele recusou.
      return interpretarValidacao(err.status, err.corpo ?? { message: err.message });
    }
    return { ok: false, soAvisos: false, erros: [String(err?.message || err)], avisos: [], causas: [] };
  }
}

export async function createItem(payload: unknown): Promise<any> {
  return mlRequest<any>('/items', { method: 'POST', body: payload });
}

export async function createItemDescription(itemId: string, plainText: string): Promise<any> {
  return mlRequest<any>(`/items/${itemId}/description`, { method: 'POST', body: { plain_text: plainText } });
}

export async function updateItem(itemId: string, patch: Record<string, unknown>): Promise<any> {
  return mlRequest<any>(`/items/${itemId}`, { method: 'PUT', body: patch });
}

/**
 * Descobre em qual PRODUTO DO USUARIO (MLBU...) o ML agrupou um anuncio.
 *
 * E o numero que decide se recriar zera a nota: se o anuncio novo receber um MLBU diferente do
 * antigo, a nota comeca do zero; se o ML reagrupar os dois no mesmo MLBU, a nota vem junto.
 *
 * Tenta duas fontes porque nenhuma e garantida:
 *   1. o proprio item (`user_product_id`), que existe mesmo sem nenhuma opiniao;
 *   2. a resposta de opinioes, que traz `user_product_id` na raiz.
 * Devolve null quando nenhuma das duas informa — nesse caso NAO da pra decidir, e quem chama
 * precisa tratar isso como "indeterminado" em vez de assumir que deu certo.
 */
export async function getUserProductId(itemId: string, itemJaLido?: any): Promise<{ userProductId: string | null; fonte: string }> {
  const item = itemJaLido ?? (await getItemFull(itemId).catch(() => null));
  const doItem = item?.user_product_id ?? null;
  if (doItem) return { userProductId: String(doItem), fonte: 'item.user_product_id' };

  const rating = await getRating(itemId).catch(() => null);
  if (rating?.userProductId) return { userProductId: rating.userProductId, fonte: `reviews (${rating.rota})` };

  return { userProductId: null, fonte: 'nao informado por nenhuma rota' };
}

/** Fecha um anuncio (status closed). Usado pra descartar a sondagem e pra encerrar o antigo. */
export async function closeItem(itemId: string): Promise<any> {
  return updateItem(itemId, { status: 'closed' });
}

/** Marca um anuncio fechado como deletado. So funciona depois de fechado. */
export async function deleteItem(itemId: string): Promise<any> {
  return updateItem(itemId, { deleted: true });
}
