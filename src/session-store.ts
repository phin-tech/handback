import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session } from "./core.js";

export function defaultSessionDir(): string {
  return process.env.HANDBACK_HOME ? join(process.env.HANDBACK_HOME, "sessions") : join(homedir(), ".handback", "sessions");
}

export function createSessionStore(dir = defaultSessionDir()) {
  const pathFor = (id: string) => join(dir, `${id}.json`);

  return {
    dir,
    pathFor,
    async save(session: Session): Promise<void> {
      await mkdir(dir, { recursive: true });
      await writeFile(pathFor(session.id), `${JSON.stringify(session, null, 2)}\n`, "utf8");
    },
    async load(id: string): Promise<Session> {
      return JSON.parse(await readFile(pathFor(id), "utf8")) as Session;
    },
    async list(): Promise<Session[]> {
      await mkdir(dir, { recursive: true });
      const files = await readdir(dir);
      const sessions = await Promise.all(
        files
          .filter((file) => file.endsWith(".json"))
          .map(async (file) => JSON.parse(await readFile(join(dir, file), "utf8")) as Session)
      );
      return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
  };
}
