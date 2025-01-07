// @ts-check
import { defineConfig } from "astro/config";
import h3Adapter from "astro-h3-adapter";

// https://astro.build/config
export default defineConfig({
  output: "server",
  adapter: h3Adapter({}),
});
