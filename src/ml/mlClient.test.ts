import { describe, expect, it } from 'vitest';
import { mensagemDeErro } from './mlClient';

describe('mensagemDeErro', () => {
  it('junta codigo e frase quando o ML poe a frase em "error"', () => {
    // Resposta real do ML ao validar um clone com title junto de family_name.
    const bruto = {
      cause: [],
      message: 'body.invalid_fields',
      error: 'The fields [title] are invalid for requested call.',
      status: 400,
    };
    expect(mensagemDeErro(bruto, 400)).toBe('body.invalid_fields: The fields [title] are invalid for requested call.');
  });

  it('funciona com a convencao inversa (frase em "message")', () => {
    const bruto = { message: 'Item not found', error: 'not_found', status: 404 };
    expect(mensagemDeErro(bruto, 404)).toBe('not_found: Item not found');
  });

  it('usa o que houver quando so um campo vem preenchido', () => {
    expect(mensagemDeErro({ error: 'forbidden' }, 403)).toBe('forbidden');
    expect(mensagemDeErro({ message: 'Sem permissao para o recurso' }, 403)).toBe('Sem permissao para o recurso');
  });

  it('cai no status quando o ML nao manda nada legivel', () => {
    expect(mensagemDeErro({}, 500)).toBe('Erro HTTP 500');
    expect(mensagemDeErro(null, 502)).toBe('Erro HTTP 502');
  });
});
