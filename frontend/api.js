import { API_URL, USE_MOCK } from "./config.js";

const MAX_RETRIES = 3;
// Apps Script sometimes takes well over 15 s to start up. Giving up too early only
// means the request is sent (and waited for) a second time.
const REQUEST_TIMEOUT_MS = 30000;
const RETRYABLE = new Set(["BUSY", "NETWORK"]);

let mockModule = null;

/**
 * Sends one action to the backend and returns the parsed response.
 * BUSY and network errors are retried up to 3 times with backoff.
 * Network failures come back as { ok: false, error: "NETWORK" }.
 */
export async function call(body) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await send(body);
    } catch {
      res = { ok: false, error: "NETWORK" };
    }
    if (res.ok || !RETRYABLE.has(res.error) || attempt >= MAX_RETRIES) return res;
    await sleep(500 * 2 ** attempt + Math.random() * 300);
  }
}

async function send(body) {
  if (USE_MOCK) {
    mockModule ??= await import("./mock.js");
    return mockModule.handle(body);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // text/plain keeps this a "simple" request, so there is no CORS preflight.
    const r = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
      redirect: "follow",
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!data || typeof data.ok !== "boolean") throw new Error("Bad response");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
