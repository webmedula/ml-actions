import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * v15 — salvaguarda F: validacao que passou SO com avisos exige sondagem antes de executar.
 *
 * O config e lido na importacao, entao a escrita precisa estar ligada antes de qualquer import.
 */
vi.hoisted(() => {
  process.env.RECREATE_ENABLED = 'true';
  process.env.DATA_DIR = require('node:fs').mkdtempSync(
    require('node:path').join(require('node:os').tmpdir(), 'ml-actions-test-'),
  );
});

const ml = vi.hoisted(() => ({
  getItemFull: vi.fn(),
  getItemDescription: vi.fn(),
  getRating: vi.fn(),
  getUserProductId: vi.fn(),
  validateItemPayload: vi.fn(),
  createItem: vi.fn(),
  createItemDescription: vi.fn(),
  updateItem: vi.fn(),
  closeItem: vi.fn(),
  deleteItem: vi.fn(),
}));

vi.mock('../ml/mlClient', async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, ...ml };
});

import { interpretarValidacao } from '../ml/mlClient';
import { executarRecriacao, simularRecriacao, sondarRecriacao, descartarSondagem } from './listingRecreate';

const item = {
  id: 'MLB7418169626',
  title: 'Par Lanterna Traseira',
  family_name: 'Par Lanterna Traseira',
  category_id: 'MLB456168',
  price: 199.99,
  currency_id: 'BRL',
  available_quantity: 139,
  sold_quantity: 114,
  listing_type_id: 'gold_special',
  shipping: { mode: 'me2', free_shipping: true, local_pick_up: false },
  pictures: [{ id: 'P1' }],
  attributes: [{ id: 'BRAND', value_name: 'X' }],
};

const soAvisos = interpretarValidacao(400, {
  error: 'validation_error',
  cause: [{ type: 'warning', code: 'item.shipping.mandatory_free_shipping', message: 'Mandatory free shipping added' }],
});

beforeEach(() => {
  Object.values(ml).forEach((f) => f.mockReset());
  ml.getItemFull.mockResolvedValue(item);
  ml.getItemDescription.mockResolvedValue('descricao');
  ml.getRating.mockResolvedValue({ ratingAverage: 3.8, total: 5 });
  ml.getUserProductId.mockImplementation(async (id: string) => ({
    userProductId: id === 'MLB7418169626' ? 'MLBU1' : 'MLBU2',
    fonte: 'teste',
  }));
  ml.createItem.mockResolvedValue({ id: 'MLB999' });
  ml.updateItem.mockResolvedValue({});
  ml.closeItem.mockResolvedValue({});
  ml.deleteItem.mockResolvedValue({});
});

describe('v15: executar exige sondagem quando a validacao so passou com avisos', () => {
  it('recusa executar sem sondar, e nao cria nada', async () => {
    ml.validateItemPayload.mockResolvedValue(soAvisos);
    const sim = await simularRecriacao('MLB7418169626');
    expect(sim.validacao.ok).toBe(true);
    expect(sim.exigeSondagem).toBe(true);

    await expect(executarRecriacao(sim.token)).rejects.toThrow(/Sonde antes de executar/);
    expect(ml.createItem).not.toHaveBeenCalled();
    expect(ml.updateItem).not.toHaveBeenCalled();
  });

  it('depois de uma sondagem que zera, executa reaproveitando o anuncio de teste', async () => {
    ml.validateItemPayload.mockResolvedValue(soAvisos);
    const sim = await simularRecriacao('MLB7418169626');
    const sondagem = await sondarRecriacao(sim.token);
    expect(sondagem.veredicto).toBe('zera');

    const r = await executarRecriacao(sim.token);
    expect(r.status).toBe('sucesso');
    expect(r.itemNovo).toBe('MLB999');
    expect(ml.createItem).toHaveBeenCalledTimes(1); // so o da sondagem
  });

  it('descartar a sondagem volta a bloquear a execucao', async () => {
    ml.validateItemPayload.mockResolvedValue(soAvisos);
    const sim = await simularRecriacao('MLB7418169626');
    await sondarRecriacao(sim.token);
    await descartarSondagem(sim.token);
    await expect(executarRecriacao(sim.token)).rejects.toThrow(/Sonde antes de executar/);
  });

  it('validacao limpa (2xx) continua permitindo executar sem sondar, como na v14', async () => {
    ml.validateItemPayload.mockResolvedValue(interpretarValidacao(204, undefined));
    const sim = await simularRecriacao('MLB7418169626');
    expect(sim.exigeSondagem).toBe(false);
    const r = await executarRecriacao(sim.token);
    expect(r.status).toBe('sucesso');
  });

  it('validacao com erro real continua bloqueando sondagem e execucao', async () => {
    ml.validateItemPayload.mockResolvedValue(
      interpretarValidacao(400, { error: 'validation_error', cause: [{ type: 'error', code: 'x', message: 'y' }] }),
    );
    const sim = await simularRecriacao('MLB7418169626');
    expect(sim.validacao.ok).toBe(false);
    await expect(sondarRecriacao(sim.token)).rejects.toThrow(/nao passou na validacao/);
    await expect(executarRecriacao(sim.token)).rejects.toThrow(/nao passou na validacao/);
    expect(ml.createItem).not.toHaveBeenCalled();
  });
});

// Limpeza do diretorio temporario de historico.
process.on('exit', () => {
  const dir = process.env.DATA_DIR;
  if (dir && dir.startsWith(os.tmpdir())) fs.rmSync(path.resolve(dir), { recursive: true, force: true });
});
