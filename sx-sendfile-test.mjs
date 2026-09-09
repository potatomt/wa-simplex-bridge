// sx-sendfile-test.mjs — sends one test image to the bridged SimpleX contact and
// logs the response. Useful for confirming --files-folder / file sending works.
//
// Run with the bridge STOPPED:
//   node sx-sendfile-test.mjs

import 'dotenv/config';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';

const SIMPLEX_CONTACT = process.env.SIMPLEX_CONTACT;
const FILES_FOLDER    = process.env.FILES_FOLDER || './files';
const SIMPLEX_WS      = process.env.SIMPLEX_WS   || 'ws://localhost:5225';

if (!SIMPLEX_CONTACT) {
  console.error('SIMPLEX_CONTACT is required (see .env.example).');
  process.exit(1);
}

// a tiny valid PNG written to disk to send as the test file
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR42mNk+M9Qz0BkYBxVSAYAAEFGAdH3uxAAAAAASUVORK5CYII=',
  'base64'
);
const testPath = path.join(FILES_FOLDER, 'sx-test.png');
fs.writeFileSync(testPath, png);
console.log('wrote test file:', testPath);

const ws = new WebSocket(SIMPLEX_WS);
let corr = 0;
function send(cmd) { const c = `t${++corr}`; console.log('>> SENT:', cmd); ws.send(JSON.stringify({ corrId: c, cmd })); }

ws.on('open', () => {
  console.log('connected');
  send('/_start');
  setTimeout(() => send(`/f @'${SIMPLEX_CONTACT}' ${testPath}`), 1500);
});

ws.on('message', (d) => {
  let m; try { m = JSON.parse(d.toString()); } catch { return; }
  const t = m.resp?.type;
  if (t === 'chatCmdError' || m.resp?.chatError) {
    console.log('<< ERROR:', JSON.stringify(m.resp, null, 2));
  } else {
    console.log('<< OK type:', t);
  }
});

ws.on('error', (e) => console.log('ws error:', e.message));
setTimeout(() => { console.log('--- done (Ctrl-C to exit) ---'); }, 8000);
