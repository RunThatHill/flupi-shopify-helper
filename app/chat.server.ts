import db from "./db.server";
import { formatPhoneNumber } from "./whatsapp.server";

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

  // Create message
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
  await db.whatsAppConversation.update({
    where: { id: conversation.id },
    data: {
      lastMessage: excerpt,
      lastMessageAt: new Date(),
      ...(params.direction === "inbound" ? { unreadCount: { increment: 1 } } : {})
    }
  });

  return { conversation, message };
}

/**
 * Get all conversations sorted by latest activity
 */
export async function getConversations(searchQuery?: string) {
  const where: any = {};
  if (searchQuery) {
    where.OR = [
      { customerPhone: { contains: searchQuery } },
      { customerName: { contains: searchQuery } },
      { shopifyOrderId: { contains: searchQuery } }
    ];
  }

  return db.whatsAppConversation.findMany({
    where,
    orderBy: { lastMessageAt: "desc" },
    include: {
      _count: {
        select: { messages: true }
      }
    }
  });
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
  await db.whatsAppConversation.update({
    where: { id: conversationId },
    data: { unreadCount: 0 }
  });
}
