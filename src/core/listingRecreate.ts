import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';
import {
  closeItem,
  createItem,
  createItemDescription,
  deleteItem,
  getItemDescription,
  getItemFull,
  getRating,
  getUserProductId,
  updateItem,
  validateItemPayload,
} from '../ml/mlClient';

/**
 * RECRIACAO MANUAL DE ANUNCIO — fases 2 e 3.
 *
 * O operador escolhe UM anuncio e manda recriar. Nada aqui roda por varredura automatica.
 *
 * Sao dois passos separados de proposito:
 *   1. simular()  — le o anuncio, monta o clone, manda o ML VALIDAR o payload. Nao escreve nada.
 *   2. executar() — cria o anuncio novo, transfere o estoque e fecha o antigo. Escreve de verdade.
 *
 * `executar` so aceita um anuncio que passou por `simular` na mesma sessao (guarda o payload em
 * memoria com um token) e so roda se RECREATE_ENABLED estiver ligado. Isso existe pra que um
 * clique errado no painel nao vire um anuncio perdido.
 */

// --- 1. Montagem do clone (funcao PURA — e o que os testes cobrem) ---

/** Campos que sao identidade/historico do anuncio velho e NAO podem ir pro novo. */
const CAMPOS_PROIBIDOS = new Set([
  'id', 'site_id', 'seller_id', 'permalink', 'thumbnail', 'secure_thumbnail',
  'date_created', 'last_updated', 'start_time', 'stop_time', 'expiration_time',
  'sold_quantity', 'initial_quantity', 'base_price', 'original_price',
  'health', 'status', 'sub_status', 'catalog_listing', 'catalog_product_id',
  'parent_item_id', 'differential_pricing', 'seller_contact', 'location',
  'geolocation', 'international_delivery_mode', 'automatic_relist', 'visits',
  'listing_source', 'coverage_areas', 'descriptions', 'deal_ids', 'tags',
]);

export interface OpcoesClone {
  /** Sufixo opcional no titulo. Vazio = titulo identico ao original. */
  sufixoTitulo?: string;
  /** Quantidade com que o anuncio novo nasce. Comeca em 1 e so vira o estoque real na virada. */
  quantidadeInicial?: number;
}

export interface ResultadoClone {
  payload: Record<string, any>;
  /** Avisos que o operador precisa ler ANTES de executar (coisas que o clone nao leva junto). */
  avisos: string[];
}

/**
 * Monta o corpo do POST /items a partir do item completo lido do ML.
 *
 * Regras:
 * - copia titulo, categoria, preco, moeda, condicao, tipo de anuncio, frete, garantia, atributos;
 * - reaproveita as fotos por `id` (evita re-upload e mantem a mesma qualidade);
 * - NUNCA copia id/permalink/vendas/status nem o vinculo de catalogo;
 * - nasce com estoque 1 e pausado — quem libera e a etapa de virada.
 */
export function montarClone(item: any, opts: OpcoesClone = {}): ResultadoClone {
  const avisos: string[] = [];

  const payload: Record<string, any> = {};
  for (const [chave, valor] of Object.entries(item || {})) {
    if (CAMPOS_PROIBIDOS.has(chave)) continue;
    if (valor === null || valor === undefined) continue;
    payload[chave] = valor;
  }

  const sufixo = (opts.sufixoTitulo || '').trim();
  if (sufixo) {
    const novo = `${item.title} ${sufixo}`.trim();
    // O ML corta titulo em 60 caracteres: melhor avisar do que deixar o ML truncar sozinho.
    if (novo.length > 60) {
      avisos.push(`Titulo com sufixo ficaria com ${novo.length} caracteres (limite 60). Sufixo ignorado.`);
      payload.title = item.title;
    } else {
      payload.title = novo;
    }
  } else {
    payload.title = item.title;
  }

  // Fotos por id: o ML reaproveita a imagem ja hospedada.
  const fotos = Array.isArray(item.pictures) ? item.pictures : [];
  if (fotos.length > 0) {
    payload.pictures = fotos.map((p: any) => (p?.id ? { id: p.id } : { source: p?.url || p?.secure_url })).filter(Boolean);
  } else {
    avisos.push('O anuncio original nao tem fotos legiveis pela API — o anuncio novo nasceria sem imagem.');
  }

  // Estoque: nasce minimo. A virada e que passa o estoque real.
  payload.available_quantity = opts.quantidadeInicial ?? 1;
  payload.status = 'paused';

  // Variacoes carregam estoque proprio e ids do anuncio velho: limpa os ids e zera o estoque.
  if (Array.isArray(item.variations) && item.variations.length > 0) {
    payload.variations = item.variations.map((v: any) => {
      const { id, catalog_product_id, sold_quantity, ...resto } = v || {};
      return { ...resto, available_quantity: 1 };
    });
    avisos.push(
      `O anuncio tem ${item.variations.length} variacao(oes). O estoque de cada uma comeca em 1 e precisa ser ajustado depois da virada.`,
    );
  }

  if (item.catalog_listing === true) {
    avisos.push('ATENCAO: este e um anuncio de CATALOGO. A opiniao mora no produto compartilhado — recriar NAO vai zerar a nota.');
  }

  if (Number(item.sold_quantity || 0) > 0) {
    avisos.push(`O anuncio original tem ${item.sold_quantity} venda(s). Esse historico e o posicionamento dele NAO vao para o anuncio novo.`);
  }

  if (Array.isArray(item.tags) && item.tags.includes('catalog_listing_eligible')) {
    avisos.push('O anuncio e elegivel a catalogo: o ML pode sincronizar o anuncio novo a um produto de catalogo e trazer a nota de volta.');
  }

  return { payload, avisos };
}

/** Quantas avaliacoes 5 estrelas seriam necessarias pra subir a nota atual ate o limite.
 * x >= N * (limite - nota) / (5 - limite). Devolve null quando ja esta acima do limite. */
export function avaliacoesParaRecuperar(nota: number | null, total: number | null, limite: number): number | null {
  if (nota == null || total == null || total <= 0) return null;
  if (nota >= limite) return null;
  if (limite >= 5) return null;
  return Math.ceil((total * (limite - nota)) / (5 - limite));
}

// --- 2. Simulacao (nao escreve nada) ---

export interface Simulacao {
  token: string;
  itemId: string;
  titulo: string;
  criadoEm?: string;
  vendas: number;
  estoqueAtual: number;
  nota: number | null;
  totalAvaliacoes: number | null;
  /** Quantas notas 5 seriam necessarias pra recuperar sem recriar. */
  avaliacoesParaRecuperar: number | null;
  catalogListing: boolean;
  catalogProductId: string | null;
  payload: Record<string, any>;
  avisos: string[];
  /** Resultado do POST /items/validate no ML. */
  validacao: { ok: boolean; erros: string[] };
  /** Produto do usuario do anuncio ORIGINAL — a sondagem compara o do clone com este. */
  userProductIdOriginal: string | null;
  simuladoEm: string;
  /** Preenchido pela sondagem: o clone pausado ja criado, esperando decisao. */
  sondagem?: Sondagem;
}

export type VeredictoSondagem = 'zera' | 'nao_zera' | 'indeterminado';

export interface Sondagem {
  /** O anuncio criado pela sondagem: pausado, estoque 1, sem descricao ainda. */
  itemNovo: string;
  userProductIdOriginal: string | null;
  userProductIdNovo: string | null;
  fonte: string;
  veredicto: VeredictoSondagem;
  explicacao: string;
  sondadoEm: string;
}

/** Compara os dois produtos do usuario e diz o que isso significa. Funcao PURA. */
export function interpretarSondagem(original: string | null, novo: string | null): { veredicto: VeredictoSondagem; explicacao: string } {
  if (!novo || !original) {
    return {
      veredicto: 'indeterminado',
      explicacao:
        'O Mercado Livre nao informou o produto do usuario de um dos anuncios, entao nao da pra saber se a nota ' +
        'seria zerada. O seguro e descartar o anuncio de teste e nao seguir com a virada.',
    };
  }
  if (novo === original) {
    return {
      veredicto: 'nao_zera',
      explicacao:
        `O anuncio novo caiu no MESMO produto do usuario (${novo}). As opinioes sao agrupadas por ele, entao a ` +
        'nota viria junto. Recriar aqui so custaria o historico de vendas — descarte o anuncio de teste.',
    };
  }
  return {
    veredicto: 'zera',
    explicacao:
      `O anuncio novo recebeu um produto do usuario diferente (${novo} em vez de ${original}). As opinioes do ` +
      'anuncio antigo nao acompanham. Recriar zera a nota.',
  };
}

/** Simulacoes pendentes de execucao, por token. Expira em 30 min. */
const simulacoes = new Map<string, Simulacao>();
const SIMULACAO_TTL_MS = 30 * 60 * 1000;

function limparExpiradas(): void {
  const agora = Date.now();
  for (const [token, s] of simulacoes) {
    if (agora - new Date(s.simuladoEm).getTime() > SIMULACAO_TTL_MS) simulacoes.delete(token);
  }
}

function novoToken(itemId: string): string {
  return `${itemId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function simularRecriacao(itemId: string, opts: OpcoesClone = {}): Promise<Simulacao> {
  limparExpiradas();

  const item = await getItemFull(itemId);
  const { payload, avisos } = montarClone(item, opts);
  const validacao = await validateItemPayload(payload);
  const rating = await getRating(itemId).catch(() => null);
  const { userProductId: userProductIdOriginal } = await getUserProductId(itemId, item);

  const sim: Simulacao = {
    token: novoToken(itemId),
    itemId,
    titulo: item.title,
    criadoEm: item.date_created,
    vendas: Number(item.sold_quantity || 0),
    estoqueAtual: Number(item.available_quantity || 0),
    nota: rating?.ratingAverage ?? null,
    totalAvaliacoes: rating?.total ?? null,
    avaliacoesParaRecuperar: avaliacoesParaRecuperar(
      rating?.ratingAverage ?? null,
      rating?.total ?? null,
      config.ratingsMinScore,
    ),
    catalogListing: item.catalog_listing === true,
    catalogProductId: item.catalog_product_id ?? null,
    payload,
    avisos,
    validacao,
    userProductIdOriginal,
    simuladoEm: new Date().toISOString(),
  };

  simulacoes.set(sim.token, sim);
  logger.info(`[RECRIAR] Simulacao ${sim.token} para ${itemId}: validacao ${validacao.ok ? 'OK' : 'FALHOU'}.`);
  return sim;
}

export function getSimulacao(token: string): Simulacao | null {
  limparExpiradas();
  return simulacoes.get(token) ?? null;
}

// --- 3. Execucao (escreve de verdade) ---

export interface RegistroRecriacao {
  token: string;
  itemAntigo: string;
  itemNovo: string | null;
  titulo: string;
  notaAntiga: number | null;
  vendasPerdidas: number;
  estoqueTransferido: number;
  executadoEm: string;
  status: 'sucesso' | 'falha' | 'parcial';
  etapaQueFalhou?: string;
  erro?: string;
  /** Snapshot do anuncio antigo — sem isso nao ha rollback. */
  snapshot: Record<string, any>;
  /** A sondagem que autorizou esta execucao, quando houve uma. */
  sondagem?: Sondagem;
}

function historicoPath(): string {
  return config.recreationsPath;
}

export function lerHistorico(): RegistroRecriacao[] {
  try {
    if (!fs.existsSync(historicoPath())) return [];
    return JSON.parse(fs.readFileSync(historicoPath(), 'utf-8'));
  } catch {
    return [];
  }
}

function gravarHistorico(registro: RegistroRecriacao): void {
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
  const todos = lerHistorico();
  todos.unshift(registro);
  const tmp = historicoPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(todos.slice(0, 500), null, 2), 'utf-8');
  fs.renameSync(tmp, historicoPath());
}

export class RecriacaoBloqueada extends Error {}

/**
 * SONDAGEM — descobre, sem risco, se recriar zeraria mesmo a nota.
 *
 * Cria o clone PAUSADO com estoque 1 e le o produto do usuario que o ML atribuiu a ele. Se for
 * diferente do original, recriar zera; se for o mesmo, a nota viria junto e nao adianta.
 *
 * O anuncio de teste fica pausado e sem estoque ate voce decidir. Nenhuma venda passa por ele, e
 * o anuncio original nao e tocado. Se o veredicto for ruim, `descartarSondagem` fecha e apaga o
 * teste — e voce nao perdeu nada.
 *
 * Quando o veredicto e bom, `executarRecriacao` REAPROVEITA este mesmo anuncio em vez de criar
 * outro: sondar e depois executar nao gera dois anuncios.
 */
export async function sondarRecriacao(token: string): Promise<Sondagem> {
  if (!config.recreateEnabled) {
    throw new RecriacaoBloqueada(
      'Escrita desligada neste servico. A sondagem cria um anuncio pausado de teste, entao precisa de RECREATE_ENABLED=true.',
    );
  }

  const sim = getSimulacao(token);
  if (!sim) {
    throw new RecriacaoBloqueada('Simulacao nao encontrada ou expirada (validade de 30 min). Simule de novo.');
  }
  if (!sim.validacao.ok) {
    throw new RecriacaoBloqueada(`A simulacao nao passou na validacao do ML: ${sim.validacao.erros.join('; ')}`);
  }
  if (sim.sondagem) return sim.sondagem; // ja sondado: nao cria um segundo anuncio de teste

  const novo = await createItem(sim.payload);
  const novoId: string | undefined = novo?.id;
  if (!novoId) throw new Error('O ML nao devolveu o id do anuncio de teste.');
  logger.info(`[SONDAGEM] Anuncio de teste ${novoId} criado (pausado) a partir de ${sim.itemId}.`);

  const { userProductId: userProductIdNovo, fonte } = await getUserProductId(novoId, novo);
  const { veredicto, explicacao } = interpretarSondagem(sim.userProductIdOriginal, userProductIdNovo);

  const sondagem: Sondagem = {
    itemNovo: novoId,
    userProductIdOriginal: sim.userProductIdOriginal,
    userProductIdNovo,
    fonte,
    veredicto,
    explicacao,
    sondadoEm: new Date().toISOString(),
  };

  sim.sondagem = sondagem;
  simulacoes.set(token, sim);
  logger.info(`[SONDAGEM] ${sim.itemId}: original=${sim.userProductIdOriginal} novo=${userProductIdNovo} -> ${veredicto}`);
  return sondagem;
}

/** Fecha e apaga o anuncio de teste. O anuncio original nunca foi tocado, entao nao ha o que reverter. */
export async function descartarSondagem(token: string): Promise<{ descartado: string; apagado: boolean }> {
  const sim = getSimulacao(token);
  if (!sim?.sondagem) throw new RecriacaoBloqueada('Nao ha sondagem pendente para este token.');

  const id = sim.sondagem.itemNovo;
  await closeItem(id);
  let apagado = false;
  try {
    await deleteItem(id);
    apagado = true;
  } catch (err: any) {
    // Fechado ja basta: nao aparece pra ninguem. O delete e so limpeza.
    logger.warn(`[SONDAGEM] ${id} fechado, mas nao consegui marcar como deletado:`, err?.message || err);
  }

  delete sim.sondagem;
  simulacoes.set(token, sim);
  logger.info(`[SONDAGEM] Anuncio de teste ${id} descartado (apagado: ${apagado}).`);
  return { descartado: id, apagado };
}

/**
 * Executa a recriacao de um anuncio ja simulado.
 *
 * Sequencia (a ordem evita ficar sem estoque e evita dois anuncios iguais ativos ao mesmo tempo):
 *   1. cria o anuncio novo pausado, com estoque 1
 *   2. copia a descricao
 *   3. libera o novo com o estoque real
 *   4. zera e fecha o antigo
 *
 * Se qualquer etapa depois da criacao falhar, o registro fica como 'parcial' e o operador precisa
 * agir a mao — o codigo NAO tenta desfazer sozinho, porque um rollback automatico errado no meio
 * da virada e pior que um estado conhecido e registrado.
 */
export async function executarRecriacao(token: string): Promise<RegistroRecriacao> {
  if (!config.recreateEnabled) {
    throw new RecriacaoBloqueada(
      'Escrita desligada neste servico. Defina RECREATE_ENABLED=true para habilitar as acoes no Mercado Livre.',
    );
  }

  const sim = getSimulacao(token);
  if (!sim) {
    throw new RecriacaoBloqueada('Simulacao nao encontrada ou expirada (validade de 30 min). Simule de novo antes de executar.');
  }
  if (!sim.validacao.ok) {
    throw new RecriacaoBloqueada(`A simulacao nao passou na validacao do ML: ${sim.validacao.erros.join('; ')}`);
  }
  // Se a sondagem ja provou que a nota nao zera, executar seria so jogar fora o historico.
  if (sim.sondagem && sim.sondagem.veredicto !== 'zera') {
    throw new RecriacaoBloqueada(
      `A sondagem concluiu "${sim.sondagem.veredicto}": ${sim.sondagem.explicacao} ` +
      'Descarte o anuncio de teste em vez de executar.',
    );
  }

  const snapshot = await getItemFull(sim.itemId);
  const descricao = await getItemDescription(sim.itemId);
  const estoqueReal = Number(snapshot.available_quantity || 0);

  const registro: RegistroRecriacao = {
    token,
    itemAntigo: sim.itemId,
    itemNovo: null,
    titulo: sim.titulo,
    notaAntiga: sim.nota,
    vendasPerdidas: sim.vendas,
    estoqueTransferido: estoqueReal,
    executadoEm: new Date().toISOString(),
    status: 'falha',
    snapshot,
  };

  let etapa = 'criar anuncio novo';
  try {
    if (sim.sondagem) {
      // A sondagem ja criou o anuncio (pausado, estoque 1) e confirmou que a nota zera.
      // Reaproveita: sondar e depois executar NAO pode gerar dois anuncios.
      registro.itemNovo = sim.sondagem.itemNovo;
      registro.sondagem = sim.sondagem;
      logger.info(`[RECRIAR] Reaproveitando o anuncio ${registro.itemNovo} criado pela sondagem.`);
    } else {
      const novo = await createItem(sim.payload);
      registro.itemNovo = novo?.id ?? null;
      if (!registro.itemNovo) throw new Error('O ML nao devolveu o id do anuncio criado.');
      logger.info(`[RECRIAR] Anuncio novo ${registro.itemNovo} criado a partir de ${sim.itemId}.`);
    }

    // A partir daqui existe um anuncio novo no ar: qualquer falha vira 'parcial', nao 'falha'.
    registro.status = 'parcial';

    etapa = 'copiar descricao';
    if (descricao) await createItemDescription(registro.itemNovo, descricao);

    etapa = 'liberar o anuncio novo com o estoque real';
    await updateItem(registro.itemNovo, { available_quantity: Math.max(1, estoqueReal), status: 'active' });

    etapa = 'fechar o anuncio antigo';
    await updateItem(sim.itemId, { available_quantity: 0, status: 'paused' });
    await updateItem(sim.itemId, { status: 'closed' });

    registro.status = 'sucesso';
    logger.info(`[RECRIAR] ${sim.itemId} -> ${registro.itemNovo} concluido.`);
  } catch (err: any) {
    registro.etapaQueFalhou = etapa;
    registro.erro = String(err?.message || err);
    logger.error(`[RECRIAR] Falha em "${etapa}" (${sim.itemId}):`, registro.erro);
  } finally {
    simulacoes.delete(token);
    gravarHistorico(registro);
  }

  return registro;
}
