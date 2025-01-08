import { createApp, defineEventHandler, toNodeListener, H3Event } from "h3";
import { NodeApp } from "astro/app/node";
import type { SSRManifest } from "astro";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";
import type { AdapterOptions } from "./types.js";
import { setGetEnv } from "astro/env/setup";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import mime from "mime-types";

setGetEnv((key) => process.env[key]);

const mimeTypeCache = new Map<string, string>();

function getMimeType(filePath: string): string {
  const ext = extname(filePath);
  let mimeType = mimeTypeCache.get(ext);
  if (!mimeType) {
    mimeType = mime.lookup(ext) || "application/octet-stream";
    mimeTypeCache.set(ext, mimeType);
  }
  return mimeType;
}

export function createExports(
  manifest: SSRManifest,
  options: AdapterOptions = {},
) {
  const app = new NodeApp(manifest);
  const h3App = createApp();
  const als = new AsyncLocalStorage<string>();
  const logger = app.getAdapterLogger();

  async function serveStaticFile(
    filePath: string,
    event: H3Event,
    cache = false,
  ): Promise<Buffer | null> {
    try {
      const stats = await stat(filePath);
      if (!stats.isFile()) return null;

      const contentType = getMimeType(filePath);
      event.node.res.setHeader("Content-Type", contentType);
      event.node.res.setHeader("Last-Modified", stats.mtime.toUTCString());

      if (cache) {
        event.node.res.setHeader(
          "Cache-Control",
          "public, max-age=31536000, immutable",
        );
      }

      return await readFile(filePath);
    } catch {
      return null;
    }
  }

  let clientRoot: string;
  if (options.client) {
    clientRoot = fileURLToPath(new URL(".", new URL(options.client)));
  }

  async function tryStaticFile(
    path: string,
    event: H3Event,
  ): Promise<Buffer | null> {
    if (!clientRoot) return null;
    const filePath = join(clientRoot, path);

    // Try exact path
    let content = await serveStaticFile(filePath, event);
    if (content) return content;

    // Try with /index.html
    if (!path.endsWith("/")) {
      content = await serveStaticFile(filePath + "/index.html", event);
      if (content) return content;
    }

    // Try path/index.html
    content = await serveStaticFile(join(filePath, "index.html"), event);
    if (content) return content;

    return null;
  }

  if (options.client) {
    h3App.use(
      "*",
      defineEventHandler(async (event) => {
        const url = event.node.req.url!;
        const method = event.node.req.method!;

        // Handle _astro assets first
        if (url.startsWith("/_astro/")) {
          const assetPath = decodeURIComponent(url.slice(7));
          const filePath = join(clientRoot, "_astro", assetPath);
          const content = await serveStaticFile(filePath, event, true);
          if (content) return content;
        }

        // Create request for route matching
        const req = new Request(`http://${event.node.req.headers.host}${url}`, {
          method: event.node.req.method,
          headers: event.node.req.headers as any,
        });

        // Try to match route first
        const routeData = app.match(req);

        if (routeData || method !== "GET") {
          return await als.run(req.url, async () => {
            const response = await app.render(req, {
              routeData,
              locals: event.context,
              addCookieHeader: true,
            });

            if (!response.body) return null;

            // Copy status and headers
            event.node.res.statusCode = response.status;
            response.headers.forEach((value, key) => {
              event.node.res.setHeader(key, value);
            });

            return Buffer.from(await response.arrayBuffer());
          });
        }

        // If no route match and it's a GET request, try static files
        if (method === "GET") {
          const path = decodeURIComponent(url);
          const content = await tryStaticFile(path, event);
          if (content) return content;
        }

        // If nothing matched, let Astro handle 404
        const notFoundResponse = await app.render(req);
        event.node.res.statusCode = notFoundResponse.status;
        notFoundResponse.headers.forEach((value, key) => {
          event.node.res.setHeader(key, value);
        });
        return Buffer.from(await notFoundResponse.arrayBuffer());
      }),
    );
  }

  const handler = toNodeListener(h3App);

  function startServer(options: AdapterOptions = {}) {
    const port = process.env.PORT
      ? parseInt(process.env.PORT)
      : options.port ?? 3000;
    const host = process.env.HOST ?? options.host ?? "localhost";
    const server = createServer(handler);
    let isClosing = false;

    const closed = new Promise<void>((resolve, reject) => {
      server.once("close", resolve);
      server.once("error", reject);
    });

    server.listen(port, host as string, () => {
      if (options.mode !== "preview") {
        logger.info(`Server listening on http://${host}:${port}`);
      }
    });

    return {
      app: h3App,
      server,
      async stop() {
        if (isClosing) return;
        isClosing = true;
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      },
      closed() {
        return closed;
      },
    };
  }

  return { handler, startServer, options };
}

export function start(manifest: SSRManifest, options: AdapterOptions = {}) {
  if (
    options.mode !== "standalone" ||
    process.env.ASTRO_NODE_AUTOSTART === "disabled"
  ) {
    return;
  }

  const { startServer } = createExports(manifest, options);
  startServer(options);
}
