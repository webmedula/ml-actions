import { config } from '../config';
import { logger } from '../logger';

/**
 * A lista de candidatos vem do ml-analytics, que ja varre as notas e classifica cada anuncio.
 * Este servico NAO repete a varredura: consome o resultado por HTTP.
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
}

export interface ListaCandidatos {
  disponivel: boolean;
  motivo?: string;
  atualizadoEm?: string;
  items: Candidato[];
}

/** So estas classificacoes fazem sentido recriar. As demais o analytics ja descartou. */
const ACIONAVEIS = new Set(['recriavel', 'indefinido']);

export async function buscarCandidatos(): Promise<ListaCandidatos> {
  if (!config.analyticsBaseUrl) {
    return { disponivel: false, motivo: 'ANALYTICS_BASE_URL nao configurado — informe o MLB manualmente.', items: [] };
  }

  const url = `${config.analyticsBaseUrl}/api/ratings`;
  try {
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
      return { disponivel: false, motivo: `O ml-analytics respondeu ${res.status}: ${corpo?.mensagem || 'sem detalhe'}`, items: [] };
    }

    const dados: any = await res.json();
    const items: Candidato[] = (dados?.items || [])
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

    return { disponivel: true, atualizadoEm: dados?.updatedAt, items };
  } catch (err: any) {
    logger.warn('[CANDIDATOS] Nao consegui falar com o ml-analytics:', err?.message || err);
    return { disponivel: false, motivo: `Nao consegui falar com o ml-analytics (${url}). Informe o MLB manualmente.`, items: [] };
  }
}
