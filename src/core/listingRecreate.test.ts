import { describe, expect, it } from 'vitest';
import { avaliacoesParaRecuperar, avisosDaValidacao, resumirProdutoDoUsuario, errosIguaisNoGrupo, interpretarSondagem, montarClone } from './listingRecreate';
import { interpretarValidacao } from '../ml/mlClient';

const itemBase = {
  id: 'MLB123',
  site_id: 'MLB',
  seller_id: 99,
  title: 'Chave Tic Tac 2 Estagios 200W',
  category_id: 'MLB1234',
  price: 39.9,
  currency_id: 'BRL',
  available_quantity: 25,
  sold_quantity: 431,
  condition: 'new',
  listing_type_id: 'gold_special',
  permalink: 'https://produto.mercadolivre.com.br/MLB123',
  status: 'active',
  health: 0.9,
  date_created: '2024-01-10T12:00:00.000Z',
  catalog_listing: false,
  catalog_product_id: null,
  pictures: [{ id: 'PIC1', url: 'http://x/1.jpg' }, { id: 'PIC2', url: 'http://x/2.jpg' }],
  attributes: [{ id: 'BRAND', value_name: 'Generica' }],
  shipping: {
    mode: 'me2', free_shipping: true, local_pick_up: false,
    dimensions: '10x10x5,300',
    // derivados do ML — o clone NAO pode reenviar nenhum destes
    methods: [{ id: 1 }], free_methods: [{ id: 73328 }], logistic_type: 'cross_docking',
    store_pick_up: false, tags: ['self_service_in'],
  },
  warranty: '3 meses',
  // campos somente-leitura que vinham junto e faziam o ML recusar com body.invalid_fields
  domain_id: 'MLB-SWITCHES',
  internal_tags: ['SELF_SERVICE_IN'],
  seller_address: { city: { name: 'Curitiba' } },
  accepts_mercadopago: true,
  automatic_relist: false,
  thumbnail_id: 'ABC',
};

describe('montarClone', () => {
  it('nao leva identidade nem historico do anuncio velho', () => {
    const { payload } = montarClone(itemBase);
    for (const proibido of ['id', 'permalink', 'sold_quantity', 'health', 'seller_id', 'date_created', 'catalog_product_id']) {
      expect(payload).not.toHaveProperty(proibido);
    }
  });

  it('descarta os campos somente-leitura que causavam body.invalid_fields', () => {
    const { payload } = montarClone(itemBase);
    for (const derivado of ['domain_id', 'internal_tags', 'seller_address', 'accepts_mercadopago', 'automatic_relist', 'thumbnail_id']) {
      expect(payload).not.toHaveProperty(derivado);
    }
  });

  it('so envia campos que o POST /items aceita', () => {
    const { payload } = montarClone(itemBase);
    const aceitos = new Set([
      'title', 'category_id', 'price', 'currency_id', 'buying_mode', 'listing_type_id',
      'condition', 'warranty', 'video_id', 'seller_custom_field', 'official_store_id',
      'channels', 'sale_terms', 'shipping', 'attributes', 'variations', 'pictures',
      'family_name', 'available_quantity', 'status',
    ]);
    for (const chave of Object.keys(payload)) expect(aceitos.has(chave)).toBe(true);
  });

  it('limpa o shipping, mantendo so o que e configuravel', () => {
    const { payload } = montarClone(itemBase);
    expect(payload.shipping).toEqual({ local_pick_up: false, free_shipping: true, dimensions: '10x10x5,300', mode: 'me2' });
  });

  it('DECLARA a modalidade atual em vez de herdar a antiga', () => {
    // Nao basta parar de copiar o me1: sem o campo, o ML infere — e em categoria velha ele infere
    // me1, que a conta nao tem mais. Declarar e o unico jeito de nao depender do passado.
    const { payload } = montarClone({ ...itemBase, shipping: { ...itemBase.shipping, mode: 'me1' } });
    expect(payload.shipping.mode).toBe('me2');
  });

  it('da pra omitir a modalidade de proposito, pra diagnostico', () => {
    const { payload } = montarClone(itemBase, { modoDeEnvio: 'nenhum' });
    expect(payload.shipping.mode).toBeUndefined();
  });

  it('descarta atributo que o ML calcula e nao aceita receber', () => {
    const { payload } = montarClone({
      ...itemBase,
      attributes: [{ id: 'BRAND', value_name: 'MCS' }, { id: 'PRODUCT_FEATURES', value_name: 'algo' }],
    });
    expect(payload.attributes).toEqual([{ id: 'BRAND', value_name: 'MCS' }]);
  });

  it('frete gratis so entra quando pedido, e avisa que sai da margem', () => {
    const semPedir = montarClone({ ...itemBase, shipping: { ...itemBase.shipping, free_shipping: false } });
    expect(semPedir.payload.shipping.free_shipping).toBe(false);

    const pedindo = montarClone({ ...itemBase, shipping: { ...itemBase.shipping, free_shipping: false } }, { freteGratis: true });
    expect(pedindo.payload.shipping.free_shipping).toBe(true);
    expect(pedindo.avisos.join(' ')).toMatch(/margem/i);
  });

  it('reduz atributos a id + valor', () => {
    const { payload } = montarClone({
      ...itemBase,
      attributes: [{ id: 'BRAND', name: 'Marca', value_id: '123', value_name: 'Generica', value_type: 'string', attribute_group_id: 'OTHERS' }],
    });
    expect(payload.attributes).toEqual([{ id: 'BRAND', value_id: '123' }]);
  });

  it('usa value_name quando nao ha value_id', () => {
    const { payload } = montarClone({ ...itemBase, attributes: [{ id: 'MODEL', value_name: 'SF-510' }] });
    expect(payload.attributes).toEqual([{ id: 'MODEL', value_name: 'SF-510' }]);
  });

  it('preserva o que define o anuncio', () => {
    const { payload } = montarClone(itemBase);
    expect(payload.title).toBe(itemBase.title);
    expect(payload.category_id).toBe('MLB1234');
    expect(payload.price).toBe(39.9);
    expect(payload.listing_type_id).toBe('gold_special');
    expect(payload.warranty).toBe('3 meses');
    expect(payload.condition).toBe('new');
    expect(payload.currency_id).toBe('BRL');
  });

  it('reaproveita as fotos por id, sem re-upload', () => {
    const { payload } = montarClone(itemBase);
    expect(payload.pictures).toEqual([{ id: 'PIC1' }, { id: 'PIC2' }]);
  });

  it('nasce pausado e com estoque minimo, nunca com o estoque do original', () => {
    const { payload } = montarClone(itemBase);
    expect(payload.status).toBe('paused');
    expect(payload.available_quantity).toBe(1);
  });

  it('avisa que as vendas do original ficam para tras', () => {
    const { avisos } = montarClone(itemBase);
    expect(avisos.join(' ')).toContain('431');
  });

  it('avisa quando o anuncio e de catalogo (recriar nao zera)', () => {
    const { avisos } = montarClone({ ...itemBase, catalog_listing: true });
    expect(avisos.join(' ')).toContain('NAO vai zerar');
  });

  it('nao avisa sobre catalogo quando o anuncio e da lista geral', () => {
    const { avisos } = montarClone(itemBase);
    expect(avisos.join(' ')).not.toContain('NAO vai zerar');
  });

  it('limpa ids e estoque das variacoes', () => {
    const { payload, avisos } = montarClone({
      ...itemBase,
      variations: [{
        id: 555, sold_quantity: 10, available_quantity: 7, price: 41.9,
        attribute_combinations: [{ id: 'COLOR', value_id: '52049', value_name: 'Preto', value_type: 'string' }],
        picture_ids: ['PIC1'], catalog_product_id: 'MLB999',
      }],
    });
    const v = payload.variations[0];
    expect(v).not.toHaveProperty('id');
    expect(v).not.toHaveProperty('sold_quantity');
    expect(v).not.toHaveProperty('catalog_product_id');
    expect(v.available_quantity).toBe(1);
    expect(v.price).toBe(41.9);
    expect(v.picture_ids).toEqual(['PIC1']);
    expect(v.attribute_combinations).toEqual([{ id: 'COLOR', value_id: '52049' }]);
    expect(avisos.join(' ')).toContain('variacao');
  });

  it('ignora o sufixo quando ele estouraria o limite de 60 caracteres', () => {
    const titulo = 'A'.repeat(58);
    const { payload, avisos } = montarClone({ ...itemBase, title: titulo }, { sufixoTitulo: 'Novo' });
    expect(payload.title).toBe(titulo);
    expect(avisos.join(' ')).toContain('limite 60');
  });

  it('aplica o sufixo quando cabe', () => {
    const { payload } = montarClone({ ...itemBase, title: 'Chave Tic Tac' }, { sufixoTitulo: '200W' });
    expect(payload.title).toBe('Chave Tic Tac 200W');
  });

  it('avisa quando o anuncio nao tem fotos', () => {
    const { avisos } = montarClone({ ...itemBase, pictures: [] });
    expect(avisos.join(' ')).toContain('sem imagem');
  });
});

describe('avaliacoesParaRecuperar', () => {
  it('com nota 4,0 e uma unica avaliacao, uma nota 5 ja resolve', () => {
    expect(avaliacoesParaRecuperar(4.0, 1, 4.5)).toBe(1);
  });

  it('com nota 4,0 precisa de tantas notas 5 quanto o total existente', () => {
    expect(avaliacoesParaRecuperar(4.0, 40, 4.5)).toBe(40);
  });

  it('quanto pior a nota, mais desproporcional fica a recuperacao', () => {
    expect(avaliacoesParaRecuperar(3.0, 20, 4.5)).toBe(60);
  });

  it('devolve null quando a nota ja esta no limite', () => {
    expect(avaliacoesParaRecuperar(4.6, 30, 4.5)).toBeNull();
    expect(avaliacoesParaRecuperar(4.5, 30, 4.5)).toBeNull();
  });

  it('devolve null sem dados de avaliacao', () => {
    expect(avaliacoesParaRecuperar(null, 10, 4.5)).toBeNull();
    expect(avaliacoesParaRecuperar(4.0, 0, 4.5)).toBeNull();
  });
});

describe('interpretarSondagem', () => {
  it('produto do usuario diferente significa que a nota zera', () => {
    const r = interpretarSondagem('MLBU4275986047', 'MLBU9999999999');
    expect(r.veredicto).toBe('zera');
    expect(r.explicacao).toContain('MLBU9999999999');
  });

  it('mesmo produto do usuario significa que a nota viria junto', () => {
    const r = interpretarSondagem('MLBU4275986047', 'MLBU4275986047');
    expect(r.veredicto).toBe('nao_zera');
    expect(r.explicacao).toContain('descarte');
  });

  it('sem o produto do usuario do clone, o veredicto e indeterminado', () => {
    expect(interpretarSondagem('MLBU4275986047', null).veredicto).toBe('indeterminado');
  });

  it('sem o produto do usuario do original tambem e indeterminado', () => {
    expect(interpretarSondagem(null, 'MLBU9999999999').veredicto).toBe('indeterminado');
  });

  it('indeterminado manda descartar, nunca seguir', () => {
    expect(interpretarSondagem(null, null).explicacao).toContain('descartar');
  });
});

describe('family_name — a alavanca do agrupamento das opinioes', () => {
  const comFamilia = { ...itemBase, family_name: 'Chave Tic Tac 200W' };

  it('e sempre enviado: sem ele o ML recusa com body.required_fields', () => {
    expect(montarClone(comFamilia).payload.family_name).toBe('Chave Tic Tac 200W');
  });

  it('nao inventa familia quando o original nao tem: manda o titulo, como o original', () => {
    const { payload } = montarClone(itemBase);
    expect(payload).not.toHaveProperty('family_name');
    expect(payload.title).toBe(itemBase.title);
  });

  it('respeita o nome escolhido pelo operador', () => {
    const { payload } = montarClone(comFamilia, { familyName: 'Chave Tic Tac 200W v2' });
    expect(payload.family_name).toBe('Chave Tic Tac 200W v2');
  });

  it('avisa que manter o nome tende a trazer a nota junto', () => {
    expect(montarClone(comFamilia).avisos.join(' ')).toContain('MESMO produto do usuario');
  });

  it('avisa que mudar o nome tende a zerar', () => {
    const { avisos } = montarClone(comFamilia, { familyName: 'Outro nome' });
    expect(avisos.join(' ')).toContain('NOVO');
  });

  it('corta em 60 caracteres', () => {
    const { payload } = montarClone(comFamilia, { familyName: 'A'.repeat(80) });
    expect(payload.family_name).toHaveLength(60);
  });
});

describe('validacao do id do anuncio', () => {
  it('aceita ids de anuncio de qualquer site do ML', () => {
    for (const id of ['MLB4881096643', 'MLA123', 'MLM99']) {
      expect(/^ML[A-Z]\d+$/.test(id)).toBe(true);
    }
  });

  it('rejeita produto de usuario, produto de catalogo com U, URL e vazio', () => {
    for (const id of ['MLBU4275986047', 'https://mercadolivre.com.br/p/MLB19872191', '', 'abc']) {
      expect(/^ML[A-Z]\d+$/.test(id)).toBe(false);
    }
  });
});

describe('title x family_name — mutuamente exclusivos', () => {
  const comFamilia = { ...itemBase, family_name: 'Chave Tic Tac 200W' };

  it('nao envia title quando ha family_name: o ML recusa com "The fields [title] are invalid"', () => {
    const { payload } = montarClone(comFamilia);
    expect(payload).not.toHaveProperty('title');
    expect(payload.family_name).toBe('Chave Tic Tac 200W');
  });

  it('envia title quando o operador informa uma familia num anuncio que nao tinha', () => {
    const { payload } = montarClone(itemBase, { familyName: 'Familia Nova' });
    expect(payload).not.toHaveProperty('title');
    expect(payload.family_name).toBe('Familia Nova');
  });

  it('avisa que mudar a familia muda o titulo visivel', () => {
    expect(montarClone(comFamilia).avisos.join(' ')).toContain('MUDA O TITULO');
  });

  it('avisa que o sufixo de titulo perde o efeito', () => {
    const { avisos } = montarClone(comFamilia, { sufixoTitulo: 'v2' });
    expect(avisos.join(' ')).toContain('sufixo de titulo foi ignorado');
  });
});

describe('GTIN — recriar cria sob as regras de hoje', () => {
  it('adiciona o GTIN informado como value_name', () => {
    const { payload } = montarClone(itemBase, { gtin: '7891234567890' });
    expect(payload.attributes).toContainEqual({ id: 'GTIN', value_name: '7891234567890' });
  });

  it('aceita declarar que o produto nao tem codigo', () => {
    for (const entrada of ['-1', 'n/a', 'N/A', 'sem', 'nao']) {
      const { payload } = montarClone(itemBase, { gtin: entrada });
      expect(payload.attributes).toContainEqual({ id: 'GTIN', value_id: '-1' });
    }
  });

  it('substitui o GTIN que ja existia em vez de duplicar', () => {
    const { payload } = montarClone(
      { ...itemBase, attributes: [{ id: 'GTIN', value_name: '111' }, { id: 'BRAND', value_id: '9' }] },
      { gtin: '7891234567890' },
    );
    const gtins = payload.attributes.filter((a: any) => a.id === 'GTIN');
    expect(gtins).toHaveLength(1);
    expect(gtins[0].value_name).toBe('7891234567890');
    expect(payload.attributes).toContainEqual({ id: 'BRAND', value_id: '9' });
  });

  it('nao mexe nos atributos quando nenhum GTIN e informado', () => {
    const { payload } = montarClone(itemBase);
    expect(payload.attributes.some((a: any) => a.id === 'GTIN')).toBe(false);
  });

  it('avisa quando o GTIN e declarado como inexistente', () => {
    expect(montarClone(itemBase, { gtin: '-1' }).avisos.join(' ')).toContain('inexistente');
  });
});

/**
 * Distinguir "o ML recusou por causa do que mandamos" de "o ML avisou algo da conta" e o que evita
 * um veredicto errado. Errei isso duas vezes: primeiro sem comparar nada, depois exigindo que a
 * mensagem aparecesse em TODAS as formas — o que descartava justamente a evidencia util, porque
 * mensagem de frete so aparece nas formas que chegam ate o frete.
 */
describe('errosIguaisNoGrupo', () => {
  const frete = (forma: string, erros: string[]) => ({ forma, descricao: '', grupo: 'frete', ok: false, erros, avisos: [], soAvisos: false });

  it('formas que so variam o frete e dao o MESMO erro provam que o frete nao e a causa', () => {
    const formas = [
      frete('me2', ['User has not mode me1', 'Mandatory free shipping added']),
      frete('sem_modo', ['User has not mode me1', 'Mandatory free shipping added']),
      frete('gratis', ['User has not mode me1', 'Mandatory free shipping added']),
    ];
    expect(errosIguaisNoGrupo(formas, 'frete')).toEqual(['User has not mode me1', 'Mandatory free shipping added']);
  });

  it('se uma forma do grupo tem erro proprio, o grupo nao e equivalente e nada e concluido', () => {
    const formas = [
      frete('me2', ['A']),
      frete('gratis', ['A', 'B']),
    ];
    expect(errosIguaisNoGrupo(formas, 'frete')).toEqual([]);
  });

  it('mensagem de OUTRO grupo nao contamina a conclusao', () => {
    const formas = [
      { forma: 'estrutura1', descricao: '', grupo: 'estrutura', ok: false, erros: ['falta family_name'], avisos: [], soAvisos: false },
      frete('me2', ['User has not mode me1']),
      frete('gratis', ['User has not mode me1']),
    ];
    // "falta family_name" nunca aparece no grupo de frete: nao entra no resultado.
    expect(errosIguaisNoGrupo(formas, 'frete')).toEqual(['User has not mode me1']);
  });

  it('grupo com uma forma so nao conclui nada — nao ha comparacao possivel', () => {
    expect(errosIguaisNoGrupo([frete('unica', ['A'])], 'frete')).toEqual([]);
  });
});

// --- v15 ---

/** Resposta REAL do ML em 2026-09-24 para o MLB7418169626: 400, e todas as causas warning. */
const respostaSoAvisos = {
  message: 'Validation error',
  error: 'validation_error',
  status: 400,
  cause: [
    { type: 'warning', code: 'item.attributes.ignored', message: 'Attribute [PACKAGE_HEIGHT] ignored because it is not modifiable.' },
    { type: 'warning', code: 'shipping.lost_me1_by_user', message: 'User has not mode me1' },
    { type: 'warning', code: 'item.shipping.mandatory_free_shipping', message: 'Mandatory free shipping added' },
  ],
};

describe('v15: atributos de embalagem', () => {
  it('nao envia PACKAGE_* nem SHIPMENT_PACKING (o ML calcula e ignora)', () => {
    const item = {
      ...itemBase,
      attributes: [
        { id: 'BRAND', value_name: 'Generica' },
        { id: 'PACKAGE_HEIGHT', value_name: '10 cm' },
        { id: 'PACKAGE_WIDTH', value_name: '10 cm' },
        { id: 'PACKAGE_LENGTH', value_name: '10 cm' },
        { id: 'PACKAGE_WEIGHT', value_name: '300 g' },
        { id: 'PACKAGE_DATA_SOURCE', value_id: '1' },
        { id: 'SHIPMENT_PACKING', value_id: '2' },
      ],
    };
    const { payload } = montarClone(item);
    expect(payload.attributes.map((a: any) => a.id)).toEqual(['BRAND']);
  });
});

describe('v15: avisosDaValidacao', () => {
  it('frete gratis obrigatorio NAO avisa margem quando o original ja tinha frete gratis', () => {
    const v = interpretarValidacao(400, respostaSoAvisos);
    const avisos = avisosDaValidacao({ shipping: { free_shipping: true } }, v);
    expect(avisos.some((a) => a.includes('margem'))).toBe(false);
  });

  it('frete gratis obrigatorio avisa margem quando o original NAO tinha', () => {
    const v = interpretarValidacao(400, respostaSoAvisos);
    const avisos = avisosDaValidacao({ shipping: { free_shipping: false } }, v);
    expect(avisos.some((a) => a.includes('margem'))).toBe(true);
  });

  it('validacao so com avisos gera o aviso de que executar exige sondagem', () => {
    const v = interpretarValidacao(400, respostaSoAvisos);
    expect(avisosDaValidacao({ shipping: { free_shipping: true } }, v).some((a) => a.includes('sondar'))).toBe(true);
  });

  it('validacao limpa (2xx) nao gera aviso nenhum', () => {
    expect(avisosDaValidacao({ shipping: {} }, interpretarValidacao(204, undefined))).toEqual([]);
  });
});

// --- v16: produto do usuario antes de sondar ---

/** Recorte da resposta REAL de GET /user-products/MLBU4712247709 (2026-09-24). */
const upReal = {
  id: 'MLBU4712247709',
  name: 'Par Lanterna Traseira Led Universal Marmitao Marmita 12v 24v Ambos Lados Vermelho',
  family_name: 'Par Lanterna Traseira Led Universal Marmitao Marmita 12v 24v',
  attributes: [
    { id: 'SELLER_SKU', name: 'SKU', values: [{ id: null, name: 'MCS9001' }] },
    { id: 'PACKAGE_WIDTH', name: 'Largura da embalagem', values: [{ id: null, name: '19.4 cm' }] },
    { id: 'SELLER_PACKAGE_WEIGHT', name: 'Peso da embalagem do vendor', values: [{ id: null, name: '1065 g' }] },
    { id: 'BRAND', name: 'Marca', values: [{ id: '18701064', name: 'MCS' }] },
    { id: 'LENS_COLOR', name: 'Cor da lente', values: [{ id: '51993', name: 'Vermelho' }] },
  ],
};
const anunciosReais = { ids: ['MLB7418169626'], total: 1 };

describe('v16: resumirProdutoDoUsuario', () => {
  it('ignora atributos de embalagem na comparacao', () => {
    const r = resumirProdutoDoUsuario(upReal, anunciosReais, { attributes: [] });
    expect(r.atributos.map((a) => a.id)).toEqual(['SELLER_SKU', 'BRAND', 'LENS_COLOR']);
  });

  it('clone com os mesmos atributos-chave: previsao provavel_nao_zera, citando o SKU', () => {
    const payload = {
      attributes: [
        { id: 'SELLER_SKU', value_name: 'MCS9001' },
        { id: 'BRAND', value_id: '18701064' },
        { id: 'LENS_COLOR', value_name: 'vermelho' }, // compara sem caixa
      ],
    };
    const r = resumirProdutoDoUsuario(upReal, anunciosReais, payload);
    expect(r.previsao).toBe('provavel_nao_zera');
    expect(r.sku).toBe('MCS9001');
    expect(r.explicacao).toContain('MCS9001');
    expect(r.anuncios).toEqual(['MLB7418169626']);
  });

  it('um atributo-chave diferente ou ausente deixa a previsao incerta e diz qual', () => {
    const payload = {
      attributes: [
        { id: 'SELLER_SKU', value_name: 'MCS9001-B' },
        { id: 'BRAND', value_id: '18701064' },
      ],
    };
    const r = resumirProdutoDoUsuario(upReal, anunciosReais, payload);
    expect(r.previsao).toBe('incerto');
    expect(r.atributos.find((a) => a.id === 'SELLER_SKU')?.comparacao).toBe('diferente');
    expect(r.atributos.find((a) => a.id === 'LENS_COLOR')?.comparacao).toBe('nao_enviado');
    expect(r.explicacao).toContain('SKU');
  });

  it('MLBU sem atributos nao preve nada', () => {
    expect(resumirProdutoDoUsuario({ id: 'X', attributes: [] }, { ids: [], total: 0 }, {}).previsao).toBe('incerto');
  });
});
