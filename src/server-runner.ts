import { serveSession } from "./server.js";

const id = process.argv[2];
if (!id) throw new Error("Usage: handback-server <session-id>");

const server = await serveSession({ id, open: process.env.HANDBACK_OPEN !== "0" });
await server.closed;
