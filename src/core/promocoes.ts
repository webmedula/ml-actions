import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';
import { getItemFull, getItemPromotions, joinPromotion, MlApiError } from '../ml/mlClient';

/**
 * ADERIR A UMA PROMOCAO DO MERCADO LIVRE (v21).
 *
 * Mesmo desenho da recriacao: simular (le tudo de novo no ML, monta o pedido e mostra a conta),
 * e so depois aderir, com token da simulacao + confirmacao "ADERIR" + PROMOCOES_ENABLED=true.
 *
 * Diferente da recriacao, o ML NAO tem rota de "validar sem gravar" para promocoes. Entao a
 * simulacao confere localmente o que da: a promocao ainda esta aberta para o anuncio, o preco
 * esta dentro da faixa que o ML aceita, o estoque da relampago esta dentro do minimo/maximo.
 * O resto so o ML responde na hora de aderir — e a resposta (aceite ou recusa) vai pro historico.
 *
 * Uma promocao pode ser desfeita na tela do ML, entao aderir e reversivel; mesmo assim mexe no
 * preco que o comprador ve, e por isso fica atras das mesmas travas da recriacao.
 */

export class AdesaoBloqueada extends Error {}

/** Tipos que a adesao suporta e o que cada um precisa. */
type Modo = 'oferta_pronta' | 'preco' | 'preco_e_estoque' | 'so_campanha';
const MODO_DO_TIPO: Record<string, Modo> = {
  SMART: 'oferta_pronta',
  PRICE_MATCHING: 'oferta_pronta',
  PRICE_MATCHING_MELI_ALL: 'oferta_pronta',
  SMART_LIGHTNING: 'oferta_pronta',
  UNHEALTHY_STOCK: 'oferta_pronta',
  DEAL: 'preco',
  DOD: 'preco',
  LIGHTNING: 'preco_e_estoque',
  MARKETPLACE_CAMPAIGN: 'so_campanha',
};

export const ROTULO: Record<string, string> = {
  DEAL: 'Campanha do ML',
  MARKETPLACE_CAMPAIGN: 'Campanha co-participada (ML banca parte)',
  SMART: 'Co-participacao automatica (ML banca parte)',
  SMART_LIGHTNING: 'Oferta relampago co-participada (ML banca parte)',
  PRICE_MATCHING: 'Preco competitivo (ML banca parte)',
  PRICE_MATCHING_MELI_ALL: 'Preco competitivo (ML banca tudo)',
  LIGHTNING: 'Oferta relampago',
  DOD: 'Oferta do dia',
  UNHEALTHY_STOCK: 'Estoque parado no Full',
  PRICE_DISCOUNT: 'Desconto proprio',
  SELLER_CAMPAIGN: 'Campanha propria',
};

const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pos = (...vs: unknown[]): number | null => {
  for (const v of vs) {
    const n = num(v);
    if (n != null && n > 0) return n;
  }
  return null;
};
const r2 = (v: number) => Math.round(v * 100) / 100;

export interface PromocaoDoAnuncio {
  promocaoId: string | null;
  tipo: string;
  rotulo: string;
  nome: string | null;
  status: string;
  ofertaId: string | null;
  precoOferta: number | null;
  precoSugerido: number | null;
  precoMinimo: number | null;
  precoMaximo: number | null;
  precoOriginal: number | null;
  mlPercentual: number | null;
  estoqueMinimo: number | null;
  estoqueMaximo: number | null;
  inicio: string | null;
  fim: string | null;
  /** o sistema sabe aderir a este tipo? */
  suportada: boolean;
  /** a promocao ainda aceita adesao? (candidata, ou oferta pronta do ML ainda nao aceita) */
  aberta: boolean;
}

export function lerPromocao(raw: any): PromocaoDoAnuncio {
  const tipo = String(raw?.type || '').toUpperCase();
  const status = String(raw?.status || '').toLowerCase();
  const modo = MODO_DO_TIPO[tipo];
  return {
    promocaoId: raw?.id ? String(raw.id) : null,
    tipo,
    rotulo: ROTULO[tipo] ?? tipo,
    nome: raw?.name || null,
    status,
    ofertaId: raw?.offer_id ?? raw?.ref_id ?? null,
    precoOferta: pos(raw?.price),
    precoSugerido: pos(raw?.suggested_discounted_price),
    precoMinimo: pos(raw?.min_discounted_price),
    precoMaximo: pos(raw?.max_discounted_price),
    precoOriginal: pos(raw?.original_price),
    mlPercentual: pos(raw?.meli_percentage),
    estoqueMinimo: num(raw?.stock?.min),
    estoqueMaximo: num(raw?.stock?.max),
    inicio: raw?.start_date ?? null,
    fim: raw?.finish_date ?? raw?.end_date ?? null,
    suportada: !!modo,
    // "pending" = aprovada e programada (a tela do ML mostra PROGRAMADA): ja aderiu, nao e aberta.
    aberta: status === 'candidate' || (modo === 'oferta_pronta' && status === 'started'),
  };
}

export interface PedidoDeAdesao {
  corpo: Record<string, unknown>;
  precoFinal: number | null;
}

/**
 * Monta o corpo do POST /seller-promotions/items/{id}. Funcao PURA.
 * - oferta pronta do ML (SMART, PRICE_MATCHING...): aceita a oferta que o ML ja calculou (offer_id).
 * - campanha/oferta do dia: precisa de um preco dentro da faixa.
 * - relampago: preco e quantidade reservada para a oferta.
 */
export function montarPedido(p: PromocaoDoAnuncio, escolha: { preco?: number | null; estoque?: number | null }): PedidoDeAdesao {
  const modo = MODO_DO_TIPO[p.tipo];
  if (!modo) throw new AdesaoBloqueada(`O sistema ainda nao sabe aderir a "${p.rotulo}". Use a tela de promocoes do ML.`);
  if (!p.aberta) throw new AdesaoBloqueada(`Esta promocao nao esta aberta para adesao (status "${p.status}"). Talvez voce ja participe.`);

  const base: Record<string, unknown> = { promotion_type: p.tipo };
  if (p.promocaoId) base.promotion_id = p.promocaoId;

  if (modo === 'oferta_pronta') {
    if (!p.ofertaId) throw new AdesaoBloqueada('O ML nao informou o id da oferta (ref_id/offer_id) para aceitar.');
    return { corpo: { ...base, offer_id: p.ofertaId }, precoFinal: p.precoOferta };
  }
  if (modo === 'so_campanha') return { corpo: base, precoFinal: p.precoOferta ?? p.precoSugerido };

  const preco = num(escolha.preco) ?? p.precoSugerido ?? p.precoMaximo;
  if (preco == null || preco <= 0) throw new AdesaoBloqueada('Informe o preco da oferta.');
  if (p.precoMinimo != null && preco < p.precoMinimo) throw new AdesaoBloqueada(`O ML aceita no minimo R$ ${p.precoMinimo.toFixed(2)} nesta promocao.`);
  if (p.precoMaximo != null && preco > p.precoMaximo) throw new AdesaoBloqueada(`O ML aceita no maximo R$ ${p.precoMaximo.toFixed(2)} nesta promocao.`);
  const corpo: Record<string, unknown> = { ...base, deal_price: r2(preco) };

  if (modo === 'preco_e_estoque') {
    const estoque = num(escolha.estoque) ?? p.estoqueMinimo;
    if (estoque == null || estoque <= 0) throw new AdesaoBloqueada('Informe quantas unidades reservar para a relampago.');
    if (p.estoqueMinimo != null && estoque < p.estoqueMinimo) throw new AdesaoBloqueada(`A relampago exige ao menos ${p.estoqueMinimo} unidade(s).`);
    if (p.estoqueMaximo != null && estoque > p.estoqueMaximo) throw new AdesaoBloqueada(`A relampago aceita no maximo ${p.estoqueMaximo} unidade(s).`);
    corpo.stock = Math.trunc(estoque);
  }
  return { corpo, precoFinal: r2(preco) };
}

// ------------------------------------------------------------------ simulacao e adesao

export interface SimulacaoAdesao {
  token: string;
  itemId: string;
  titulo: string | null;
  precoCheio: number | null;
  promocao: PromocaoDoAnuncio;
  corpo: Record<string, unknown>;
  precoFinal: number | null;
  descontoPercentual: number | null;
  mlBanca: number | null;
  avisos: string[];
  simuladoEm: string;
  escritaHabilitada: boolean;
}

const TTL_MS = 30 * 60 * 1000;
const simulacoes = new Map<string, SimulacaoAdesao>();

function limparExpiradas(): void {
  const agora = Date.now();
  for (const [t, s] of simulacoes) if (agora - Date.parse(s.simuladoEm) > TTL_MS) simulacoes.delete(t);
}

export async function listarPromocoes(itemId: string): Promise<PromocaoDoAnuncio[]> {
  return (await getItemPromotions(itemId)).map(lerPromocao);
}

/** Escolhe a promocao pedida na lista fresca do ML: pelo id, ou pelo tipo quando nao ha id. */
export function acharPromocao(lista: PromocaoDoAnuncio[], promocaoId?: string | null, tipo?: string | null): PromocaoDoAnuncio | null {
  if (promocaoId) return lista.find((p) => p.promocaoId === promocaoId) ?? null;
  const t = String(tipo || '').toUpperCase();
  const doTipo = lista.filter((p) => p.tipo === t);
  return doTipo.length === 1 ? doTipo[0] : null;
}

export async function simularAdesao(
  itemId: string,
  pedido: { promocaoId?: string | null; tipo?: string | null; preco?: number | null; estoque?: number | null },
): Promise<SimulacaoAdesao> {
  const id = String(itemId || '').trim().toUpperCase();
  if (!/^[A-Z]{3}\d+$/.test(id)) throw new AdesaoBloqueada('Informe um MLB valido.');
  const [item, lista] = await Promise.all([getItemFull(id), listarPromocoes(id)]);
  const promo = acharPromocao(lista, pedido.promocaoId, pedido.tipo);
  if (!promo) throw new AdesaoBloqueada('Essa promocao nao aparece mais para este anuncio no ML (pode ter encerrado).');

  const { corpo, precoFinal } = montarPedido(promo, pedido);
  const precoCheio = num(item?.price);
  const avisos: string[] = [];
  if (item?.status !== 'active') avisos.push(`O anuncio esta "${item?.status}", nao ativo.`);
  if (promo.tipo === 'LIGHTNING' || promo.tipo === 'SMART_LIGHTNING') avisos.push('Relampago tem poucas horas e estoque reservado: confira o estoque antes.');
  const outras = lista.filter((p) => p !== promo && (p.status === 'started' || p.status === 'pending') && !p.aberta);
  if (outras.length) avisos.push(`O anuncio ja esta em: ${outras.map((o) => o.nome || o.rotulo).join(', ')}. O ML aplica o menor preco entre elas.`);

  limparExpiradas();
  const sim: SimulacaoAdesao = {
    token: crypto.randomBytes(12).toString('hex'),
    itemId: id,
    titulo: item?.title ?? null,
    precoCheio,
    promocao: promo,
    corpo,
    precoFinal,
    descontoPercentual: precoCheio && precoFinal ? r2((1 - precoFinal / precoCheio) * 100) : null,
    mlBanca: promo.mlPercentual && (promo.precoOriginal ?? precoCheio) ? r2(((promo.precoOriginal ?? precoCheio)! * promo.mlPercentual) / 100) : null,
    avisos,
    simuladoEm: new Date().toISOString(),
    escritaHabilitada: config.promocoesEnabled,
  };
  simulacoes.set(sim.token, sim);
  logger.info(`[PROMOCAO] Simulacao ${sim.token}: ${id} ${promo.tipo} ${promo.promocaoId ?? ''} ${JSON.stringify(corpo)}`);
  return sim;
}

export interface RegistroAdesao {
  quando: string;
  itemId: string;
  titulo: string | null;
  tipo: string;
  promocaoId: string | null;
  nome: string | null;
  corpo: Record<string, unknown>;
  precoFinal: number | null;
  status: 'sucesso' | 'erro';
  respostaMl: unknown;
  erro: string | null;
}

export function lerHistoricoAdesoes(): RegistroAdesao[] {
  try {
    return fs.existsSync(config.promocoesHistoricoPath) ? JSON.parse(fs.readFileSync(config.promocoesHistoricoPath, 'utf-8')) : [];
  } catch {
    return [];
  }
}

function gravar(r: RegistroAdesao): void {
  const lista = [r, ...lerHistoricoAdesoes()].slice(0, 500);
  fs.mkdirSync(path.dirname(config.promocoesHistoricoPath), { recursive: true });
  const tmp = config.promocoesHistoricoPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(lista, null, 2), 'utf-8');
  fs.renameSync(tmp, config.promocoesHistoricoPath);
}

export async function aderir(token: string): Promise<RegistroAdesao> {
  if (!config.promocoesEnabled) throw new AdesaoBloqueada('Adesao desligada. Ligue PROMOCOES_ENABLED=true no servico para aderir.');
  limparExpiradas();
  const sim = simulacoes.get(token);
  if (!sim) throw new AdesaoBloqueada('Simulacao expirada ou inexistente. Simule de novo.');
  simulacoes.delete(token); // um token, uma adesao: clique duplo nao vira dois POST

  const base = { quando: new Date().toISOString(), itemId: sim.itemId, titulo: sim.titulo, tipo: sim.promocao.tipo, promocaoId: sim.promocao.promocaoId, nome: sim.promocao.nome, corpo: sim.corpo, precoFinal: sim.precoFinal };
  try {
    const resposta = await joinPromotion(sim.itemId, sim.corpo);
    const r: RegistroAdesao = { ...base, status: 'sucesso', respostaMl: resposta, erro: null };
    gravar(r);
    logger.info(`[PROMOCAO] Aderiu ${sim.itemId} a ${sim.promocao.tipo} ${sim.promocao.promocaoId ?? ''}.`);
    return r;
  } catch (err: any) {
    const r: RegistroAdesao = {
      ...base,
      status: 'erro',
      respostaMl: err instanceof MlApiError ? err.corpo : null,
      erro: err instanceof MlApiError ? `${err.status}: ${err.message}${err.causas.length ? ' — ' + err.causas.join('; ') : ''}` : String(err?.message || err),
    };
    gravar(r);
    logger.warn(`[PROMOCAO] ML recusou a adesao de ${sim.itemId}: ${r.erro}`);
    return r;
  }
}
