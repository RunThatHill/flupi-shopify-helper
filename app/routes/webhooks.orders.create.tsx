import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { supabase } from "../supabase.server";
import { sendWhatsAppMessage } from "../whatsapp.server";

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

    // ─── 2. WHATSAPP NOTIFICATION FLOW ───
    const gatewayNames: string[] = payload.payment_gateway_names || [];
    const gateway: string = payload.gateway || "";
    const isInstapay = 
      gateway.toLowerCase().includes("instapay") || 
      gatewayNames.some(g => g.toLowerCase().includes("instapay"));

    if (!cleanPhone) {
      console.error(`Order ${orderNumber} has no valid phone number. Cannot send WhatsApp notification.`);
      return new Response();
    }

    const firstName = customerName.trim().split(/\s+/)[0] || "Customer";
    const currStr = currency === "EGP" ? "EGP" : currency;
    const currStrAr = currency === "EGP" ? "جنيه مصري" : currency;

    if (isInstapay) {
      console.log(`Registering Instapay order: ${orderNumber} for customer ${customerName} (${cleanPhone})`);

      // Save to local database queue
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

      const instapayLink = process.env.INSTAPAY_LINK || "https://ipn.eg/S/abdelmassehmorad/instapay/0esDlD";
      const instapayUser = process.env.INSTAPAY_USERNAME || "abdelmassehmorad@instapay";

      const instapayMsgText = `Hi ${firstName},\n\nThank you for your order ${orderNumber}! You selected Instapay checkout.\n\n💳 Amount to Transfer: ${totalPrice} ${currStr}\n👤 Instapay Account: ${instapayUser}\n🔗 Direct Payment Link: ${instapayLink}\n\nPlease click the link above or transfer to ${instapayUser}, then reply to this chat with a screenshot of your payment transfer to confirm and verify your order.\n\n---\n\nشكراً على طلبك ${orderNumber}! لقد اخترت الدفع الفوري Instapay.\n\n💳 المبلغ المطلوب تحويله: ${totalPrice} ${currStrAr}\n👤 عنوان حساب إنستاباي: ${instapayUser}\n🔗 رابط التحويل المباشر: ${instapayLink}\n\nيرجى الضغط على الرابط أعلاه أو التحويل إلى ${instapayUser}، ثم الرد على هذه المحادثة بصورة من تحويلك لتأكيد والتحقق من طلبك.`;

      console.log(`Sending Instapay payment request via WhatsApp to: ${cleanPhone}`);
      
      // Async non-blocking dispatch
      sendWhatsAppMessage({
        to: cleanPhone,
        text: instapayMsgText,
        shopifyOrderId: String(payload.id),
        orderNumber,
        customerName,
        amount: totalPrice,
        currency,
        isInstapay: true,
      }).catch(err => {
        console.error("Failed to send WhatsApp message for Instapay order:", err.message);
      });
    } else {
      console.log(`Order ${orderNumber} is standard (${gateway || gatewayNames.join(", ")}). Sending standard confirmation via WhatsApp.`);

      const standardMsgText = `Hi ${firstName},\n\nThank you for your order ${orderNumber}! We have received your order of ${totalPrice} ${currStr} and it is now being processed.\n\nشكراً على طلبك ${orderNumber}! لقد استلمنا طلبك بقيمة ${totalPrice} ${currStrAr} وجاري تجهيزه الآن.`;

      // Async non-blocking dispatch
      sendWhatsAppMessage({
        to: cleanPhone,
        text: standardMsgText,
        shopifyOrderId: String(payload.id),
        orderNumber,
        customerName,
        amount: totalPrice,
        currency,
        isInstapay: false,
      }).catch(err => {
        console.error("Failed to send WhatsApp message for standard order:", err.message);
      });
    }

  } catch (error: any) {
    console.error("Error processing orders/create webhook:", error);
  }

  // Always return 200 OK to Shopify to acknowledge receipt
  return new Response();
};

