import { json } from "@remix-run/node";
import db from "../db.server";

export const loader = async () => {
  let dbStatus = "DISCONNECTED";
  let dbError = null;
  try {
    // Check SQLite database connectivity
    await db.$queryRaw`SELECT 1`;
    dbStatus = "CONNECTED";
  } catch (e: any) {
    dbError = e.message;
  }

  return json(
    {
      status: "ok",
      environment: process.env.NODE_ENV || "production",
      database: {
        status: dbStatus,
        error: dbError,
      },
      timestamp: new Date().toISOString(),
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    }
  );
};
