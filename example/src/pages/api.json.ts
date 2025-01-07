import type { APIRoute } from "astro";

export const GET: APIRoute = async () => {
  let x = 0;
  for (let i = 0; i < 1000; i++) {
    x = i + i;
  }
  return new Response(
    JSON.stringify({
      message: `Hello John Doe!`,
      x,
    }),
  );
};
