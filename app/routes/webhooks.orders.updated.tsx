import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("[DEBUG] Webhook request received at /webhooks/orders/updated");
  try {
    const { payload, topic, shop } = await authenticate.webhook(request);
    console.log(`[DEBUG] Webhook authenticated successfully: ${topic} for ${shop}`);

    const customerName = `${payload.customer?.first_name || ""} ${payload.customer?.last_name || ""}`.trim() || "Customer";
    const orderNumber = payload.name || `#${payload.id}`;
    const totalPrice = payload.total_price || "0.00";
    const currency = payload.currency || "AED";
    
    const phone = payload.phone || 
                  payload.customer?.phone || 
                  payload.billing_address?.phone || 
                  payload.shipping_address?.phone || 
                  "";
    const cleanPhone = phone.replace(/\D/g, "");

    if (supabase) {
      const tagsArray = payload.tags 
        ? (typeof payload.tags === "string" 
            ? payload.tags.split(",").map((t: string) => t.trim()) 
            : payload.tags) 
        : [];

      console.log(`Updating order ${orderNumber} in Supabase...`);
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
        console.error(`[ERROR] Failed to update order ${orderNumber} in Supabase:`, dbError.message);
      } else {
        console.log(`[DEBUG] Successfully updated order ${orderNumber} in Supabase.`);
      }
    } else {
      console.log(`[DEBUG] Supabase client offline, skipped database update for order ${orderNumber}.`);
    }

  } catch (error: any) {
    console.error("Error processing orders/updated webhook:", error);
  }

  return new Response();
};
