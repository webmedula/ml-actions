import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config';
import { logger } from './logger';
import { healthRoutes } from './routes/health';
import { mlOauthRoutes } from './routes/mlOauth';
import { recreateRoutes } from './routes/recreate';

export function buildServer() {
  const app = Fastify({ logger: false });

  // Trata corpo JSON vazio como ausente (POST sem body pra disparar acao) em vez de erro.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (!text) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      (err as any).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  app.register(fastifyStatic, { root: path.join(__dirname, '..', 'public'), prefix: '/' });

  // Protege /api/* com x-api-key (rotas de /oauth/* e /health ficam livres).
  // Este servico ESCREVE no Mercado Livre: rodar sem SERVICE_API_KEY deixa as acoes abertas a
  // quem alcancar o dominio. O aviso no boot existe pra isso nao passar batido.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (!config.serviceApiKey) return;

    if (req.headers['x-api-key'] !== config.serviceApiKey) {
      reply.code(401).send({ mensagem: 'x-api-key invalida ou ausente' });
    }
  });

  app.register(healthRoutes);
  app.register(mlOauthRoutes);
  app.register(recreateRoutes);

  app.setErrorHandler((err, _req, reply) => {
    logger.error('Erro nao tratado:', err.message, err.stack);
    reply.code((err as any).status || 500).send({ mensagem: err.message || 'Erro interno' });
  });

  return app;
}
