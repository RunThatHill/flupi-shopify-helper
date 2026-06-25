import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import db from "../db.server";
import { supabase } from "../supabase.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shopDomain = url.searchParams.get("shop") || "yf8qqz-at.myshopify.com";
  const limit = url.searchParams.get("limit") || "50";

  console.log(`[DEBUG] Syncing orders for shop: ${shopDomain}, limit: ${limit}`);

  try {
    // 1. Get session from DB
    let session = await db.session.findFirst({
      where: { shop: shopDomain },
    });

    if (!session) {
      session = await db.session.findFirst();
    }

    const accessToken = session?.accessToken ?? process.env.SHOPIFY_ACCESS_TOKEN ?? "";
    const resolvedShop = session?.shop ?? process.env.SHOPIFY_SHOP ?? shopDomain;

    if (!accessToken) {
      return json({ error: "No active Shopify session found" }, { status: 404, headers: corsHeaders });
    }

    if (!supabase) {
      return json({ error: "Supabase client is not initialized" }, { status: 500, headers: corsHeaders });
    }

    // 2. Fetch orders from Shopify REST API
    const shopifyUrl = `https://${resolvedShop}/admin/api/2025-01/orders.json?limit=${limit}&status=any`;
    const response = await fetch(shopifyUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ERROR] Shopify REST API failed: ${response.status} - ${errorText}`);
      return json({ error: "Shopify REST API failed", details: errorText }, { status: response.status, headers: corsHeaders });
    }

    const { orders } = await response.json();
    console.log(`[DEBUG] Fetched ${orders.length} orders from Shopify. Syncing to Supabase...`);

    let successCount = 0;
    let failCount = 0;

    for (const order of orders) {
      const customerName = `${order.customer?.first_name || ""} ${order.customer?.last_name || ""}`.trim() || "Customer";
      const orderNumber = order.name || `#${order.id}`;
      const totalPrice = order.total_price || "0.00";
      const currency = order.currency || "AED";
      
      const phone = order.phone || 
                    order.customer?.phone || 
                    order.billing_address?.phone || 
                    order.shipping_address?.phone || 
                    "";
      const cleanPhone = phone.replace(/\D/g, "");

      const tagsArray = order.tags 
        ? (typeof order.tags === "string" 
            ? order.tags.split(",").map((t: string) => t.trim()) 
            : order.tags) 
        : [];

      const { error: dbError } = await supabase
        .from("orders")
        .upsert({
          id: String(order.id),
          order_number: orderNumber,
          customer_id: order.customer?.id ? String(order.customer.id) : null,
          customer_email: order.email || null,
          customer_phone: cleanPhone || null,
          customer_name: customerName,
          total_price: parseFloat(totalPrice),
          currency: currency,
          financial_status: order.financial_status || "pending",
          fulfillment_status: order.fulfillment_status || "unfulfilled",
          raw_data: order,
          tags: tagsArray,
          notes: order.note || null,
          shipping_address: order.shipping_address || null,
          billing_address: order.billing_address || null,
          shopify_shop: resolvedShop,
          updated_at: new Date().toISOString()
        });

      if (dbError) {
        console.error(`[ERROR] Failed to sync order ${orderNumber} in sync-orders loader:`, dbError.message);
        failCount++;
      } else {
        successCount++;
      }
    }

    return json({
      success: true,
      message: `Sync completed: ${successCount} succeeded, ${failCount} failed.`,
      syncedCount: successCount,
      failedCount: failCount
    }, { headers: corsHeaders });

  } catch (error: any) {
    console.error("Error running sync-orders loader:", error);
    return json({ error: error.message }, { status: 500, headers: corsHeaders });
  }
};
