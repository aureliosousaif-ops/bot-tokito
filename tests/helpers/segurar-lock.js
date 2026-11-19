'use strict'
/*
 * Helper de teste do lock de instância.
 *
 * Modos:
 *   hold   <dir>  adquire o lock e fica vivo (para simular a 1ª instância).
 *   crasha <dir>  adquire o lock e morre SEM rodar a liberação automática
 *                 (para simular uma queda e deixar um lock obsoleto no disco).
 *   exit   <dir>  adquire o lock com liberação registrada e encerra normalmente.
 */

const instanciaLock = require('../../DADOS_TOKITO/database/lib/instancia-lock.js')

const modo = process.argv[2]
const dir = process.argv[3]

if (!dir) {
  console.error('uso: node segurar-lock.js <hold|crasha|exit> <dir>')
  process.exit(2)
}

const resultado = instanciaLock.adquirir(dir)
console.log(JSON.stringify(resultado))

if (modo === 'exit') {
  instanciaLock.registrarSaida(dir)
  process.exit(0)
}

if (modo === 'crasha') {
  // Não registra a liberação: o lock fica no disco com um PID que já morreu.
  process.exit(0)
}

// hold: continua vivo até ser encerrado externamente.
setInterval(() => {}, 1000)
