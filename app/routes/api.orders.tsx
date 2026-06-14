import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import db from "../db.server";
import shopify from "../shopify.server";
import fs from "fs/promises";
import path from "path";

// CORS Headers helper
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Handle OPTIONS preflight requests
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "PENDING_APPROVAL";

  try {
    const orders = await db.instapayOrderQueue.findMany({
      where: { status },
      orderBy: { createdAt: "desc" },
    });

    return json(orders, {
      headers: corsHeaders,
    });
  } catch (error: any) {
    console.error("Error fetching order queue:", error);
    return json({ error: error.message }, { status: 500, headers: corsHeaders });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = await request.json();
    const { action, shopifyOrderId, phone, screenshot, currency, amount } = body;

    // ─────────────────────────────────────────────────────────────────────────
    // ACTION: update_phone (called by WhatsApp Bot when phone resolves to LID)
    // ─────────────────────────────────────────────────────────────────────────
    if (action === "update_phone") {
      if (!shopifyOrderId || !phone) {
        return json({ error: "Missing shopifyOrderId or phone" }, { status: 400, headers: corsHeaders });
      }
      const cleanPhone = phone.replace(/\D/g, "");
      const updatedOrder = await db.instapayOrderQueue.update({
        where: { shopifyOrderId },
        data: { customerPhone: cleanPhone },
      });
      console.log(`[DEBUG] Updated order ${updatedOrder.orderNumber} phone to resolved JID/LID: ${cleanPhone}`);
      return json({ success: true, order: updatedOrder }, { headers: corsHeaders });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ACTION: upload_proof (called by WhatsApp Bot when customer sends media)
    // ─────────────────────────────────────────────────────────────────────────
    if (action === "upload_proof") {
      if (!phone || !screenshot) {
        return json({ error: "Missing phone or screenshot payload" }, { status: 400, headers: corsHeaders });
      }

      // Clean the incoming phone number (digits only)
      const cleanPhone = phone.replace(/\D/g, "");

      // Find the latest order in AWAITING_PROOF state for this phone number
      const order = await db.instapayOrderQueue.findFirst({
        where: {
          customerPhone: cleanPhone,
          status: "AWAITING_PROOF",
        },
        orderBy: { createdAt: "desc" },
      });

      if (!order) {
        return json({ error: `No order awaiting proof found for phone: ${cleanPhone}` }, { status: 404, headers: corsHeaders });
      }

      // Decode base64 image and save to public/uploads/proofs/
      const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      
      const uploadDir = path.join(process.cwd(), "public", "uploads", "proofs");
      await fs.mkdir(uploadDir, { recursive: true });

      const filename = `${order.shopifyOrderId}.jpg`;
      const filepath = path.join(uploadDir, filename);
      await fs.writeFile(filepath, buffer);

      const screenshotPath = `/uploads/proofs/${filename}`;

      // Update database status to PENDING_APPROVAL
      const updatedOrder = await db.instapayOrderQueue.update({
        where: { id: order.id },
        data: {
          status: "PENDING_APPROVAL",
          screenshotPath,
        },
      });

      console.log(`Saved screenshot for order ${order.orderNumber}. Queue status updated to PENDING_APPROVAL.`);

      return json({ success: true, order: updatedOrder }, { headers: corsHeaders });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ACTION: confirm (called by Spark dashboard to approve and mark as paid)
    // ─────────────────────────────────────────────────────────────────────────
    if (action === "confirm") {
      if (!shopifyOrderId) {
        return json({ error: "Missing shopifyOrderId" }, { status: 400, headers: corsHeaders });
      }

      // Find order in queue
      const order = await db.instapayOrderQueue.findUnique({
        where: { shopifyOrderId },
      });

      if (!order) {
        return json({ error: "Order not found in queue" }, { status: 404, headers: corsHeaders });
      }

      // Get Shopify session/shop
      const session = await db.session.findFirst();
      const shop = session?.shop ?? process.env.SHOPIFY_SHOP ?? "";

      if (!shop) {
        return json({ error: "Shopify shop credentials not found" }, { status: 500, headers: corsHeaders });
      }

      // Execute Shopify GraphQL mutation to mark order as paid
      const gqlQuery = `#graphql
        mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
          orderMarkAsPaid(input: $input) {
            order {
              id
              displayFinancialStatus
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const orderGid = shopifyOrderId.startsWith("gid://") ? shopifyOrderId : `gid://shopify/Order/${shopifyOrderId}`;
      const gqlVariables = {
        input: {
          id: orderGid,
        },
      };

      console.log(`Sending orderMarkAsPaid mutation to Shopify for order: ${orderGid}`);
      
      let resJson;
      if (session?.accessToken) {
        try {
          const { admin } = await shopify.unauthenticated.admin(shop);
          const response = await admin.graphql(gqlQuery, { variables: gqlVariables });
          resJson = await response.json();
        } catch (e: any) {
          console.warn(`Admin client authentication failed, falling back to manual fetch:`, e.message);
        }
      }

      if (!resJson) {
        // Fallback to manual fetch using env vars
        const accessToken = session?.accessToken ?? process.env.SHOPIFY_ACCESS_TOKEN ?? "";
        if (!accessToken) {
          return json({ error: "No Shopify access token found (session is empty and env var is missing)" }, { status: 500, headers: corsHeaders });
        }
        const shopifyEndpoint = `https://${shop}/admin/api/2025-01/graphql.json`;
        console.log(`Using fallback manual fetch for order confirmation at: ${shopifyEndpoint}`);
        const response = await fetch(shopifyEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({ query: gqlQuery, variables: gqlVariables }),
        });
        resJson = await response.json();
      }
      console.log("Shopify response for mark as paid:", JSON.stringify(resJson));

      if (resJson.errors && resJson.errors.length > 0) {
        return json({ error: "Shopify GraphQL error", details: resJson.errors }, { status: 400, headers: corsHeaders });
      }

      const mutationResult = resJson.data?.orderMarkAsPaid;
      if (mutationResult?.userErrors && mutationResult.userErrors.length > 0) {
        return json({ error: "Shopify user error", details: mutationResult.userErrors }, { status: 400, headers: corsHeaders });
      }

      // Update database status to CONFIRMED
      const updatedOrder = await db.instapayOrderQueue.update({
        where: { shopifyOrderId },
        data: { status: "CONFIRMED" },
      });

      // Notify WhatsApp bot to send success message
      const botUrl = process.env.WHATSAPP_BOT_URL || "http://localhost:3001";
      fetch(`${botUrl}/send-success`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: order.customerPhone,
          orderNumber: order.orderNumber,
        }),
      }).catch(err => {
        console.error("Failed to notify WhatsApp bot of confirmation:", err.message);
      });

      console.log(`Successfully confirmed payment for order: ${order.orderNumber}`);
      return json({ success: true, order: updatedOrder }, { headers: corsHeaders });
    }

    return json({ error: "Invalid action" }, { status: 400, headers: corsHeaders });
  } catch (error: any) {
    console.error("Error processing queue action:", error);
    return json({ error: error.message }, { status: 500, headers: corsHeaders });
  }
};
