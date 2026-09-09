# wa-simplex-bridge

A small self-hosted bridge that relays messages **both ways** between a single
**WhatsApp group** and a single **SimpleX Chat** contact.

It was built for a common situation: one person you want to include in a group
chat refuses to use WhatsApp and will only use SimpleX (or vice-versa). The
bridge makes them a first-class participant — their messages appear in the
group, and the group's messages reach them on SimpleX, with media, quoted
replies, and reactions carried across.

> ⚠️ WhatsApp does not permit unofficial clients. This uses
> [Baileys](https://github.com/WhiskeySockets/Baileys), which drives a
> *linked-device* session. Use a number you are willing to risk, and read
> Baileys' own disclaimer. This project is provided as-is under the MIT license.

## What it does

- Listens to one WhatsApp group via a Baileys linked device.
- Talks to a locally-running SimpleX Chat CLI over its websocket API.
- Forwards every group message to the SimpleX contact, prefixed with the
  sender's label, and forwards the contact's replies back into the group under
  a configurable header.
- Keeps a persistent map of WhatsApp message IDs ↔ SimpleX item IDs on disk so
  that replies and reactions can be matched to the right original message.

### Features

| Feature | WhatsApp → SimpleX | SimpleX → WhatsApp |
| --- | --- | --- |
| Text | ✅ | ✅ |
| Images / video / voice / documents | ✅ | ✅ |
| Quoted replies | ✅ | ✅ |
| Emoji reactions | ✅ | ✅ |
| Per-sender display labels (any language/script, e.g. Arabic) | ✅ | n/a |

## Architecture

```
   WhatsApp group                                        SimpleX contact
        │                                                       │
        │  linked-device (Baileys)              websocket API    │
        ▼                                                       ▼
 ┌─────────────┐        ┌───────────────────────┐        ┌──────────────────┐
 │  WhatsApp   │◀──────▶│      bridge.mjs       │◀──────▶│  simplex-chat    │
 │  servers    │        │  ─────────────────    │  ws    │  CLI (-p 5225)   │
 └─────────────┘        │  • messages.upsert    │        │  --files-folder  │
                        │  • msgmap.json (IDs)  │        └──────────────────┘
                        │  • media staging dir  │
                        └───────────────────────┘
```

- **Baileys ↔ bridge** — `bridge.mjs` runs a Baileys socket as a linked device,
  subscribes to `messages.upsert` for the target group, and sends messages,
  media, quotes and reactions back to it.
- **bridge ↔ SimpleX** — the [SimpleX Chat](https://github.com/simplex-chat/simplex-chat)
  CLI is run in server mode (`-p 5225`). The bridge connects to its websocket,
  issues chat commands (`@contact ...`, `/f`, `/_send`, `/_reaction`,
  `/freceive`) and parses the JSON event stream.
- **State** — `msgmap.json` stores `wa2sx` / `sx2wa` ID maps plus enough of each
  WhatsApp message key to build a quote. Media is staged through
  `FILES_FOLDER`, which must be the same folder the SimpleX CLI was started with.

## Requirements

- Node.js ≥ 18
- The [`simplex-chat`](https://github.com/simplex-chat/simplex-chat/releases)
  CLI binary
- A WhatsApp account (phone) to link as a device
- An established SimpleX contact (you must have already connected once, so it
  shows under `/contacts`)

## Setup

```bash
git clone https://github.com/potatomt/wa-simplex-bridge.git
cd wa-simplex-bridge
npm install

cp .env.example .env            # then edit
cp names.example.json names.json # optional, then edit
```

1. **Start the SimpleX CLI in server mode**, pointing at a files folder that
   matches `FILES_FOLDER` in your `.env`:

   ```bash
   mkdir -p files
   simplex-chat -p 5225 --files-folder ./files -f
   ```

   Leave it running (under its own pm2 process in production — see below).

2. **Find your group JID.** With `.env` filled in enough to authenticate
   (`AUTH_DIR`), run:

   ```bash
   npm run list-groups
   ```

   Scan the QR code with **WhatsApp → Linked Devices**. It prints every group
   and its JID. Put the right one in `WA_GROUP_ID`, then stop this script.

3. **Set `SIMPLEX_CONTACT`** to the contact's local display name exactly as it
   appears in the CLI's `/contacts` list.

4. **Fill `names.json`** (optional) with `"number": "label"` pairs. Numbers are
   country code + number, no `+`. Anyone not listed shows up by their WhatsApp
   profile name or bare number.

5. **Run the bridge:**

   ```bash
   npm start
   ```

   On first run scan the QR with WhatsApp → Linked Devices. The session is
   saved in `AUTH_DIR` and reused after that.

## Environment variables

| Variable | Required | Default | Description                                                                                                                |
| --- | --- | --- |----------------------------------------------------------------------------------------------------------------------------|
| `WA_GROUP_ID` | yes | — | Target WhatsApp group JID, e.g. `1203630000000000000@g.us`. Discover with `npm run list-groups`.                           |
| `SIMPLEX_CONTACT` | yes | — | Local display name of the SimpleX contact to bridge with.                                                                  |
| `SIMPLEX_WS` | no | `ws://localhost:5225` | Websocket address of the SimpleX Chat CLI.                                                                                 |
| `FILES_FOLDER` | no | `./files` | Folder the SimpleX CLI reads/writes files in; must match its `--files-folder`. Incoming WhatsApp media is staged here too. |
| `MAP_FILE` | no | `./msgmap.json` | Path to the persisted WhatsApp ↔ SimpleX message-ID map.                                                                   |
| `AUTH_DIR` | no | `./auth` | Baileys multi-file auth-state folder (the WhatsApp session).                                                               |
| `NAMES_FILE` | no | `./names.json` | JSON map of number → display label for forwarded WhatsApp senders.                                                         |
| `DAD_HEADER` | no | `Message from Dad` | Header prefixed to messages coming from SimpleX into the group. Any language / script, e.g. `رسالة من ابوي`.               |

## Helper scripts

| Command | Purpose |
| --- | --- |
| `npm run list-groups` | List every WhatsApp group + member numbers; used to find `WA_GROUP_ID`. Run with the bridge stopped. |
| `npm run sx-debug` | Dump raw SimpleX CLI events to stdout for troubleshooting. Run with the bridge stopped. |
| `npm run sx-test` | Send one tiny test PNG to `SIMPLEX_CONTACT` to verify file sending / `--files-folder`. Run with the bridge stopped. |

## Deployment (pm2)

Run the SimpleX CLI and the bridge as two long-lived processes:

```bash
# 1. SimpleX Chat CLI as a websocket server
pm2 start "simplex-chat -p 5225 --files-folder $(pwd)/files -f" --name simplex-chat

# 2. the bridge
pm2 start ecosystem.config.cjs        # reads .env via dotenv

pm2 save                              # persist across reboots
pm2 startup                           # follow the printed instruction
```

Useful:

```bash
pm2 logs wa-simplex-bridge
pm2 restart wa-simplex-bridge
pm2 restart simplex-chat
```

Notes:

- The bridge reconnects on its own if either side drops.
- `msgmap.json` grows slowly; it is safe to delete when both processes are
  stopped (you lose reply/reaction matching for older messages only).
- Back up `AUTH_DIR` — losing it means re-linking the device.

## How reply / reaction matching works

Every time the bridge relays a message it records the pair
`(whatsappMessageId, simplexItemId)` in `MAP_FILE`, along with a trimmed copy of
the WhatsApp message key and text. When a reply or reaction arrives referencing
one of those IDs, the bridge looks up the counterpart and reconstructs a native
quote / reaction on the other platform. IDs that predate the map (or that were
lost when the map was cleared) simply fall through as plain messages.

## License

[MIT](LICENSE)
