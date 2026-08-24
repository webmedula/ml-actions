import { FastifyInstance } from 'fastify';
import { buildMlAuthorizationUrl, exchangeMlCodeForToken, getMlAuthStatus, isValidMlState } from '../ml/mlOauthClient';
import { logger } from '../logger';

export async function mlOauthRoutes(app: FastifyInstance): Promise<void> {
  // Fluxo de login do Mercado Livre (rotas de navegador, sem x-api-key).
  app.get('/oauth/ml/login', async (_req, reply) => {
    reply.redirect(buildMlAuthorizationUrl());
  });

  app.get('/oauth/ml/callback', async (req, reply) => {
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };

    if (error) {
      reply.code(400).type('text/html').send(`<h1>Falha na autorizacao do Mercado Livre</h1><p>${error}</p>`);
      return;
    }
    if (!code || !isValidMlState(state)) {
      reply.code(400).type('text/html').send('<h1>Requisicao invalida</h1><p>Codigo ou state ausente/invalido. Tente novamente em /oauth/ml/login.</p>');
      return;
    }

    try {
      await exchangeMlCodeForToken(code);
      reply.redirect('/?ml_oauth=success');
    } catch (err: any) {
      logger.error('[ML OAUTH] Falha ao trocar codigo por token:', err.message);
      reply.code(500).type('text/html').send(`<h1>Falha ao concluir login no Mercado Livre</h1><p>${err.message}</p>`);
    }
  });

  app.get('/api/oauth/ml/status', async () => {
    return getMlAuthStatus();
  });
}
