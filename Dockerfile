FROM node:20-alpine
RUN apk add --no-cache openssl

WORKDIR /app

# Copy package manifest only first (better layer caching)
COPY package.json ./

# Install ALL deps (including dev) — needed for Remix build
RUN npm install --legacy-peer-deps

# Copy rest of source
COPY . .

# Build the Remix app
RUN npx prisma generate
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "run", "start"]
