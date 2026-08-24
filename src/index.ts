import { config } from './config';
import { logger } from './logger';
import { buildServer } from './server';

async function main(): Promise<void> {
  const app = buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });

  logger.info(`ml-actions ${config.appVersion} rodando em http://localhost:${config.port}`);
  logger.info(`Painel: http://localhost:${config.port}/`);

  if (config.recreateEnabled) {
    logger.warn('[ESCRITA] RECREATE_ENABLED=true — este servico PODE criar e fechar anuncios no Mercado Livre.');
  } else {
    logger.info('[ESCRITA] Desligada (RECREATE_ENABLED nao e "true"). O servico simula, mas nao altera nada.');
  }
  if (config.recreateEnabled && !config.serviceApiKey) {
    logger.warn('[SEGURANCA] Escrita ligada SEM SERVICE_API_KEY: quem alcancar o dominio pode recriar anuncios.');
  }
  if (!config.analyticsBaseUrl) {
    logger.info('[CANDIDATOS] ANALYTICS_BASE_URL vazio: a lista de candidatos fica indisponivel (use o MLB manual).');
  }
}

main().catch((err) => {
  logger.error('Falha ao iniciar o servidor:', err);
  process.exit(1);
});
