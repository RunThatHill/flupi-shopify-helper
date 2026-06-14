import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, Form } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  Box,
  TextField,
  FormLayout,
  Banner,
  InlineStack,
  Badge,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate, registerWebhooks } from "../shopify.server";

// ─────────────────────────────────────────────────────────────────────────────
// LOADER: Queries customer by email or order by number
// ─────────────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // Programmatically register webhooks for this store session
  try {
    const regResult = await registerWebhooks({ session });
    console.log("[DEBUG] Webhook registration result:", JSON.stringify(regResult));
  } catch (err: any) {
    console.error("[DEBUG] Webhook registration error in loader:", err.message);
  }

  const url = new URL(request.url);
  
  const emailQuery = url.searchParams.get("email")?.trim();
  const orderQuery = url.searchParams.get("order")?.trim();

  let customerResult = null;
  let orderResult = null;
  let searchTriggered = false;

  if (emailQuery) {
    searchTriggered = true;
    try {
      const response = await admin.graphql(
        `#graphql
        query FindCustomer($query: String!) {
          customers(first: 1, query: $query) {
            edges {
              node {
                id
                firstName
                lastName
                email
                phone
                tags
                note
              }
            }
          }
        }`,
        { variables: { query: `email:${emailQuery}` } }
      );
      const resJson = await response.json();
      const node = resJson.data?.customers?.edges?.[0]?.node;
      if (node) {
        customerResult = {
          id: node.id,
          firstName: node.firstName || "",
          lastName: node.lastName || "",
          email: node.email || "",
          phone: node.phone || "",
          tags: node.tags || [],
          note: node.note || "",
        };
      }
    } catch (err) {
      console.error("Error searching customer:", err);
    }
  }

  if (orderQuery) {
    searchTriggered = true;
    try {
      // Search orders by name (number) e.g. "#1001" or "1001"
      const cleanOrderQuery = orderQuery.startsWith("#") ? orderQuery : `#${orderQuery}`;
      const response = await admin.graphql(
        `#graphql
        query FindOrder($query: String!) {
          orders(first: 1, query: $query) {
            edges {
              node {
                id
                name
                note
                customer {
                  email
                }
              }
            }
          }
        }`,
        { variables: { query: `name:${cleanOrderQuery}` } }
      );
      const resJson = await response.json();
      const node = resJson.data?.orders?.edges?.[0]?.node;
      if (node) {
        orderResult = {
          id: node.id,
          name: node.name,
          note: node.note || "",
          customerEmail: node.customer?.email || "No email",
        };
      }
    } catch (err) {
      console.error("Error searching order:", err);
    }
  }

  return json({
    customerResult,
    orderResult,
    emailQuery: emailQuery || "",
    orderQuery: orderQuery || "",
    searchTriggered,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: Performs customerUpdate or orderUpdate mutations
// ─────────────────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "updateCustomer") {
    const id = formData.get("id") as string;
    const note = formData.get("note") as string;
    const tagsString = formData.get("tags") as string;
    const tags = tagsString
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    try {
      const response = await admin.graphql(
        `#graphql
        mutation UpdateCustomer($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer {
              id
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            input: {
              id,
              note,
              tags,
            },
          },
        }
      );
      const resJson = await response.json();
      const errors = resJson.data?.customerUpdate?.userErrors || [];
      if (errors.length > 0) {
        return json({ success: false, error: errors[0].message });
      }
      return json({ success: true, type: "customer" });
    } catch (err) {
      return json({ success: false, error: "Mutation failed" });
    }
  }

  if (intent === "updateOrder") {
    const id = formData.get("id") as string;
    const note = formData.get("note") as string;

    try {
      const response = await admin.graphql(
        `#graphql
        mutation UpdateOrder($input: OrderInput!) {
          orderUpdate(input: $input) {
            order {
              id
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            input: {
              id,
              note,
            },
          },
        }
      );
      const resJson = await response.json();
      const errors = resJson.data?.orderUpdate?.userErrors || [];
      if (errors.length > 0) {
        return json({ success: false, error: errors[0].message });
      }
      return json({ success: true, type: "order" });
    } catch (err) {
      return json({ success: false, error: "Mutation failed" });
    }
  }

  return json({ success: false, error: "Invalid intent" });
};

// ─────────────────────────────────────────────────────────────────────────────
// VIEW COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function Index() {
  const { customerResult, orderResult, emailQuery, orderQuery, searchTriggered } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  // Local Form state overrides
  const [custEmailInput, setCustEmailInput] = useState(emailQuery);
  const [ordNameInput, setOrdNameInput] = useState(orderQuery);

  const [customerNote, setCustomerNote] = useState("");
  const [customerTags, setCustomerTags] = useState("");
  const [orderNote, setOrderNote] = useState("");

  // Sync state variables with newly loaded/searched objects
  useEffect(() => {
    if (customerResult) {
      setCustomerNote(customerResult.note);
      setCustomerTags(customerResult.tags.join(", "));
    }
  }, [customerResult]);

  useEffect(() => {
    if (orderResult) {
      setOrderNote(orderResult.note);
    }
  }, [orderResult]);

  // Handle operation success toasts
  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show(
        fetcher.data.type === "customer"
          ? "Customer notes and tags updated successfully"
          : "Order notes updated successfully"
      );
    } else if (fetcher.data?.success === false) {
      shopify.toast.show(`Error: ${fetcher.data.error || "Operation failed"}`);
    }
  }, [fetcher.data, shopify]);

  const customerSubmitting = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "updateCustomer";
  const orderSubmitting = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "updateOrder";

  return (
    <Page>
      <TitleBar title="Flùpi CRM Notes Override" />
      <BlockStack gap="600">
        <Layout>
          {/* COLUMN 1: Customer Profile Search & Edit */}
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  👤 Customer Notes & Tags Editor
                </Text>
                
                {/* Search Form */}
                <Form method="get">
                  <FormLayout>
                    <InlineStack gap="300" align="space-between">
                      <div style={{ flex: 1 }}>
                        <TextField
                          label="Customer Email"
                          labelHidden
                          type="email"
                          placeholder="Search customer email..."
                          autoComplete="email"
                          value={custEmailInput}
                          onChange={setCustEmailInput}
                          name="email"
                        />
                      </div>
                      <Button submit variant="primary">Search</Button>
                    </InlineStack>
                  </FormLayout>
                </Form>

                {searchTriggered && emailQuery && !customerResult && (
                  <Banner tone="warning">
                    <p>No customer found matching email: <strong>{emailQuery}</strong></p>
                  </Banner>
                )}

                {/* Edit Form */}
                {customerResult && (
                  <Box paddingBlockStart="300">
                    <BlockStack gap="400">
                      <Banner tone="info" hideDismissButton>
                        <Text as="p" variant="bodyMd">
                          Found: <strong>{customerResult.firstName} {customerResult.lastName}</strong> ({customerResult.phone || "No phone"})
                        </Text>
                      </Banner>
                      
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="updateCustomer" />
                        <input type="hidden" name="id" value={customerResult.id} />
                        
                        <FormLayout>
                          <TextField
                            label="Customer Tags (comma-separated)"
                            value={customerTags}
                            onChange={setCustomerTags}
                            name="tags"
                            autoComplete="off"
                            helpText="E.g., VIP, Returning, Loyal, CustomStyle"
                          />
                          
                          <TextField
                            label="Customer Note"
                            value={customerNote}
                            onChange={setCustomerNote}
                            name="note"
                            multiline={4}
                            autoComplete="off"
                            helpText="Note fields are matched directly to local CRM database"
                          />
                          
                          <Button loading={customerSubmitting} submit variant="primary">
                            Save Customer Details
                          </Button>
                        </FormLayout>
                      </fetcher.Form>
                    </BlockStack>
                  </Box>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* COLUMN 2: Order Notes Edit */}
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  📦 Order Notes Editor (Override Only)
                </Text>
                
                {/* Search Form */}
                <Form method="get">
                  <FormLayout>
                    <InlineStack gap="300" align="space-between">
                      <div style={{ flex: 1 }}>
                        <TextField
                          label="Order Number"
                          labelHidden
                          type="text"
                          placeholder="E.g. 1001 or #1001"
                          autoComplete="off"
                          value={ordNameInput}
                          onChange={setOrdNameInput}
                          name="order"
                        />
                      </div>
                      <Button submit variant="primary">Search</Button>
                    </InlineStack>
                  </FormLayout>
                </Form>

                {searchTriggered && orderQuery && !orderResult && (
                  <Banner tone="warning">
                    <p>No order found matching: <strong>{orderQuery}</strong></p>
                  </Banner>
                )}

                {/* Edit Form */}
                {orderResult && (
                  <Box paddingBlockStart="300">
                    <BlockStack gap="400">
                      <Banner tone="info" hideDismissButton>
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd">
                            Order: <Badge>{orderResult.name}</Badge>
                          </Text>
                          <Text as="p" variant="bodyMd">
                            Customer: <strong>{orderResult.customerEmail}</strong>
                          </Text>
                        </BlockStack>
                      </Banner>
                      
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="updateOrder" />
                        <input type="hidden" name="id" value={orderResult.id} />
                        
                        <FormLayout>
                          <TextField
                            label="Order Note"
                            value={orderNote}
                            onChange={setOrderNote}
                            name="note"
                            multiline={4}
                            autoComplete="off"
                            helpText="Updates the Shopify native note field on this order"
                          />
                          
                          <Button loading={orderSubmitting} submit variant="primary">
                            Save Order Note
                          </Button>
                        </FormLayout>
                      </fetcher.Form>
                    </BlockStack>
                  </Box>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
