import { FastifyInstance } from 'fastify';
import { lerHistoricoAdesoes } from '../core/promocoes';

/**
 * v23: so o historico das adesoes antigas (leitura, usado pelo Gerente IA). A adesao em si fica na aba
 * Promocoes do ml-analytics.
 */
export async function promocoesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/promocoes-historico', async () => ({
    escritaHabilitada: false,
    aviso: 'A adesao a promocoes saiu do ml-actions (v23). Use a aba Promocoes do ml-analytics.',
    items: lerHistoricoAdesoes(),
  }));
}
