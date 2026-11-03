import { FastifyInstance } from 'fastify';
import { config } from '../config';
import { AdesaoBloqueada, aderir, lerHistoricoAdesoes, listarPromocoes, simularAdesao } from '../core/promocoes';
import { getMlAuthStatus } from '../ml/mlOauthClient';

/** v21: adesao a promocoes do ML. Simular nao escreve; aderir exige token + "ADERIR" + flag. */
export async function promocoesRoutes(app: FastifyInstance): Promise<void> {
  function exigeAuth(reply: any): boolean {
    if (getMlAuthStatus().authenticated) return true;
    reply.code(409).send({ mensagem: 'Mercado Livre nao autorizado. Acesse /oauth/ml/login para conectar.' });
    return false;
  }

  app.get('/api/promocoes/:itemId', async (req, reply) => {
    if (!exigeAuth(reply)) return;
    const { itemId } = req.params as { itemId: string };
    try {
      return { itemId, escritaHabilitada: config.promocoesEnabled, promocoes: await listarPromocoes(itemId.toUpperCase()) };
    } catch (err: any) {
      reply.code(err?.status === 403 ? 403 : 500);
      return { mensagem: err?.status === 403 ? 'O ML recusou ler promocoes com o app do ml-actions: ligue a permissao de promocoes no DevCenter e refaca o login.' : err?.message || 'Erro ao ler promocoes' };
    }
  });

  app.post('/api/promocoes/simular', async (req, reply) => {
    if (!exigeAuth(reply)) return;
    const b = (req.body as any) || {};
    try {
      return await simularAdesao(b.itemId, { promocaoId: b.promocaoId, tipo: b.tipo, preco: b.preco, estoque: b.estoque });
    } catch (err: any) {
      reply.code(err instanceof AdesaoBloqueada ? 400 : err?.status === 404 ? 404 : 500);
      return { mensagem: err?.message || 'Erro ao simular a adesao' };
    }
  });

  app.post('/api/promocoes/aderir', async (req, reply) => {
    if (!exigeAuth(reply)) return;
    const { token, confirmacao } = (req.body as { token?: string; confirmacao?: string }) || {};
    if (!token) {
      reply.code(400);
      return { mensagem: 'Informe o token da simulacao.' };
    }
    if (confirmacao !== 'ADERIR') {
      reply.code(400);
      return { mensagem: 'Confirmacao ausente. Envie confirmacao: "ADERIR".' };
    }
    try {
      const r = await aderir(token);
      reply.code(r.status === 'sucesso' ? 200 : 502);
      return r.status === 'sucesso' ? r : { ...r, mensagem: r.erro };
    } catch (err: any) {
      reply.code(err instanceof AdesaoBloqueada ? 409 : 500);
      return { mensagem: err?.message || 'Erro ao aderir' };
    }
  });

  app.get('/api/promocoes-historico', async () => ({ escritaHabilitada: config.promocoesEnabled, items: lerHistoricoAdesoes() }));
}
