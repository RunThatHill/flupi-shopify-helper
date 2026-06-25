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
  const diagnostics = url.searchParams.get("diagnostics") === "true";

  console.log(`[DEBUG] Syncing orders for shop: ${shopDomain}, limit: ${limit}, diagnostics: ${diagnostics}`);

  try {
    if (!supabase) {
      return json({ error: "Supabase client is not initialized" }, { status: 500, headers: corsHeaders });
    }

    // ─── ADDED: Register Role Endpoint ───
    const registerRole = url.searchParams.get("register_role") === "true";
    if (registerRole) {
      const userId = url.searchParams.get("userId");
      const email = url.searchParams.get("email");
      const role = url.searchParams.get("role") || "customer_care";
      const fullName = url.searchParams.get("fullName");

      if (!userId || !email) {
        return json({ error: "Missing userId or email" }, { status: 400, headers: corsHeaders });
      }

      console.log(`[DEBUG] Registering/upserting role for user ${email} (${userId}) to role: ${role}`);

      const defaultPermissionsMapping: Record<string, any> = {
        "system_admin": { access_dashboard: true, access_tickets: true, access_products: true, access_vendors: true, access_orgchart: true, access_queues: true },
        "customer_care": { access_dashboard: true, access_tickets: true, access_products: true, access_vendors: false, access_orgchart: true, access_queues: false },
        "vendor_user": { access_dashboard: true, access_tickets: false, access_products: true, access_vendors: false, access_orgchart: false, access_queues: false }
      };

      const { data, error } = await supabase
        .from("user_roles")
        .upsert({
          user_id: userId,
          role: role,
          email: email,
          full_name: fullName || email.split("@")[0].split(/[._-]/).map((p: string) => p.charAt(0).toUpperCase() + p.slice(1)).join(" "),
          username: email.split("@")[0],
          permissions: defaultPermissionsMapping[role] || defaultPermissionsMapping["customer_care"]
        })
        .select();

      if (error) {
        console.error(`[ERROR] Failed to upsert user_role for ${email}:`, error.message);
        return json({ success: false, error: error.message }, { status: 500, headers: corsHeaders });
      }

      return json({ success: true, data }, { headers: corsHeaders });
    }

    if (diagnostics) {
      // 1. Fetch total orders count
      const { count: ordersCount, error: ordersCountError } = await supabase
        .from("orders")
        .select("*", { count: "exact", head: true });

      // 2. Fetch all user roles from public.user_roles
      const { data: userRoles, error: rolesError } = await supabase
        .from("user_roles")
        .select("*");

      // 3. Try to create the demo users in Supabase Auth if they don't exist
      const demoUsersToCreate = [
        { email: "admin@favogroup.com", role: "system_admin", name: "System Admin" },
        { email: "care@favogroup.com", role: "customer_care", name: "Customer Care Agent" },
        { email: "vendor@favogroup.com", role: "vendor_user", name: "Zara Vendor" }
      ];

      const demoResults = [];
      for (const demo of demoUsersToCreate) {
        let userId = null;
        let authResult = "Skipped/Exists";
        try {
          const { data: userData, error: createError } = await supabase.auth.admin.createUser({
            email: demo.email,
            password: "Password123!",
            email_confirm: true
          });
          if (createError) {
            authResult = `Exists/Error: ${createError.message}`;
          } else if (userData?.user) {
            userId = userData.user.id;
            authResult = "Created";
          }
        } catch (err: any) {
          authResult = `Exception: ${err.message || err}`;
        }

        // Check if there is an existing role for this email in user_roles
        const { data: existingRole } = await supabase
          .from("user_roles")
          .select("user_id")
          .eq("email", demo.email)
          .maybeSingle();
        
        const resolvedUserId = userId || existingRole?.user_id;

        if (resolvedUserId) {
          const defaultPermissionsMapping: Record<string, any> = {
            "system_admin": { access_dashboard: true, access_tickets: true, access_products: true, access_vendors: true, access_orgchart: true, access_queues: true },
            "customer_care": { access_dashboard: true, access_tickets: true, access_products: true, access_vendors: false, access_orgchart: true, access_queues: false },
            "vendor_user": { access_dashboard: true, access_tickets: false, access_products: true, access_vendors: false, access_orgchart: false, access_queues: false }
          };

          const { error: roleError } = await supabase
            .from("user_roles")
            .upsert({
              user_id: resolvedUserId,
              role: demo.role,
              email: demo.email,
              full_name: demo.name,
              username: demo.email.split("@")[0],
              permissions: defaultPermissionsMapping[demo.role]
            });
          
          demoResults.push({
            email: demo.email,
            authResult,
            roleResult: roleError ? `Error: ${roleError.message}` : "Upserted",
            userId: resolvedUserId
          });
        } else {
          demoResults.push({
            email: demo.email,
            authResult,
            roleResult: "Skipped (No User ID resolved)"
          });
        }
      }

      // 4. Fetch all auth users using the service role client
      let authUsers: any[] = [];
      let authError: any = null;
      try {
        const { data, error } = await supabase.auth.admin.listUsers();
        authUsers = data?.users || [];
        authError = error?.message || null;
      } catch (err: any) {
        authError = err.stack || err.message || String(err);
      }

      // 5. Auto-repair / seed: If there are users in Auth but not in user_roles, create roles for them
      const repairedUsers = [];
      for (const u of authUsers) {
        const hasRole = userRoles?.some(r => r.user_id === u.id);
        if (!hasRole) {
          const email = u.email || "";
          let role = "customer_care";
          if (email === "admin@favogroup.com" || email.toLowerCase() === "abdelmassehmourad@gmail.com") {
            role = "system_admin";
          } else if (email === "vendor@favogroup.com") {
            role = "vendor_user";
          }
          
          const defaultPermissionsMapping: Record<string, any> = {
            "system_admin": { access_dashboard: true, access_tickets: true, access_products: true, access_vendors: true, access_orgchart: true, access_queues: true },
            "customer_care": { access_dashboard: true, access_tickets: true, access_products: true, access_vendors: false, access_orgchart: true, access_queues: false },
            "vendor_user": { access_dashboard: true, access_tickets: false, access_products: true, access_vendors: false, access_orgchart: false, access_queues: false }
          };

          const { error: insertError } = await supabase
            .from("user_roles")
            .insert({
              user_id: u.id,
              role: role,
              email: email,
              full_name: email.split("@")[0].split(/[._-]/).map((p: string) => p.charAt(0).toUpperCase() + p.slice(1)).join(" "),
              username: email.split("@")[0],
              permissions: defaultPermissionsMapping[role]
            });
          
          if (!insertError) {
            repairedUsers.push({ id: u.id, email, role });
          } else {
            console.error(`[ERROR] Failed to repair user role for ${email}:`, insertError.message);
          }
        }
      }

      // Re-fetch user roles
      const { data: finalUserRoles } = await supabase.from("user_roles").select("*");

      return json({
        success: true,
        ordersCount: ordersCount ?? 0,
        ordersCountError: ordersCountError?.message || null,
        userRoles: finalUserRoles || [],
        rolesError: rolesError?.message || null,
        authUsersCount: authUsers.length,
        authError,
        demoResults,
        repairedUsers
      }, { headers: corsHeaders });
    }

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
