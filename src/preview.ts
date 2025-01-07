import { fileURLToPath } from "node:url";
import type { CreatePreviewServer } from "astro";
import { AstroError } from "astro/errors";
import type { createExports } from "./server.js";

type ServerModule = ReturnType<typeof createExports>;
type MaybeServerModule = Partial<ServerModule>;

const createPreviewServer: CreatePreviewServer = async (preview) => {
  let ssrHandler: ServerModule["handler"];
  let startServer: ServerModule["startServer"];

  try {
    process.env.ASTRO_NODE_AUTOSTART = "disabled";
    const ssrModule: MaybeServerModule = await import(
      preview.serverEntrypoint.toString()
    );

    if (
      typeof ssrModule?.handler === "function" &&
      typeof ssrModule?.startServer === "function"
    ) {
      ssrHandler = ssrModule.handler;
      startServer = ssrModule.startServer;
    } else {
      throw new AstroError(
        "The server entrypoint doesn't have required exports (handler and startServer). Are you sure this is the right file?",
      );
    }
  } catch (err) {
    if (err instanceof Error && (err as any).code === "ERR_MODULE_NOT_FOUND") {
      throw new AstroError(
        `The server entrypoint ${fileURLToPath(
          preview.serverEntrypoint,
        )} does not exist. Have you run a build yet?`,
      );
    }
    throw err;
  }

  const options = {
    host: preview.host ?? "localhost",
    port: preview.port ?? 4321,
    mode: "preview" as const,
  };

  const server = startServer(options);

  // If user specified custom headers append a listener
  if (preview.headers && server.app) {
    server.app.use(async (event) => {
      const response = event.node.res;
      if (response.statusCode === 200) {
        for (const [name, value] of Object.entries(preview.headers ?? {})) {
          if (value) {
            response.setHeader(name, value);
          }
        }
      }
    });
  }

  preview.logger.info(
    `Preview server listening on http://${options.host}:${options.port}`,
  );

  await new Promise<void>((resolve, reject) => {
    server.server.once("listening", resolve);
    server.server.once("error", reject);
  });

  return {
    host: options.host,
    port: options.port,
    server: server.server,
    handler: ssrHandler,
    closed() {
      return server.closed();
    },
    async stop() {
      await server.stop();
    },
  };
};

export { createPreviewServer as default };
