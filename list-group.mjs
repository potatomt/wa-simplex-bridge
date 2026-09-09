// list-group.mjs — prints every WhatsApp group the linked account is in, plus
// every member's number. Use it to find the JID for WA_GROUP_ID.
//
// Run with the bridge STOPPED (it shares the same auth folder):
//   node list-group.mjs
//
// Note: this prints phone numbers of every group member to your terminal.

import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';

const AUTH_DIR = process.env.AUTH_DIR || './auth';

const logger = { level: 'silent', child: () => logger, trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){} };

const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
const sock = makeWASocket({ auth: state, logger, browser: ['list', 'Chrome', '1.0'] });
sock.ev.on('creds.update', saveCreds);

sock.ev.on('connection.update', async (u) => {
  if (u.connection !== 'open') return;
  try {
    const groups = await sock.groupFetchAllParticipating();
    for (const [jid, meta] of Object.entries(groups)) {
      console.log(`\n=== ${meta.subject}  (${jid})  — ${meta.participants.length} members ===`);
      for (const p of meta.participants) {
        const num = p.id.split('@')[0].split(':')[0];
        const role = p.admin ? `  [${p.admin}]` : '';
        console.log('   ', num + role);
      }
    }
  } catch (e) {
    console.error('error:', e.message);
  }
  console.log('\n--- done ---');
  process.exit(0);
});
