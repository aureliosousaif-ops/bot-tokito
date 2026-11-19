'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'
const MODEL_PADRAO = 'qwen/qwen3.8-27b'
const LIMITE_RPM_LOCAL = 4
const LIMITE_RPD_LOCAL = 900
const LIMITE_PROMPT_CARACTERES = 5200
const requisicoesRecentes = []
let diaAtual = new Date().toISOString().slice(0, 10)
let requisicoesHoje = 0

// Node 20.19+ oferece loadEnvFile nativo. Variáveis já definidas pelo host
// prevalecem; o arquivo .env nunca é impresso nem incluído em erros.
const arquivoEnv = path.resolve(__dirname, '..', '..', '.env')
if (typeof process.loadEnvFile === 'function' && fs.existsSync(arquivoEnv)) {
  try {
    process.loadEnvFile(arquivoEnv)
  } catch {
    // Falhas de configuração são tratadas quando a Nick for chamada.
  }
}

class GroqError extends Error {
  constructor(code, status = 0) {
    super(code)
    this.name = 'GroqError'
    this.code = code
    this.status = status
  }
}

const configuracao = () => {
  const timeout = Number.parseInt(process.env.GROQ_TIMEOUT_MS || '15000', 10)
  return {
    apiKey: String(process.env.GROQ_API_KEY || '').trim(),
    model: String(process.env.GROQ_MODEL || MODEL_PADRAO).trim() || MODEL_PADRAO,
    timeoutMs: Number.isFinite(timeout) ? Math.min(30000, Math.max(500, timeout)) : 15000
  }
}

const reservarRequisicao = () => {
  const agora = Date.now()
  const dia = new Date(agora).toISOString().slice(0, 10)
  if (dia !== diaAtual) {
    diaAtual = dia
    requisicoesHoje = 0
  }
  while (requisicoesRecentes.length && agora - requisicoesRecentes[0] >= 60000) {
    requisicoesRecentes.shift()
  }
  if (requisicoesRecentes.length >= LIMITE_RPM_LOCAL || requisicoesHoje >= LIMITE_RPD_LOCAL) {
    throw new GroqError('LOCAL_RATE_LIMIT')
  }
  requisicoesRecentes.push(agora)
  requisicoesHoje += 1
}

const totalCaracteres = mensagens => mensagens.reduce(
  (total, mensagem) => total + String(mensagem?.content || '').length,
  0
)

const chat = async (mensagens, opcoes = {}) => {
  const { apiKey, model, timeoutMs } = configuracao()
  const fetchImpl = typeof opcoes.fetchImpl === 'function' ? opcoes.fetchImpl : globalThis.fetch
  if (!apiKey) throw new GroqError('MISSING_API_KEY')
  if (!Array.isArray(mensagens) || !mensagens.length) throw new GroqError('INVALID_MESSAGES')
  if (totalCaracteres(mensagens) > LIMITE_PROMPT_CARACTERES) throw new GroqError('PROMPT_TOO_LARGE')
  if (typeof fetchImpl !== 'function') throw new GroqError('FETCH_UNAVAILABLE')

  reservarRequisicao()
  const controller = new AbortController()
  const limiteTempo = Number.isFinite(opcoes.timeoutMs)
    ? Math.min(30000, Math.max(50, opcoes.timeoutMs))
    : timeoutMs
  let expirou = false
  const timer = setTimeout(() => {
    expirou = true
    controller.abort()
  }, limiteTempo)

  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: mensagens,
        temperature: 0.82,
        top_p: 0.85,
        presence_penalty: 0.45,
        max_tokens: 180
      }),
      signal: controller.signal
    })

    if (!response?.ok) {
      throw new GroqError(`HTTP_${Number(response?.status) || 0}`, Number(response?.status) || 0)
    }

    let payload
    try {
      payload = await response.json()
    } catch {
      throw new GroqError('INVALID_RESPONSE')
    }
    const answer = String(payload?.choices?.[0]?.message?.content || '').trim()
    if (!answer) throw new GroqError('EMPTY_RESPONSE')
    return answer
  } catch (error) {
    if (error instanceof GroqError) throw error
    if (expirou || error?.name === 'AbortError') throw new GroqError('TIMEOUT')
    throw new GroqError('NETWORK_ERROR')
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { chat, configuracao, GroqError }
