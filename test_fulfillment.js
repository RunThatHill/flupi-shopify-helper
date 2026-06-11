import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const shop = 'yf8qqz-at.myshopify.com';
  const session = await prisma.session.findFirst({
    where: { shop },
  });

  if (!session) {
    console.error(`Session for ${shop} not found.`);
    return;
  }

  // 1. Fetch first order ID
  const endpoint = `https://${shop}/admin/api/2026-04/graphql.json`;
  const ordersResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({
      query: `
        query {
          orders(first: 1) {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      `
    }),
  });

  const ordersJson = await ordersResponse.json();
  const firstOrder = ordersJson.data?.orders?.edges?.[0]?.node;

  if (!firstOrder) {
    console.log("No orders found in the store.");
    return;
  }

  console.log(`Found order: ${firstOrder.name} (${firstOrder.id})`);

  // 2. Fetch fulfillment orders for this order
  const fulfillmentOrdersResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({
      query: `
        query getFulfillmentOrders($orderId: ID!) {
          order(id: $orderId) {
            fulfillmentOrders(first: 10) {
              edges {
                node {
                  id
                  status
                  requestStatus
                  lineItems(first: 10) {
                    edges {
                      node {
                        id
                        totalQuantity
                        remainingQuantity
                        lineItem {
                          id
                          title
                          vendor
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      variables: {
        orderId: firstOrder.id
      }
    }),
  });

  const foJson = await fulfillmentOrdersResponse.json();
  console.log("Fulfillment Orders Response:", JSON.stringify(foJson, null, 2));
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
