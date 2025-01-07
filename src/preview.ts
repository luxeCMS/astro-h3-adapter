import { fileURLToPath } from "node:url";
import type { CreatePreviewServer } from "astro";
import { AstroError } from "astro/errors";
import { createExports } from "./server.js";

type ServerModule = {
  handler: ReturnType<typeof createExports>["handler"];
  startServer: ReturnType<typeof createExports>["startServer"];
  options: ReturnType<typeof createExports>["options"];
};

const createPreviewServer: CreatePreviewServer = async (preview) => {
  let ssrModule: Partial<ServerModule>;

  try {
    process.env.ASTRO_NODE_AUTOSTART = "disabled";

    ssrModule = await import(preview.serverEntrypoint.toString());

    if (
      typeof ssrModule?.handler !== "function" ||
      typeof ssrModule?.startServer !== "function"
    ) {
      throw new AstroError(
        "The server entrypoint is missing required exports (handler or startServer). Did you remove the adapter exports?",
      );
    }
  } catch (err) {
    if (err instanceof Error && (err as any).code === "ERR_MODULE_NOT_FOUND") {
      throw new AstroError(
        `The server entrypoint ${fileURLToPath(
          preview.serverEntrypoint,
        )} does not exist. Have you run a build?`,
      );
    }
    throw err;
  }

  const options = {
    host: preview.host ?? "localhost",
    port: preview.port ?? 4321,
    mode: "preview" as const,
  };

  const server = ssrModule.startServer(options);

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

  return {
    host: options.host,
    port: options.port,
    server: server.server,
    closed() {
      return server.closed();
    },
    async stop() {
      await server.stop();
    },
  };
};

export { createPreviewServer as default };
