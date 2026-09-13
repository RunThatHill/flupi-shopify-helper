import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getConversations, getConversationMessages, markConversationAsRead, logWhatsAppMessage, updateConversationStatus } from "../chat.server";
import { sendWhatsAppMessage } from "../whatsapp.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId");
    const search = url.searchParams.get("search") || undefined;

    if (conversationId) {
      try {
        await markConversationAsRead(conversationId);
      } catch (e) {}
      const messages = await getConversationMessages(conversationId).catch(() => []);
      return json({ messages }, { headers: corsHeaders });
    }

    const conversations = await getConversations(search).catch(() => []);
    return json({ conversations }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("Error in api.chat loader:", error);
    return json({ conversations: [], messages: [] }, { status: 200, headers: corsHeaders });
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

    if (actionType === "update_status" && conversationId && body.status) {
      const updated = await updateConversationStatus(conversationId, body.status);
      return json({ success: true, conversation: updated }, { headers: corsHeaders });
    }

    if (!customerPhone || !message) {
      return json({ error: "Missing customerPhone or message" }, { status: 400, headers: corsHeaders });
    }

    const sender = agentName ? agentName.trim() : "Flùpi Support";
    const formattedText = `${sender}: ${message}`;

    const sendResult = await sendWhatsAppMessage({
      to: customerPhone,
      text: formattedText,
      shopifyOrderId
    });

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
