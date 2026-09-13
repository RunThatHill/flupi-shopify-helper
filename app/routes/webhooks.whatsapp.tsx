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
      const lowerText = bodyText.toLowerCase().trim();
      console.log(`[Meta Webhook] Customer sent text: "${bodyText}"`);

      // 1. Log incoming text message
      const { conversation } = await logWhatsAppMessage({
        customerPhone: fromPhone,
        customerName: contactName,
        direction: "inbound",
        senderName: contactName || "Customer",
        messageType: "text",
        body: bodyText,
        metaMessageId
      });

      // 2. Check for Human Agent Handoff request
      const isHumanRequest = /agent|human|support|مواظف|مواظفين|خدمة العملاء|انسان|تحدث|مساعدة|help|3/i.test(lowerText);

      if (isHumanRequest) {
        const { updateConversationStatus } = await import("../chat.server");
        await updateConversationStatus(conversation.id, "human_agent");

        const handoffReply = "⚡ Connecting you to a live support agent! A representative has been notified in our CRM inbox and will respond shortly.\n\nتم تحويل محادثتك لممثل خدمة العملاء. تم إبلاغ فريقنا وسيقوم أحد الموظفين بالرد عليك قريباً!";
        await sendWhatsAppMessage({ to: fromPhone, text: handoffReply });
        await logWhatsAppMessage({
          customerPhone: fromPhone,
          customerName: contactName,
          direction: "outbound",
          senderName: "Flùpi Assistant",
          messageType: "text",
          body: handoffReply
        });
        return new Response("EVENT_RECEIVED", { status: 200 });
      }

      // 3. Check for Order Status Inquiry ("Where is my order?")
      const isOrderStatusInquiry = /order|where|status|مكاني|فين|الطلب|طلب|تتبع|شحن|track|1/i.test(lowerText);

      if (isOrderStatusInquiry) {
        // Query Instapay queue order
        const order = await db.instapayOrderQueue.findFirst({
          where: {
            customerPhone: { contains: fromPhone.slice(-10) }
          },
          orderBy: { createdAt: "desc" }
        });

        let statusText = "";
        if (order) {
          const readableStatus =
            order.status === "AWAITING_PROOF"
              ? "⏳ Awaiting Instapay Payment Proof"
              : order.status === "PENDING_APPROVAL"
              ? "🔍 Payment Proof Uploaded — Under Staff Verification"
              : order.status === "CONFIRMED"
              ? "✅ Order Paid & Confirmed for Delivery"
              : order.status;

          statusText = `📦 Order Status for ${order.orderNumber}:\n• Total: ${order.totalPrice} ${order.currency}\n• Status: ${readableStatus}\n\nNeed more assistance? Reply 'agent' at any time to talk to a human support representative.\n\nحالة الطلب ${order.orderNumber}:\n• إجمالي المبلغ: ${order.totalPrice} EGP\n• الحالة الحالية: ${readableStatus}\n\nللتحدث مع ممثل خدمة العملاء، ارسل كلمة 'مواظف'.`;
        } else {
          statusText = `Hello! We couldn't locate a recent pending order associated with (+${fromPhone}).\n\nIf you have a general question or want to inquire about a specific order, reply 'agent' to connect with a live support agent!\n\nأهلاً بك! لم نجد طلب حالي مرتبط بهذا الرقم.\nللتحدث مع الموظف مباشرةً، ارسل كلمة 'مواظف'.`;
        }

        await sendWhatsAppMessage({ to: fromPhone, text: statusText });
        await logWhatsAppMessage({
          customerPhone: fromPhone,
          customerName: contactName,
          direction: "outbound",
          senderName: "Flùpi Assistant",
          messageType: "text",
          body: statusText
        });
        return new Response("EVENT_RECEIVED", { status: 200 });
      }

      // 4. Default Interactive Welcome Menu for general greetings
      const greetingReply = "Welcome to Flùpi Support! 🛍️\nHow can we help you today?\n\n1️⃣ Reply '1' or 'order' for Live Order Status & Tracking\n2️⃣ Send a photo to upload Instapay payment screenshot\n3️⃣ Reply 'agent' to talk directly with a real human agent.\n\nأهلاً بك في خدمة عملاء Flùpi!\n1️⃣ اكتب '1' لمعرفة حالة الطلب والتتبع\n2️⃣ ارسل صورة التحويل لتأكيد دفع إنستا باي\n3️⃣ اكتب 'مواظف' للتحدث مباشرة مع الدعم الفني.";

      await sendWhatsAppMessage({ to: fromPhone, text: greetingReply });
      await logWhatsAppMessage({
        customerPhone: fromPhone,
        customerName: contactName,
        direction: "outbound",
        senderName: "Flùpi Assistant",
        messageType: "text",
        body: greetingReply
      });
    }

  } catch (error: any) {
    console.error(`[Meta Webhook Action Error]:`, error);
  }

  // Always respond with 200 OK to Meta immediately
  return new Response("EVENT_RECEIVED", { status: 200 });
};
