/**
 * Meta WhatsApp Cloud API & Baileys Bot Unified Messaging Helper
 */

interface SendMessageOptions {
  to: string;
  text: string;
  templateName?: string;
  templateLanguage?: string;
  templateComponents?: any[];
  shopifyOrderId?: string;
  orderNumber?: string;
  customerName?: string;
  amount?: string;
  currency?: string;
  isInstapay?: boolean;
}

/**
 * Clean phone number to E.164 numerical format without leading '+'
 */
export function formatPhoneNumber(phone: string): string {
  let cleaned = phone.replace(/\D/g, "");
  // If local Egyptian format starting with 01..., prepend country code 2
  if (cleaned.startsWith("01") && cleaned.length === 11) {
    cleaned = "2" + cleaned;
  }
  return cleaned;
}

/**
 * Send WhatsApp Message using Meta Cloud API (with optional fallback to Baileys Bot)
 */
export async function sendWhatsAppMessage(options: SendMessageOptions) {
  const token = process.env.WHATSAPP_CLOUD_API_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const botUrl = process.env.WHATSAPP_BOT_URL;

  const targetPhone = formatPhoneNumber(options.to);
  if (!targetPhone) {
    throw new Error("Invalid or missing phone number");
  }

  // ── 1. TRY META WHATSAPP CLOUD API FIRST ──
  if (token && phoneId) {
    try {
      console.log(`[WhatsApp Cloud API] Sending message to ${targetPhone}...`);
      const metaEndpoint = `https://graph.facebook.com/v25.0/${phoneId}/messages`;

      let bodyPayload: any;

      if (options.templateName) {
        // Template Message (Required for business-initiated chats outside 24h window)
        bodyPayload = {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: targetPhone,
          type: "template",
          template: {
            name: options.templateName,
            language: { code: options.templateLanguage || "en_US" },
            ...(options.templateComponents ? { components: options.templateComponents } : {})
          }
        };
      } else {
        // Freeform Text Message (Used inside 24h customer window or for test messages)
        bodyPayload = {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: targetPhone,
          type: "text",
          text: {
            preview_url: false,
            body: options.text
          }
        };
      }

      const response = await fetch(metaEndpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(bodyPayload)
      });

      const resJson = await response.json();

      if (response.ok) {
        console.log(`[WhatsApp Cloud API] Success! Message ID: ${resJson.messages?.[0]?.id}`);
        return { success: true, provider: "cloud_api", metaResponse: resJson };
      } else {
        console.warn(`[WhatsApp Cloud API] Error from Meta API (${response.status}):`, JSON.stringify(resJson));
        
        // If template error or outside 24h window error, attempt fallback to template or bot
        if (resJson.error?.code === 131047 && !options.templateName) {
          console.log(`[WhatsApp Cloud API] Customer window closed. Retrying with default 'hello_world' template...`);
          return sendWhatsAppMessage({
            ...options,
            templateName: "hello_world"
          });
        }
      }
    } catch (err: any) {
      console.error(`[WhatsApp Cloud API] Request failed: ${err.message}`);
    }
  }

  // ── 2. FALLBACK TO BAILEYS BOT IF CONFIGURED ──
  if (botUrl) {
    console.log(`[WhatsApp Bot Fallback] Forwarding request to Baileys bot at ${botUrl}/send-request...`);
    try {
      const response = await fetch(`${botUrl}/send-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopifyOrderId: options.shopifyOrderId,
          phone: targetPhone,
          name: options.customerName,
          orderNumber: options.orderNumber,
          amount: options.amount,
          currency: options.currency,
          isInstapay: options.isInstapay
        })
      });
      const resJson = await response.json();
      return { success: response.ok, provider: "baileys_bot", botResponse: resJson };
    } catch (err: any) {
      console.error(`[WhatsApp Bot Fallback] Failed: ${err.message}`);
    }
  }

  return { success: false, error: "No operational WhatsApp provider configured" };
}

/**
 * Download Media (e.g. proof screenshot) from Meta WhatsApp Cloud API
 */
export async function downloadWhatsAppMedia(mediaId: string): Promise<string> {
  const token = process.env.WHATSAPP_CLOUD_API_TOKEN;
  if (!token) {
    throw new Error("WHATSAPP_CLOUD_API_TOKEN is missing");
  }

  // Step 1: Retrieve Media URL from Meta Graph API
  console.log(`[WhatsApp Cloud API] Resolving media URL for media ID: ${mediaId}`);
  const metadataRes = await fetch(`https://graph.facebook.com/v25.0/${mediaId}`, {
    headers: { "Authorization": `Bearer ${token}` }
  });

  const metadata = await metadataRes.json();
  if (!metadataRes.ok || !metadata.url) {
    throw new Error(`Failed to resolve media URL from Meta: ${JSON.stringify(metadata)}`);
  }

  // Step 2: Download binary media stream from Meta URL
  console.log(`[WhatsApp Cloud API] Downloading binary image stream from Meta...`);
  const mediaRes = await fetch(metadata.url, {
    headers: { "Authorization": `Bearer ${token}` }
  });

  if (!mediaRes.ok) {
    throw new Error(`Failed to download binary media file (HTTP ${mediaRes.status})`);
  }

  const arrayBuffer = await mediaRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const base64Data = buffer.toString("base64");
  const mimeType = metadata.mime_type || "image/jpeg";

  return `data:${mimeType};base64,${base64Data}`;
}
