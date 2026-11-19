'use strict'
/*
 * Detecção de sessão pareada do WhatsApp.
 *
 * A biblioteca @stone-wpp/ofc@1.0.7 considera a sessão pareada quando existe
 * identidade de conta salva (me.id + account), mesmo que o fluxo antigo ainda
 * esteja com `registered: false` em creds.json. Exigir apenas
 * `registered === true` faz o bot gerar um QR novo (e reiniciar a sessão)
 * para uma sessão que na verdade já está pareada.
 */

const fs = require('fs')
const path = require('path')

/**
 * Verifica se o conteúdo de creds.json representa uma sessão pareada.
 */
const sessaoPareada = creds => {
  if (!creds || typeof creds !== 'object') return false
  if (creds.registered === true) return true
  // Pareamento real reconhecido pela biblioteca: identidade + conta presentes.
  return Boolean(creds.me?.id && creds.account)
}

/**
 * Lê creds.json da pasta da sessão e decide se ela já está pareada.
 * Nunca lança exceção: qualquer erro de leitura significa "sem sessão válida".
 */
const sessaoRegistrada = dirSessao => {
  try {
    const arquivo = path.join(dirSessao, 'creds.json')
    if (!fs.existsSync(arquivo)) return false
    const creds = JSON.parse(fs.readFileSync(arquivo, 'utf8'))
    return sessaoPareada(creds)
  } catch {
    return false
  }
}

module.exports = { sessaoPareada, sessaoRegistrada }
