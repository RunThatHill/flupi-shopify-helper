import db from "./db.server";
import { formatPhoneNumber } from "./whatsapp.server";
import { supabase } from "./supabase.server";

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

/**
 * Get or create a WhatsApp conversation by clean phone number
 */
export async function getOrCreateConversation(customerPhone: string, customerName?: string, shopifyOrderId?: string) {
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
    // Update name/order ID if provided
    conversation = await db.whatsAppConversation.update({
      where: { id: conversation.id },
      data: {
        ...(customerName ? { customerName } : {}),
        ...(shopifyOrderId ? { shopifyOrderId } : {})
      }
    });
  }

  // Sync to Supabase if configured
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
  const conversation = await getOrCreateConversation(
    params.customerPhone,
    params.customerName,
    params.shopifyOrderId
  );

  const excerpt = params.body || (params.messageType === "image" ? "📷 Image attached" : "Message");

  // Create message in local database
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

  // Update conversation last message & unread count
  const updatedConv = await db.whatsAppConversation.update({
    where: { id: conversation.id },
    data: {
      lastMessage: excerpt,
      lastMessageAt: new Date(),
      ...(params.direction === "inbound" ? { unreadCount: { increment: 1 } } : {})
    }
  });

  // Sync to Supabase if configured
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
  const where: any = {};
  if (searchQuery && searchQuery.trim()) {
    const q = searchQuery.trim();
    // Strip "WA-" or "CONV-" prefix if searching by conversation code
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
}

/**
 * Update conversation status (e.g., 'bot', 'human_agent', 'resolved')
 */
export async function updateConversationStatus(conversationId: string, status: string) {
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
}

/**
 * Get message history for a conversation
 */
export async function getConversationMessages(conversationId: string) {
  return db.whatsAppMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" }
  });
}

/**
 * Mark all messages in a conversation as read
 */
export async function markConversationAsRead(conversationId: string) {
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
}
