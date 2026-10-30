import auth from "../../workers/auth/src/index.ts";
import { unlimitedRateLimiter } from "./rate-limiter.ts";

export default {
  fetch(request, env, context) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/auth/")) return new Response("Not found", { status: 404 });
    url.pathname = url.pathname.slice("/api/auth".length);
    return auth.fetch(
      new Request(url, request),
      { ...env, RATE_LIMITER: unlimitedRateLimiter },
      context
    );
  },
};
