import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { supabase } from "../supabase.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("[DEBUG] Webhook request received at /webhooks/orders/create");
  try {
    const { payload, topic, shop } = await authenticate.webhook(request);
    console.log(`[DEBUG] Webhook authenticated successfully: ${topic} for ${shop}`);

    const customerName = `${payload.customer?.first_name || ""} ${payload.customer?.last_name || ""}`.trim() || "Customer";
    const orderNumber = payload.name || `#${payload.id}`;
    const totalPrice = payload.total_price || "0.00";
    const currency = payload.currency || "AED";
    
    // Extract customer phone
    const phone = payload.phone || 
                  payload.customer?.phone || 
                  payload.billing_address?.phone || 
                  payload.shipping_address?.phone || 
                  "";
    const cleanPhone = phone.replace(/\D/g, "");

    // ─── 1. SYNC ORDER TO SUPABASE ───
    if (supabase) {
      const tagsArray = payload.tags 
        ? (typeof payload.tags === "string" 
            ? payload.tags.split(",").map((t: string) => t.trim()) 
            : payload.tags) 
        : [];

      console.log(`Syncing order ${orderNumber} to Supabase...`);
      const { error: dbError } = await supabase
        .from("orders")
        .upsert({
          id: String(payload.id),
          order_number: orderNumber,
          customer_id: payload.customer?.id ? String(payload.customer.id) : null,
          customer_email: payload.email || null,
          customer_phone: cleanPhone || null,
          customer_name: customerName,
          total_price: parseFloat(totalPrice),
          currency: currency,
          financial_status: payload.financial_status || "pending",
          fulfillment_status: payload.fulfillment_status || "unfulfilled",
          raw_data: payload,
          tags: tagsArray,
          notes: payload.note || null,
          shipping_address: payload.shipping_address || null,
          billing_address: payload.billing_address || null,
          shopify_shop: shop,
          updated_at: new Date().toISOString()
        });

      if (dbError) {
        console.error(`[ERROR] Failed to sync order ${orderNumber} to Supabase:`, dbError.message);
      } else {
        console.log(`[DEBUG] Successfully synced order ${orderNumber} to Supabase.`);
      }
    } else {
      console.log(`[DEBUG] Supabase client offline, skipped database sync for order ${orderNumber}.`);
    }

    // ─── 2. INSTAPAY WHATSAPP BOT FLOW (Existing Logic) ───
    const gatewayNames: string[] = payload.payment_gateway_names || [];
    const gateway: string = payload.gateway || "";
    const isInstapay = 
      gateway.toLowerCase().includes("instapay") || 
      gatewayNames.some(g => g.toLowerCase().includes("instapay"));

    if (!isInstapay) {
      console.log(`Order ${orderNumber} gateway is not Instapay (${gateway || gatewayNames.join(", ")}). Skipping WhatsApp bot.`);
      return new Response();
    }

    if (!cleanPhone) {
      console.error(`Order ${orderNumber} has no valid phone number. Cannot register in WhatsApp queue.`);
      return new Response();
    }

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
        shopifyOrderId: String(payload.id),
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

