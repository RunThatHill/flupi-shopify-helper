import db from "./db.server";
import { supabase } from "./supabase.server";

export function formatPhoneNumber(phone: string): string {
  if (!phone) return "";
  let cleaned = phone.replace(/\D/g, "");
  if (cleaned.startsWith("01") && cleaned.length === 11) {
    cleaned = "2" + cleaned;
  }
  return cleaned;
}

export interface CreateMessageParams {
  customerPhone: string;
  customerName?: string;
  direction: "inbound" | "outbound";
  senderName?: string;
  messageType?: "text" | "image" | "template" | "document";
  body?: string;
  mediaUrl?: string;
  metaMessageId?: string;
  shopifyOrderId?: string;
  status?: string;
}

let tablesEnsured = false;

/**
 * Auto-healing helper to create SQLite tables on the fly if missing in database
 */
export async function ensureTablesExist() {
  if (tablesEnsured) return;
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
    tablesEnsured = true;
  } catch (e: any) {
    console.warn("Auto-creating SQLite tables warning:", e.message);
  }
}

/**
 * Get or create a WhatsApp conversation by clean phone number
 */
export async function getOrCreateConversation(customerPhone: string, customerName?: string, shopifyOrderId?: string) {
  await ensureTablesExist();
  const cleanPhone = formatPhoneNumber(customerPhone);
  if (!cleanPhone) {
    throw new Error("Invalid customer phone number");
  }

  let conversation = await db.whatsAppConversation.findUnique({
    where: { customerPhone: cleanPhone }
  });

  if (!conversation) {
    conversation = await db.whatsAppConversation.create({
      data: {
        customerPhone: cleanPhone,
        customerName: customerName || `Customer (+${cleanPhone})`,
        shopifyOrderId: shopifyOrderId || null,
        unreadCount: 0,
        status: "active"
      }
    });
  } else if (customerName || shopifyOrderId) {
    conversation = await db.whatsAppConversation.update({
      where: { id: conversation.id },
      data: {
        ...(customerName ? { customerName } : {}),
        ...(shopifyOrderId ? { shopifyOrderId } : {})
      }
    });
  }

  if (supabase) {
    try {
      await supabase.from("whatsapp_conversations").upsert({
        id: conversation.id,
        customer_phone: cleanPhone,
        customer_name: conversation.customerName,
        last_message: conversation.lastMessage,
        last_message_at: conversation.lastMessageAt ? conversation.lastMessageAt.toISOString() : new Date().toISOString(),
        unread_count: conversation.unreadCount,
        status: conversation.status,
        shopify_order_id: conversation.shopifyOrderId,
        updated_at: new Date().toISOString()
      });
    } catch (e: any) {
      console.warn("Supabase conversation sync warning:", e.message);
    }
  }

  return conversation;
}

/**
 * Log a message to database & update conversation last activity
 */
export async function logWhatsAppMessage(params: CreateMessageParams) {
  await ensureTablesExist();
  const conversation = await getOrCreateConversation(
    params.customerPhone,
    params.customerName,
    params.shopifyOrderId
  );

  const excerpt = params.body || (params.messageType === "image" ? "📷 Image attached" : "Message");

  const message = await db.whatsAppMessage.create({
    data: {
      conversationId: conversation.id,
      metaMessageId: params.metaMessageId || null,
      direction: params.direction,
      senderName: params.senderName || (params.direction === "inbound" ? (conversation.customerName || "Customer") : "Flùpi Support"),
      messageType: params.messageType || "text",
      body: params.body || null,
      mediaUrl: params.mediaUrl || null,
      status: params.status || (params.direction === "inbound" ? "delivered" : "sent")
    }
  });

  const updatedConv = await db.whatsAppConversation.update({
    where: { id: conversation.id },
    data: {
      lastMessage: excerpt,
      lastMessageAt: new Date(),
      ...(params.direction === "inbound" ? { unreadCount: { increment: 1 } } : {})
    }
  });

  if (supabase) {
    try {
      await supabase.from("whatsapp_messages").upsert({
        id: message.id,
        meta_message_id: message.metaMessageId,
        conversation_id: conversation.id,
        customer_phone: params.customerPhone,
        direction: message.direction,
        sender_name: message.senderName,
        message_type: message.messageType,
        body: message.body,
        media_url: message.mediaUrl,
        status: message.status,
        created_at: message.createdAt.toISOString()
      });

      await supabase.from("whatsapp_conversations").upsert({
        id: updatedConv.id,
        customer_phone: updatedConv.customerPhone,
        customer_name: updatedConv.customerName,
        last_message: excerpt,
        last_message_at: updatedConv.lastMessageAt.toISOString(),
        unread_count: updatedConv.unreadCount,
        status: updatedConv.status,
        shopify_order_id: updatedConv.shopifyOrderId,
        updated_at: new Date().toISOString()
      });
    } catch (e: any) {
      console.warn("Supabase message sync warning:", e.message);
    }
  }

  return { conversation: updatedConv, message };
}

/**
 * Get all conversations sorted by latest activity, with Conversation ID search support
 */
export async function getConversations(searchQuery?: string) {
  await ensureTablesExist();

  try {
    const where: any = {};
    if (searchQuery && searchQuery.trim()) {
      const q = searchQuery.trim();
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
      orderBy: { lastMessageAt: "desc" },
      include: {
        _count: {
          select: { messages: true }
        }
      }
    });

    return list.map((c) => ({
      ...c,
      formattedConvId: `WA-${c.id.slice(-6).toUpperCase()}`
    }));
  } catch (err: any) {
    console.error("Error in getConversations, returning empty list fallback:", err.message);
    return [];
  }
}

/**
 * Update conversation status (e.g., 'bot', 'human_agent', 'resolved')
 */
export async function updateConversationStatus(conversationId: string, status: string) {
  await ensureTablesExist();
  try {
    const updated = await db.whatsAppConversation.update({
      where: { id: conversationId },
      data: { status }
    });

    if (supabase) {
      try {
        await supabase.from("whatsapp_conversations").update({ status, updated_at: new Date().toISOString() }).eq("id", conversationId);
      } catch (e: any) {}
    }

    return updated;
  } catch (e: any) {
    console.warn("Failed to update conversation status:", e.message);
    return null;
  }
}

/**
 * Get message history for a conversation
 */
export async function getConversationMessages(conversationId: string) {
  await ensureTablesExist();
  try {
    return await db.whatsAppMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" }
    });
  } catch (err: any) {
    console.error("Error fetching conversation messages:", err.message);
    return [];
  }
}

/**
 * Mark all messages in a conversation as read
 */
export async function markConversationAsRead(conversationId: string) {
  await ensureTablesExist();
  try {
    const updated = await db.whatsAppConversation.update({
      where: { id: conversationId },
      data: { unreadCount: 0 }
    });

    if (supabase) {
      try {
        await supabase.from("whatsapp_conversations").update({ unread_count: 0 }).eq("id", conversationId);
      } catch (e: any) {}
    }

    return updated;
  } catch (e: any) {
    console.warn("Failed to mark conversation as read:", e.message);
    return null;
  }
}
