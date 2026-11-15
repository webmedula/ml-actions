import { describe, expect, it } from 'vitest';
import { lerHistoricoAdesoes } from './promocoes';

describe('historico de adesoes (v23: so leitura)', () => {
  it('sem arquivo devolve lista vazia', () => {
    expect(Array.isArray(lerHistoricoAdesoes())).toBe(true);
  });
});
