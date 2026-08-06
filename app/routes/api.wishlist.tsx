import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import shopify from "../shopify.server";
import { supabase } from "../supabase.server";

// Helper for liquid/liquid app proxies to prevent Shopify layout wrapping
const jsonResponse = (data: any, status = 200) => {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session, admin } = await shopify.authenticate.public.appProxy(request);
    const url = new URL(request.url);
    
    // Shopify automatically appends logged_in_customer_id parameter (numeric format)
    const customerIdRaw = url.searchParams.get("logged_in_customer_id");
    const shop = url.searchParams.get("shop") || session?.shop || "";
    const fullDetails = url.searchParams.get("full") === "true";
    
    if (!customerIdRaw) {
      // Guest: return empty array, UI will read from localStorage
      return jsonResponse({ success: true, wishlist: [], isGuest: true });
    }

    const customerId = `gid://shopify/Customer/${customerIdRaw}`;

    if (!supabase) {
      console.warn("[WISHLIST] Supabase client offline. Using mock database fallback.");
      return jsonResponse({ success: true, wishlist: [], isMock: true });
    }

    const { data: items, error } = await supabase
      .from("shopify_wishlist_items")
      .select("product_id, variant_id")
      .eq("customer_id", customerId)
      .eq("shop", shop);

    if (error) {
      console.error("[WISHLIST] Error fetching wishlist:", error);
      return jsonResponse({ error: error.message }, 500);
    }

    // If storefront requests full details (for Wishlist Page grid rendering)
    if (fullDetails && items.length > 0 && admin) {
      const productIds = items.map(item => item.product_id);
      
      try {
        // Query Shopify Admin GraphQL API for the product information in batch (compatible with all API versions)
        const response = await admin.graphql(
          `#graphql
          query GetWishlistProducts($ids: [ID!]!) {
            shop {
              currencyCode
            }
            nodes(ids: $ids) {
              ... on Product {
                id
                title
                handle
                featuredImage {
                  url
                  altText
                }
                variants(first: 1) {
                  edges {
                    node {
                      id
                      title
                      price
                    }
                  }
                }
              }
            }
          }`,
          {
            variables: {
              ids: productIds,
            },
          }
        );

        const resJson = await response.json();
        
        // Log query errors if any
        if (resJson.errors) {
          console.error("[WISHLIST] Shopify GraphQL errors:", resJson.errors);
        }

        const currencyCode = resJson.data?.shop?.currencyCode || "EGP";
        const nodes = resJson.data?.nodes || [];
        
        // Filter out null nodes (products deleted from Shopify)
        const productsMap = nodes
          .filter((node: any) => node !== null && node.id)
          .reduce((acc: any, node: any) => {
            const firstVariant = node.variants?.edges?.[0]?.node;
            acc[node.id] = {
              title: node.title,
              handle: node.handle,
              imageUrl: node.featuredImage?.url || "",
              imageAlt: node.featuredImage?.altText || node.title,
              price: firstVariant?.price || "0.00",
              currencyCode: currencyCode,
              firstVariantId: firstVariant?.id || ""
            };
            return acc;
          }, {});

        // Merge DB records with Shopify details
        const enrichedWishlist = items
          .map(item => {
            const shopifyDetails = productsMap[item.product_id];
            if (!shopifyDetails) return null; // Filter out products deleted in admin
            return {
              productId: item.product_id,
              variantId: item.variant_id || shopifyDetails.firstVariantId,
              ...shopifyDetails
            };
          })
          .filter(item => item !== null);

        return jsonResponse({
          success: true,
          wishlist: enrichedWishlist,
          isGuest: false
        });
      } catch (err: any) {
        console.error("[WISHLIST] Failed to fetch product details from Shopify GraphQL:", err);
      }
    }

    // Default: Return simple product IDs
    return jsonResponse({
      success: true,
      wishlist: items.map(item => ({
        productId: item.product_id,
        variantId: item.variant_id
      })),
      isGuest: false
    });

  } catch (error: any) {
    console.error("[WISHLIST ERROR] Loader authentication failed:", error);
    return jsonResponse({ error: "Unauthorized request signature" }, 401);
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await shopify.authenticate.public.appProxy(request);
    const url = new URL(request.url);
    const customerIdRaw = url.searchParams.get("logged_in_customer_id");
    const shop = url.searchParams.get("shop") || session?.shop || "";
    
    if (!customerIdRaw) {
      return jsonResponse({ error: "Customer must be logged in to sync wishlist with account" }, 400);
    }

    const customerId = `gid://shopify/Customer/${customerIdRaw}`;
    const body = await request.json().catch(() => ({}));
    const { action, productId, variantId, items } = body;

    if (!supabase) {
      return jsonResponse({ error: "Supabase client is offline" }, 503);
    }

    // --- CASE A: Sync items (from localStorage to Database on login) ---
    if (action === "sync") {
      if (!Array.isArray(items)) {
        return jsonResponse({ error: "Sync action expects an array of items" }, 400);
      }

      // Perform upsert for each item in local storage
      const upsertData = items.map((item: any) => ({
        customer_id: customerId,
        product_id: item.productId,
        variant_id: item.variantId || null,
        shop: shop
      }));

      if (upsertData.length === 0) {
        return jsonResponse({ success: true, message: "No items to sync" });
      }

      const { error } = await supabase
        .from("shopify_wishlist_items")
        .upsert(upsertData, { onConflict: "customer_id,product_id,variant_id" });

      if (error) {
        console.error("[WISHLIST] Sync failed:", error);
        return jsonResponse({ error: error.message }, 500);
      }

      return jsonResponse({ success: true, message: "Wishlist synced successfully" });
    }

    // --- CASE B: Add item ---
    if (request.method === "POST" && action !== "delete") {
      if (!productId) {
        return jsonResponse({ error: "Missing productId" }, 400);
      }

      const { error } = await supabase
        .from("shopify_wishlist_items")
        .upsert({
          customer_id: customerId,
          product_id: productId,
          variant_id: variantId || null,
          shop: shop
        }, { onConflict: "customer_id,product_id,variant_id" });

      if (error) {
        console.error("[WISHLIST] Add failed:", error);
        return jsonResponse({ error: error.message }, 500);
      }

      return jsonResponse({ success: true, message: "Item added to wishlist" });
    }

    // --- CASE C: Remove item ---
    if (request.method === "DELETE" || action === "delete") {
      if (!productId) {
        return jsonResponse({ error: "Missing productId" }, 400);
      }

      const query = supabase
        .from("shopify_wishlist_items")
        .delete()
        .eq("customer_id", customerId)
        .eq("product_id", productId)
        .eq("shop", shop);

      if (variantId) {
        query.eq("variant_id", variantId);
      }

      const { error } = await query;

      if (error) {
        console.error("[WISHLIST] Delete failed:", error);
        return jsonResponse({ error: error.message }, 500);
      }

      return jsonResponse({ success: true, message: "Item removed from wishlist" });
    }

    return jsonResponse({ error: "Method or action not supported" }, 400);

  } catch (error: any) {
    console.error("[WISHLIST ERROR] Action authentication failed:", error);
    return jsonResponse({ error: "Unauthorized request signature" }, 401);
  }
};
