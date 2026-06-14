---
title: Whatsapp Instapay Bot
emoji: 💬
colorFrom: purple
colorTo: indigo
sdk: docker
pinned: false
---

# Setup Instructions: Deploy WhatsApp Bot to Hugging Face Spaces & Keep it Awake

Follow these simple steps to deploy your bot for free and configure UptimeRobot to keep it running 24/7.

---

## Part 1: Deploy to Hugging Face Spaces

1. **Create Hugging Face Account**:
   - Go to [Hugging Face](https://huggingface.co/) and sign up for a free account.

2. **Create a New Space**:
   - Click your profile icon at the top right and select **New Space** (or go to `huggingface.co/new-space`).
   - Give it a name (e.g. `whatsapp-instapay-bot`).
   - Select **Docker** as the SDK.
   - Choose **Blank** (do not select a template).
   - Set Space Visibility to **Public** (required for the Shopify helper to make API calls to it).
   - Click **Create Space**.

3. **Upload the Bot Files**:
   - In your newly created Space, navigate to the **Files and versions** tab.
   - Click **Add file** -> **Upload files**.
   - Drag & drop all 3 files from this folder (`Dockerfile`, `package.json`, `whatsapp-bot.js`) into the upload zone.
   - Click **Commit changes to main** at the bottom.

4. **Verify Build**:
   - Navigate back to the **App** tab of your Space. Hugging Face will automatically start building the Docker image and deploy it.
   - Once the build succeeds, click **Container Logs** under the App menu.
   - You will see the **WhatsApp QR Code** printed in the console logs.
   - Open WhatsApp on your phone, go to **Linked Devices** -> **Link a Device**, and scan this QR code.
   - Once linked, the console logs will output: `[WA-Bot] Connection successfully opened!`.

---

## Part 2: Configure Environment Variables

1. In your Hugging Face Space, click on the **Settings** tab.
2. Under **Variables and secrets**, add the following Variable:
   - **Name**: `SHOPIFY_HELPER_URL`
   - **Value**: The public URL of your `flupi-shopify-helper` (e.g. `https://your-shopify-helper.onrender.com` or `https://your-tunnel.loca.lt`).
3. If you want to change the port or other details, you can add them here, but the default configuration is fully operational.
4. After adding variables, the container will rebuild and start running. (You won't need to scan the QR code again if your session files are kept, but if the container fully resets, you might have to scan the QR code once more).

---

## Part 3: Keep Space Awake 24/7 using UptimeRobot

Hugging Face Spaces automatically shut down (go to sleep) if they do not receive web traffic for 48 hours. We keep it active indefinitely by pinging the `/health` endpoint.

1. **Find your Space Direct URL**:
   - Your Space URL looks like: `https://huggingface.co/spaces/[username]/[space-name]`
   - Your **direct app URL** is: `https://[username]-[space-name].hf.space`
   - For example: if username is `RunThatHill` and Space name is `whatsapp-bot`, the direct URL is `https://runthathill-whatsapp-bot.hf.space`
   - Verify it works by opening `https://[username]-[space-name].hf.space/health` in your browser. You should see: `{"status":"ok","uptime":...}`.

2. **Register on UptimeRobot**:
   - Go to [UptimeRobot](https://uptimerobot.com/) and create a free account.

3. **Add a Monitor**:
   - Click **Add New Monitor**.
   - **Monitor Type**: Choose **HTTP(s)**.
   - **Friendly Name**: e.g., `WhatsApp Bot Health`.
   - **URL (or IP)**: Enter your direct health URL: `https://[username]-[space-name].hf.space/health`.
   - **Monitoring Interval**: Set it to every **15 minutes**.
   - Click **Create Monitor**.

UptimeRobot will now ping your bot every 15 minutes, preventing the Hugging Face container from ever sleeping.
