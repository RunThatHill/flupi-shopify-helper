import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("[DEBUG] Webhook request received at /webhooks/orders/create");
  try {
    const { payload, topic, shop } = await authenticate.webhook(request);
    console.log(`[DEBUG] Webhook authenticated successfully: ${topic} for ${shop}`);

    // Check payment gateway (case insensitive check for "instapay")
    const gatewayNames: string[] = payload.payment_gateway_names || [];
    const gateway: string = payload.gateway || "";
    const isInstapay = 
      gateway.toLowerCase().includes("instapay") || 
      gatewayNames.some(g => g.toLowerCase().includes("instapay"));

    if (!isInstapay) {
      console.log(`Order ${payload.name} gateway is not Instapay (${gateway || gatewayNames.join(", ")}). Skipping.`);
      return new Response();
    }

    // Extract customer phone
    const phone = payload.phone || 
                  payload.customer?.phone || 
                  payload.billing_address?.phone || 
                  payload.shipping_address?.phone || 
                  "";
    
    // Clean phone number (keep digits only)
    const cleanPhone = phone.replace(/\D/g, "");
    if (!cleanPhone) {
      console.error(`Order ${payload.name} has no valid phone number. Cannot register in WhatsApp queue.`);
      return new Response();
    }

    const customerName = `${payload.customer?.first_name || ""} ${payload.customer?.last_name || ""}`.trim() || "Customer";
    const orderNumber = payload.name || `#${payload.id}`;
    const totalPrice = payload.total_price || "0.00";
    const currency = payload.currency || "AED";

    console.log(`Registering Instapay order: ${orderNumber} for customer ${customerName} (${cleanPhone})`);

    // Save to local database
    await db.instapayOrderQueue.upsert({
      where: { shopifyOrderId: String(payload.id) },
      update: {
        orderNumber,
        customerName,
        customerPhone: cleanPhone,
        totalPrice,
        currency,
        status: "AWAITING_PROOF",
      },
      create: {
        shopifyOrderId: String(payload.id),
        orderNumber,
        customerName,
        customerPhone: cleanPhone,
        totalPrice,
        currency,
        status: "AWAITING_PROOF",
      }
    });

    // Notify WhatsApp bot asynchronously
    const botUrl = process.env.WHATSAPP_BOT_URL || "http://localhost:3001";
    console.log(`Notifying WhatsApp bot at: ${botUrl}/send-request`);
    
    // Non-blocking fetch so we don't delay Shopify's webhook response
    fetch(`${botUrl}/send-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: cleanPhone,
        name: customerName,
        orderNumber,
        amount: totalPrice,
        currency,
      }),
    }).catch(err => {
      console.error("Failed to notify WhatsApp bot:", err.message);
    });

  } catch (error: any) {
    console.error("Error processing orders/create webhook:", error);
  }

  // Always return 200 OK to Shopify to acknowledge receipt
  return new Response();
};
