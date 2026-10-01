import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static server for the frontend.
 *
 * Dependency-free on purpose. It does four things:
 *   - serves the files in this folder,
 *   - passes /api/* through to the backend, so the whole site works from one
 *     address - on this computer, through a tunnel, or behind a proxy,
 *   - generates /runtime-config.js so the browser knows where the API lives,
 *   - sets the security headers a production deployment needs.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number.parseInt(process.env.FRONTEND_PORT || "3000", 10);
/** Loopback by default: in production only the reverse proxy should reach this. */
const HOST = process.env.HOST || "127.0.0.1";
/** Where this server reaches the backend - always on this machine. */
const BACKEND = { host: "127.0.0.1", port: Number.parseInt(process.env.BACKEND_PORT || process.env.PORT || "4000", 10) };
/**
 * Where the browser sends API calls. Empty means "this same address", via the
 * pass-through below - the default, and what makes a tunnel or a single
 * domain work. BROWSER_API_URL is only for splitting the API onto another host.
 */
const API_URL = process.env.BROWSER_API_URL || "";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Content Security Policy.
 * 'unsafe-inline' is present for styles only: the views set a few layout
 * styles through style attributes. Scripts stay restricted to this origin
 * plus Google Identity Services, which is only loaded when Google sign-in is
 * configured.
 */
function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' https://accounts.google.com https://apis.google.com",
    "frame-src https://accounts.google.com",
    `connect-src 'self' ${API_URL} https://accounts.google.com`.replace(/\s+/g, " "),
    "form-action 'self'",
  ].join("; ");
}

function securityHeaders(res, contentType) {
  res.setHeader("Content-Type", contentType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), payment=(), microphone=(self)");
  res.setHeader("Content-Security-Policy", contentSecurityPolicy());
}

/** Resolve a URL path to a file inside this folder, blocking traversal. */
async function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  const candidate = path.normalize(path.join(HERE, clean === "/" ? "index.html" : clean));
  if (!candidate.startsWith(HERE)) return null;
  try {
    const info = await stat(candidate);
    if (info.isDirectory()) return path.join(candidate, "index.html");
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Pass an /api request to the backend and stream the answer back. The
 * visitor's address is forwarded so the backend's per-person rate limits and
 * logs still see real people, not this server.
 */
function proxyToBackend(req, res) {
  // Never pass on a visitor-supplied X-Forwarded-For: anyone could set it to
  // dodge the rate limits. Trust only Cloudflare's verified address (when
  // reached through a Cloudflare tunnel) or the actual connection.
  const forwardedFor = req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "";
  const upstream = http.request(
    {
      ...BACKEND,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `${BACKEND.host}:${BACKEND.port}`, "x-forwarded-for": forwardedFor },
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    }
  );
  upstream.on("error", () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "The NIEC Visa AI server is not responding. Please try again in a moment." }));
  });
  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (urlPath.startsWith("/api/")) {
    proxyToBackend(req, res);
    return;
  }

  // Runtime configuration, generated rather than committed.
  if (urlPath === "/runtime-config.js") {
    const body = `window.NIEC_CONFIG = ${JSON.stringify({ apiBaseUrl: API_URL })};\n`;
    securityHeaders(res, MIME[".js"]);
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
    return;
  }

  if (urlPath === "/healthz") {
    securityHeaders(res, MIME[".json"]);
    res.end(JSON.stringify({ status: "ok", api: API_URL }));
    return;
  }

  // The admin portal lives at /admin/ - its assets load by absolute path, so
  // the trailing slash only matters for tidiness.
  if (urlPath === "/admin") {
    res.writeHead(301, { Location: "/admin/" });
    res.end();
    return;
  }

  // Each app falls back to its own page: /admin/... to the portal, the rest
  // to the student site.
  const fallback = urlPath.startsWith("/admin/") ? path.join(HERE, "admin", "index.html") : path.join(HERE, "index.html");
  const file = (await resolveFile(urlPath)) ?? fallback;
  try {
    const body = await readFile(file);
    const extension = path.extname(file).toLowerCase();
    securityHeaders(res, MIME[extension] || "application/octet-stream");
    // No content hashing in filenames, so HTML/CSS/JS must always be
    // revalidated - otherwise a deploy leaves browsers on stale code.
    // Images are stable and may be cached.
    const revalidate = [".html", ".css", ".js", ".mjs", ".json"].includes(extension);
    res.setHeader("Cache-Control", revalidate ? "no-cache" : "public, max-age=86400");
    res.end(body);
  } catch {
    securityHeaders(res, MIME[".txt"]);
    res.statusCode = 404;
    res.end("Not found");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[web]  NIEC Visa AI on http://${HOST}:${PORT}`);
  console.log(`[web]  API: ${API_URL || `/api on this address, passed through to ${BACKEND.host}:${BACKEND.port}`}`);
});
