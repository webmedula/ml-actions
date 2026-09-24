import { describe, expect, it } from 'vitest';
import { extrairCausasTipadas, interpretarValidacao, mensagemDeErro } from './mlClient';

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

// --- v15: tipo das causas e regra de aceite do /items/validate ---

describe('extrairCausasTipadas', () => {
  it('preserva o type de cada causa', () => {
    const c = extrairCausasTipadas({
      cause: [
        { type: 'warning', code: 'a', message: 'aviso' },
        { type: 'error', code: 'b', message: 'erro' },
        { code: 'c', message: 'sem tipo' },
        'texto solto',
      ],
    });
    expect(c.map((x) => x.tipo)).toEqual(['warning', 'error', 'desconhecido', 'desconhecido']);
    expect(c[0].texto).toBe('a: aviso');
  });
});

describe('interpretarValidacao', () => {
  const warn = (code: string) => ({ type: 'warning', code, message: code });
  const err = (code: string) => ({ type: 'error', code, message: code });

  it('2xx passa sem ressalva', () => {
    const v = interpretarValidacao(204, undefined);
    expect(v).toMatchObject({ ok: true, soAvisos: false, erros: [] });
  });

  it('400 validation_error so com warnings passa, marcado como soAvisos (caso real MLB7418169626)', () => {
    const v = interpretarValidacao(400, {
      message: 'Validation error', error: 'validation_error', status: 400,
      cause: [warn('shipping.lost_me1_by_user'), warn('item.shipping.mandatory_free_shipping')],
    });
    expect(v.ok).toBe(true);
    expect(v.soAvisos).toBe(true);
    expect(v.avisos).toHaveLength(2);
    expect(v.erros).toEqual([]);
  });

  it('um unico error entre warnings recusa, e so o error aparece como bloqueio', () => {
    const v = interpretarValidacao(400, {
      error: 'validation_error', cause: [warn('w1'), err('item.attribute.missing_conditional_required')],
    });
    expect(v.ok).toBe(false);
    expect(v.erros).toEqual(['item.attribute.missing_conditional_required']);
    expect(v.avisos).toEqual(['w1']);
  });

  it('causa sem type conta como erro, por seguranca', () => {
    const v = interpretarValidacao(400, { error: 'validation_error', cause: [{ code: 'x', message: 'y' }] });
    expect(v.ok).toBe(false);
  });

  it('400 sem causas recusa, com a mensagem do topo', () => {
    const v = interpretarValidacao(400, { message: 'body.invalid_fields', error: 'The fields [title] are invalid for requested call.' });
    expect(v.ok).toBe(false);
    expect(v.erros[0]).toContain('[title]');
  });

  it('400 com so warnings mas error diferente de validation_error recusa', () => {
    const v = interpretarValidacao(400, { error: 'bad_request', cause: [warn('w')] });
    expect(v.ok).toBe(false);
  });

  it('outros status (403, 500) com so warnings recusam', () => {
    expect(interpretarValidacao(403, { error: 'validation_error', cause: [warn('w')] }).ok).toBe(false);
    expect(interpretarValidacao(500, { error: 'validation_error', cause: [warn('w')] }).ok).toBe(false);
  });
});
