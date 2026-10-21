import { cookies } from "next/headers";
import { NextRequest } from "next/server";

const COOKIE = "scheduler_session";
const routes: [RegExp, string[]][] = [
  [/^auth\/login$/, ["POST"]],
  [/^auth\/me$/, ["GET"]],
  [/^jobs$/, ["GET", "POST"]],
  [/^jobs\/[\w-]+\/runs$/, ["GET"]],
  [/^jobs\/[\w-]+\/run$/, ["POST"]],
  [/^jobs\/[\w-]+\/schedules$/, ["GET", "POST"]],
  [/^schedules\/[\w-]+$/, ["PATCH", "DELETE"]],
  [/^runs\/[\w-]+$/, ["GET"]],
  [/^runs\/[\w-]+\/logs(?:\/stream)?$/, ["GET"]],
  [/^(health|ready)$/, ["GET"]],
];

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const endpoint = path.join("/");
  const store = await cookies();
  const headers = { "Cache-Control": "no-store" };
  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    // Next.js may normalize the internal URL's hostname to localhost even
    // when the browser uses 127.0.0.1. Validate against the actual request host.
    const expectedOrigin = new URL(request.nextUrl);
    expectedOrigin.host = request.headers.get("host") || expectedOrigin.host;
    if (origin && origin !== expectedOrigin.origin)
      return new Response("Invalid request origin", { status: 403, headers });
  }
  if (endpoint === "auth/logout" && request.method === "POST") {
    store.delete(COOKIE);
    return new Response(null, { status: 204, headers });
  }
  if (
    !routes.some(
      ([pattern, methods]) =>
        pattern.test(endpoint) && methods.includes(request.method),
    )
  ) {
    return new Response("Endpoint not found", { status: 404, headers });
  }
  const login = endpoint === "auth/login";
  const token = store.get(COOKIE)?.value;
  if (!login && !token)
    return new Response("Please sign in to continue.", {
      status: 401,
      headers,
    });
  const base = (process.env.BACKEND_URL || "http://127.0.0.1:8080").replace(
    /\/$/,
    "",
  );
  const url = `${base}/${endpoint === "health" || endpoint === "ready" ? "" : "api/"}${endpoint}${request.nextUrl.search}`;
  try {
    const upstream = await fetch(url, {
      method: request.method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: ["POST", "PATCH"].includes(request.method)
        ? await request.text()
        : undefined,
      cache: "no-store",
      signal: endpoint.endsWith("/stream")
        ? request.signal
        : AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
    });
    if (login && upstream.ok) {
      const data = await upstream.json();
      if (typeof data.token !== "string")
        return new Response("Invalid login response", { status: 502, headers });
      store.set(COOKIE, data.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 86400,
      });
      return Response.json({ authenticated: true }, { headers });
    }
    if (upstream.status === 401) store.delete(COOKIE);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...headers,
        "Content-Type": upstream.headers.get("Content-Type") || "text/plain",
        ...(endpoint.endsWith("/stream") ? { "X-Accel-Buffering": "no" } : {}),
      },
    });
  } catch {
    return new Response(
      "Cannot reach the scheduler API. Check that the backend is running and BACKEND_URL is correct.",
      { status: 502, headers },
    );
  }
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE };
