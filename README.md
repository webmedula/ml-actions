# ml-actions

Serviço de **ações de escrita** no Mercado Livre. Hoje faz uma coisa só: **recriar um anúncio**
para zerar a pontuação de opiniões.

Existe separado do `ml-analytics` de propósito. O analytics é somente leitura — um bug lá produz
um gráfico errado. Aqui um bug pode fechar um anúncio. São classes de risco diferentes e não
deveriam dividir o mesmo processo, o mesmo deploy nem o mesmo token do Mercado Livre.

```
tiny/
├── tiny-pedidos-nf   emite NF          (não encoste)
├── ml-analytics      só leitura        (dashboard, diagnóstico de notas)
└── ml-actions        escreve no ML     (este serviço)
```

## O que ele faz

O operador escolhe **um** anúncio — da lista de candidatos que vem do `ml-analytics`, ou digitando
o MLB. Nada roda por varredura automática.

São três passos separados, sempre:

1. **Simular** — lê o anúncio, monta o clone e manda o **próprio Mercado Livre validar** o payload
   (`POST /items/validate`). Não escreve nada. Mostra o que seria criado, os avisos e o custo.
2. **Sondar** — cria o clone **pausado, com estoque 1**, e lê o produto do usuário (`MLBU...`) que
   o ML atribuiu a ele. Se for diferente do original, recriar zera a nota. Se for o mesmo, a nota
   viria junto e não adianta — descarte o teste. O anúncio original não é tocado em nenhum caso.
3. **Executar** — libera o anúncio novo com o estoque real e fecha o antigo. Escrita real.
   Quando houve sondagem, reaproveita o anúncio dela: sondar e depois executar **não** cria dois.

A tela de simulação mostra o contraponto antes do botão: quantas avaliações 5 estrelas
recuperariam a nota **sem** recriar. Com nota 4,0 e 1 opinião, é 1 — e o painel diz isso.

## Antes de recriar qualquer coisa: a nota mora onde?

Recriar só zera a nota se a opinião estiver presa ao **item** (MLB). Se o anúncio for de catálogo,
ou se o ML o sincronizou com um produto de catálogo, a opinião mora no **produto** e é
compartilhada até com concorrentes — o anúncio novo nasce com as mesmas estrelas e você jogou
fora o histórico de vendas à toa.

Quem classifica isso é o `ml-analytics` (`/api/ratings`). Este serviço consome o resultado.

Há um terceiro caso, descoberto em 2026-08-20 nos dados reais da conta: anúncios da lista geral
cujas opiniões estão agrupadas num **produto do usuário** (`MLBU...`). Aí a opinião é só sua — mas
zerar depende de o anúncio novo receber um `MLBU` diferente, e quem decide isso é o ML, pelos
atributos do anúncio. **É exatamente para isso que existe a sondagem.** O diagnóstico marca esses
casos como `depende_do_user_product` em vez de prometer que recriar resolve.

## Salvaguardas

1. `RECREATE_ENABLED` **desligado por padrão**. Sem ele o serviço simula e valida, mas o botão de
   executar nem aparece. Dá pra rodar em produção com risco zero enquanto você confere os clones.
2. Executar exige três coisas juntas: token de uma simulação válida (30 min), `confirmacao: "RECRIAR"`
   no corpo, e a flag ligada.
3. Se a sondagem concluiu que a nota **não** zera, executar é recusado. Não dá pra jogar fora o
   histórico por engano depois de a evidência dizer que não adianta.
4. Retry de `429` só em `GET`. Num `POST`, o 429 pode chegar depois de o ML já ter criado o
   anúncio — repetir criaria duplicado.
5. Falha depois da criação registra `parcial` e **para**. O serviço não tenta desfazer sozinho: um
   rollback automático errado no meio da virada é pior que um estado conhecido e registrado.
6. Todo histórico vai pra `data/recreations.json` **com o snapshot do anúncio antigo**, que é o que
   permite reverter à mão.
7. *(v15)* Se o ML aprovou o clone **só com avisos** (responde 400, mas nenhuma causa é `error`),
   executar exige uma **sondagem** antes. "Passou com avisos" é evidência mais fraca que "passou":
   a sondagem cria o anúncio pausado e prova que o ML aceita, sem tocar no original.

## Configurar

### 1. Aplicativo próprio no Mercado Livre

Precisa ser um app **novo**, separado do `ml-analytics` e do `tiny-pedidos-nf`. O ML mantém ~1
token por usuário+app: dois serviços no mesmo app derrubam o login um do outro.

Em https://developers.mercadolivre.com.br/ crie o aplicativo e cadastre como URI de redirect a URL
pública deste serviço + `/oauth/ml/callback`.

O app precisa de permissão de **escrita** em anúncios (`write`), diferente do analytics.

### 2. Variáveis

```bash
cp .env.example .env
```

| Variável | Para quê |
|---|---|
| `ML_CLIENT_ID` / `ML_CLIENT_SECRET` / `ML_REDIRECT_URI` | o app próprio deste serviço |
| `SERVICE_API_KEY` | protege `/api/*`. **Não rode sem**, este serviço escreve |
| `RECREATE_ENABLED` | `true` libera a escrita. Comece com `false` |
| `ANALYTICS_BASE_URL` / `ANALYTICS_API_KEY` | onde buscar os candidatos |
| `PORT` | padrão `3011` |

Sem `ANALYTICS_BASE_URL` o serviço continua funcionando — só perde a lista de candidatos, e você
digita o MLB à mão.

### 3. Rodar

```bash
npm install
npm run dev     # http://localhost:3011
npm test
```

### 4. Deploy (EasyPanel)

`push` na `main` builda e publica `ghcr.io/webmedula/ml-actions:latest`.

No projeto `tiny`, crie um **terceiro serviço** apontando pra essa imagem, com domínio próprio,
volume próprio em `/app/data` e as variáveis acima. Depois do deploy, acesse a URL e conecte ao
Mercado Livre uma vez.

## Endpoints

| Rota | O que faz |
|---|---|
| `GET /health` | status, versão, se a escrita está ligada |
| `GET /api/status` | o mesmo, para o painel |
| `GET /api/candidates` | candidatos vindos do ml-analytics |
| `POST /api/listings/:id/recreate/simulate` | **não escreve**: monta o clone e valida no ML |
| `POST /api/listings/recreate/probe` | cria o clone pausado e compara o produto do usuário |
| `POST /api/listings/recreate/discard` | fecha e apaga o clone de teste da sondagem |
| `POST /api/listings/recreate/execute` | escrita real (exige token + confirmação + flag) |
| `GET /api/listings/recreations` | histórico com snapshot do anúncio antigo |
| `GET /oauth/ml/login` | conecta ao Mercado Livre |

## O que ainda é manual

**O vínculo SKU ↔ MLB no Tiny.** Depois de uma recriação bem-sucedida, o painel avisa — mas quem
atualiza é você. Enquanto não atualizar, estoque, preço e emissão de NF param de sincronizar
naquele SKU. Automatizar isso exige mexer no `tiny-pedidos-nf`, que é o serviço que emite nota.

## Histórico de versões

### actions v15 (2026-09-24)

Motivo: o `MLB7418169626` ficou travado em "O Mercado Livre rejeitou o clone" — mas as 8 mensagens
eram **todas `warning`**. O `/items/validate` responde `400 validation_error` mesmo sem nenhum erro
real, e a v14 descartava o `type` de cada causa, então aviso e recusa eram indistinguíveis.

- **Erro × aviso.** O `type` das causas agora é preservado. `ok` passa a ser "nenhuma causa é
  `error`". Regra restrita: só vale para `400` com `error: "validation_error"`, com causas, todas
  `warning`. Causa sem `type`, outro status ou 400 sem causas continuam sendo recusa.
- **Painel.** Três estados: ✅ validado · ⚠️ aprovado com avisos · ❌ rejeitado (mostra só o que
  bloqueia; avisos ficam num bloco à parte).
- **Salvaguarda 7.** Aprovado só com avisos → executar exige sondagem. O botão "Recriar sem sondar"
  some e o servidor recusa pulando etapa.
- **Atributos de embalagem.** `PACKAGE_*` e `SHIPMENT_PACKING` não são mais enviados (o ML calcula
  e ignorava, gerando 6 avisos).
- **Frete grátis obrigatório.** O aviso de margem só aparece se o original **não** tinha frete
  grátis.
- **"Descobrir formato".** Usa o `type`: formas com só avisos aparecem como aceitas.
- Testado e descartado: tirar `shipping.dimensions` não muda nada — o aviso `lost_me1_by_user`
  vem da conta, não do payload.
- Testes: 64 → 82.
