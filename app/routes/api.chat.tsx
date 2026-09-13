import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getConversations, getConversationMessages, markConversationAsRead, logWhatsAppMessage } from "../chat.server";
import { sendWhatsAppMessage } from "../whatsapp.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId");
  const search = url.searchParams.get("search") || undefined;

  try {
    if (conversationId) {
      await markConversationAsRead(conversationId);
      const messages = await getConversationMessages(conversationId);
      return json({ messages }, { headers: corsHeaders });
    }

    const conversations = await getConversations(search);
    return json({ conversations }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("Error in api.chat loader:", error);
    return json({ error: error.message }, { status: 500, headers: corsHeaders });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = await request.json();
    const { action: actionType, customerPhone, message, agentName, shopifyOrderId, conversationId } = body;

    if (actionType === "mark_read" && conversationId) {
      await markConversationAsRead(conversationId);
      return json({ success: true }, { headers: corsHeaders });
    }

    if (!customerPhone || !message) {
      return json({ error: "Missing customerPhone or message" }, { status: 400, headers: corsHeaders });
    }

    // Format text with agent prefix if configured
    const sender = agentName ? agentName.trim() : "Flùpi Support";
    const formattedText = `${sender}: ${message}`;

    console.log(`[CRM Inbox] Sending agent reply from '${sender}' to phone ${customerPhone}...`);

    // 1. Send message via Meta WhatsApp Cloud API / Baileys
    const sendResult = await sendWhatsAppMessage({
      to: customerPhone,
      text: formattedText,
      shopifyOrderId
    });

    if (!sendResult.success) {
      console.warn(`[CRM Inbox] Failed to dispatch message via WhatsApp API: ${sendResult.error}`);
    }

    // 2. Log outbound message to database
    const { message: savedMsg } = await logWhatsAppMessage({
      customerPhone,
      direction: "outbound",
      senderName: sender,
      messageType: "text",
      body: message,
      shopifyOrderId,
      status: sendResult.success ? "sent" : "failed"
    });

    return json({ success: true, message: savedMsg, sendResult }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("Error in api.chat action:", error);
    return json({ error: error.message }, { status: 500, headers: corsHeaders });
  }
};
