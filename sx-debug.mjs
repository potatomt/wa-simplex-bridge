// sx-debug.mjs — prints raw SimpleX Chat CLI events so you can inspect their shape.
//
// Run with the bridge STOPPED:
//   node sx-debug.mjs
// Then have the bridged contact send you a text, then a photo, and watch the output.

import 'dotenv/config';
import WebSocket from 'ws';

const SIMPLEX_WS = process.env.SIMPLEX_WS || 'ws://localhost:5225';

const ws = new WebSocket(SIMPLEX_WS);
let corr = 0;

ws.on('open', () => {
  console.log('--- connected, sending /_start ---');
  ws.send(JSON.stringify({ corrId: `d${++corr}`, cmd: '/_start' }));
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    // print just the event type first, then the full object
    console.log('\n=== EVENT type:', msg.resp?.type, '===');
    console.log(JSON.stringify(msg, null, 2));
  } catch {
    console.log('RAW:', data.toString());
  }
});

ws.on('close', () => console.log('--- closed ---'));
ws.on('error', (e) => console.log('--- error:', e.message, '---'));
