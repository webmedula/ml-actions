import 'dotenv/config';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || './data';

export const config = {
  /** Versao — atualize a cada release. Exibida no cabecalho e em /health, sempre vinda do SERVIDOR. */
  appVersion: 'actions v2 (2026-08-20)',

  port: Number(process.env.PORT || 3011),
  serviceApiKey: process.env.SERVICE_API_KEY || '',

  // Aplicativo PROPRIO deste servico no Mercado Livre.
  // Precisa ser um app SEPARADO do ml-analytics e do tiny-pedidos-nf: o ML mantem ~1 token por
  // usuario+app, entao dois servicos no mesmo app derrubam o login um do outro.
  mlClientId: process.env.ML_CLIENT_ID || '',
  mlClientSecret: process.env.ML_CLIENT_SECRET || '',
  mlRedirectUri: process.env.ML_REDIRECT_URI || 'http://localhost:3011/oauth/ml/callback',
  mlAuthUrl: 'https://auth.mercadolivre.com.br/authorization',
  mlTokenUrl: 'https://api.mercadolibre.com/oauth/token',
  mlApiBaseUrl: 'https://api.mercadolibre.com',

  /**
   * TRAVA MESTRA DA ESCRITA. Desligada, este servico le, simula e valida — mas nao cria nem fecha
   * nada no Mercado Livre. Ligue so quando quiser de fato agir: RECREATE_ENABLED=true
   */
  recreateEnabled: String(process.env.RECREATE_ENABLED || '').toLowerCase() === 'true',

  /** Nota de corte usada so pra mostrar o contraponto ("quantas notas 5 resolveriam sem recriar"). */
  ratingsMinScore: Number(process.env.RATINGS_MIN_SCORE || 4.5),

  /**
   * De onde vem a lista de candidatos. O ml-analytics ja varre as notas e classifica quem e
   * recriavel; aqui so consumimos esse resultado em vez de repetir a varredura.
   * Ex: https://analytics.seudominio.com.br  (vazio = este servico funciona so por MLB digitado)
   */
  analyticsBaseUrl: (process.env.ANALYTICS_BASE_URL || '').replace(/\/+$/, ''),
  analyticsApiKey: process.env.ANALYTICS_API_KEY || '',

  dataDir,
  mlTokenStorePath: path.join(dataDir, 'ml-token.json'),
  recreationsPath: path.join(dataDir, 'recreations.json'),
};
