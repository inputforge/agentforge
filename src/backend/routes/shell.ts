import { Hono } from "hono";
import { randomUUID } from "crypto";
import { remoteStmts } from "../db";
import { shellSessionManager } from "../services/ShellSessionManager";
import { clearShellScrollback } from "../ws/hub";

export const shellRouter = new Hono();

shellRouter.post("/", (c) => {
  const remoteConfig = remoteStmts.get.get() as { localPath: string } | null;
  const cwd = remoteConfig?.localPath ?? process.cwd();

  const sessionId = randomUUID();

  shellSessionManager.spawn(sessionId, cwd, (id) => {
    clearShellScrollback(id);
  });

  return c.json({ id: sessionId, cwd });
});

shellRouter.delete("/:id", (c) => {
  const id = c.req.param("id");
  shellSessionManager.kill(id);
  clearShellScrollback(id);
  return c.body(null, 204);
});
