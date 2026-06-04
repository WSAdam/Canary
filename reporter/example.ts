// Runnable example. Start with:
//   CANARY_SECRET=dev-secret deno run --allow-net --allow-env --unstable-kv reporter/example.ts
// then:
//   curl -s -X POST localhost:8000/boom                                   # record an error
//   curl -s -X POST localhost:8000/canary/errors -H 'authorization: Bearer dev-secret' | jq

import { CanaryReporter } from "./mod.ts";

const canary = new CanaryReporter({ secret: Deno.env.get("CANARY_SECRET") ?? "dev-secret" });

Deno.serve(async (req) => {
  const { pathname } = new URL(req.url);

  // The Canary health contract — this is the whole integration on the producer side.
  if (req.method === "POST" && pathname === "/canary/errors") {
    return canary.handleErrors(req);
  }

  // Anywhere a real error happens, record it:
  if (req.method === "POST" && pathname === "/boom") {
    await canary.trackError("demo", "something exploded", { ref: crypto.randomUUID() });
    return new Response("recorded\n");
  }

  return new Response("ok\n");
});
