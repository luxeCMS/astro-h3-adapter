import {
  createApp,
  defineEventHandler,
  toNodeListener,
  createError,
  H3Error,
} from "h3";
import { NodeApp } from "astro/app/node";
import type { SSRManifest } from "astro";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { AdapterOptions } from "./types.js";
import { setGetEnv } from "astro/env/setup";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import mime from "mime-types";
import { Readable } from "node:stream";

setGetEnv((key) => process.env[key]);

async function writeWebResponse(res: any, webResponse: Response) {
  const { status, headers, body } = webResponse;

  // Set status code
  res.statusCode = status;

  // Get content type from response headers
  let contentType = "";
  for (const [name, value] of headers) {
    const headerName = name.toLowerCase();
    if (headerName === "content-type") {
      contentType = value;
    }
    res.setHeader(name, value);
  }

  // If no content type is set, try to infer it
  if (!contentType) {
    contentType = "text/plain";
    res.setHeader("Content-Type", contentType);
  }

  if (!body) {
    res.end();
    return;
  }

  if (body instanceof Readable) {
    body.pipe(res);
    return;
  }

  // ReadableStream from web standard
  const bodyAsReadable = body as ReadableStream;
  const reader = bodyAsReadable.getReader();
  const chunks: Uint8Array[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const fullBuffer = Buffer.concat(chunks);

    // Handle different content types
    if (contentType.includes("application/json")) {
      try {
        const jsonString = fullBuffer.toString("utf-8");
        const jsonData = JSON.parse(jsonString);
        res.end(JSON.stringify(jsonData, null, 2));
      } catch {
        res.end(fullBuffer);
      }
    } else if (contentType.startsWith("text/")) {
      res.end(fullBuffer.toString("utf-8"));
    } else {
      res.end(fullBuffer);
    }
  } catch (error) {
    console.error("Error reading from body:", error);
    throw error;
  } finally {
    reader.releaseLock();
  }
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
  ): Promise<boolean> {
    try {
      const stats = await stat(filePath);
      if (!stats.isFile()) return false;

      const contentType = mime.lookup(filePath) || "application/octet-stream";
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
        event.node.res.end();
        return true;
      }

      const content = await readFile(filePath);
      event.node.res.end(content);
      return true;
    } catch {
      return false;
    }
  }

  async function handleRequest(req: Request, event: any, routeData: any) {
    try {
      const response = await app.render(req, {
        routeData,
        locals: event.context,
        addCookieHeader: true,
      });

      await writeWebResponse(event.node.res, response);
    } catch (error) {
      logger.error(`Error rendering ${req.url}`);
      console.error(error);
      throw createError({
        statusCode: 500,
        statusMessage: "Internal Server Error",
      });
    }
  }

  if (options.client) {
    const clientRoot = fileURLToPath(new URL(".", new URL(options.client)));

    h3App.use(
      "*",
      defineEventHandler(async (event) => {
        const url = event.node.req.url!;

        // Handle _astro assets first
        if (url.startsWith("/_astro/")) {
          const assetPath = decodeURIComponent(url.slice(7));
          const filePath = join(clientRoot, "_astro", assetPath);
          if (await serveStaticFile(filePath, event, true)) {
            return;
          }
        }

        // Handle regular static files for GET requests
        if (event.node.req.method === "GET") {
          const path = decodeURIComponent(url);
          const filePath = join(clientRoot, path);
          if (await serveStaticFile(filePath, event)) {
            return;
          }
        }

        // If we get here, it's not a static file, so handle it as a route
        const req = new Request(`http://${event.node.req.headers.host}${url}`, {
          method: event.node.req.method,
          headers: event.node.req.headers as any,
        });

        try {
          const routeData = app.match(req);
          if (routeData) {
            await als.run(req.url, () => handleRequest(req, event, routeData));
            return;
          }

          // No route matched, try to render 404
          const response = await app.render(req);
          await writeWebResponse(event.node.res, response);
        } catch (err) {
          if (err instanceof H3Error && err?.statusCode === 404) {
            throw err;
          }
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
