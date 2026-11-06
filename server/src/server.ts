import { resolve } from "node:path";
import { createApp } from "./app.js";
import { initializeDatabase } from "./database.js";
import { RoutingWorker } from "./routing-worker.js";

const port = Number(process.env.PORT ?? 3001);
const databasePath = resolve(
  process.cwd(),
  process.env.DATABASE_PATH ?? "../data/taskflow.sqlite",
);
const db = await initializeDatabase(databasePath);
const app = createApp(db);
const worker = new RoutingWorker(db);
await worker.sweep();
const sweepTimer = setInterval(() => {
  void worker.sweep().catch(console.error);
}, 1000);

const server = app.listen(port, () => {
  console.log(`TaskFlow API listening on port ${port}`);
});

function close(): void {
  clearInterval(sweepTimer);
  server.close(() => {
    void db.close();
  });
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
