import { describe, expect, it } from 'vitest';
import { avaliacoesParaRecuperar, interpretarSondagem, montarClone } from './listingRecreate';

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
  shipping: { mode: 'me2', free_shipping: true },
  warranty: '3 meses',
};

describe('montarClone', () => {
  it('nao leva identidade nem historico do anuncio velho', () => {
    const { payload } = montarClone(itemBase);
    for (const proibido of ['id', 'permalink', 'sold_quantity', 'health', 'seller_id', 'date_created', 'catalog_product_id']) {
      expect(payload).not.toHaveProperty(proibido);
    }
  });

  it('preserva o que define o anuncio', () => {
    const { payload } = montarClone(itemBase);
    expect(payload.title).toBe(itemBase.title);
    expect(payload.category_id).toBe('MLB1234');
    expect(payload.price).toBe(39.9);
    expect(payload.listing_type_id).toBe('gold_special');
    expect(payload.shipping).toEqual(itemBase.shipping);
    expect(payload.attributes).toEqual(itemBase.attributes);
    expect(payload.warranty).toBe('3 meses');
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
      variations: [{ id: 555, sold_quantity: 10, available_quantity: 7, attribute_combinations: [{ id: 'COLOR' }] }],
    });
    expect(payload.variations[0]).not.toHaveProperty('id');
    expect(payload.variations[0]).not.toHaveProperty('sold_quantity');
    expect(payload.variations[0].available_quantity).toBe(1);
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
