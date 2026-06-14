import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import express from 'express';
import cors from 'cors';

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

const PORT = process.env.WHATSAPP_BOT_PORT || 3001;
const HELPER_URL = process.env.SHOPIFY_HELPER_URL || 'http://localhost:8080';

let sock = null;

// Connect to WhatsApp
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[WA-Bot] Using Baileys version v${version.join('.')}, isLatest: ${isLatest}`);

  sock = makeWASocket({
    version,
    printQRInTerminal: true,
    auth: state,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('[WA-Bot] Scan this QR code to log in:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('[WA-Bot] Connection closed due to', lastDisconnect.error, ', reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('[WA-Bot] Connection successfully opened!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Listen to incoming messages
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.key.fromMe && m.type === 'notify') {
      const from = msg.key.remoteJid;
      const phone = from.split('@')[0];
      const messageType = Object.keys(msg.message || {})[0];
      const isImage = messageType === 'imageMessage';

      if (isImage) {
        console.log(`[WA-Bot] Received image message from phone: ${phone}`);

        try {
          // Download the image buffer
          const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            { 
              logger: undefined,
              reuploadRequest: sock.updateMediaMessage
            }
          );

          const base64Screenshot = buffer.toString('base64');
          console.log(`[WA-Bot] Forwarding proof screenshot to Shopify helper at ${HELPER_URL}/api/orders...`);

          // Send to Shopify helper API
          const response = await fetch(`${HELPER_URL}/api/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'upload_proof',
              phone,
              screenshot: `data:image/jpeg;base64,${base64Screenshot}`
            })
          });

          const resJson = await response.json();

          if (response.ok) {
            console.log(`[WA-Bot] Screenshot successfully processed for ${phone}`);
            await sock.sendMessage(from, { 
              text: 'Thank you! We have received your payment screenshot. Our team will verify it shortly and confirm your order.' 
            });
          } else {
            console.warn(`[WA-Bot] Proof upload rejected by helper: ${resJson.error}`);
            // No active order awaiting proof, ignore or reply politely
          }

        } catch (err) {
          console.error('[WA-Bot] Failed to download or upload screenshot:', err);
        }
      }
    }
  });
}

// HTTP API: Send Instapay Payment Request
app.post('/send-request', async (req, res) => {
  const { phone, name, orderNumber, amount, currency } = req.body;
  if (!phone) {
    return res.status(400).json({ error: 'Missing phone' });
  }

  const jid = `${phone}@s.whatsapp.net`;
  const message = `Hi ${name},\n\nThank you for your order ${orderNumber}! You selected Instapay checkout. Please reply to this chat with a screenshot of your payment transfer of ${amount} ${currency} to confirm and verify your order.`;

  try {
    if (!sock) {
      throw new Error('WhatsApp client is not connected');
    }
    await sock.sendMessage(jid, { text: message });
    console.log(`[WA-Bot] Sent payment request message to ${phone} for order ${orderNumber}`);
    return res.json({ success: true });
  } catch (err) {
    console.error(`[WA-Bot] Failed to send payment request to ${phone}:`, err);
    return res.status(500).json({ error: err.message });
  }
});

// HTTP API: Send Payment Confirmation Success
app.post('/send-success', async (req, res) => {
  const { phone, orderNumber } = req.body;
  if (!phone) {
    return res.status(400).json({ error: 'Missing phone' });
  }

  const jid = `${phone}@s.whatsapp.net`;
  const message = `Payment Verified! ✅\n\nYour payment for order ${orderNumber} has been verified and your order is now confirmed. Thank you for shopping with us!`;

  try {
    if (!sock) {
      throw new Error('WhatsApp client is not connected');
    }
    await sock.sendMessage(jid, { text: message });
    console.log(`[WA-Bot] Sent payment confirmation success message to ${phone} for order ${orderNumber}`);
    return res.json({ success: true });
  } catch (err) {
    console.error(`[WA-Bot] Failed to send payment confirmation to ${phone}:`, err);
    return res.status(500).json({ error: err.message });
  }
});

// Start Express Server
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`[WA-Bot] Express server running on port ${PORT}`);
});

// Initialize WhatsApp connection
connectToWhatsApp().catch(err => {
  console.error('[WA-Bot] Failed to connect to WhatsApp:', err);
});
