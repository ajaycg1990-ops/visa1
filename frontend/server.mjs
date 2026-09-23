import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static server for the frontend.
 *
 * Dependency-free on purpose. It does three things:
 *   - serves the files in this folder,
 *   - generates /runtime-config.js so the browser knows where the API lives
 *     without the API URL being baked into app.js at build time,
 *   - sets the security headers a production deployment needs.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number.parseInt(process.env.FRONTEND_PORT || "3000", 10);
/** Loopback by default: in production only the reverse proxy should reach this. */
const HOST = process.env.HOST || "127.0.0.1";
const API_URL = process.env.PUBLIC_API_URL === "SAME_ORIGIN" ? "" : (process.env.PUBLIC_API_URL || "");
const INTERNAL_API_URL = process.env.INTERNAL_API_URL || "http://127.0.0.1:4000";

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
    `connect-src 'self' ${API_URL || ""} https://accounts.google.com`,
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

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  // Single-port hosting: forward API and health requests to the private API process.
  if (urlPath === "/health" || urlPath.startsWith("/api/")) {
    const target = new URL(req.url || "/", INTERNAL_API_URL);
    const proxyReq = http.request(target, {
      method: req.method,
      headers: { ...req.headers, host: target.host },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on("error", (error) => {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "API unavailable", detail: error.message }));
    });
    req.pipe(proxyReq);
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

  const file = (await resolveFile(urlPath)) ?? path.join(HERE, "index.html"); // SPA fallback
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
  console.log(`[web]  talking to the API at ${API_URL}`);
});
