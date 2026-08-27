import { describe, expect, it } from 'vitest';
import { candidatosDaFila, candidatosDeRatings } from './candidates';

/**
 * A lista de candidatos e onde alguem clica "Simular". O que entra nela vira, na pratica, um
 * convite a recriar — entao o filtro importa tanto quanto o resto do fluxo.
 */

describe('candidatosDaFila', () => {
  const fila = [
    { itemId: 'A', titulo: 'Recriar', acao: 'recriar', nota: 4, totalAvaliacoes: 900, classificacao: 'recriavel', evidencia: 'x', liquidoEmRisco: 100 },
    { itemId: 'B', titulo: 'Cautela', acao: 'recriar_com_cautela', nota: 4, totalAvaliacoes: 900, classificacao: 'recriavel', evidencia: 'x', liquidoEmRisco: 9000 },
    { itemId: 'C', titulo: 'Sondar', acao: 'sondar', nota: 4, totalAvaliacoes: 20, classificacao: 'indefinido', evidencia: 'x', liquidoEmRisco: 500 },
    { itemId: 'D', titulo: 'Catalogo', acao: 'nao_recriar', nota: 4, totalAvaliacoes: 500, classificacao: 'preso_ao_catalogo', evidencia: 'x', liquidoEmRisco: 30000 },
    { itemId: 'E', titulo: 'Poucas opinioes', acao: 'recuperar_por_avaliacao', nota: 4, totalAvaliacoes: 3, classificacao: 'recriavel', evidencia: 'x', liquidoEmRisco: 500, avaliacoesParaRecuperar: 3 },
  ];

  it('deixa de fora o que recriar nao resolve, por mais que fature', () => {
    const ids = candidatosDaFila(fila).map((c) => c.itemId);
    // D fatura 30 mil e lidera a fila em dinheiro, mas recriar ali nao zera nada: oferecer o
    // botao seria convidar a destruir historico a troco de nada.
    expect(ids).not.toContain('D');
  });

  it('tambem deixa de fora quem se resolve com avaliacao', () => {
    // Nao e "nao ha o que fazer" — e que a providencia certa nao passa por aqui.
    expect(candidatosDaFila(fila).map((c) => c.itemId)).not.toContain('E');
  });

  it('mantem recriar, cautela e sondar', () => {
    expect(candidatosDaFila(fila).map((c) => c.itemId)).toEqual(['A', 'B', 'C']);
  });

  it('preserva a ordem que o analytics enviou — ela ja e a ordem de trabalho', () => {
    const invertida = [...fila].reverse();
    expect(candidatosDaFila(invertida).map((c) => c.itemId)).toEqual(['C', 'B', 'A']);
  });

  it('carrega o dinheiro e a alternativa pra tela poder mostrar', () => {
    const b = candidatosDaFila(fila).find((c) => c.itemId === 'B')!;
    expect(b.liquidoEmRisco).toBe(9000);
    expect(b.acao).toBe('recriar_com_cautela');
  });

  it('item sem acao (analytics de outra versao) passa em vez de sumir', () => {
    const semAcao = [{ itemId: 'X', titulo: 'Sem acao', nota: 4, totalAvaliacoes: 10, classificacao: 'recriavel', evidencia: 'x' }];
    expect(candidatosDaFila(semAcao)).toHaveLength(1);
  });

  it('lista vazia ou ausente nao quebra', () => {
    expect(candidatosDaFila([])).toEqual([]);
    expect(candidatosDaFila(undefined as any)).toEqual([]);
  });
});

describe('candidatosDeRatings (formato antigo)', () => {
  const items = [
    { itemId: 'A', title: 'Recriavel', nota: 4, totalAvaliacoes: 9, classificacao: 'recriavel', evidencia: 'x' },
    { itemId: 'B', title: 'Catalogo', nota: 4, totalAvaliacoes: 9, classificacao: 'preso_ao_catalogo', evidencia: 'x' },
    { itemId: 'C', title: 'Nota ok', nota: 4.9, totalAvaliacoes: 9, classificacao: 'nota_ok', evidencia: 'x' },
    { itemId: 'D', title: 'Depende', nota: 4, totalAvaliacoes: 9, classificacao: 'depende_do_user_product', evidencia: 'x' },
  ];

  it('so passa o que faz sentido recriar', () => {
    expect(candidatosDeRatings(items).map((c) => c.itemId)).toEqual(['A', 'D']);
  });

  it('nao inventa campo de dinheiro que a rota antiga nao tem', () => {
    const a = candidatosDeRatings(items)[0];
    expect(a.liquidoEmRisco).toBeUndefined();
    expect(a.acao).toBeUndefined();
  });
});
