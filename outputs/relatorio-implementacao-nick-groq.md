# Relatório de implementação — Nick com Groq API

**Data:** 4 de novembro de 2026  
**Projeto:** TokitoBot V10

## Resultado

A Nick foi integrada como rota adicional e independente, usando o endpoint compatível com OpenAI da Groq API e o modelo configurável `qwen/qwen3.8-27b`. Ela só inicia uma resposta quando a mensagem chama diretamente “Nick” ou “Nickzinha” (com variações de caixa, acentos e pontuação), ou quando a pessoa responde a uma mensagem da Nick enviada pelo processo atual. Mensagens sem chamada permanecem silenciosas.

O dispatcher chama a Nick depois dos filtros e eventos dos plugins existentes e antes do caminho que encerra mensagens sem comando. Mensagens identificadas como comando continuam no fluxo anterior. Os plugins de IA e o agente existente não foram substituídos nem editados.

## Arquivos

Foram criados `DADOS_TOKITO/ia/groq.js`, com a comunicação HTTP, leitura de configuração, timeout e controle local de requisições, e `DADOS_TOKITO/ia/nick.js`, com personalidade, detecção, integração ao contexto e proteções contra duplicação/loop. Também foram criados `.env.example` e `.gitignore` para documentar as variáveis e proteger o arquivo `.env` real.

O único arquivo existente editado foi `tokito.js`, com o import do novo handler e uma chamada no dispatcher. Não foram editados `DADOS_TOKITO/ia/index.js`, `DADOS_TOKITO/ia/memoria.js`, os sete plugins em `DADOS_TOKITO/plugins/ia/`, `package.json` ou `package-lock.json`. Nenhuma dependência foi instalada.

A memória é reaproveitada por meio de `DADOS_TOKITO/ia/memoria.js`: o contexto recente do grupo mantém o nome de quem falou, enquanto o histórico de interações com a Nick é consultado pela chave grupo + participante. Os turnos pessoais não são enviados como histórico de outro participante nem de outro grupo. A chamada de acompanhamento pode ocorrer por reply a uma mensagem da Nick reconhecida durante a execução atual.

O controle local limita a Nick a quatro chamadas por minuto e 900 por dia, com até duas chamadas simultâneas, limite de tamanho de contexto e saída de até 180 tokens. Esses são limites do processo local, não uma leitura dos contadores da conta Groq; outros programas que usem a mesma conta podem consumir a cota antes.

## Configuração e ativação

Não foi criado um `.env` real, pois não havia arquivo `.env` nem `GROQ_API_KEY` configurada no ambiente. Para ativar, copie `.env.example` para `.env`, substitua o valor de exemplo pela chave da sua conta e mantenha:

```env
GROQ_API_KEY=sua_chave_real
GROQ_MODEL=qwen/qwen3.8-27b
NICK_ENABLED=true
```

A chave fica fora do código e `.env` está no `.gitignore`. `NICK_ENABLED=false` desativa somente a Nick. Depois de preencher o arquivo, reinicie o bot. No WhatsApp, teste com “Nick, me ajuda com uma coisa” e, para continuar, responda à mensagem que a Nick enviou. Sem a configuração e uma chave válida, não ocorre chamada autenticada à Groq.

## Disponibilidade e limites Groq

A documentação oficial lista `qwen/qwen3.8-27b` como modelo **Preview**, com janela de contexto de 131.072 tokens e máximo de 16.384 tokens de saída. A tabela pública de limites do Free Plan lista 30 requisições por minuto, 1.000 por dia, 8.000 tokens por minuto e 200.000 tokens por dia para esse modelo [1] [2]. A ficha do modelo também publica preços de US$ 0,80 por milhão de tokens de entrada e US$ 4,00 por milhão de tokens de saída [1]. Por ser Preview, a disponibilidade pode mudar; os limites exatos podem variar por organização.

A disponibilidade pública e os limites documentados foram confirmados, mas **não foi possível consultar a conta específica do usuário**, pois não há chave configurada. Por isso, este relatório não afirma que a chave, o modelo ou a cota estão habilitados nessa conta, nem que a conta dispõe de saldo gratuito restante.

## Backup e testes

Antes das edições, foi feito backup de `tokito.js` em `.work/backups/nick-groq-20261104-1339/tokito.js`. O arquivo foi comparado por SHA-256 com o original; hash: `0D01747874515D27959A2DD5F8F3C084E505FF37E2672C604B3365EA9AF92412`.

A suíte local terminou com **9 testes contabilizados, 9 aprovados e 0 falhas**. Os cenários verificaram variações de chamadas e falsos positivos, silêncio sem chamada, comandos com prefixo, desativação independente, continuidade por reply, isolamento de contexto por participante e grupo, deduplicação, erro HTTP, formato/endpoint/modelo/resposta do cliente Groq, falta de chave, timeout e a ordem dos filtros, eventos e dispatch de comandos. As respostas e o transporte HTTP foram simulados; não houve requisição à conta Groq nem envio de mensagens reais ao WhatsApp.

`node --check` passou para os três arquivos de runtime e para o teste local. O smoke test do registro de plugins encontrou as funções públicas de comandos, execução, resolução e eventos, com 1.206 comandos listados. O carregador também emitiu um aviso de alias duplicado `inativos` entre plugins existentes; nenhum plugin foi alterado. Os arquivos JSON de memória temporários usados na suíte foram restaurados; permaneceu somente `.gitkeep` no diretório de memória.

## Referências

[1]: https://console.groq.com/docs/model/qwen/qwen3.8-27b "Ficha oficial Groq do Qwen 3.8 27B"
[2]: https://console.groq.com/docs/rate-limits "Limites oficiais da Groq API"
