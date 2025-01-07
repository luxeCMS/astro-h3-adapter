import { createApp, defineEventHandler, toNodeListener, createError } from "h3";
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
    event: any,
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

      const ifModifiedSince = event.node.req.headers["if-modified-since"];
      if (ifModifiedSince && new Date(ifModifiedSince) >= stats.mtime) {
        event.node.res.statusCode = 304;
        return null;
      }

      return await readFile(filePath);
    } catch {
      return null;
    }
  }

  async function handleRequest(req: Request, event: any, routeData: any) {
    const response = await app.render(req, {
      routeData,
      locals: event.context,
      addCookieHeader: true,
    });

    if (!response.body) return null;

    event.node.res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      event.node.res.setHeader(key, value);
    });

    return Buffer.from(await response.arrayBuffer());
  }

  if (options.client) {
    const clientRoot = fileURLToPath(new URL(".", new URL(options.client)));

    h3App.use(
      "*",
      defineEventHandler(async (event) => {
        const url = event.node.req.url!;

        // Early return for non-GET requests that aren't Astro routes
        if (event.node.req.method !== "GET" && !url.includes("/_astro/")) {
          return;
        }

        // Handle _astro assets
        if (url.startsWith("/_astro/")) {
          const assetPath = decodeURIComponent(url.slice(7));
          const filePath = join(clientRoot, "_astro", assetPath);
          const content = await serveStaticFile(filePath, event, true);
          if (content) return content;
        }

        // Handle regular static files
        if (event.node.req.method === "GET") {
          const path = decodeURIComponent(url);
          const filePath = join(clientRoot, path);
          const content = await serveStaticFile(filePath, event);
          if (content) return content;
        }

        // Handle Astro routes
        const req = new Request(`http://${event.node.req.headers.host}${url}`, {
          method: event.node.req.method,
          headers: event.node.req.headers as any,
        });

        try {
          const routeData = app.match(req);
          return routeData
            ? await als.run(req.url, () => handleRequest(req, event, routeData))
            : await handleRequest(req, event, null);
        } catch (err) {
          logger.error(`Error rendering ${req.url}`);
          console.error(err);
          throw createError({
            statusCode: 500,
            statusMessage: "Internal Server Error",
          });
        }
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
