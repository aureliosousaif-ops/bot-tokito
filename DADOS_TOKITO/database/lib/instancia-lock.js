'use strict'
/*
 * Lock de instância única do Tokito.
 *
 * Evita que duas instâncias principais usem a MESMA sessão do WhatsApp ao
 * mesmo tempo (o que gera o erro 440 "connectionReplaced" em loop).
 *
 * - Grava um arquivo de lock com o PID do processo dono.
 * - Se o PID registrado não existe mais, o lock é considerado obsoleto e
 *   pode ser substituído com segurança.
 * - O lock só é removido quando o PID registrado é o nosso; locks de outros
 *   processos nunca são apagados.
 * - Liberado automaticamente na saída normal do processo.
 */

const fs = require('fs')
const path = require('path')

const NOME_ARQUIVO = 'instancia.lock'
// Lock ilegível com menos de 30s é tratado como recém-criado (ativo).
const LOCK_RECENTE_MS = 30 * 1000
const SINAIS_SAIDA = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }

const caminhoDoLock = dir => path.join(dir, NOME_ARQUIVO)

// Verifica se um PID realmente corresponde a um processo vivo.
const pidEmUso = pid => {
  const numero = Number(pid)
  if (!Number.isInteger(numero) || numero <= 0) return false
  if (numero === process.pid) return true
  try {
    process.kill(numero, 0)
    return true
  } catch (error) {
    // EPERM = processo existe, mas pertence a outro usuário.
    return error?.code === 'EPERM'
  }
}

const lerLock = caminho => {
  try {
    const bruto = fs.readFileSync(caminho, 'utf8')
    return { existe: true, dados: JSON.parse(bruto), ilegivel: false }
  } catch (error) {
    if (error?.code === 'ENOENT') return { existe: false, dados: null, ilegivel: false }
    return { existe: true, dados: null, ilegivel: true }
  }
}

const idadeDoLock = caminho => {
  try {
    return Date.now() - fs.statSync(caminho).mtimeMs
  } catch {
    return Infinity
  }
}

// Escrita atômica (arquivo temporário + rename) para não deixar lock parcial.
const gravarLock = (caminho, dados) => {
  const temporario = `${caminho}.${process.pid}.tmp`
  fs.writeFileSync(temporario, JSON.stringify(dados, null, 2))
  fs.renameSync(temporario, caminho)
}

/**
 * Tenta adquirir o lock da instância.
 * Retorna { adquirido, pid, ... } e nunca lança exceção por problemas de I/O:
 * em caso de falha de disco o lock é marcado como degradado (motivo) e o
 * processo continua, apenas sem a garantia de instância única.
 */
const adquirir = (dir, opcoes = {}) => {
  const caminho = caminhoDoLock(dir)
  const pid = Number.isInteger(opcoes.pid) ? opcoes.pid : process.pid
  const registro = { pid, iniciadoEm: new Date().toISOString() }

  try {
    fs.mkdirSync(dir, { recursive: true })
    const atual = lerLock(caminho)

    if (atual.existe && atual.ilegivel) {
      // Não dá para ler o PID: só substitui se o arquivo for antigo o bastante
      // para não ser um lock recém-criado por outra instância.
      if (idadeDoLock(caminho) < LOCK_RECENTE_MS) {
        return { adquirido: false, pid: null, caminho, motivo: 'lock ilegível e recente' }
      }
    } else if (atual.existe && atual.dados) {
      const pidRegistrado = Number(atual.dados.pid)
      if (pidRegistrado === pid) {
        // Já somos os donos (reentrada do mesmo processo).
        return { adquirido: true, pid, caminho, jaAdquirido: true }
      }
      if (pidEmUso(pidRegistrado)) {
        return { adquirido: false, pid: pidRegistrado, caminho, motivo: 'processo ativo' }
      }
      // PID morto: lock antigo, seguro substituir.
    }

    gravarLock(caminho, registro)
    return { adquirido: true, pid, caminho, substituiuObsoleto: Boolean(atual.existe) }
  } catch (error) {
    return {
      adquirido: true,
      pid,
      caminho,
      degradado: true,
      motivo: `falha de I/O no lock (${error?.code || error?.message || 'erro desconhecido'})`
    }
  }
}

/**
 * Libera o lock SOMENTE se ele pertencer a este processo.
 * Nunca remove lock de outro PID.
 */
const liberar = (dir, opcoes = {}) => {
  const caminho = caminhoDoLock(dir)
  const pid = Number.isInteger(opcoes.pid) ? opcoes.pid : process.pid
  try {
    const atual = lerLock(caminho)
    if (!atual.existe) return { liberado: false, motivo: 'ausente' }
    if (atual.ilegivel || !atual.dados) return { liberado: false, motivo: 'ilegível (não removido)' }
    if (Number(atual.dados.pid) !== pid) {
      return { liberado: false, motivo: 'pertence a outro processo', pid: atual.dados.pid }
    }
    fs.unlinkSync(caminho)
    return { liberado: true, pid }
  } catch (error) {
    return { liberado: false, motivo: error?.message || 'erro desconhecido' }
  }
}

const saidasRegistradas = new Set()

/**
 * Registra a liberação automática do lock na saída normal do processo
 * (process.exit, fim do script e sinais).
 */
const registrarSaida = dir => {
  const caminho = caminhoDoLock(dir)
  if (saidasRegistradas.has(caminho)) return
  saidasRegistradas.add(caminho)

  process.on('exit', () => {
    try { liberar(dir) } catch {}
  })
  for (const [sinal, codigo] of Object.entries(SINAIS_SAIDA)) {
    process.on(sinal, () => {
      try { liberar(dir) } catch {}
      process.exit(codigo)
    })
  }
}

const estaTravado = dir => {
  const atual = lerLock(caminhoDoLock(dir))
  if (!atual.existe) return false
  if (atual.ilegivel || !atual.dados) return idadeDoLock(caminhoDoLock(dir)) < LOCK_RECENTE_MS
  return pidEmUso(atual.dados.pid)
}

module.exports = {
  NOME_ARQUIVO,
  adquirir,
  liberar,
  registrarSaida,
  estaTravado,
  pidEmUso
}
