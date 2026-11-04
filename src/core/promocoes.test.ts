import { describe, expect, it } from 'vitest';
import { acharPromocao, AdesaoBloqueada, lerPromocao, montarPedido } from './promocoes';

// Resposta REAL do ML para MLB4109133481 em 2026-11-03.
const REAL = [
  { id: 'LGH-MLB1000', type: 'LIGHTNING', ref_id: 'CANDIDATE-MLB4109133481-77687047774', status: 'candidate', price: 76.53, original_price: 78.9, min_discounted_price: 15.79, max_discounted_price: 71.01, suggested_discounted_price: 67.07, stock: { min: 5, max: 3357 } },
  { id: 'C-MLB5941729', type: 'SELLER_CAMPAIGN', status: 'started', price: 36.99, original_price: 78.9, name: 'OUTUBRO 2026' },
  { id: 'P-MLB18099366', type: 'PRICE_MATCHING', ref_id: 'OFFER-MLB4109133481-14274740471', status: 'started', price: 35.88, meli_percentage: 2.7, original_price: 78.9 },
  { id: 'P-MLB18055120', type: 'SMART_LIGHTNING', ref_id: 'OFFER-MLB4109133481-14274737615', status: 'pending', price: 35, meli_percentage: 3.3, original_price: 78.9 },
  { type: 'PRICE_DISCOUNT', status: 'candidate', price: 0, original_price: 78.9, suggested_discounted_price: 70.22 },
  { id: 'P-MLB17909028', type: 'DEAL', status: 'candidate', price: 0, original_price: 78.9, name: '11.11 da Black', min_discounted_price: 15.79, max_discounted_price: 35.88, suggested_discounted_price: 27.99 },
];
const L = REAL.map(lerPromocao);

describe('lerPromocao', () => {
  it('marca o que esta aberto e o que o sistema sabe aderir', () => {
    expect(L.map((p) => [p.tipo, p.aberta, p.suportada])).toEqual([
      ['LIGHTNING', true, true],
      ['SELLER_CAMPAIGN', false, false],
      ['PRICE_MATCHING', true, true],
      ['SMART_LIGHTNING', false, true],
      ['PRICE_DISCOUNT', true, false],
      ['DEAL', true, true],
    ]);
  });
});

describe('montarPedido', () => {
  it('oferta pronta do ML aceita pelo offer_id', () => {
    expect(montarPedido(L[2], {}).corpo).toEqual({ promotion_type: 'PRICE_MATCHING', promotion_id: 'P-MLB18099366', offer_id: 'OFFER-MLB4109133481-14274740471' });
  });

  it('campanha usa o preco sugerido por padrao e respeita a faixa', () => {
    expect(montarPedido(L[5], {})).toEqual({ corpo: { promotion_type: 'DEAL', promotion_id: 'P-MLB17909028', deal_price: 27.99 }, precoFinal: 27.99 });
    expect(montarPedido(L[5], { preco: 30 }).corpo.deal_price).toBe(30);
    expect(() => montarPedido(L[5], { preco: 40 })).toThrow(/maximo/);
    expect(() => montarPedido(L[5], { preco: 10 })).toThrow(/minimo/);
  });

  it('relampago pede preco e estoque dentro dos limites', () => {
    expect(montarPedido(L[0], { preco: 60, estoque: 10 }).corpo).toEqual({ promotion_type: 'LIGHTNING', promotion_id: 'LGH-MLB1000', deal_price: 60, stock: 10 });
    expect(montarPedido(L[0], {}).corpo.stock).toBe(5);
    expect(() => montarPedido(L[0], { estoque: 2 })).toThrow(/ao menos 5/);
  });

  it('recusa o que ja esta ativo ou o que nao sabe fazer', () => {
    expect(() => montarPedido(L[1], {})).toThrow(AdesaoBloqueada);
    expect(() => montarPedido(L[4], {})).toThrow(/ainda nao sabe/);
  });
});

describe('acharPromocao', () => {
  it('pelo id, ou pelo tipo quando ha uma so', () => {
    expect(acharPromocao(L, 'P-MLB17909028')?.nome).toBe('11.11 da Black');
    expect(acharPromocao(L, null, 'price_matching')?.promocaoId).toBe('P-MLB18099366');
    expect(acharPromocao(L, 'nao-existe')).toBeNull();
  });
});
