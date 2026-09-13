import { PrismaClient } from "@prisma/client";

declare global {
  var prismaGlobal: PrismaClient;
}

function createPrismaClient() {
  try {
    return new PrismaClient();
  } catch (e: any) {
    console.error("[CRITICAL] PrismaClient failed to instantiate:", e.message);
    return new PrismaClient();
  }
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = createPrismaClient();
  }
}

const prisma = global.prismaGlobal ?? createPrismaClient();

export default prisma;
