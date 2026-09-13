import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import { downloadWhatsAppMedia, sendWhatsAppMessage, formatPhoneNumber } from "../whatsapp.server";
import { logWhatsAppMessage } from "../chat.server";
import fs from "fs/promises";
import path from "path";

/**
 * GET: Webhook Verification Endpoint (Meta Developer Dashboard Verification)
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expectedToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "favo_whatsapp_secret_2026";

  console.log(`[Meta Webhook GET] Verification request: mode=${mode}, token=${token}`);

  if (mode === "subscribe" && token === expectedToken) {
    console.log(`[Meta Webhook GET] Verification SUCCESSFUL! Returning challenge.`);
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" }
    });
  }

  console.warn(`[Meta Webhook GET] Verification FAILED: token mismatch or invalid mode.`);
  return new Response("Forbidden", { status: 403 });
};

/**
 * POST: Incoming WhatsApp Messages & Events Webhook Receiver
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const body = await request.json();
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    const contactName = value?.contacts?.[0]?.profile?.name || "";

    if (!message) {
      // Status update (sent, delivered, read) or non-message event
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    const fromPhone = formatPhoneNumber(message.from || "");
    const messageType = message.type;
    const metaMessageId = message.id;

    console.log(`[Meta Webhook] Incoming message type '${messageType}' from phone: ${fromPhone}`);

    // ── 1. HANDLE INCOMING PAYMENT PROOF SCREENSHOT ──
    if (messageType === "image") {
      const mediaId = message.image?.id;
      const caption = message.image?.caption || "";

      // Look up latest order in AWAITING_PROOF status for this phone number
      const order = await db.instapayOrderQueue.findFirst({
        where: {
          customerPhone: {
            contains: fromPhone.slice(-10) // match last 10 digits to handle formatting
          },
          status: "AWAITING_PROOF"
        },
        orderBy: { createdAt: "desc" }
      });

      let screenshotPath = "";
      if (mediaId) {
        console.log(`[Meta Webhook] Downloading proof screenshot...`);
        const dataUri = await downloadWhatsAppMedia(mediaId);

        // Save screenshot binary file locally in public/uploads/proofs/
        const base64Data = dataUri.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");

        const uploadDir = path.join(process.cwd(), "public", "uploads", "proofs");
        await fs.mkdir(uploadDir, { recursive: true });

        const filename = `${order?.shopifyOrderId || Date.now()}.jpg`;
        const filepath = path.join(uploadDir, filename);
        await fs.writeFile(filepath, buffer);

        screenshotPath = `/uploads/proofs/${filename}`;
      }

      // Log incoming image message in conversation database
      await logWhatsAppMessage({
        customerPhone: fromPhone,
        customerName: contactName || order?.customerName,
        direction: "inbound",
        senderName: contactName || order?.customerName || "Customer",
        messageType: "image",
        body: caption || "📷 Payment proof screenshot",
        mediaUrl: screenshotPath,
        metaMessageId,
        shopifyOrderId: order?.shopifyOrderId
      });

      if (!order) {
        console.warn(`[Meta Webhook] No order awaiting proof found for phone: ${fromPhone}`);
        const replyText = "Thank you for reaching out! We received your image. If you are uploading payment proof for an Instapay order, our team will review it shortly.\n\nشكراً لتواصلك معنا! استلمنا الصورة وسيتم مراجعتها قريباً.";
        
        await sendWhatsAppMessage({ to: fromPhone, text: replyText });
        await logWhatsAppMessage({
          customerPhone: fromPhone,
          direction: "outbound",
          senderName: "Flùpi System",
          messageType: "text",
          body: replyText
        });

        return new Response("EVENT_RECEIVED", { status: 200 });
      }

      // Update database queue status to PENDING_APPROVAL
      await db.instapayOrderQueue.update({
        where: { id: order.id },
        data: {
          status: "PENDING_APPROVAL",
          screenshotPath
        }
      });

      console.log(`[Meta Webhook] Saved screenshot for order ${order.orderNumber}. Queue updated to PENDING_APPROVAL.`);

      const ackText = "Thank you! We have received your payment screenshot. Our team will verify it shortly and confirm your order. Please note that verification can take up to 2 hours.\n\nشكراً لك! لقد استلمنا لقطة شاشة الدفع الخاصة بك. سيقوم فريقنا بالتحقق منها قريباً وتأكيد طلبك. يرجى ملاحظة أن عملية التحقق قد تستغرق ما يصل إلى ساعتين.";

      // Send confirmation reply back to customer via WhatsApp
      await sendWhatsAppMessage({ to: fromPhone, text: ackText });

      // Log outbound ACK message
      await logWhatsAppMessage({
        customerPhone: fromPhone,
        customerName: order.customerName,
        direction: "outbound",
        senderName: "Flùpi System",
        messageType: "text",
        body: ackText,
        shopifyOrderId: order.shopifyOrderId
      });

    } else if (messageType === "text") {
      const bodyText = message.text?.body || "";
      console.log(`[Meta Webhook] Customer sent text: "${bodyText}"`);

      // Log incoming text message
      await logWhatsAppMessage({
        customerPhone: fromPhone,
        customerName: contactName,
        direction: "inbound",
        senderName: contactName || "Customer",
        messageType: "text",
        body: bodyText,
        metaMessageId
      });
    }

  } catch (error: any) {
    console.error(`[Meta Webhook Action Error]:`, error);
  }

  // Always respond with 200 OK to Meta immediately
  return new Response("EVENT_RECEIVED", { status: 200 });
};
