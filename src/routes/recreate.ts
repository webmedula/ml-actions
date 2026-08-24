import { FastifyInstance } from 'fastify';
import { config } from '../config';
import { buscarCandidatos } from '../core/candidates';
import {
  descartarSondagem,
  executarRecriacao,
  lerHistorico,
  RecriacaoBloqueada,
  simularRecriacao,
  sondarRecriacao,
} from '../core/listingRecreate';
import { getMlAuthStatus } from '../ml/mlOauthClient';

export async function recreateRoutes(app: FastifyInstance): Promise<void> {
  function exigeAuth(reply: any): boolean {
    if (getMlAuthStatus().authenticated) return true;
    reply.code(409).send({ mensagem: 'Mercado Livre nao autorizado. Acesse /oauth/ml/login para conectar.' });
    return false;
  }

  /** Estado do servico: se a escrita esta liberada e se o analytics esta alcancavel. */
  app.get('/api/status', async () => {
    return {
      versao: config.appVersion,
      escritaHabilitada: config.recreateEnabled,
      mlAutenticado: getMlAuthStatus().authenticated,
      analyticsConfigurado: !!config.analyticsBaseUrl,
    };
  });

  /** Candidatos vindos do ml-analytics. Se ele nao responder, o painel cai pro MLB manual. */
  app.get('/api/candidates', async () => {
    return buscarCandidatos();
  });

  /** Passo 1: SIMULA. Le o anuncio, monta o clone e manda o ML validar. Nao escreve nada. */
  app.post('/api/listings/:itemId/recreate/simulate', async (req, reply) => {
    if (!exigeAuth(reply)) return;
    const { itemId } = req.params as { itemId: string };
    const body = (req.body as { sufixoTitulo?: string; familyName?: string }) || {};
    try {
      const sim = await simularRecriacao(itemId, { sufixoTitulo: body.sufixoTitulo, familyName: body.familyName });
      return { ...sim, escritaHabilitada: config.recreateEnabled };
    } catch (err: any) {
      reply.code(err?.status === 404 ? 404 : 500);
      return { mensagem: err?.message || 'Erro ao simular a recriacao' };
    }
  });

  /**
   * Passo 2 (opcional, mas o que resolve a duvida): SONDA.
   * Cria o clone pausado com estoque 1 e compara o produto do usuario dele com o do original.
   * MLBU diferente = recriar zera. MLBU igual = a nota viria junto, descarte o teste.
   * O anuncio original nao e tocado em nenhum caso.
   */
  app.post('/api/listings/recreate/probe', async (req, reply) => {
    if (!exigeAuth(reply)) return;
    const { token } = (req.body as { token?: string }) || {};
    if (!token) {
      reply.code(400);
      return { mensagem: 'Informe o token da simulacao.' };
    }
    try {
      return await sondarRecriacao(token);
    } catch (err: any) {
      reply.code(err instanceof RecriacaoBloqueada ? 409 : 500);
      return { mensagem: err?.message || 'Erro ao sondar' };
    }
  });

  /** Descarta o anuncio de teste da sondagem. Fecha e apaga; o original segue intacto. */
  app.post('/api/listings/recreate/discard', async (req, reply) => {
    if (!exigeAuth(reply)) return;
    const { token } = (req.body as { token?: string }) || {};
    if (!token) {
      reply.code(400);
      return { mensagem: 'Informe o token da simulacao.' };
    }
    try {
      return await descartarSondagem(token);
    } catch (err: any) {
      reply.code(err instanceof RecriacaoBloqueada ? 409 : 500);
      return { mensagem: err?.message || 'Erro ao descartar a sondagem' };
    }
  });

  /** Passo 3: EXECUTA. Escrita real e irreversivel. Exige simulacao valida + confirmacao + flag. */
  app.post('/api/listings/recreate/execute', async (req, reply) => {
    if (!exigeAuth(reply)) return;
    const { token, confirmacao } = (req.body as { token?: string; confirmacao?: string }) || {};
    if (!token) {
      reply.code(400);
      return { mensagem: 'Informe o token da simulacao.' };
    }
    // Confirmacao explicita: evita que um POST acidental (ou um clique duplo) recrie um anuncio.
    if (confirmacao !== 'RECRIAR') {
      reply.code(400);
      return { mensagem: 'Confirmacao ausente. Envie confirmacao: "RECRIAR" para executar.' };
    }
    try {
      const registro = await executarRecriacao(token);
      reply.code(registro.status === 'sucesso' ? 200 : 207);
      return registro;
    } catch (err: any) {
      reply.code(err instanceof RecriacaoBloqueada ? 409 : 500);
      return { mensagem: err?.message || 'Erro ao executar a recriacao' };
    }
  });

  /** Historico das recriacoes, com o snapshot do anuncio antigo pra reverter a mao. */
  app.get('/api/listings/recreations', async () => {
    return { escritaHabilitada: config.recreateEnabled, items: lerHistorico() };
  });
}
