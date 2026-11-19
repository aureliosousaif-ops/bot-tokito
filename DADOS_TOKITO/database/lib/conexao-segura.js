'use strict'
/*
 * Regras de desconexão e agendamento único de reconexão do Tokito.
 *
 * - planoDeFechamento(): função pura que decide O QUE fazer em cada código de
 *   desconexão (440, 401, quedas normais), separando o comportamento do
 *   bot principal do dos Sub Bots.
 * - criarAgendadorReconexao(): garante UM ÚNICO timer de reconexão por vez,
 *   eliminando a corrida entre o handler de desconexão e o catch de início
 *   de conexão (dois timers = dois sockets concorrentes = erro 440).
 */

// DisconnectReason.connectionReplaced = 440
const CODIGO_SESSAO_SUBSTITUIDA = 440
// DisconnectReason.loggedOut = 401
const CODIGO_SESSAO_ENCERRADA = 401

const ATRASO_PADRAO_MS = 5000
const ATRASO_HANDSHAKE_SUB_MS = 2500

/**
 * Decide o plano de ação para um fechamento de conexão.
 *
 * @param {object} opcoes
 * @param {number|string} opcoes.codigo  statusCode da desconexão (shouldReconnect)
 * @param {boolean} opcoes.subBot        true quando executado por um Sub Bot
 * @param {boolean} opcoes.sessaoNaoRegistrada  state.creds.registered !== true
 * @returns {{ acao: string, codigo: number, reconectar: boolean, atrasoMs?: number, mensagem?: string }}
 */
const planoDeFechamento = (opcoes = {}) => {
  const codigo = Number(opcoes.codigo) || 0
  const subBot = opcoes.subBot === true
  const sessaoNaoRegistrada = opcoes.sessaoNaoRegistrada === true

  // 440: outra instância está usando a MESMA sessão.
  // Reconectar aqui só gera tempestade de logins (loop de 440).
  if (codigo === CODIGO_SESSAO_SUBSTITUIDA) {
    if (subBot) {
      return {
        acao: 'sub-conflict',
        codigo,
        reconectar: false,
        mensagem: 'Sub Bot desconectado: sessão substituída (440). Verifique se existe outra instância com o mesmo número.'
      }
    }
    return {
      acao: 'pausar-substituida',
      codigo,
      reconectar: false,
      mensagem: 'Conexão substituída (440): outra instância está usando a mesma sessão do WhatsApp.'
    }
  }

  // Primeiro pareamento do Sub Bot: fechamentos transitórios (inclusive 401)
  // devem aguardar um novo handshake em vez de encerrar.
  if (subBot && sessaoNaoRegistrada) {
    return {
      acao: 'retry',
      codigo,
      reconectar: true,
      atrasoMs: ATRASO_HANDSHAKE_SUB_MS,
      mensagem: `Conexão inicial do Sub Bot fechada. Aguardando novo handshake. Código: ${codigo}`
    }
  }

  // 401: sessão deslogada de verdade (não adianta reconectar).
  if (codigo === CODIGO_SESSAO_ENCERRADA) {
    return {
      acao: 'logout',
      codigo,
      reconectar: false,
      mensagem: 'Sessão encerrada. Apague a pasta qrcode e conecte novamente.'
    }
  }

  // Queda normal (rede, timeout, 428 etc.): reconexão automática.
  return {
    acao: 'retry',
    codigo,
    reconectar: true,
    atrasoMs: ATRASO_PADRAO_MS,
    mensagem: `Conexão fechada. Reconectando em ${ATRASO_PADRAO_MS / 1000} segundos. Código: ${codigo}`
  }
}

/**
 * Cria o único mecanismo de agendamento de reconexão.
 * Sempre que se agenda, um timer anterior pendente é cancelado:
 * no máximo UM timer (e portanto UMA reconexão) pode existir por vez.
 */
const criarAgendadorReconexao = executar => {
  if (typeof executar !== 'function') throw new TypeError('criarAgendadorReconexao requer uma função')

  let timer = null

  return {
    agendar(atrasoMs) {
      const atraso = Math.max(0, Number(atrasoMs) || 0)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        try {
          executar()
        } catch {}
      }, atraso)
      return true
    },
    cancelar() {
      if (!timer) return false
      clearTimeout(timer)
      timer = null
      return true
    },
    ativo() {
      return timer !== null
    }
  }
}

module.exports = {
  CODIGO_SESSAO_SUBSTITUIDA,
  CODIGO_SESSAO_ENCERRADA,
  ATRASO_PADRAO_MS,
  ATRASO_HANDSHAKE_SUB_MS,
  planoDeFechamento,
  criarAgendadorReconexao
}
