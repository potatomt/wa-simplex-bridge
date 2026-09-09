// bridge.mjs — WhatsApp <-> SimpleX bridge with replies + reactions.
//
// Run the SimpleX Chat CLI as a local websocket server first, e.g.:
//   simplex-chat -p 5225 --files-folder ./files -f
// then:
//   node bridge.mjs           (or: pm2 start bridge.mjs --name wa-simplex-bridge)
//
// All configuration comes from environment variables — see .env.example.

import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import WebSocket from 'ws';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';

// ====================== CONFIG ======================
const GROUP_ID        = process.env.WA_GROUP_ID;              // e.g. 1203630000000000000@g.us
const SIMPLEX_CONTACT = process.env.SIMPLEX_CONTACT;          // local display name of the SimpleX contact
const FILES_FOLDER    = process.env.FILES_FOLDER || './files';
const SIMPLEX_WS      = process.env.SIMPLEX_WS   || 'ws://localhost:5225';
const MAP_FILE        = process.env.MAP_FILE     || './msgmap.json';
const AUTH_DIR        = process.env.AUTH_DIR     || './auth';
const NAMES_FILE      = process.env.NAMES_FILE   || './names.json';
const HEADER_DAD      = process.env.DAD_HEADER   || 'Message from Dad';

if (!GROUP_ID || !SIMPLEX_CONTACT) {
  console.error('WA_GROUP_ID and SIMPLEX_CONTACT are required. Copy .env.example to .env and fill it in.');
  console.error('Tip: run `node list-group.mjs` to discover your group JID.');
  process.exit(1);
}

// number -> display label, used to prefix WhatsApp messages forwarded to SimpleX.
// Optional: if names.json is absent, senders fall back to their WhatsApp pushName / raw number.
let NAMES = {};
try {
  NAMES = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8'));
} catch {
  console.warn(`No ${NAMES_FILE} — senders will show their WhatsApp name or number.`);
}
// ====================================================

const logger = { level: 'silent', child: () => logger, trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){} };

let sock, simplex, ready = false, corr = 0;
const outbox = [];
const pending = new Map();        // SimpleX fileId -> { caption, fileName }
const pendingSends = new Map();   // corrId -> { waMsgId, key, text } (to capture sent SX itemId)

// ---------- persistent message-id map ----------
let store = { contactId: null, wa2sx: {}, sx2wa: {}, keys: {}, texts: {} };
try { store = { ...store, ...JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')) }; } catch {}
let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.writeFileSync(MAP_FILE, JSON.stringify(store)); } catch (e) { console.error('save error:', e.message); } }, 400);
}
function link(waMsgId, sxItemId, key, text) {
  if (waMsgId != null && sxItemId != null) { store.wa2sx[waMsgId] = sxItemId; store.sx2wa[sxItemId] = waMsgId; }
  if (waMsgId != null && key) store.keys[waMsgId] = { remoteJid: key.remoteJid, id: key.id, participant: key.participant, fromMe: !!key.fromMe };
  if (waMsgId != null && text != null) store.texts[waMsgId] = String(text).slice(0, 120);
  saveStore();
}
function deepFind(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[key] !== undefined && typeof obj[key] !== 'object') return obj[key];
  for (const k in obj) { const v = deepFind(obj[k], key); if (v !== undefined) return v; }
  return undefined;
}

// ===================== SimpleX side =====================
function connectSimplex() {
  simplex = new WebSocket(SIMPLEX_WS);
  simplex.on('open', () => { console.log('SimpleX websocket connected'); ready = true; rawCmd('/_start'); while (outbox.length) simplex.send(outbox.shift()); });
  simplex.on('close', () => { console.log('SimpleX closed — reconnecting in 3s'); ready = false; setTimeout(connectSimplex, 3000); });
  simplex.on('error', (e) => console.error('SimpleX ws error:', e.message));
  simplex.on('message', (data) => handleSimplexEvent(data.toString()));
}
function rawCmd(cmd) {
  const frame = JSON.stringify({ corrId: `bridge${++corr}`, cmd });
  if (!ready) { outbox.push(frame); return; }
  simplex.send(frame);
}
// send text to the SimpleX contact, tracking the resulting SX itemId back to a WA message
function sxSend(text, { waMsgId, key, snippet, quotedItemId } = {}) {
  const c = `bridge${++corr}`;
  if (waMsgId != null) pendingSends.set(c, { waMsgId, key, text: snippet });
  let cmd;
  if (quotedItemId != null && store.contactId != null) {
    cmd = `/_send @${store.contactId} json ${JSON.stringify([{ quotedItemId, msgContent: { type: 'text', text } }])}`;
  } else {
    cmd = `@'${SIMPLEX_CONTACT}' ${text}`;
  }
  const frame = JSON.stringify({ corrId: c, cmd });
  if (!ready) { outbox.push(frame); return; }
  simplex.send(frame);
}
function sxSendFile(absPath, { waMsgId, key, snippet } = {}) {
  const c = `bridge${++corr}`;
  if (waMsgId != null) pendingSends.set(c, { waMsgId, key, text: snippet });
  const frame = JSON.stringify({ corrId: c, cmd: `/f @'${SIMPLEX_CONTACT}' ${absPath}` });
  if (!ready) { outbox.push(frame); return; }
  simplex.send(frame);
}
function sxReact(itemId, emoji, add) {
  if (store.contactId == null) return;
  rawCmd(`/_reaction @${store.contactId} ${itemId} ${add ? 'on' : 'off'} ${JSON.stringify({ type: 'emoji', emoji })}`);
}

function handleSimplexEvent(raw) {
  let parsed; try { parsed = JSON.parse(raw); } catch { return; }
  const resp = parsed.resp; if (!resp) return;

  // capture SX itemId for messages WE sent (matched by corrId)
  if (parsed.corrId && pendingSends.has(parsed.corrId)) {
    const info = pendingSends.get(parsed.corrId); pendingSends.delete(parsed.corrId);
    const itemId = deepFind(resp, 'itemId');
    if (itemId != null && info.waMsgId != null) link(info.waMsgId, itemId, info.key, info.text);
  }

  if (resp.type === 'newChatItems' || resp.type === 'newChatItem') {
    const items = resp.chatItems || (resp.chatItem ? [resp.chatItem] : []);
    for (const w of items) handleChatItem(w);
  } else if (resp.type === 'rcvFileComplete') {
    const fileId = deepFind(resp, 'fileId'), filePath = deepFind(resp, 'filePath');
    if (fileId != null && filePath) deliverFile(fileId, filePath);
  } else if (resp.type === 'chatItemReaction') {
    handleSxReaction(resp);
  } else if (resp.type !== 'chatRunning' && resp.type !== 'contactSubSummary' && resp.type !== 'pendingSubSummary' && resp.type !== 'memberSubSummary') {
    // log unhandled event types so we can finalize reply/reaction shapes from real traffic
    console.log('SX OTHER EVENT:', resp.type, raw.slice(0, 240));
  }
}

function handleChatItem(w) {
  const info = w?.chatInfo, ci = w?.chatItem;
  if (!info || !ci) return;
  if (info.type !== 'direct') return;
  const nm = info.contact?.localDisplayName === SIMPLEX_CONTACT || info.contact?.profile?.displayName === SIMPLEX_CONTACT;
  if (!nm) return;
  if (store.contactId == null && info.contact?.contactId != null) { store.contactId = info.contact.contactId; saveStore(); }
  if (ci.chatDir?.type !== 'directRcv') return;

  const content = ci.content;
  if (content?.type !== 'rcvMsgContent') return;
  const mc = content.msgContent || {}, kind = mc.type, text = mc.text || '';
  const sxItemId = ci.meta?.itemId;

  // is this a reply to something we forwarded? (SimpleX -> WhatsApp reply)
  let quoted;
  const quotedSxId = deepFind(ci.quotedItem || {}, 'itemId') ?? deepFind(ci.quotedItem || {}, 'chatItemId');
  if (quotedSxId != null && store.sx2wa[quotedSxId] != null) {
    const waId = store.sx2wa[quotedSxId];
    const k = store.keys[waId];
    if (k) quoted = { key: k, message: { conversation: store.texts[waId] || '…' } };
  }

  if (kind === 'text') { sendToGroup({ text: `${HEADER_DAD}\n${text}` }, { sxItemId, quoted }); return; }

  if (['image', 'video', 'voice', 'file'].includes(kind)) {
    const file = ci.file;
    const cap = text ? `${HEADER_DAD}\n${text}` : HEADER_DAD;
    if (file?.fileId != null) {
      pending.set(file.fileId, { caption: cap, fileName: file.fileName, sxItemId, quoted });
      const already = deepFind(file, 'filePath');
      if (already) deliverFile(file.fileId, already); else rawCmd(`/freceive ${file.fileId}`);
    } else sendToGroup({ text: cap }, { sxItemId, quoted });
  }
}

function handleSxReaction(resp) {
  // best-guess handler; the SX OTHER EVENT log will reveal the true shape if this misses
  const itemId = deepFind(resp, 'chatItemId') ?? deepFind(resp, 'itemId');
  const emoji = deepFind(resp, 'emoji');
  const waId = itemId != null ? store.sx2wa[itemId] : undefined;
  const k = waId != null ? store.keys[waId] : undefined;
  if (k && emoji && sock) {
    sock.sendMessage(k.remoteJid, { react: { text: emoji, key: k } }).catch((e) => console.error('WA react error:', e.message));
  }
}

// ===================== WhatsApp side =====================
async function sendToGroup(content, { sxItemId, quoted } = {}) {
  if (!sock) return;
  try {
    const sent = await sock.sendMessage(GROUP_ID, content, quoted ? { quoted } : {});
    const waMsgId = sent?.key?.id;
    if (sxItemId != null && waMsgId) link(waMsgId, sxItemId, sent.key, content.text || content.caption || '');
    return sent;
  } catch (e) { console.error('WA send error:', e.message); }
}
function mimeFor(name = '') {
  const e = name.toLowerCase().split('.').pop();
  const m = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', mp4:'video/mp4', mov:'video/quicktime', mkv:'video/x-matroska', webm:'video/webm', mp3:'audio/mpeg', ogg:'audio/ogg', m4a:'audio/mp4', wav:'audio/wav', pdf:'application/pdf' };
  return m[e] || 'application/octet-stream';
}
async function deliverFile(fileId, filePath) {
  const meta = pending.get(fileId); if (!meta) return; pending.delete(fileId);
  const abs = path.isAbsolute(filePath) ? filePath : path.join(FILES_FOLDER, filePath);
  try {
    if (!sock || !fs.existsSync(abs)) { sendToGroup({ text: meta.caption }, meta); return; }
    const buffer = fs.readFileSync(abs), fname = meta.fileName || path.basename(abs);
    let content;
    if (/\.(jpg|jpeg|png|webp|gif)$/i.test(fname)) content = { image: buffer, caption: meta.caption };
    else if (/\.(mp4|mov|mkv|webm)$/i.test(fname)) content = { video: buffer, caption: meta.caption };
    else content = { document: buffer, fileName: fname, mimetype: mimeFor(fname), caption: meta.caption };
    await sendToGroup(content, meta);
  } catch (e) { console.error('deliverFile error:', e.message); sendToGroup({ text: meta.caption }, meta); }
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({ auth: state, logger, browser: ['wa-simplex-bridge', 'Chrome', '1.0'] });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) { console.log('Scan with WhatsApp > Linked Devices:'); qrcode.generate(qr, { small: true }); }
    if (connection === 'open') console.log('WhatsApp connected — bridge running');
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) console.log(`Logged out. Delete ${AUTH_DIR} and re-run.`);
      else { console.log('WhatsApp closed — reconnecting...'); startWhatsApp(); }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (!m.message) continue;
      if (m.key.remoteJid !== GROUP_ID) continue;
      if (m.key.fromMe) continue;

      const participant = m.key.participant || m.key.remoteJid;
      const number = participant.split('@')[0].split(':')[0];
      const sender = NAMES[number] || m.pushName || number;
      const msg = m.message;
      const waMsgId = m.key.id;

      // --- WhatsApp reaction -> SimpleX ---
      const react = msg.reactionMessage;
      if (react) {
        const targetId = react.key?.id, emoji = react.text || '';
        const sxItemId = targetId != null ? store.wa2sx[targetId] : undefined;
        if (sxItemId != null && emoji) sxReact(sxItemId, emoji, true);
        continue;
      }

      // --- detect reply (WhatsApp -> SimpleX) ---
      const ctx = msg.extendedTextMessage?.contextInfo || msg.imageMessage?.contextInfo || msg.videoMessage?.contextInfo;
      const quotedWaId = ctx?.stanzaId;
      const quotedItemId = quotedWaId ? store.wa2sx[quotedWaId] : undefined;

      const mediaTypes = ['imageMessage', 'videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage'];
      const mt = mediaTypes.find((t) => msg[t]);

      if (mt) {
        const caption = msg[mt]?.caption || '';
        const header = caption ? `${sender}:\n${caption}` : `${sender}:`;
        const exts = { imageMessage:'jpg', videoMessage:'mp4', stickerMessage:'webp', audioMessage:'ogg' };
        try {
          const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const ext = exts[mt] || (msg.documentMessage?.fileName?.split('.').pop() || 'bin');
          const abs = path.join(FILES_FOLDER, `wa_${Date.now()}.${ext}`);
          fs.writeFileSync(abs, buffer);
          sxSend(header, { waMsgId, key: m.key, snippet: caption || `[${mt}]` });
          sxSendFile(abs);
        } catch (e) {
          console.error('WA media error:', e.message);
          sxSend(`${sender}:\n${caption}`, { waMsgId, key: m.key, snippet: caption });
        }
        continue;
      }

      const text = msg.conversation || msg.extendedTextMessage?.text || '[message]';
      sxSend(`${sender}:\n${text}`, { waMsgId, key: m.key, snippet: text, quotedItemId });
    }
  });
}

connectSimplex();
startWhatsApp().catch((e) => console.error('WA start error:', e.message));
