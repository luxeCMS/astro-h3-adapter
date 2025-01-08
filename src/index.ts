import type { AstroAdapter, AstroIntegration } from "astro";
import type { UserOptions } from "./types.js";

export interface Options extends UserOptions {
  host?: string | boolean;
  port?: number;
  server?: string;
  client?: string;
  assets?: string;
}

function getAdapter(options: Options): AstroAdapter {
  return {
    name: "astro-h3-adapter",
    serverEntrypoint: "astro-h3-adapter/server.js",
    previewEntrypoint: "astro-h3-adapter/preview.js",
    exports: ["handler", "startServer", "start"],
    args: options,
    adapterFeatures: {
      edgeMiddleware: true,
      buildOutput: "server",
    },
    supportedAstroFeatures: {
      staticOutput: "stable",
      serverOutput: "stable",
      hybridOutput: "stable",
      // @ts-ignore
      assets: {
        supportKind: "stable",
        isSharpCompatible: true,
        isSquooshCompatible: true,
      },
      i18nDomains: "experimental",
      cookies: true,
      envGetSecret: "stable",
    },
  };
}

export default function createIntegration(
  userOptions: UserOptions = {},
): AstroIntegration {
  let _options: Options;

  return {
    name: "astro-h3-adapter",
    hooks: {
      "astro:config:setup": async ({ updateConfig }) => {
        updateConfig({
          vite: {
            ssr: {
              noExternal: ["astro-h3-adapter"],
            },
          },
        });
      },

      "astro:config:done": ({ setAdapter, config }) => {
        _options = {
          ...userOptions,
          mode: userOptions.mode ?? "standalone",
          client: config.build.client.toString(),
          server: config.build.server.toString(),
          assets: config.build.assets,
          host: userOptions.host ?? process.env.HOST ?? "localhost",
          port: userOptions.port ?? Number(process.env.PORT ?? 3000),
        };

        setAdapter(getAdapter(_options));
      },
    },
  };
}

export type * from "./types.js";
