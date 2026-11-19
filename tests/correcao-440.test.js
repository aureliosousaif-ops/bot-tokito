'use strict'
/*
 * Testes isolados da correção do erro 440 do TokitoBot V10.
 *
 * Roda com:  node tests/correcao-440.test.js   (ou  npm run test:440)
 *
 * NÃO utiliza a sessão real do WhatsApp: todos os arquivos de lock e de
 * credenciais usados aqui são criados em pastas temporárias descartáveis.
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const instanciaLock = require(path.join(ROOT, 'DADOS_TOKITO/database/lib/instancia-lock.js'))
const conexaoSegura = require(path.join(ROOT, 'DADOS_TOKITO/database/lib/conexao-segura.js'))
const sessaoWhats = require(path.join(ROOT, 'DADOS_TOKITO/database/lib/sessao-whatsapp.js'))

const resultados = []
const temporarias = []

const pastaTemporaria = rotulo => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tokito-teste-${rotulo}-`))
  temporarias.push(dir)
  return dir
}

const registrar = (nome, funcao) => resultados.push({ nome, funcao })

const esperar = ms => new Promise(resolve => setTimeout(resolve, ms))

// Gera um PID que comprovadamente não existe mais (para testar lock obsoleto).
const obterPidMorto = async () => {
  const filho = spawn(process.execPath, ['-e', 'process.exit(0)'])
  const pid = filho.pid
  await new Promise(resolve => filho.on('close', resolve))
  return pid
}

const executarNode = (args, opcoes = {}) => new Promise(resolve => {
  const filho = spawn(process.execPath, args, { cwd: ROOT, ...opcoes })
  let stdout = ''
  let stderr = ''
  filho.stdout.on('data', d => { stdout += d })
  filho.stderr.on('data', d => { stderr += d })
  filho.on('error', error => resolve({ code: -1, stdout, stderr: String(error) }))
  filho.on('close', code => resolve({ code, stdout, stderr }))
})

// ---------------------------------------------------------------------------
// 1. Lock de instância única
// ---------------------------------------------------------------------------

registrar('1.1 primeira instância adquire o lock', () => {
  const dir = pastaTemporaria('lock1')
  const lock = instanciaLock.adquirir(dir)
  assert.strictEqual(lock.adquirido, true, 'primeira instância deve adquirir o lock')
  assert.ok(fs.existsSync(path.join(dir, 'instancia.lock')), 'arquivo de lock deve existir')
  assert.strictEqual(instanciaLock.estaTravado(dir), true)
  // Reentrada do mesmo processo continua adquirindo (não se bloqueia sozinho).
  const deNovo = instanciaLock.adquirir(dir)
  assert.strictEqual(deNovo.adquirido, true)
  assert.strictEqual(deNovo.jaAdquirido, true)
})

registrar('1.2 segunda instância é bloqueada', async () => {
  const dir = pastaTemporaria('lock2')
  const helper = path.join(__dirname, 'helpers', 'segurar-lock.js')
  const primeiro = spawn(process.execPath, [helper, 'hold', dir], { cwd: ROOT })
  let saida = ''
  let pid = null
  await new Promise((resolve, reject) => {
    const limite = setTimeout(() => reject(new Error('a 1ª instância não iniciou a tempo')), 10000)
    primeiro.stdout.on('data', dados => {
      saida += dados
      try {
        const info = JSON.parse(saida.trim().split('\n')[0])
        if (info.adquirido) {
          pid = primeiro.pid
          clearTimeout(limite)
          resolve()
        }
      } catch {}
    })
    primeiro.on('error', reject)
  })

  const segunda = instanciaLock.adquirir(dir)
  assert.strictEqual(segunda.adquirido, false, 'segunda instância deve ser bloqueada')
  assert.strictEqual(segunda.pid, pid, 'o lock deve indicar o PID da instância dona')

  // Encerra a 1ª instância "à força" (sem liberação) para deixar lock obsoleto.
  primeiro.kill()
  await new Promise(resolve => primeiro.on('close', resolve))
  await esperar(150)

  // 1.3 fica implícito aqui: PID morto = lock obsoleto = nova instância adquire.
  const recuperado = instanciaLock.adquirir(dir)
  assert.strictEqual(recuperado.adquirido, true, 'lock com PID morto deve ser substituído')
  assert.strictEqual(recuperado.substituiuObsoleto, true)
  assert.strictEqual(instanciaLock.pidEmUso(pid), false, 'PID encerrado não pode ser considerado ativo')
})

registrar('1.4 recuperação de lock obsoleto (PID inexistente)', async () => {
  const dir = pastaTemporaria('lock4')
  const pidMorto = await obterPidMorto()
  fs.writeFileSync(path.join(dir, 'instancia.lock'), JSON.stringify({ pid: pidMorto }))
  assert.strictEqual(instanciaLock.pidEmUso(pidMorto), false, 'o PID de teste precisa estar morto')
  const lock = instanciaLock.adquirir(dir)
  assert.strictEqual(lock.adquirido, true, 'lock antigo deve ser substituído')
  assert.strictEqual(lock.substituiuObsoleto, true)
})

registrar('1.5 lock ilegível recente bloqueia; antigo é substituído', () => {
  const dir = pastaTemporaria('lock5')
  const caminho = path.join(dir, 'instancia.lock')
  fs.writeFileSync(caminho, '{isso não é json')
  const recente = instanciaLock.adquirir(dir)
  assert.strictEqual(recente.adquirido, false, 'lock ilegível e recente deve bloquear')
  // Envelhece o arquivo artificialmente.
  const antigo = new Date(Date.now() - 5 * 60 * 1000)
  fs.utimesSync(caminho, antigo, antigo)
  const recuperado = instanciaLock.adquirir(dir)
  assert.strictEqual(recuperado.adquirido, true, 'lock ilegível antigo deve ser substituído')
})

registrar('1.6 liberação do lock (e nunca de lock alheio)', async () => {
  const dir = pastaTemporaria('lock6')
  instanciaLock.adquirir(dir)
  const caminho = path.join(dir, 'instancia.lock')
  assert.ok(fs.existsSync(caminho))

  // Lock pertencente a OUTRO processo: não pode ser removido.
  const pidAlheio = await obterPidMorto()
  fs.writeFileSync(caminho, JSON.stringify({ pid: pidAlheio, iniciadoEm: 'externo' }))
  const alheio = instanciaLock.liberar(dir)
  assert.strictEqual(alheio.liberado, false, 'lock de outro processo não pode ser removido')
  assert.ok(fs.existsSync(caminho), 'lock alheio precisa continuar no disco')

  // Lock ilegível: também não é removido (não dá para provar propriedade).
  fs.writeFileSync(caminho, 'lixo-ilegivel')
  const ilegivel = instanciaLock.liberar(dir)
  assert.strictEqual(ilegivel.liberado, false)
  assert.ok(fs.existsSync(caminho))

  // Lock ilegível antigo pode ser substituído pelo nosso processo...
  const antigo = new Date(Date.now() - 5 * 60 * 1000)
  fs.utimesSync(caminho, antigo, antigo)
  const novo = instanciaLock.adquirir(dir)
  assert.strictEqual(novo.adquirido, true, 'lock ilegível antigo deve ser substituído')

  // ...e o lock nosso é removido normalmente.
  const meu = instanciaLock.liberar(dir)
  assert.strictEqual(meu.liberado, true)
  assert.ok(!fs.existsSync(caminho), 'lock próprio deve ser removido')
  const ausente = instanciaLock.liberar(dir)
  assert.strictEqual(ausente.liberado, false)
  assert.strictEqual(ausente.motivo, 'ausente')
})

registrar('1.7 lock é liberado na saída normal do processo', async () => {
  const dir = pastaTemporaria('lock7')
  const helper = path.join(__dirname, 'helpers', 'segurar-lock.js')
  const resultado = await executarNode([helper, 'exit', dir])
  assert.strictEqual(resultado.code, 0, resultado.stderr)
  assert.ok(!fs.existsSync(path.join(dir, 'instancia.lock')), 'o lock deve ser liberado ao encerrar')
})

registrar('1.8 lock obsoleto deixado por crash é recuperável', async () => {
  const dir = pastaTemporaria('lock8')
  const helper = path.join(__dirname, 'helpers', 'segurar-lock.js')
  const resultado = await executarNode([helper, 'crasha', dir])
  assert.strictEqual(resultado.code, 0, resultado.stderr)
  assert.ok(fs.existsSync(path.join(dir, 'instancia.lock')), 'crash deixa o lock no disco')
  const lock = instanciaLock.adquirir(dir)
  assert.strictEqual(lock.adquirido, true, 'nova instância recupera o lock docrash')
  assert.strictEqual(lock.substituiuObsoleto, true)
})

// ---------------------------------------------------------------------------
// 2. Código 440 e plano de desconexão
// ---------------------------------------------------------------------------

registrar('2.1 440 no bot principal => pausa, sem reconexão', () => {
  const plano = conexaoSegura.planoDeFechamento({ codigo: 440, subBot: false })
  assert.strictEqual(plano.acao, 'pausar-substituida')
  assert.strictEqual(plano.reconectar, false)
  assert.strictEqual(plano.atrasoMs, undefined, 'não pode existir atraso de reconexão para 440')
  assert.ok(/outra instância/i.test(plano.mensagem), 'mensagem deve citar outra instância')
})

registrar('2.2 440 em Sub Bot => conflito informado ao pai, sem reconexão', () => {
  const plano = conexaoSegura.planoDeFechamento({ codigo: 440, subBot: true })
  assert.strictEqual(plano.acao, 'sub-conflict')
  assert.strictEqual(plano.reconectar, false)
  assert.strictEqual(plano.atrasoMs, undefined)
})

registrar('2.3 queda normal => reconexão automática agendada', () => {
  const fechamento = conexaoSegura.planoDeFechamento({ codigo: 428, subBot: false })
  assert.strictEqual(fechamento.acao, 'retry')
  assert.strictEqual(fechamento.reconectar, true)
  assert.strictEqual(fechamento.atrasoMs, 5000)

  const semRede = conexaoSegura.planoDeFechamento({ codigo: 515, subBot: false })
  assert.strictEqual(semRede.acao, 'retry')
  assert.strictEqual(semRede.reconectar, true)
})

registrar('2.4 401 (logout) => sem reconexão automática', () => {
  const plano = conexaoSegura.planoDeFechamento({ codigo: 401, subBot: false, sessaoNaoRegistrada: false })
  assert.strictEqual(plano.acao, 'logout')
  assert.strictEqual(plano.reconectar, false)
  assert.strictEqual(plano.atrasoMs, undefined)
})

registrar('2.5 Sub Bot sem sessão pareada => handshake curto (2500ms)', () => {
  const plano = conexaoSegura.planoDeFechamento({ codigo: 401, subBot: true, sessaoNaoRegistrada: true })
  assert.strictEqual(plano.acao, 'retry')
  assert.strictEqual(plano.atrasoMs, 2500, 'primeiro pareamento do Sub Bot continua rápido')
  assert.strictEqual(plano.reconectar, true)
})

// ---------------------------------------------------------------------------
// 3. Agendador único de reconexão (sem timers concorrentes)
// ---------------------------------------------------------------------------

registrar('3.1 agendador executa exatamente uma vez por queda', async () => {
  let execucoes = 0
  const agendador = conexaoSegura.criarAgendadorReconexao(() => { execucoes += 1 })
  // Simula handler de desconexão + catch tentando agendar ao mesmo tempo.
  agendador.agendar(60)
  agendador.agendar(60)
  agendador.agendar(60)
  assert.strictEqual(agendador.ativo(), true)
  await esperar(200)
  assert.strictEqual(execucoes, 1, 'só pode haver UMA reconexão agendada')
  assert.strictEqual(agendador.ativo(), false)
})

registrar('3.2 cancelar impede a reconexão (pausa do 440)', async () => {
  let execucoes = 0
  const agendador = conexaoSegura.criarAgendadorReconexao(() => { execucoes += 1 })
  agendador.agendar(50)
  assert.strictEqual(agendador.cancelar(), true)
  await esperar(150)
  assert.strictEqual(execucoes, 0, 'reconexão cancelada não pode disparar')
  assert.strictEqual(agendador.ativo(), false)
})

registrar('3.3 novo agendamento substitui o anterior (1 timer só)', async () => {
  const marcas = []
  const agendador = conexaoSegura.criarAgendadorReconexao(() => marcas.push(Date.now()))
  agendador.agendar(300)
  await esperar(100)
  agendador.agendar(50) // substitui o timer antigo
  await esperar(400)
  assert.strictEqual(marcas.length, 1, 'apenas o último agendamento deve disparar')
})

registrar('3.4 erro na reconexão não derruba o processo', async () => {
  const agendador = conexaoSegura.criarAgendadorReconexao(() => { throw new Error('falha simulada') })
  agendador.agendar(30)
  await esperar(120)
  assert.strictEqual(agendador.ativo(), false)
  assert.strictEqual(process.exitCode || 0, 0)
})

// ---------------------------------------------------------------------------
// 4. Detecção de sessão pareada (registered:false com me.id + account)
// ---------------------------------------------------------------------------

registrar('4.1 sessão com registered:false mas me.id + account é pareada', () => {
  const dir = pastaTemporaria('sessao1')
  fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({
    registered: false,
    me: { id: '5511999999999:12@s.whatsapp.net', lid: 'x@lid' },
    account: { details: { voip: {} }, signalId: 'abc' },
    platform: 'android'
  }))
  assert.strictEqual(sessaoWhats.sessaoRegistrada(dir), true, 'a biblioteca reconhece me.id + account')
})

registrar('4.2 registered:false sem conta completa NÃO é pareada', () => {
  const dir = pastaTemporaria('sessao2')
  fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ registered: false, me: { id: 'y@s.whatsapp.net' } }))
  assert.strictEqual(sessaoWhats.sessaoRegistrada(dir), false, 'sem account não há pareamento')

  const dir3 = pastaTemporaria('sessao3')
  fs.writeFileSync(path.join(dir3, 'creds.json'), JSON.stringify({ registered: false, account: {} }))
  assert.strictEqual(sessaoWhats.sessaoRegistrada(dir3), false, 'sem me.id não há pareamento')
})

registrar('4.3 registered:true continua pareada e ausência de sessão não', () => {
  const dir = pastaTemporaria('sessao4')
  fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ registered: true }))
  assert.strictEqual(sessaoWhats.sessaoRegistrada(dir), true)

  const vazio = pastaTemporaria('sessao5')
  assert.strictEqual(sessaoWhats.sessaoRegistrada(vazio), false, 'pasta sem creds.json = sem sessão')

  const quebrado = pastaTemporaria('sessao6')
  fs.writeFileSync(path.join(quebrado, 'creds.json'), '{json inválido')
  assert.strictEqual(sessaoWhats.sessaoRegistrada(quebrado), false, 'creds ilegíveis = sem sessão válida')
})

// ---------------------------------------------------------------------------
// 5. Inicialização dos Sub Bots (não herdam o lock da instância principal)
// ---------------------------------------------------------------------------

registrar('5.1 Sub Bot inicializa apontando para a pasta própria', async () => {
  const numero = '5511000000000'
  const pastaSub = path.join(ROOT, 'DADOS_TOKITO/database/subs', numero)
  const existiaAntes = fs.existsSync(pastaSub)
  try {
    const codigo = [
      "process.env.TOKITO_SUBBOT = '1'",
      `process.env.TOKITO_SUB_ID = '${numero}'`,
      "const r = require('./DADOS_TOKITO/sub/runtime.js')",
      "console.log(JSON.stringify({ isSubBot: r.isSubBot, sessionDir: r.sessionDir }))"
    ].join(';')
    const resultado = await executarNode(['-e', codigo])
    assert.strictEqual(resultado.code, 0, resultado.stderr)
    const dados = JSON.parse(resultado.stdout.trim())
    assert.strictEqual(dados.isSubBot, true)
    assert.ok(
      dados.sessionDir.endsWith(path.join('subs', numero, 'qrcode')),
      `sessionDir de Sub Bot inválida: ${dados.sessionDir}`
    )
  } finally {
    // Remove a pasta da sub de teste (número fictício) para não deixar resíduo.
    if (!existiaAntes) {
      try { fs.rmSync(pastaSub, { recursive: true, force: true }) } catch {}
    }
  }
})

registrar('5.2 código do Sub Bot retorna antes de adquirir o lock', () => {
  const fonte = fs.readFileSync(path.join(ROOT, 'DADOS_TOKITO/connect.js'), 'utf8')
  const inicio = fonte.indexOf('async function iniciarTokito()')
  assert.ok(inicio > 0, 'iniciarTokito não encontrada')
  const corpo = fonte.slice(inicio, inicio + 1600)
  const fimDoSub = corpo.indexOf('startConnect()')
  const lock = corpo.indexOf('instanciaLock.adquirir')
  assert.ok(fimDoSub > 0 && lock > 0, 'trechos esperados não encontrados em iniciarTokito')
  assert.ok(
    fimDoSub < lock,
    'o retorno do Sub Bot precisa acontecer ANTES da aquisição do lock (subbots não podem ser bloqueados)'
  )
})

// ---------------------------------------------------------------------------
// 6. Integração estática do connect.js (440 sem loop, lock e saída 23)
// ---------------------------------------------------------------------------

const fonteConnect = fs
  .readFileSync(path.join(ROOT, 'DADOS_TOKITO/connect.js'), 'utf8')
  .replace(/\r\n/g, '\n')

registrar('6.1 connect.js usa lock com saída 23 (tratada pelo supervisor)', () => {
  assert.ok(fonteConnect.includes('instanciaLock.adquirir(qrcode)'), 'aquisição do lock ausente')
  assert.ok(fonteConnect.includes('process.exit(23)'), 'saída 23 ausente')
  assert.ok(fonteConnect.includes('instanciaLock.registrarSaida(qrcode)'), 'liberação automática ausente')
  const supervisor = fs.readFileSync(path.join(ROOT, 'DADOS_TOKITO/database/lib/supervisor.js'), 'utf8')
  assert.ok(/code\s*===\s*23/.test(supervisor), 'supervisor deve tratar o código 23')
})

registrar('6.2 handler de fechamento não reconecta 440 nem usa timer solto', () => {
  const inicio = fonteConnect.indexOf("case 'close': {")
  const fim = fonteConnect.indexOf('/*\n * MENSAGENS', inicio)
  assert.ok(inicio > 0 && fim > inicio, 'bloco case close não encontrado')
  const bloco = fonteConnect.slice(inicio, fim)

  assert.ok(bloco.includes('planoDeFechamento'), 'o fechamento deve usar o plano de desconexão')
  assert.ok(bloco.includes("acao === 'pausar-substituida'"), 'tratamento do 440 ausente')
  assert.ok(bloco.includes('sessaoSubstituida = true'), 'flag de pausa do 440 ausente')
  assert.ok(bloco.includes('agendadorReconexao.cancelar()'), 'timer deve ser cancelado no 440')
  assert.ok(bloco.includes('agendadorReconexao.agendar(plano.atrasoMs)'), 'reconexão deve usar o agendador único')

  assert.ok(!bloco.includes('startConnect()'), 'o handler não pode chamar startConnect direto (timer solto)')
  assert.ok(!/setTimeout\([^)]*5000/.test(bloco), 'não pode haver setTimeout de 5000ms solto no fechamento')
  assert.ok(!/if\s*\(\s*!reconectando\s*\)/.test(bloco), 'guard antigo de reconectando foi substituído pelo agendador')
})

registrar('6.3 startConnect respeita a pausa do 440', () => {
  const inicio = fonteConnect.indexOf('async function startConnect()')
  const trecho = fonteConnect.slice(inicio, inicio + 900)
  assert.ok(trecho.includes('if (sessaoSubstituida)'), 'startConnect deve verificar a pausa')
  const posGuard = trecho.indexOf('if (sessaoSubstituida)')
  const posIniciando = trecho.indexOf('if (iniciando) return')
  assert.ok(posGuard >= 0 && posIniciando > 0 && posGuard < posIniciando, 'a pausa deve ser verificada antes de iniciar')
  assert.ok(
    (fonteConnect.match(/agendadorReconexao\.agendar\(/g) || []).length >= 2,
    'handler de fechamento e catch devem compartilhar o mesmo agendador'
  )
})

registrar('6.4 catch limita falhas consecutivas de início', () => {
  assert.ok(fonteConnect.includes('MAX_FALHAS_INICIACAO'), 'limite de falhas ausente')
  assert.ok(fonteConnect.includes('falhasIniciacao += 1'), 'contador de falhas ausente')
  const inicio = fonteConnect.indexOf('async function startConnect()')
  const abrirCatch = fonteConnect.indexOf('} catch (error) {', inicio)
  assert.ok(abrirCatch > 0, 'catch do startConnect não encontrado')
  // Limita ao fim do próprio startConnect (antes dos handlers globais).
  const fimStart = fonteConnect.indexOf("process.on('uncaughtException'", inicio)
  const trecho = fonteConnect.slice(abrirCatch, fimStart > 0 ? fimStart : abrirCatch + 1400)
  assert.ok(trecho.includes('agendadorReconexao.agendar(5000)'), 'o catch deve usar o agendador único')
  assert.ok(trecho.includes('falhasIniciacao >= MAX_FALHAS_INICIACAO'), 'corte de loop permanente ausente')
  assert.ok(!trecho.includes('startConnect()'), 'o catch não pode chamar startConnect direto (timer solto)')
})

registrar('6.5 sessaoRegistrada() usa o novo detector de pareamento', () => {
  assert.ok(fonteConnect.includes('sessaoWhats.sessaoRegistrada(qrcode)'), 'delegação do detector ausente')
  assert.ok(!/creds\?\.registered === true/.test(fonteConnect), 'a checagem antiga foi substituída')
})

// ---------------------------------------------------------------------------
// 7. Sintaxe dos arquivos alterados/criados
// ---------------------------------------------------------------------------

registrar('7.1 todos os arquivos passam no node --check', () => {
  const arquivos = [
    'DADOS_TOKITO/connect.js',
    'DADOS_TOKITO/database/lib/instancia-lock.js',
    'DADOS_TOKITO/database/lib/conexao-segura.js',
    'DADOS_TOKITO/database/lib/sessao-whatsapp.js',
    'tests/helpers/segurar-lock.js',
    'tests/correcao-440.test.js'
  ]
  for (const arquivo of arquivos) {
    const resultado = spawnSync(process.execPath, ['--check', path.join(ROOT, arquivo)], { cwd: ROOT })
    assert.strictEqual(resultado.status, 0, `falha de sintaxe em ${arquivo}:\n${resultado.stderr}`)
  }
})

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

const main = async () => {
  let falhas = 0
  for (const { nome, funcao } of resultados) {
    try {
      await funcao()
      console.log(`  [OK] ${nome}`)
    } catch (error) {
      falhas += 1
      console.log(`  [FALHA] ${nome}`)
      console.log(`          ${error.message}`)
    }
  }

  for (const dir of temporarias) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }

  console.log('')
  console.log(`${resultados.length - falhas}/${resultados.length} testes aprovados.`)
  if (falhas > 0) {
    console.log(`${falhas} teste(s) reprovado(s).`)
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
