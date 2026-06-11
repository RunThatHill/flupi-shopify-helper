import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import db from "../db.server";

// CORS Headers helper
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Handle OPTIONS preflight requests
export const loader = async ({ request }: LoaderFunctionArgs) => {
  return json({}, { headers: corsHeaders });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  // Handle preflight OPTIONS request if it hits the action route
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { query: gqlQuery, variables } = await request.json();

    // 1. Get the shop domain from the variables or context
    let shop = "yf8qqz-at.myshopify.com";
    if (variables?.shopDomain) {
      shop = variables.shopDomain;
    } else {
      // Find the live FLÙPI session in SQLite database as fallback, otherwise the first session
      const liveSession = await db.session.findFirst({
        where: { shop: "yf8qqz-at.myshopify.com" }
      });
      if (liveSession) {
        shop = liveSession.shop;
      } else {
        const firstSession = await db.session.findFirst();
        if (firstSession) {
          shop = firstSession.shop;
        }
      }
    }

    // 2. Load the session directly from Prisma SQLite database
    const session = await db.session.findFirst({
      where: { shop },
    });

    // Fallback: use env var access token if no DB session exists (Railway production)
    const accessToken = session?.accessToken ?? process.env.SHOPIFY_ACCESS_TOKEN ?? ""
    const resolvedShop = session?.shop ?? process.env.SHOPIFY_SHOP ?? shop

    if (!accessToken) {
      return json(
        { errors: [{ message: `No active Shopify session found for shop: ${shop}` }] },
        { status: 404, headers: corsHeaders }
      );
    }

    // 3. Helper to execute GraphQL queries directly via fetch using the stored access token
    const executeShopifyGraphQL = async (gqlQuery: string, gqlVariables: any = {}) => {
      const endpoint = `https://${resolvedShop}/admin/api/2026-04/graphql.json`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query: gqlQuery, variables: gqlVariables }),
      });
      return response;
    };

    // 4. Inspect the incoming GraphQL query and route it accordingly
    const queryStr = (gqlQuery || "").trim();

    // ── CASE A: Get Shopify Customers List ──
    if (queryStr.includes("GetShopifyCustomers") || queryStr.includes("shopifyCustomers")) {
      const response = await executeShopifyGraphQL(
        `#graphql
        query {
          customers(first: 50) {
            edges {
              node {
                id
                firstName
                lastName
                email
                phone
                note
                createdAt
                taxExempt
              }
            }
          }
        }`
      );
      const resJson = await response.json();
      if (resJson.errors && resJson.errors.length > 0) {
        console.error("Shopify GraphQL Errors (GetShopifyCustomers):", resJson.errors);
        return json(
          { errors: resJson.errors },
          { status: 400, headers: corsHeaders }
        );
      }
      const shopifyCustomers = resJson.data?.customers?.edges || [];

      // Fetch all customer notes from our SQLite database via Prisma
      const localNotes = await db.customerNote.findMany({
        orderBy: { createdAt: "desc" },
      });

      // Map native Shopify customer fields to match Gadget's JSON schema expected by the frontend
      const mappedEdges = shopifyCustomers.map((edge: any) => {
        const node = edge.node;
        const customerNotes = localNotes
          .filter((n) => n.customerId === node.id)
          .map((n) => ({
            node: {
              id: n.id,
              note: { markdown: n.note },
              authorFirstName: n.authorFirstName,
              authorLastName: n.authorLastName,
              type: n.type,
              visibility: n.visibility,
              createdAt: n.createdAt.toISOString(),
            },
          }));

        return {
          node: {
            id: node.id,
            firstName: node.firstName || "",
            lastName: node.lastName || "",
            email: node.email || "",
            phone: node.phone || "",
            shopifyState: "enabled", // Mocked to match schema
            note: node.note || "",
            shopifyCreatedAt: node.createdAt,
            taxExempt: node.taxExempt || false,
            shop: {
              id: "shopify-shop-favo-ops",
              domain: shop,
            },
            customerNotes: {
              edges: customerNotes,
            },
          },
        };
      });

      return json(
        {
          data: {
            shopifyCustomers: {
              edges: mappedEdges,
            },
          },
        },
        { headers: corsHeaders }
      );
    }

    // ── CASE B: Get Shopify Orders List ──
    if (queryStr.includes("GetShopifyOrders") || queryStr.includes("shopifyOrders")) {
      const response = await executeShopifyGraphQL(
        `#graphql
        query {
          orders(first: 50) {
            edges {
              node {
                id
                name
                email
                phone
                displayFinancialStatus
                displayFulfillmentStatus
                totalPriceSet {
                  presentmentMoney {
                    amount
                    currencyCode
                  }
                }
                note
                tags
                createdAt
                lineItems(first: 50) {
                  edges {
                    node {
                      id
                      title
                      quantity
                      unfulfilledQuantity
                      vendor
                      sku
                      image {
                        url
                      }
                      variant {
                        id
                        title
                        price
                        sku
                        inventoryItem {
                          unitCost {
                            amount
                            currencyCode
                          }
                        }
                      }
                    }
                  }
                }
                fulfillments(first: 10) {
                  id
                  status
                  trackingInfo {
                    company
                    number
                    url
                  }
                }
              }
            }
          }
        }`
      );
      const resJson = await response.json();
      if (resJson.errors && resJson.errors.length > 0) {
        console.error("Shopify GraphQL Errors (GetShopifyOrders):", resJson.errors);
        return json(
          { errors: resJson.errors },
          { status: 400, headers: corsHeaders }
        );
      }
      const shopifyOrders = resJson.data?.orders?.edges || [];

      // Fetch all order notes from SQLite database via Prisma
      const localNotes = await db.orderNote.findMany({
        orderBy: { createdAt: "desc" },
      });

      // Map native Shopify order fields to match Gadget's JSON schema expected by the frontend
      const mappedEdges = shopifyOrders.map((edge: any) => {
        const node = edge.node;
        const orderNotes = localNotes
          .filter((n) => n.orderId === node.id)
          .map((n) => ({
            node: {
              id: n.id,
              note: { markdown: n.note },
              authorFirstName: n.authorFirstName,
              authorLastName: n.authorLastName,
              type: n.type,
              visibility: n.visibility,
              createdAt: n.createdAt.toISOString(),
            },
          }));

        // Flatten fulfillments structure to match Gadget's schema
        const fulfillmentsEdges = (node.fulfillments || []).map((f: any) => {
          const tInfo = f.trackingInfo?.[0] || {};
          return {
            node: {
              id: f.id,
              status: f.status || "success",
              shipmentStatus: "in_transit",
              trackingCompany: tInfo.company || "Standard Logistics",
              trackingNumber: tInfo.number || "",
              trackingUrl: tInfo.url || "",
            },
          };
        });

        const lineItemsEdges = (node.lineItems?.edges || []).map((le: any) => {
          const leNode = le.node;
          return {
            node: {
              id: leNode.id,
              title: leNode.title,
              quantity: leNode.quantity,
              unfulfilledQuantity: leNode.unfulfilledQuantity,
              vendor: leNode.vendor,
              sku: leNode.sku || (leNode.variant ? leNode.variant.sku : ""),
              image: leNode.image ? { url: leNode.image.url } : null,
              variant: leNode.variant ? {
                id: leNode.variant.id,
                title: leNode.variant.title,
                price: leNode.variant.price,
                sku: leNode.variant.sku,
                cost: leNode.variant.inventoryItem?.unitCost ? {
                  amount: leNode.variant.inventoryItem.unitCost.amount,
                  currency: leNode.variant.inventoryItem.unitCost.currencyCode
                } : null
              } : null,
            },
          };
        });

        return {
          node: {
            id: node.id,
            name: node.name,
            email: node.email || "",
            phone: node.phone || "",
            financialStatus: (node.displayFinancialStatus || "").toLowerCase(),
            fulfillmentStatus: (node.displayFulfillmentStatus || "").toLowerCase(),
            totalPrice: node.totalPriceSet?.presentmentMoney?.amount || "0.00",
            currency: node.totalPriceSet?.presentmentMoney?.currencyCode || "AED",
            note: node.note || "",
            tags: node.tags || [],
            shopifyCreatedAt: node.createdAt,
            shop: {
              id: "shopify-shop-favo-ops",
              domain: shop,
            },
            fulfillments: {
              edges: fulfillmentsEdges,
            },
            orderNotes: {
              edges: orderNotes,
            },
            lineItems: {
              edges: lineItemsEdges,
            },
          },
        };
      });

      return json(
        {
          data: {
            shopifyOrders: {
              edges: mappedEdges,
            },
          },
        },
        { headers: corsHeaders }
      );
    }

    // ── CASE C: Create Customer Note ──
    if (queryStr.includes("CreateCustomerNote") || queryStr.includes("createCustomerNote")) {
      const { note, authorFirstName, authorLastName, type, visibility, customer } = variables.customerNote;
      const customerId = customer._link;

      const newNote = await db.customerNote.create({
        data: {
          customerId,
          note: note.markdown,
          authorFirstName: authorFirstName || "System",
          authorLastName: authorLastName || "Agent",
          type: type || "Other",
          visibility: visibility || "Staff Only",
        },
      });

      return json(
        {
          data: {
            createCustomerNote: {
              success: true,
              customerNote: {
                id: newNote.id,
                note: { markdown: newNote.note },
                authorFirstName: newNote.authorFirstName,
                authorLastName: newNote.authorLastName,
                type: newNote.type,
                visibility: newNote.visibility,
                createdAt: newNote.createdAt.toISOString(),
              },
              errors: [],
            },
          },
        },
        { headers: corsHeaders }
      );
    }

    // ── CASE D: Delete Customer Note ──
    if (queryStr.includes("DeleteCustomerNote") || queryStr.includes("deleteCustomerNote")) {
      const { id } = variables;

      await db.customerNote.delete({
        where: { id },
      });

      return json(
        {
          data: {
            deleteCustomerNote: {
              success: true,
              errors: [],
            },
          },
        },
        { headers: corsHeaders }
      );
    }

    // ── CASE E: Create Order Note ──
    if (queryStr.includes("CreateOrderNote") || queryStr.includes("createOrderNote")) {
      const { note, authorFirstName, authorLastName, type, visibility, order } = variables.orderNote;
      const orderId = order._link;

      const newNote = await db.orderNote.create({
        data: {
          orderId,
          note: note.markdown,
          authorFirstName: authorFirstName || "System",
          authorLastName: authorLastName || "Agent",
          type: type || "Other",
          visibility: visibility || "Staff Only",
        },
      });

      return json(
        {
          data: {
            createOrderNote: {
              success: true,
              orderNote: {
                id: newNote.id,
                note: { markdown: newNote.note },
                authorFirstName: newNote.authorFirstName,
                authorLastName: newNote.authorLastName,
                type: newNote.type,
                visibility: newNote.visibility,
                createdAt: newNote.createdAt.toISOString(),
              },
              errors: [],
            },
          },
        },
        { headers: corsHeaders }
      );
    }

    // ── CASE F: Delete Order Note ──
    if (queryStr.includes("DeleteOrderNote") || queryStr.includes("deleteOrderNote")) {
      const { id } = variables;

      await db.orderNote.delete({
        where: { id },
      });

      return json(
        {
          data: {
            deleteOrderNote: {
              success: true,
              errors: [],
            },
          },
        },
        { headers: corsHeaders }
      );
    }

    // ── CASE G: Create Shopify Fulfillment ──
    if (queryStr.includes("CreateShopifyFulfillment") || queryStr.includes("createShopifyFulfillment")) {
      const { orderId, lineItems: requestedItems, trackingCompany, trackingNumber } = variables;

      const foResponse = await executeShopifyGraphQL(
        `#graphql
        query getFulfillmentOrders($orderId: ID!) {
          order(id: $orderId) {
            fulfillmentOrders(first: 10) {
              edges {
                node {
                  id
                  status
                  requestStatus
                  lineItems(first: 50) {
                    edges {
                      node {
                        id
                        totalQuantity
                        remainingQuantity
                        lineItem {
                          id
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }`,
        { orderId }
      );

      const foJson = await foResponse.json();
      if (foJson.errors && foJson.errors.length > 0) {
        return json(
          { errors: foJson.errors },
          { status: 400, headers: corsHeaders }
        );
      }

      const fulfillmentOrders = foJson.data?.order?.fulfillmentOrders?.edges || [];
      const lineItemsByFulfillmentOrder: any[] = [];

      for (const item of requestedItems) {
        let matched = false;

        for (const foEdge of fulfillmentOrders) {
          const foNode = foEdge.node;
          if (foNode.status === "CLOSED" || foNode.status === "COMPLETED") continue;

          const foLineItems = foNode.lineItems?.edges || [];
          for (const foLineEdge of foLineItems) {
            const foLineNode = foLineEdge.node;
            if (foLineNode.lineItem?.id === item.id) {
              let qtyToFulfill = Math.min(item.quantity, foLineNode.remainingQuantity);
              if (qtyToFulfill > 0) {
                let existingFoEntry = lineItemsByFulfillmentOrder.find(
                  (entry) => entry.fulfillmentOrderId === foNode.id
                );
                if (!existingFoEntry) {
                  existingFoEntry = {
                    fulfillmentOrderId: foNode.id,
                    fulfillmentOrderLineItems: [],
                  };
                  lineItemsByFulfillmentOrder.push(existingFoEntry);
                }

                existingFoEntry.fulfillmentOrderLineItems.push({
                  id: foLineNode.id,
                  quantity: qtyToFulfill,
                });
                matched = true;
                break;
              }
            }
          }
          if (matched) break;
        }
      }

      if (lineItemsByFulfillmentOrder.length === 0) {
        return json(
          {
            errors: [
              {
                message: "No matching unfulfilled items found in the order's fulfillment orders.",
              },
            ],
          },
          { status: 400, headers: corsHeaders }
        );
      }

      const fulfillmentInput: any = {
        lineItemsByFulfillmentOrder,
      };

      if (trackingCompany && trackingNumber) {
        fulfillmentInput.trackingInfo = {
          company: trackingCompany,
          number: trackingNumber,
        };
      }

      const fulfillResponse = await executeShopifyGraphQL(
        `#graphql
        mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
          fulfillmentCreateV2(fulfillment: $fulfillment) {
            fulfillment {
              id
              status
            }
            userErrors {
              field
              message
            }
          }
        }`,
        { fulfillment: fulfillmentInput }
      );

      const fulfillJson = await fulfillResponse.json();
      if (fulfillJson.errors && fulfillJson.errors.length > 0) {
        return json(
          { errors: fulfillJson.errors },
          { status: 400, headers: corsHeaders }
        );
      }

      const result = fulfillJson.data?.fulfillmentCreateV2;
      if (result?.userErrors && result.userErrors.length > 0) {
        return json(
          { errors: result.userErrors.map((ue: any) => ({ message: ue.message })) },
          { status: 400, headers: corsHeaders }
        );
      }

      return json(
        {
          data: {
            createShopifyFulfillment: {
              success: true,
              fulfillment: result.fulfillment,
              errors: [],
            },
          },
        },
        { headers: corsHeaders }
      );
    }

    // ── CASE H: Update Shopify Order Note And Tags ──
    if (queryStr.includes("UpdateShopifyOrderNoteAndTags") || queryStr.includes("updateShopifyOrderNoteAndTags")) {
      const { orderId, note, tags } = variables;

      const updateResponse = await executeShopifyGraphQL(
        `#graphql
        mutation orderUpdate($input: OrderInput!) {
          orderUpdate(input: $input) {
            order {
              id
              note
              tags
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          input: {
            id: orderId,
            note: note,
            tags: tags
          }
        }
      );

      const updateJson = await updateResponse.json();
      if (updateJson.errors && updateJson.errors.length > 0) {
        return json(
          { errors: updateJson.errors },
          { status: 400, headers: corsHeaders }
        );
      }

      const result = updateJson.data?.orderUpdate;
      if (result?.userErrors && result.userErrors.length > 0) {
        return json(
          { errors: result.userErrors.map((ue: any) => ({ message: ue.message })) },
          { status: 400, headers: corsHeaders }
        );
      }

      return json(
        {
          data: {
            updateShopifyOrderNoteAndTags: {
              success: true,
              order: result.order,
              errors: []
            }
          }
        },
        { headers: corsHeaders }
      );
    }

    // Fallback: If not handled, return unhandled operation error
    return json(
      { errors: [{ message: "Unhandled custom sync API operation." }] },
      { status: 400, headers: corsHeaders }
    );
  } catch (err) {
    if (err instanceof Response) {
      try {
        const text = await err.text();
        console.error("Error executing API Shopify proxy request (Response):", err.status, err.statusText, text);
      } catch (e) {
        console.error("Error executing API Shopify proxy request (Response no body):", err.status, err.statusText);
      }
    } else {
      console.error("Error executing API Shopify proxy request:", err);
    }
    return json(
      { errors: [{ message: err instanceof Error ? err.message : "GraphQL API Proxy Error" }] },
      { status: 500, headers: corsHeaders }
    );
  }
};
