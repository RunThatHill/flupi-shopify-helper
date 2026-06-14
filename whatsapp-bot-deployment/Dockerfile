FROM node:20

# Install ffmpeg (useful for processing WhatsApp media)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .

# Hugging Face Spaces requires binding to port 7860
ENV WHATSAPP_BOT_PORT=7860
EXPOSE 7860

CMD ["node", "whatsapp-bot.js"]
