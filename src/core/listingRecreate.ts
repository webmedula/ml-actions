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

/**
 * Campos que o POST /items aceita. LISTA DE INCLUSAO, de proposito.
 *
 * A primeira versao usava lista de EXCLUSAO (copia tudo menos alguns proibidos) e o ML rejeitou o
 * clone com "body.invalid_fields". A resposta de GET /items traz dezenas de campos derivados e
 * somente-leitura — domain_id, internal_tags, seller_address, accepts_mercadopago, shipping.methods
 * — e lista de exclusao sempre deixa passar o que nao foi previsto. Aqui e o contrario: nada entra
 * no payload sem estar nesta lista.
 */
const CAMPOS_ACEITOS = [
  'title', 'category_id', 'price', 'currency_id', 'buying_mode', 'listing_type_id',
  'condition', 'warranty', 'video_id', 'seller_custom_field', 'official_store_id',
  'channels', 'sale_terms', 'shipping', 'attributes', 'variations', 'pictures',
  'family_name',
] as const;

/**
 * De `shipping`, so o que e configuravel. methods/free_methods/logistic_type sao derivados.
 *
 * `mode` saiu da lista: anuncio antigo carrega `me1`, uma modalidade de envio que a conta pode nao
 * ter mais, e o ML recusa com "User has not mode me1". E o mesmo tipo de armadilha do GTIN — o
 * clone herdando uma condicao que era valida quando o anuncio nasceu e nao e mais. Sem `mode`, o
 * ML atribui a modalidade vigente da conta.
 */
const SHIPPING_ACEITO = ['local_pick_up', 'free_shipping', 'dimensions'] as const;

/**
 * Atributos que o ML calcula e nao aceita receber. Mandar rende
 * "ignored because it is not modifiable" — as vezes so ruido, as vezes recusa.
 */
const ATRIBUTOS_SOMENTE_LEITURA = new Set(['PRODUCT_FEATURES']);

/**
 * Modalidade de envio do anuncio NOVO.
 *
 * Nao basta parar de copiar o `mode` antigo: sem o campo, o ML infere — e num anuncio de categoria
 * velha ele infere `me1`, modalidade que a conta nao tem mais ("User has not mode me1"). Entao o
 * clone declara a modalidade vigente em vez de deixar o ML adivinhar a partir do passado.
 */
const MODO_DE_ENVIO_PADRAO = 'me2';

/** Atributos e sale_terms: o ML quer o id e o valor. O resto (name, value_type, grupos) e enfeite. */
function limparAtributos(lista: any): any[] | undefined {
  if (!Array.isArray(lista)) return undefined;
  const limpos = lista
    .filter((a: any) => a?.id && !ATRIBUTOS_SOMENTE_LEITURA.has(a.id))
    .map((a: any) => {
      const out: Record<string, any> = { id: a.id };
      if (a.value_id != null) out.value_id = a.value_id;
      else if (a.value_name != null) out.value_name = a.value_name;
      if (a.value_struct != null) out.value_struct = a.value_struct;
      return out;
    });
  return limpos.length ? limpos : undefined;
}

function limparShipping(shipping: any): Record<string, any> | undefined {
  if (!shipping || typeof shipping !== 'object') return undefined;
  const out: Record<string, any> = {};
  for (const campo of SHIPPING_ACEITO) {
    if (shipping[campo] !== undefined && shipping[campo] !== null) out[campo] = shipping[campo];
  }
  return Object.keys(out).length ? out : undefined;
}

/** Variacao nova: sem id do anuncio velho, sem estoque dele, sem vendas. */
function limparVariacoes(variacoes: any): any[] | undefined {
  if (!Array.isArray(variacoes) || variacoes.length === 0) return undefined;
  return variacoes.map((v: any) => {
    const out: Record<string, any> = { available_quantity: 1 };
    if (v?.price != null) out.price = v.price;
    if (Array.isArray(v?.picture_ids) && v.picture_ids.length) out.picture_ids = v.picture_ids;
    if (v?.seller_custom_field != null) out.seller_custom_field = v.seller_custom_field;
    const comb = limparAtributos(v?.attribute_combinations);
    if (comb) out.attribute_combinations = comb;
    const attrs = limparAtributos(v?.attributes);
    if (attrs) out.attributes = attrs;
    return out;
  });
}

export interface OpcoesClone {
  /** Sufixo opcional no titulo. Vazio = titulo identico ao original. */
  sufixoTitulo?: string;
  /** Quantidade com que o anuncio novo nasce. Comeca em 1 e so vira o estoque real na virada. */
  quantidadeInicial?: number;
  /**
   * NOME DA FAMILIA — o campo que decide o agrupamento das opinioes.
   *
   * O ML exige `family_name` no POST /items e o usa pra encaixar o anuncio num produto do usuario
   * (MLBU...). Repetir o nome do original tende a cair no MESMO MLBU, e as opinioes vem junto;
   * um nome diferente tende a criar um agrupamento novo, sem opinioes.
   *
   * "Tende a" porque quem decide e o ML, cruzando tambem marca, modelo e GTIN. Por isso o padrao
   * aqui e FIEL (copia o do original) e quem confirma o efeito e a sondagem, nao esta suposicao.
   */
  familyName?: string;
  /**
   * Modalidade de envio do anuncio novo. Vazio = 'me2'. 'nenhum' omite o campo.
   */
  modoDeEnvio?: string;
  /**
   * Forcar frete gratis no anuncio novo.
   *
   * Algumas categorias passaram a EXIGIR frete gratis por faixa de preco ("mandatory_free_shipping").
   * Nao ligo isso sozinho: frete gratis sai do bolso do vendedor, e mudar isso em silencio alteraria
   * a margem sem ninguem decidir. Fica como escolha explicita.
   */
  freteGratis?: boolean;
  /**
   * GTIN (EAN/UPC) do produto.
   *
   * Recriar nao e clonar: o anuncio novo nasce sob as regras de HOJE. Categorias que passaram a
   * exigir GTIN recusam o clone de um anuncio antigo que so tinha EMPTY_GTIN_REASON, com
   * "item.attribute.missing_conditional_required".
   *
   * Aceita o codigo de barras, ou "-1" / "n/a" para declarar que o produto nao tem codigo.
   */
  gtin?: string;
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
  for (const chave of CAMPOS_ACEITOS) {
    const valor = (item || {})[chave];
    if (valor === null || valor === undefined) continue;
    payload[chave] = valor;
  }

  // Os tres campos abaixo precisam ser reescritos, nao copiados como vieram.
  const attrs = limparAtributos(item?.attributes);
  if (attrs) payload.attributes = attrs; else delete payload.attributes;

  const terms = limparAtributos(item?.sale_terms);
  if (terms) payload.sale_terms = terms; else delete payload.sale_terms;

  const frete = limparShipping(item?.shipping);
  if (frete) payload.shipping = frete; else delete payload.shipping;

  const modo = (opts.modoDeEnvio || '').trim() || MODO_DE_ENVIO_PADRAO;
  if (modo !== 'nenhum') {
    payload.shipping = { ...(payload.shipping || {}), mode: modo };
  }

  if (opts.freteGratis) {
    payload.shipping = { ...(payload.shipping || {}), free_shipping: true };
    avisos.push('Frete gratis LIGADO no anuncio novo: o custo do envio passa a sair da sua margem.');
  }

  // GTIN informado pelo operador: substitui o que houver, pra nao duplicar o atributo.
  const gtin = (opts.gtin || '').trim();
  if (gtin) {
    const lista: any[] = Array.isArray(payload.attributes) ? payload.attributes.filter((a: any) => a.id !== 'GTIN') : [];
    const semCodigo = /^(-1|n\/?a|sem|nao|não)$/i.test(gtin);
    lista.push(semCodigo ? { id: 'GTIN', value_id: '-1' } : { id: 'GTIN', value_name: gtin });
    payload.attributes = lista;
    avisos.push(
      semCodigo
        ? 'GTIN declarado como inexistente (-1). Se a categoria exigir o codigo de verdade, o ML recusa.'
        : `GTIN ${gtin} adicionado ao anuncio novo.`,
    );
  }

  // family_name e title sao MUTUAMENTE EXCLUSIVOS.
  // Sem family_name: "body.required_fields ... [family_name]".
  // Com family_name + title: "The fields [title] are invalid for requested call."
  // Em anuncio de familia, o ML GERA o titulo a partir do nome da familia + atributos.
  // Sem fallback pro titulo de proposito: o clone espelha a FORMA do original. Anuncio sem familia
  // continua sendo anuncio com titulo proprio. Se o ML exigir familia, o operador informa uma no
  // painel — e ai o titulo passa a ser derivado dela.
  const familia = (opts.familyName || '').trim() || item?.family_name;
  if (familia) {
    payload.family_name = String(familia).slice(0, 60);
    // O titulo nao pode ir junto: quem manda no titulo, aqui, e o nome da familia.
    delete payload.title;
    avisos.push(
      'O titulo nao e enviado: em anuncio de familia o ML monta o titulo a partir do nome da familia e dos ' +
      'atributos. Ou seja, mudar o nome da familia MUDA O TITULO que o comprador ve.',
    );
    if ((opts.sufixoTitulo || '').trim()) {
      avisos.push('O sufixo de titulo foi ignorado: com familia de produtos, quem define o titulo e o nome da familia.');
    }
    if (opts.familyName && opts.familyName.trim() && opts.familyName.trim() !== (item?.family_name || item?.title)) {
      avisos.push(
        `Nome de familia alterado para "${payload.family_name}". Isso tende a criar um produto do usuario NOVO — ` +
        'que e o que zera as opinioes. A sondagem confirma se funcionou.',
      );
    } else {
      avisos.push(
        `Nome de familia mantido igual ao original ("${payload.family_name}"). O ML tende a reagrupar o anuncio novo ` +
        'no MESMO produto do usuario, e nesse caso a nota vem junto. Se o objetivo e zerar, use um nome diferente.',
      );
    }
  }

  // Titulo so quando NAO ha familia: com family_name, quem monta o titulo e o ML.
  if (!payload.family_name) {
    const sufixo = (opts.sufixoTitulo || '').trim();
    if (sufixo) {
      const comSufixo = `${item.title} ${sufixo}`.trim();
      // O ML corta titulo em 60 caracteres: melhor avisar do que deixar o ML truncar sozinho.
      if (comSufixo.length > 60) {
        avisos.push(`Titulo com sufixo ficaria com ${comSufixo.length} caracteres (limite 60). Sufixo ignorado.`);
        payload.title = item.title;
      } else {
        payload.title = comSufixo;
      }
    } else {
      payload.title = item.title;
    }
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

  // Variacoes: ids e estoque do anuncio velho nao vao junto.
  const vars = limparVariacoes(item?.variations);
  if (vars) {
    payload.variations = vars;
    avisos.push(
      `O anuncio tem ${vars.length} variacao(oes). O estoque de cada uma comeca em 1 e precisa ser ajustado depois da virada.`,
    );
  } else {
    delete payload.variations;
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
  /** Nome de familia que seria enviado — o campo que decide o agrupamento das opinioes. */
  familyName: string | null;
  familyNameOriginal: string | null;
  payload: Record<string, any>;
  avisos: string[];
  /** Resultado do POST /items/validate no ML. `bruto` traz a resposta crua quando ele recusa. */
  validacao: { ok: boolean; erros: string[]; bruto?: unknown };
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

  const id = String(itemId || '').trim().toUpperCase();
  if (!/^ML[A-Z]\d+$/.test(id)) {
    throw new RecriacaoBloqueada(
      `"${itemId}" nao parece um id de anuncio. Informe o MLB do anuncio (ex: MLB4881096643) — nao a URL nem o id do produto.`,
    );
  }

  // Unica chamada sem tratamento no fluxo: se o ML nao achar o anuncio, a mensagem dele e generica
  // ("visita el Sitio de Desarrolladores"). Traduz pra algo que diga o que de fato aconteceu.
  let item: any;
  try {
    item = await getItemFull(id);
  } catch (err: any) {
    if (err?.status === 404) {
      throw new RecriacaoBloqueada(`O Mercado Livre nao encontrou o anuncio ${id}. Confira o id — ele precisa ser de um anuncio seu.`);
    }
    if (err?.status === 403) {
      throw new RecriacaoBloqueada(`Sem permissao para ler o anuncio ${id}. Confira os escopos do aplicativo no Mercado Livre.`);
    }
    throw err;
  }

  const { payload, avisos } = montarClone(item, opts);
  const validacao = await validateItemPayload(payload);
  const rating = await getRating(id).catch(() => null);
  const { userProductId: userProductIdOriginal } = await getUserProductId(id, item);

  const sim: Simulacao = {
    token: novoToken(id),
    itemId: id,
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
    familyName: payload.family_name ?? null,
    familyNameOriginal: item.family_name ?? null,
    payload,
    avisos,
    validacao,
    userProductIdOriginal,
    simuladoEm: new Date().toISOString(),
  };

  simulacoes.set(sim.token, sim);
  logger.info(`[RECRIAR] Simulacao ${sim.token} para ${id}: validacao ${validacao.ok ? 'OK' : 'FALHOU'}.`);
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

// --- 5. Sonda de FORMA do payload ---

/**
 * DESCOBRE QUAL FORMATO O ML ACEITA, sem criar nada.
 *
 * Um anuncio com variacoes numa categoria que exige familia produz dois erros contraditorios ao
 * mesmo tempo: "falta family_name" e "variations e invalido com family name". Nao da pra saber por
 * leitura qual e a saida — e cada tentativa as cegas gasta o tempo de quem opera.
 *
 * `/items/validate` nao cria anuncio e nao custa nada alem da chamada. Entao em vez de adivinhar,
 * pergunta-se ao proprio ML: monta-se o payload em varias formas e ve-se qual passa.
 */
export interface FormaTestada {
  forma: string;
  descricao: string;
  ok: boolean;
  erros: string[];
}

export async function diagnosticarFormas(itemId: string, familyName?: string): Promise<any> {
  const item = await getItemFull(itemId);
  const nomeDeFamilia = (familyName || '').trim() || item?.title || 'Familia';

  const semVariacoes = (p: Record<string, any>) => {
    const { variations, ...resto } = p;
    return resto;
  };

  const base = montarClone(item, {}).payload;
  const comFamilia = montarClone(item, { familyName: nomeDeFamilia }).payload;

  const formas: Array<{ forma: string; descricao: string; payload: Record<string, any> }> = [
    {
      forma: 'como_esta',
      descricao: 'Titulo proprio + variacoes, exatamente como o anuncio original.',
      payload: base,
    },
    {
      forma: 'sem_variacoes',
      descricao: 'Titulo proprio, SEM variacoes. Se passar, da pra criar o anuncio e adicionar as variacoes depois.',
      payload: semVariacoes(base),
    },
    {
      forma: 'familia_sem_variacoes',
      descricao: 'Nome de familia, SEM variacoes. O ML gera o titulo a partir da familia.',
      payload: semVariacoes(comFamilia),
    },
    {
      forma: 'familia_com_variacoes',
      descricao: 'Nome de familia E variacoes juntos — a combinacao que o erro diz ser invalida.',
      payload: comFamilia,
    },
    {
      forma: 'familia_frete_gratis',
      descricao:
        'Familia, sem variacoes, com FRETE GRATIS ligado. Algumas categorias exigem frete gratis por faixa de ' +
        'preco — e ai o custo do envio passa a sair da sua margem.',
      payload: semVariacoes(montarClone(item, { familyName: nomeDeFamilia, freteGratis: true }).payload),
    },
    {
      forma: 'familia_sem_modo_de_envio',
      descricao:
        'Familia, sem variacoes, SEM declarar modalidade de envio. Serve pra confirmar se o "me1" vem do que a ' +
        'gente manda ou do que o ML infere sozinho.',
      payload: semVariacoes(montarClone(item, { familyName: nomeDeFamilia, modoDeEnvio: 'nenhum' }).payload),
    },
  ];

  const testadas: FormaTestada[] = [];
  for (const f of formas) {
    const v = await validateItemPayload(f.payload);
    testadas.push({ forma: f.forma, descricao: f.descricao, ok: v.ok, erros: v.erros });
  }

  const aceitas = testadas.filter((t) => t.ok);

  /**
   * Mensagem que aparece em TODAS as formas nao vem do payload.
   *
   * Cada forma manda um corpo diferente. Se a mensagem nao muda quando o corpo muda, a causa esta
   * fora do que controlamos — na conta, na categoria ou no tipo de anuncio. Distinguir isso importa:
   * sem essa separacao eu dei um veredicto de "nao e recriavel" com base em duas mensagens que
   * provavelmente eram avisos, e mandei o usuario atras de tres versoes de correcao inutil.
   */
  const invariantes = testadas.length > 1
    ? testadas[0].erros.filter((e) => testadas.every((t) => t.erros.includes(e)))
    : [];
  const variaveis = (t: FormaTestada) => t.erros.filter((e) => !invariantes.includes(e));
  const semErroProprio = testadas.filter((t) => !t.ok && variaveis(t).length === 0);

  let veredicto: string;
  if (aceitas.length > 0) {
    veredicto = aceitas.some((t) => t.forma === 'como_esta')
      ? 'O formato original passa. O erro anterior veio de outra coisa — compare os erros abaixo.'
      : `O ML aceita: ${aceitas.map((t) => t.forma).join(', ')}. A recriacao e possivel, mas mudando a forma do anuncio — leia a descricao antes de decidir se o resultado ainda e o anuncio que voce quer.`;
  } else if (semErroProprio.length > 0) {
    veredicto =
      `Nenhuma forma passou limpa, MAS ${semErroProprio.map((t) => t.forma).join(', ')} so recebeu mensagem que ` +
      'aparece em todas as formas — ou seja, que nao vem do que a gente manda. Isso costuma ser aviso da conta ou ' +
      'da categoria, e nao impedimento. Nao da pra confirmar sem criar de verdade: use a sondagem, que cria um ' +
      'anuncio pausado com estoque 1 e descarta em seguida.';
  } else {
    veredicto =
      'Todas as formas foram recusadas por motivos que mudam conforme o payload. Este anuncio nao e recriavel por ' +
      'clone hoje: as regras da categoria mudaram desde que ele foi criado.';
  }

  return {
    itemId,
    titulo: item?.title,
    temVariacoes: Array.isArray(item?.variations) ? item.variations.length : 0,
    familyNameOriginal: item?.family_name ?? null,
    veredicto,
    /** Mensagens iguais em todas as formas: nao sao causadas pelo corpo enviado. */
    mensagensQueNaoDependemDoPayload: invariantes,
    formas: testadas.map((t) => ({ ...t, errosProprios: variaveis(t) })),
    aviso: 'Nenhum anuncio foi criado. /items/validate apenas valida.',
  };
}
