import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import db from "../db.server";

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

    // Auto-create SQLite tables if missing
    try {
      await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "WhatsAppConversation" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "customerPhone" TEXT NOT NULL UNIQUE,
          "customerName" TEXT,
          "lastMessage" TEXT,
          "lastMessageAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "unreadCount" INTEGER NOT NULL DEFAULT 0,
          "status" TEXT NOT NULL DEFAULT 'active',
          "shopifyOrderId" TEXT,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "WhatsAppMessage" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "metaMessageId" TEXT UNIQUE,
          "conversationId" TEXT NOT NULL,
          "direction" TEXT NOT NULL,
          "senderName" TEXT,
          "messageType" TEXT NOT NULL DEFAULT 'text',
          "body" TEXT,
          "mediaUrl" TEXT,
          "status" TEXT NOT NULL DEFAULT 'sent',
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "WhatsAppMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "WhatsAppConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
        );
      `);
    } catch (e: any) {}

    if (conversationId) {
      try {
        await db.whatsAppConversation.update({
          where: { id: conversationId },
          data: { unreadCount: 0 }
        });
      } catch (e) {}

      const messages = await db.whatsAppMessage.findMany({
        where: { conversationId },
        orderBy: { createdAt: "asc" }
      });
      return json({ messages }, { headers: corsHeaders });
    }

    const where: any = {};
    if (search && search.trim()) {
      const q = search.trim();
      const rawCode = q.replace(/^(WA-|CONV-)/i, "");
      where.OR = [
        { id: { contains: q } },
        { id: { contains: rawCode } },
        { customerPhone: { contains: q } },
        { customerName: { contains: q } },
        { shopifyOrderId: { contains: q } }
      ];
    }

    const list = await db.whatsAppConversation.findMany({
      where,
      orderBy: { lastMessageAt: "desc" }
    });

    const conversations = list.map((c) => ({
      ...c,
      formattedConvId: `WA-${c.id.slice(-6).toUpperCase()}`
    }));

    return json({ conversations }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("Error in api.chat loader:", error);
    return json({ conversations: [], messages: [], error: error.message }, { status: 200, headers: corsHeaders });
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
      try {
        await db.whatsAppConversation.update({
          where: { id: conversationId },
          data: { unreadCount: 0 }
        });
      } catch (e) {}
      return json({ success: true }, { headers: corsHeaders });
    }

    if (actionType === "update_status" && conversationId && body.status) {
      const updated = await db.whatsAppConversation.update({
        where: { id: conversationId },
        data: { status: body.status }
      });
      return json({ success: true, conversation: updated }, { headers: corsHeaders });
    }

    if (!customerPhone || !message) {
      return json({ error: "Missing customerPhone or message" }, { status: 400, headers: corsHeaders });
    }

    const sender = agentName ? agentName.trim() : "Flùpi Support";
    const formattedText = `${sender}: ${message}`;

    const { sendWhatsAppMessage } = await import("../whatsapp.server");
    const { logWhatsAppMessage } = await import("../chat.server");

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
