import { config } from '../config';
import { logger } from '../logger';

/**
 * A lista de candidatos vem do ml-analytics, que ja varre as notas, classifica cada anuncio E
 * apura quanto ele fatura. Este servico NAO repete nada disso: consome o resultado por HTTP.
 *
 * Se ANALYTICS_BASE_URL nao estiver configurado (ou o analytics estiver fora do ar), o painel
 * continua funcionando — o operador digita o MLB na mao. A dependencia e conveniencia, nao requisito.
 */

export interface Candidato {
  itemId: string;
  title?: string;
  permalink?: string;
  nota: number | null;
  totalAvaliacoes: number | null;
  classificacao: string;
  evidencia: string;
  vendidos?: number;
  disponivel?: number;

  // --- vindos da fila (/api/fila). Ausentes quando o analytics ainda e antigo. ---
  /** Liquido de 30 dias do anuncio: o que a recriacao poe em risco. */
  liquidoEmRisco?: number | null;
  margem?: number | null;
  /** Quantas notas 5 devolveriam a media ao limite SEM recriar. */
  avaliacoesParaRecuperar?: number | null;
  acao?: string | null;
  porque?: string | null;
}

export interface ListaCandidatos {
  disponivel: boolean;
  motivo?: string;
  atualizadoEm?: string;
  /** 'fila' (com dinheiro e recomendacao) ou 'ratings' (formato antigo, so o veredicto tecnico). */
  fonte?: 'fila' | 'ratings';
  items: Candidato[];
}

/** So estas classificacoes fazem sentido recriar. As demais o analytics ja descartou. */
const ACIONAVEIS = new Set(['recriavel', 'indefinido', 'depende_do_user_product']);

/**
 * Acoes que pedem alguma providencia. `nao_recriar` fica de fora: recriar ali nao zera nada, e
 * oferecer o botao seria convidar a destruir historico a troco de nada.
 */
const ACOES_QUE_ENTRAM = new Set(['recriar', 'recriar_com_cautela', 'sondar']);

/** Converte a fila do analytics em candidatos. Pura, pra poder testar sem rede. */
export function candidatosDaFila(itens: any[]): Candidato[] {
  return (itens || [])
    .filter((i: any) => !i.acao || ACOES_QUE_ENTRAM.has(i.acao))
    .map((i: any) => ({
      itemId: i.itemId,
      title: i.titulo,
      permalink: i.permalink,
      nota: i.nota ?? null,
      totalAvaliacoes: i.totalAvaliacoes ?? null,
      classificacao: i.classificacao,
      evidencia: i.evidencia,
      disponivel: i.estoque ?? undefined,
      vendidos: i.unidades ?? undefined,
      liquidoEmRisco: i.liquidoEmRisco ?? null,
      margem: i.margem ?? null,
      avaliacoesParaRecuperar: i.avaliacoesParaRecuperar ?? null,
      acao: i.acao ?? null,
      porque: i.porque ?? null,
    }));
}

/** Formato antigo (/api/ratings), sem dinheiro. Mantido pra sobreviver a analytics desatualizado. */
export function candidatosDeRatings(items: any[]): Candidato[] {
  return (items || [])
    .filter((i: any) => ACIONAVEIS.has(i.classificacao))
    .map((i: any) => ({
      itemId: i.itemId,
      title: i.title,
      permalink: i.permalink,
      nota: i.nota ?? null,
      totalAvaliacoes: i.totalAvaliacoes ?? null,
      classificacao: i.classificacao,
      evidencia: i.evidencia,
      vendidos: i.vendidos,
      disponivel: i.disponivel,
    }));
}

async function buscar(url: string): Promise<{ ok: true; dados: any } | { ok: false; motivo: string }> {
  const headers: Record<string, string> = {};
  if (config.analyticsApiKey) headers['x-api-key'] = config.analyticsApiKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const corpo: any = await res.json().catch(() => ({}));
    return { ok: false, motivo: `${res.status}: ${corpo?.mensagem || 'sem detalhe'}` };
  }
  return { ok: true, dados: await res.json() };
}

export async function buscarCandidatos(): Promise<ListaCandidatos> {
  if (!config.analyticsBaseUrl) {
    return { disponivel: false, motivo: 'ANALYTICS_BASE_URL nao configurado — informe o MLB manualmente.', items: [] };
  }

  try {
    // Preferimos /api/fila: ela ja traz o dinheiro e a recomendacao, e vem ORDENADA por onde vale
    // trabalhar. Cair pra /api/ratings quando ela nao existe permite que os dois servicos sejam
    // atualizados em momentos diferentes — que e como eles sao publicados na pratica.
    const fila = await buscar(`${config.analyticsBaseUrl}/api/fila`);

    if (fila.ok) {
      const items = candidatosDaFila(fila.dados?.itens);

      return { disponivel: true, atualizadoEm: fila.dados?.atualizadoEm, fonte: 'fila', items };
    }

    logger.info(`[CANDIDATOS] /api/fila indisponivel (${fila.motivo}); usando /api/ratings.`);
    const ratings = await buscar(`${config.analyticsBaseUrl}/api/ratings`);
    if (!ratings.ok) {
      return { disponivel: false, motivo: `O ml-analytics respondeu ${ratings.motivo}`, items: [] };
    }

    const items = candidatosDeRatings(ratings.dados?.items);

    return { disponivel: true, atualizadoEm: ratings.dados?.updatedAt, fonte: 'ratings', items };
  } catch (err: any) {
    logger.warn('[CANDIDATOS] Nao consegui falar com o ml-analytics:', err?.message || err);
    return {
      disponivel: false,
      motivo: `Nao consegui falar com o ml-analytics (${config.analyticsBaseUrl}). Informe o MLB manualmente.`,
      items: [],
    };
  }
}
