import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import shopify from "../shopify.server";
import db from "../db.server";

// Helper for liquid app proxies to prevent Shopify layout wrapping
const jsonResponse = (data: any, status = 200) => {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
};

// Helper to query Shopify Admin GraphQL API using offline token
const executeShopifyGraphQL = async (shop: string, query: string, variables: any = {}) => {
  // Normalize shop to ensure it is always the .myshopify.com domain
  let resolvedShop = shop;
  if (!resolvedShop.endsWith(".myshopify.com")) {
    const session = await db.session.findFirst();
    resolvedShop = session?.shop || process.env.SHOPIFY_SHOP || "yf8qqz-at.myshopify.com";
  }

  // Find the offline session to get the token
  const offlineSession = await db.session.findFirst({
    where: { shop: resolvedShop },
  });
  const token = offlineSession?.accessToken || process.env.SHOPIFY_ACCESS_TOKEN || "";

  if (!token) {
    throw new Error(`No active access token found for shop: ${resolvedShop}`);
  }

  const endpoint = `https://${resolvedShop}/admin/api/2026-04/graphql.json`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await shopify.authenticate.public.appProxy(request);
    const url = new URL(request.url);
    
    const customerIdRaw = url.searchParams.get("logged_in_customer_id");
    const shop = url.searchParams.get("shop") || session?.shop || "";
    const fullDetails = url.searchParams.get("full") === "true";
    
    console.log(`[WISHLIST] Loader request for shop: ${shop}, customerIdRaw: ${customerIdRaw}, fullDetails: ${fullDetails}`);

    if (!customerIdRaw) {
      // Guest: return empty array, UI will read from localStorage
      return jsonResponse({ success: true, wishlist: [], isGuest: true });
    }

    const customerId = `gid://shopify/Customer/${customerIdRaw}`;

    // 2. Fetch the customer metafield value containing the product ID list
    const getMetafieldQuery = `
      query GetCustomerWishlist($id: ID!) {
        customer(id: $id) {
          metafield(namespace: "favo", key: "wishlist") {
            value
          }
        }
      }
    `;

    const metaResult = await executeShopifyGraphQL(shop, getMetafieldQuery, { id: customerId });
    
    if (metaResult.errors) {
      console.error("[WISHLIST] GraphQL metafield query errors:", JSON.stringify(metaResult.errors));
    }

    const metafieldValue = metaResult.data?.customer?.metafield?.value;
    console.log(`[WISHLIST] Metafield raw value retrieved: ${metafieldValue}`);
    
    let wishlistProductIds: string[] = [];
    if (metafieldValue) {
      try {
        wishlistProductIds = JSON.parse(metafieldValue);
      } catch (e) {
        console.error("[WISHLIST] Failed to parse wishlist metafield JSON:", e);
      }
    }

    // 3. If grid detail rendering is requested, fetch product details
    if (fullDetails && wishlistProductIds.length > 0) {
      const getProductsQuery = `
        query GetWishlistProducts($ids: [ID!]!) {
          shop {
            currencyCode
          }
          nodes(ids: $ids) {
            ... on Product {
              id
              title
              handle
              vendor
              availableForSale
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
                    compareAtPrice
                  }
                }
              }
            }
          }
        }
      `;

      try {
        const prodResult = await executeShopifyGraphQL(shop, getProductsQuery, { ids: wishlistProductIds });
        
        if (prodResult.errors) {
          console.error("[WISHLIST] GraphQL products query errors:", JSON.stringify(prodResult.errors));
        }

        const currencyCode = prodResult.data?.shop?.currencyCode || "EGP";
        const nodes = prodResult.data?.nodes || [];

        const productsMap = nodes
          .filter((node: any) => node !== null && node.id)
          .reduce((acc: any, node: any) => {
            const firstVariant = node.variants?.edges?.[0]?.node;
            acc[node.id] = {
              title: node.title,
              handle: node.handle,
              vendor: node.vendor || "",
              availableForSale: node.availableForSale,
              imageUrl: node.featuredImage?.url || "",
              imageAlt: node.featuredImage?.altText || node.title,
              price: firstVariant?.price || "0.00",
              compareAtPrice: firstVariant?.compareAtPrice || null,
              currencyCode: currencyCode,
              firstVariantId: firstVariant?.id || ""
            };
            return acc;
          }, {});

        // Build sorted wishlist array
        const enrichedWishlist = wishlistProductIds
          .map(id => {
            const details = productsMap[id];
            if (!details) return null;
            return {
              productId: id,
              variantId: details.firstVariantId,
              ...details
            };
          })
          .filter(item => item !== null);

        console.log(`[WISHLIST] Returning enriched wishlist size: ${enrichedWishlist.length}`);

        return jsonResponse({
          success: true,
          wishlist: enrichedWishlist,
          isGuest: false
        });
      } catch (err: any) {
        console.error("[WISHLIST] GraphQL details fetch failed:", err);
      }
    }

    // Default: return simple product IDs list
    return jsonResponse({
      success: true,
      wishlist: wishlistProductIds.map(id => ({ productId: id })),
      isGuest: false
    });

  } catch (error: any) {
    console.error("[WISHLIST ERROR] Loader proxy authentication failed:", error);
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
      return jsonResponse({ error: "Customer session not active" }, 400);
    }

    const customerId = `gid://shopify/Customer/${customerIdRaw}`;
    const body = await request.json().catch(() => ({}));
    const { action, productId, items } = body;

    console.log(`[WISHLIST] Action request: ${action}, productId: ${productId}, shop: ${shop}, customer: ${customerId}`);

    // 1. Fetch current wishlist metafield from Shopify
    const getMetafieldQuery = `
      query GetCustomerWishlist($id: ID!) {
        customer(id: $id) {
          metafield(namespace: "favo", key: "wishlist") {
            value
          }
        }
      }
    `;

    const metaResult = await executeShopifyGraphQL(shop, getMetafieldQuery, { id: customerId });
    
    if (metaResult.errors) {
      console.error("[WISHLIST] GraphQL action query errors:", JSON.stringify(metaResult.errors));
    }

    const metafieldValue = metaResult.data?.customer?.metafield?.value;
    
    let wishlistProductIds: string[] = [];
    if (metafieldValue) {
      try {
        wishlistProductIds = JSON.parse(metafieldValue);
      } catch (e) {
        wishlistProductIds = [];
      }
    }

    // 2. Perform requested operation on wishlist list
    let modified = false;

    if (action === "sync") {
      // Sync guest items array
      if (Array.isArray(items)) {
        const localIds = items.map((i: any) => i.productId).filter((id: any) => typeof id === "string" && id.startsWith("gid://"));
        const combined = [...wishlistProductIds, ...localIds];
        const uniqueIds = Array.from(new Set(combined));
        if (uniqueIds.length !== wishlistProductIds.length) {
          wishlistProductIds = uniqueIds;
          modified = true;
        }
      }
    } else if (request.method === "POST" && action !== "delete") {
      // Add product
      if (productId && !wishlistProductIds.includes(productId)) {
        wishlistProductIds.push(productId);
        modified = true;
      }
    } else if (request.method === "DELETE" || action === "delete") {
      // Remove product
      if (productId && wishlistProductIds.includes(productId)) {
        wishlistProductIds = wishlistProductIds.filter(id => id !== productId);
        modified = true;
      }
    }

    // 3. If changed, push update back to customer metafield on Shopify
    if (modified || action === "sync") {
      console.log(`[WISHLIST] Updating customer metafield with new values: ${JSON.stringify(wishlistProductIds)}`);
      
      const updateMetafieldMutation = `
        mutation customerUpdate($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const variables = {
        input: {
          id: customerId,
          metafields: [
            {
              namespace: "favo",
              key: "wishlist",
              value: JSON.stringify(wishlistProductIds),
              type: "json"
            }
          ]
        }
      };

      const mutationResult = await executeShopifyGraphQL(shop, updateMetafieldMutation, variables);
      
      if (mutationResult.errors) {
        console.error("[WISHLIST] GraphQL action mutation errors:", JSON.stringify(mutationResult.errors));
      }

      const errors = mutationResult.data?.customerUpdate?.userErrors;
      if (errors && errors.length > 0) {
        console.error("[WISHLIST] customerUpdate userErrors:", errors);
        return jsonResponse({ error: errors[0].message }, 500);
      }
    }

    return jsonResponse({
      success: true,
      wishlist: wishlistProductIds.map(id => ({ productId: id })),
      message: "Operation completed successfully"
    });

  } catch (error: any) {
    console.error("[WISHLIST ERROR] Action proxy authentication failed:", error);
    return jsonResponse({ error: "Unauthorized request signature" }, 401);
  }
};
