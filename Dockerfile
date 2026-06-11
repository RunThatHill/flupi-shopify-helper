FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

# Copy package manifest
COPY package.json ./

# Install dependencies (no lockfile required)
RUN npm install --omit=dev && npm cache clean --force

# Remove CLI packages not needed in production
RUN npm remove @shopify/cli --ignore-scripts || true

# Copy the rest of the app
COPY . .

# Generate Prisma client & build Remix
RUN npm run build

CMD ["npm", "run", "docker-start"]
