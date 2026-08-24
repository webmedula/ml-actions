import { FastifyInstance } from 'fastify';
import { config } from '../config';
import { getMlAuthStatus } from '../ml/mlOauthClient';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'ml-actions',
      escritaHabilitada: config.recreateEnabled,
      version: config.appVersion,
      mlAuthenticated: getMlAuthStatus().authenticated,
    };
  });
}
