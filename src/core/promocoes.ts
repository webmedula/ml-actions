import fs from 'node:fs';
import { config } from '../config';

/**
 * HISTORICO DAS ADESOES A PROMOCOES FEITAS PELO ml-actions (v21 a v22).
 *
 * v23: a adesao saiu daqui. Ela mora na aba Promocoes do ml-analytics (v39+), que mostra o "voce recebe"
 * e a promocao em vigor ao lado. Ter dois botoes para a mesma escrita no ML confundia e dobrava a manutencao.
 * Fica so a leitura do historico antigo (data/promocoes-adesoes.json), que o Gerente IA junta com o do analytics.
 */

export interface RegistroAdesao {
  quando: string;
  itemId: string;
  titulo: string | null;
  tipo: string;
  promocaoId: string | null;
  nome: string | null;
  corpo: Record<string, unknown>;
  precoFinal: number | null;
  status: 'sucesso' | 'erro';
  respostaMl: unknown;
  erro: string | null;
}

export function lerHistoricoAdesoes(): RegistroAdesao[] {
  try {
    return fs.existsSync(config.promocoesHistoricoPath) ? JSON.parse(fs.readFileSync(config.promocoesHistoricoPath, 'utf-8')) : [];
  } catch {
    return [];
  }
}
