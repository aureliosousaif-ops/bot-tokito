'use strict';

/*
 * ============================================================
 *      TOKITO BOT V10 - SUPORTE AO AMBIENTE DE HOSPEDAGEM
 * ============================================================
 *
 * Responsável por duas tarefas pontuais, usadas pelo connect.js:
 *
 * 1) detectarAmbiente()
 *    Define se o bot está rodando em hospedagem (AquaCloud, VPS,
 *    PM2, Docker, etc.) e, portanto, sem terminal interativo (TTY).
 *    - TOKITO_HOSTED=true força o modo hospedagem.
 *    - Sem a variável, qualquer processo sem TTY é tratado como
 *      hospedagem (fallback seguro contra "readline was closed").
 *    - Em terminal interativo local (Windows) o comportamento
 *      original, com menu, é preservado.
 *
 * 2) salvarQr() / limparQr()
 *    Disponibiliza o QR-Code da conexão em arquivos locais quando
 *    não existe impressão confiável no terminal:
 *      - qr-atual.txt  (QR em texto monoespacado + instruções)
 *      - qr-atual.png  (imagem PNG gerada localmente)
 *    Nada é enviado para servidores de terceiros e os arquivos são
 *    apagados assim que a sessão conecta com sucesso.
 *
 * Author: Dylan Modz
 * ============================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const qrcodeTerminal = require('qrcode-terminal');

const INFO_DIR = path.resolve(__dirname, '..', 'INFO_DADOS');
const QR_TXT = path.join(INFO_DIR, 'qr-atual.txt');
const QR_PNG = path.join(INFO_DIR, 'qr-atual.png');

const VALOR_TRUE = ['1', 'true', 'sim', 's', 'yes', 'y', 'on'];
const VALOR_FALSE = ['0', 'false', 'nao', 'não', 'n', 'no', 'off'];

/**
 * Detecta o ambiente de hospedagem.
 * @param {{env?: object, stdin?: object, stdout?: object}} opcoes
 * @returns {boolean}
 */
function detectarAmbiente(opcoes = {}) {
  const env = opcoes.env || process.env;
  const stdin = opcoes.stdin || process.stdin;
  const stdout = opcoes.stdout || process.stdout;
  const valor = String(env.TOKITO_HOSTED ?? '').trim().toLowerCase();

  // Forçado pelo usuário/painel da hospedagem.
  if (VALOR_TRUE.includes(valor)) return true;

  // Fallback seguro: sem terminal interativo não existe menu interativo.
  // Mesmo com TOKITO_HOSTED=false, processo sem TTY continua em hospedagem
  // para nunca depender de "readline" encerrado.
  if (!stdin || !stdin.isTTY || !stdout || !stdout.isTTY) return true;

  // Terminal interativo local (ex.: Windows): comportamento original.
  return false;
}

/* ------------------------------------------------------------
 * PNG do QR-Code (sem dependências extras: usa zlib nativo)
 * ------------------------------------------------------------ */

const tabelaCrc32 = (() => {
  const tabela = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[n] = c;
  }
  return tabela;
})();

const crc32 = buffer => {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) crc = tabelaCrc32[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
};

const pedacoPng = (tipo, dados) => {
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  // O campo tamanho do chunk PNG contém apenas os dados (sem o tipo).
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length, 0);
  // O CRC cobre tipo + dados, conforme a especificação PNG.
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo), 0);
  return Buffer.concat([tamanho, corpo, crc]);
};

// Monta um PNG em escala de cinzas (0 = preto, 255 = branco) a partir
// da mesma matriz usada pelo qrcode-terminal no terminal.
function gerarPngQr(conteudo) {
  try {
    const QRCode = require('qrcode-terminal/vendor/QRCode');
    const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
    const codigo = new QRCode(-1, QRErrorCorrectLevel.L);
    codigo.addData(conteudo);
    codigo.make();

    const total = codigo.getModuleCount();
    const escala = 12;
    const margem = 4;
    const lado = (total + margem * 2) * escala;
    const bruto = Buffer.alloc((lado + 1) * lado);
    let offset = 0;
    for (let y = 0; y < lado; y++) {
      bruto[offset++] = 0; // filtro "None"
      const moduloY = Math.floor(y / escala) - margem;
      for (let x = 0; x < lado; x++) {
        const moduloX = Math.floor(x / escala) - margem;
        const preto =
          moduloX >= 0 && moduloY >= 0 && moduloX < total && moduloY < total &&
          codigo.isDark(moduloY, moduloX);
        bruto[offset++] = preto ? 0 : 255;
      }
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(lado, 0);
    ihdr.writeUInt32BE(lado, 4);
    ihdr[8] = 8; // profundidade de bits
    ihdr[9] = 0; // escala de cinzas
    ihdr[10] = 0; // compressão padrão
    ihdr[11] = 0; // filtro padrão
    ihdr[12] = 0; // sem entrelaçamento

    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pedacoPng('IHDR', ihdr),
      pedacoPng('IDAT', zlib.deflateSync(bruto, { level: 9 })),
      pedacoPng('IEND', Buffer.alloc(0))
    ]);
  } catch {
    return null;
  }
}

const cabecalhoQr = quando =>
  [
    'TOKITO BOT V10 - QR-CODE DE CONEXAO (modo hospedagem)',
    'Gerado em: ' + quando,
    'Arquivo temporario: apagado automaticamente apos a conexao.',
    'IMPORTANTE: nao compartilhe este QR-Code com ninguem.',
    '',
    'Como usar:',
    '1. Abra o arquivo qr-atual.png (imagem) ou este arquivo em um',
    '   visualizador de texto monoespacado.',
    '2. No WhatsApp: Aparelhos conectados > Conectar aparelho >',
    '   Escanear QR Code.',
    '3. O QR-Code expira em poucos segundos. Se escanear tarde,',
    '   aguarde a geracao de um novo arquivo.',
    '',
    '------------------------------------------------------------',
    ''
  ].join('\n');

/**
 * Salva o QR-Code atual em arquivos locais (texto + imagem PNG).
 * @param {string} conteudo payload do QR vindo do WhatsApp
 * @param {{agora?: Date}} opcoes
 * @returns {{ok: boolean, texto: string, imagem: string}}
 */
function salvarQr(conteudo, opcoes = {}) {
  const codigo = String(conteudo || '').trim();
  if (!codigo) return { ok: false, texto: '', imagem: '' };
  try {
    fs.mkdirSync(INFO_DIR, { recursive: true });

    let ascii = '';
    qrcodeTerminal.generate(codigo, { small: true }, saida => {
      ascii = saida;
    });

    const quando = (opcoes.agora instanceof Date ? opcoes.agora : new Date()).toISOString();
    fs.writeFileSync(QR_TXT, cabecalhoQr(quando) + ascii + '\n', 'utf8');

    const png = gerarPngQr(codigo);
    let imagem = '';
    if (png) {
      fs.writeFileSync(QR_PNG, png);
      imagem = QR_PNG;
    }

    return { ok: true, texto: QR_TXT, imagem };
  } catch {
    return { ok: false, texto: '', imagem: '' };
  }
}

/**
 * Remove os arquivos de QR-Code (ao conectar ou ao iniciar com sessão válida).
 * @returns {{texto: boolean, imagem: boolean}}
 */
function limparQr() {
  const apagar = arquivo => {
    try {
      if (fs.existsSync(arquivo)) fs.unlinkSync(arquivo);
      return true;
    } catch {
      return false;
    }
  };
  return { texto: apagar(QR_TXT), imagem: apagar(QR_PNG) };
}

/**
 * Caminhos dos arquivos de QR-Code da hospedagem.
 * @returns {{texto: string, imagem: string}}
 */
function caminhosQr() {
  return { texto: QR_TXT, imagem: QR_PNG };
}

module.exports = {
  detectarAmbiente,
  salvarQr,
  limparQr,
  caminhosQr
};
