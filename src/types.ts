import type { App } from "h3";
import type { Server } from "node:http";
import type { SSRManifest } from "astro";

export interface UserOptions {
  /**
   * The mode to run the server in
   * @default 'standalone'
   */
  mode?: "standalone" | "preview";

  /**
   * The port to run the server on
   * @default process.env.PORT || 3000
   */
  port?: number;

  /**
   * The host to run the server on
   * @default process.env.HOST || 'localhost'
   */
  host?: string | boolean;

  /**
   * Enable or disable logging
   * @default true
   */
  logging?: boolean;

  /**
   * Custom entry file for additional H3 routes
   * Can be a string path or URL
   */
  entry?: string | URL;
}

export interface AdapterOptions extends UserOptions {
  client?: string;
  server?: string;
  assets?: string;
  trailingSlash?: SSRManifest["trailingSlash"];
}

export interface AstroH3Server {
  server: Server;
  app: App;
  stop(): Promise<void>;
  closed(): Promise<void>;
}

export interface AdapterEnv {
  PORT?: string;
  HOST?: string;
  [key: string]: string | undefined;
}

export class AstroH3Error extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
  ) {
    super(message);
    this.name = "AstroH3Error";
  }
}
