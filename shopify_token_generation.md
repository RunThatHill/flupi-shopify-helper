# Shopify Permanent Access Token Generation Guide

This guide documents the architecture and step-by-step process used to generate a permanent Shopify offline access token and configure it to persist on an ephemeral hosting environment like Railway.

---

## 📋 Context & Architecture

By default, the Shopify Remix template stores merchant session tokens in a local SQLite database (`dev.sqlite`). Because Railway runs on ephemeral containers, **re-deployments or server restarts completely wipe the SQLite database file**.

To prevent the app from losing its connection, we implemented a fallback architecture:
1. When the app receives a request, it checks the database session.
2. If the session is missing (due to a server reset), it falls back to the **`SHOPIFY_ACCESS_TOKEN`** environment variable configured on Railway.
3. To ensure this token never expires, we disabled Shopify's token rotation so it issues a permanent token.

---

## 🛠️ Step-by-Step Regeneration Procedure

If you ever change the app's scopes, credentials, or link it to a different store, follow these steps to generate and save a new permanent token:

### Step 1: Ensure Token Rotation is Disabled
Make sure `expiringOfflineAccessTokens` is set to `false` in `flupi-shopify-helper/app/shopify.server.ts`:
```typescript
const shopify = shopifyApp({
  // ...
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    expiringOfflineAccessTokens: false, // <-- Crucial: Must be false for permanent tokens
  },
});
```

### Step 2: Push App Configuration to Shopify
If you modified the App URL or Redirect URLs in `shopify.app.favo-sync.toml`, deploy the configuration to the Shopify Partner Portal by running this command on your local machine:
```bash
npx.cmd shopify app deploy --config favo-sync --no-build --allow-updates
```

### Step 3: Temporary Token Logging
To retrieve the token from the logs, temporarily add a logging statement in `flupi-shopify-helper/app/routes/api.shopify.ts` right after the session is loaded from the database:
```typescript
const session = await db.session.findFirst({
  where: { shop },
});

// Add this line temporarily:
if (session) {
  console.log(`[Shopify Session Info] Shop: ${resolvedShop}, Token: ${session.accessToken}`);
}
```
*Push this change to GitHub so it builds on Railway.*

### Step 4: Run the OAuth Flow
1. If the app is already installed, **uninstall it first** from your Shopify Admin dashboard (**Settings** -> **Apps and sales channels** -> **Uninstall**) to force a fresh token exchange.
2. In your browser tab, visit the direct authentication URL on Railway:
   `https://flupi-shopify-helper-production.up.railway.app/auth?shop=yf8qqz-at.myshopify.com`
3. Log in with your store credentials and click **Install / Approve**.

### Step 5: Copy the Token & Save to Railway
1. Open your **Railway Dashboard** -> go to the **Observability (Logs)** tab.
2. Locate the line:
   `[Shopify Session Info] Shop: yf8qqz-at.myshopify.com, Token: shpca_xxxxxxxxxxxxxxxxxxxxxxxx`
3. Copy the token (starts with `shpca_` or `shpat_`).
4. Go to the **Variables** tab in Railway and update the **`SHOPIFY_ACCESS_TOKEN`** environment variable with the new token.
5. Save the variable.

### Step 6: Clean Up Logging Code
Remove the `console.log` statement from `api.shopify.ts` and push to Git to keep your production logs secure.
