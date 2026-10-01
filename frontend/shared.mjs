/**
 * Helpers shared by the student site (app.js) and the admin portal
 * (admin/admin.mjs): the API client, escaping, toasts, dates and small pieces
 * of UI. No framework, no build step.
 */

/** "" means the same address as the page (the web server passes /api through). */
export const API_BASE = typeof window.NIEC_CONFIG?.apiBaseUrl === "string" ? window.NIEC_CONFIG.apiBaseUrl : "";
export const THEME_KEY = "niec_theme";

export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

/* ---------------------------------- api ---------------------------------- */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * A JSON client for the backend. `getToken` supplies the session token for
 * each call; `onUnauthorized` runs when a signed-in call comes back 401 (the
 * session expired or was signed out elsewhere).
 */
export function createApi({ getToken, onUnauthorized }) {
  return async function api(path, { method = "GET", body } = {}) {
    const token = getToken();
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;

    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError("Cannot reach the NIEC Visa AI server. Is the backend running?", 0);
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && token) onUnauthorized();
      throw new ApiError(payload.error || "Something went wrong.", response.status);
    }
    return payload;
  };
}

/* ---------------------------------- text --------------------------------- */

/** Escape anything that came from a user or the API before putting it in HTML. */
export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";

export const formatDateTime = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : "";

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/* ----------------------------------- ui ---------------------------------- */

export function toast(message, kind = "") {
  const stack = $("#toastStack");
  if (!stack) return;
  const node = document.createElement("div");
  node.className = `toast ${kind}`.trim();
  node.textContent = message;
  stack.append(node);
  setTimeout(() => {
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 300);
  }, 4200);
}

export const scoreClass = (value) => (value >= 75 ? "good" : value >= 60 ? "warn" : "bad");

export function meter(label, value, sub = "") {
  const tone = scoreClass(value);
  return `
    <div class="meter">
      <div class="meter-head"><span>${esc(label)}</span><b class="score-${tone}">${value}</b></div>
      <div class="meter-track"><div class="meter-fill fill-${tone}" style="width:${Math.max(2, value)}%"></div></div>
      ${sub ? `<div class="meter-sub">${esc(sub)}</div>` : ""}
    </div>`;
}

/** Disable a button and show what is happening, then put it back. */
export function setBusy(button, busy, busyLabel = "Working...") {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyLabel;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

/** "Show" / "Hide" buttons next to password fields. */
export function installPasswordReveal(scope = document) {
  for (const button of $$(".reveal", scope)) {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.for);
      if (!input) return;
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      button.textContent = showing ? "Show" : "Hide";
      button.setAttribute("aria-label", showing ? "Show password" : "Hide password");
      input.focus();
    });
  }
}

/** Light, dark or follow the device. Remembered per browser. */
export function resolveTheme(theme) {
  if (theme !== "system") return theme === "dark" ? "dark" : "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
