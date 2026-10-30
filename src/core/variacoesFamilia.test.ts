import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * v17 — anuncio com variacoes numa categoria de familia: um anuncio novo por variacao.
 * Caso real: MLB6198163182 (2 variacoes, 438 em estoque), 2026-10-30.
 */
vi.hoisted(() => {
  process.env.RECREATE_ENABLED = 'true';
  process.env.DATA_DIR = require('node:fs').mkdtempSync(
    require('node:path').join(require('node:os').tmpdir(), 'ml-actions-test-'),
  );
});

const ml = vi.hoisted(() => ({
  getItemFull: vi.fn(), getItemDescription: vi.fn(), getRating: vi.fn(), getUserProductId: vi.fn(),
  validateItemPayload: vi.fn(), createItem: vi.fn(), createItemDescription: vi.fn(), updateItem: vi.fn(),
  closeItem: vi.fn(), deleteItem: vi.fn(), getUserProduct: vi.fn(), listItemsByUserProduct: vi.fn(),
}));

vi.mock('../ml/mlClient', async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, ...ml };
});

import { interpretarValidacao } from '../ml/mlClient';
import { executarRecriacao, simularRecriacao, sondarRecriacao } from './listingRecreate';

const item = {
  id: 'MLB6198163182',
  title: 'Lanterna Traseira Led Guerra Diamond 3 Iii 12v 24v Ld/le',
  category_id: 'MLB1',
  price: 50, currency_id: 'BRL', available_quantity: 438, sold_quantity: 66,
  listing_type_id: 'gold_special',
  pictures: [{ id: 'P1' }],
  attributes: [{ id: 'BRAND', value_name: 'X' }],
  variations: [
    { id: 1, available_quantity: 300, price: 50, attribute_combinations: [{ id: 'VOLTAGE', name: 'Voltagem', value_name: '12V' }] },
    { id: 2, available_quantity: 138, price: 55, attribute_combinations: [{ id: 'VOLTAGE', name: 'Voltagem', value_name: '24V' }] },
  ],
};

const recusaFamilia = interpretarValidacao(400, {
  error: 'validation_error',
  cause: [{ type: 'error', message: 'The body does not contains some or none of the following properties [family_name]' }],
});
const ok = interpretarValidacao(204, undefined);

beforeEach(() => {
  Object.values(ml).forEach((f) => f.mockReset());
  ml.getItemFull.mockResolvedValue(item);
  ml.getItemDescription.mockResolvedValue('descricao');
  ml.getRating.mockResolvedValue({ ratingAverage: 3.3, total: 3 });
  ml.getUserProductId.mockImplementation(async (id: string) => ({ userProductId: id === item.id ? 'MLBU1' : 'MLBU-' + id, fonte: 'teste' }));
  let n = 0;
  ml.createItem.mockImplementation(async () => ({ id: 'MLBNEW' + ++n }));
  ml.updateItem.mockResolvedValue({});
  ml.closeItem.mockResolvedValue({});
  ml.deleteItem.mockResolvedValue({});
  ml.getUserProduct.mockResolvedValue({ id: 'MLBU1', attributes: [] });
  ml.listItemsByUserProduct.mockResolvedValue({ ids: [item.id], total: 1 });
  // 1a chamada (sem familia) recusa; as seguintes (com familia, sem variations) passam.
  ml.validateItemPayload.mockImplementation(async (p: any) => (p.family_name ? ok : recusaFamilia));
});

describe('v17: recriacao com variacoes em categoria de familia', () => {
  it('ao ser recusado por falta de familia, refaz com o titulo como nome e 1 anuncio por variacao', async () => {
    const sim = await simularRecriacao(item.id);
    expect(sim.validacao.ok).toBe(true);
    expect(sim.payloads).toHaveLength(2);
    expect(sim.familyName).toBe(item.title.slice(0, 60));
    expect(sim.avisos.join(' ')).toContain('exige nome de familia');
    sim.payloads.forEach((c) => expect(c.payload).not.toHaveProperty('variations'));
  });

  it('executa criando N anuncios, cada um com o estoque da sua variacao, e fecha o antigo', async () => {
    const sim = await simularRecriacao(item.id);
    const reg = await executarRecriacao(sim.token);
    expect(reg.status).toBe('sucesso');
    expect(reg.itensNovos?.map((i) => [i.id, i.estoque])).toEqual([['MLBNEW1', 300], ['MLBNEW2', 138]]);
    expect(reg.estoqueTransferido).toBe(438);
    expect(ml.updateItem).toHaveBeenCalledWith('MLBNEW1', { available_quantity: 300, status: 'active' });
    expect(ml.updateItem).toHaveBeenCalledWith('MLBNEW2', { available_quantity: 138, status: 'active' });
    expect(ml.updateItem).toHaveBeenCalledWith(item.id, { status: 'closed' });
    expect(ml.createItemDescription).toHaveBeenCalledTimes(2);
  });

  it('variacao sem estoque no original nao e ativada', async () => {
    ml.getItemFull.mockResolvedValue({ ...item, variations: [{ ...item.variations[0], available_quantity: 0 }, item.variations[1]] });
    const sim = await simularRecriacao(item.id);
    await executarRecriacao(sim.token);
    expect(ml.updateItem).not.toHaveBeenCalledWith('MLBNEW1', expect.anything());
    expect(ml.updateItem).toHaveBeenCalledWith('MLBNEW2', { available_quantity: 138, status: 'active' });
  });

  it('sonda criando um teste por variacao e reaproveita todos na execucao', async () => {
    const sim = await simularRecriacao(item.id);
    const s = await sondarRecriacao(sim.token);
    expect(s.itens).toHaveLength(2);
    expect(s.veredicto).toBe('zera');
    const reg = await executarRecriacao(sim.token);
    expect(ml.createItem).toHaveBeenCalledTimes(2); // so os da sondagem — nenhum duplicado
    expect(reg.itensNovos?.map((i) => i.id)).toEqual(['MLBNEW1', 'MLBNEW2']);
  });

  it('se a criacao do 2o anuncio falha na execucao, o 1o fica registrado como parcial', async () => {
    const sim = await simularRecriacao(item.id);
    ml.createItem.mockReset();
    ml.createItem.mockResolvedValueOnce({ id: 'MLBNEW1' }).mockRejectedValueOnce(new Error('boom'));
    const reg = await executarRecriacao(sim.token);
    expect(reg.status).toBe('parcial');
    expect(reg.itemNovo).toBe('MLBNEW1');
    expect(reg.erro).toContain('boom');
    expect(ml.updateItem).not.toHaveBeenCalledWith(item.id, expect.anything()); // antigo intacto
  });

  it('se a sondagem falha no meio, fecha os testes que ja nasceram', async () => {
    const sim = await simularRecriacao(item.id);
    ml.createItem.mockReset();
    ml.createItem.mockResolvedValueOnce({ id: 'MLBNEW1' }).mockRejectedValueOnce(new Error('boom'));
    await expect(sondarRecriacao(sim.token)).rejects.toThrow('boom');
    expect(ml.closeItem).toHaveBeenCalledWith('MLBNEW1');
  });
});
