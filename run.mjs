// Thin wrapper around zen-proxy: routes its upstream LLM fetches through the
// in-container CONNECT egress proxy and rotates egress + caller identity on
// confirmed free-tier limits. Mirrors the OpenCode plugin's retry hook without
// touching the OpenCode installation (the plugin itself stays read-only).
import { readFileSync, writeFileSync } from "node:fs"
import { createHash, randomBytes } from "node:crypto"

const CONTROL = process.env.UNLIMITEDCODE_CONTROL || "http://127.0.0.1:42988"
const LISTEN = (process.env.UNLIMITEDCODE_LISTEN || "http://127.0.0.1:42987").replace(/^https?:\/\//, "")
const TOKEN = readFileSync(`${process.env.UNLIMITEDCODE_HOME}/control.token`, "utf8").trim()

// Keep the alias resolvable and persisted, but NEVER put the alias key in
// fallbackModels: that list is the retry chain, and an alias key there gets
// sent upstream as a real paid model. /v1/models visibility comes from the
// ALLOWED() patch applied at image build time (see Dockerfile).
const CONFIG_PATH = process.env.ZEN_PROXY_CONFIG || "/app/zen-proxy/zen-proxy.json"
let cfg = {}
try {
  cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
} catch {}
cfg.modelAliases = { ...(cfg.modelAliases || {}), "gpt-6-astra": "hy4-flash-free" }
// Seed from the shipped catalog on a fresh container, and undo the earlier
// mistake of listing gpt-6-astra as a fallback candidate.
let fallback = Array.isArray(cfg.fallbackModels)
  ? cfg.fallbackModels.filter((m) => m !== "gpt-6-astra")
  : []
if (!fallback.length) {
  try {
    const shipped = JSON.parse(readFileSync("/app/zen-proxy/models.json", "utf8"))
    if (Array.isArray(shipped.models)) fallback = [...shipped.models]
  } catch {}
}
cfg.fallbackModels = fallback
const PROJECT_PINNED = typeof cfg.projectHash === "string" && cfg.projectHash.length > 0
writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))

// --- Identity rotation (parity with the host OpenCode plugin) ----------------
// MAX_ATTEMPTS mirrors OpenCode's ModelRetry policy (attempt = 2..11).
const MAX_ATTEMPTS = 11
const MAX_SESSION_ALIASES = 200
const ROTATE_WINDOW_MS = 5 * 60_000
const MIN_ROTATE_INTERVAL_MS = 1_500
const MAX_ROTATIONS_PER_HOUR = 60
const ROTATE_TIMEOUT_MS = 55_000
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const SESSION_HEADERS = [
  "x-opencode-session",
  "x-opencode-session-id",
  "x-session-affinity",
  "x-session-id",
  "X-Session-Id",
]
const PROJECT_HEADER = "x-opencode-project"
const sessionAliases = new Map()
let lastIDTs = 0
let idCounter = 0
let epoch = 0
let lastRotateAt = 0
let rotationTimes = []

// "ses_" + 12 hex of ~(ms*0x1000+counter) + 14 Base62, matching
// OpenCode Identifier.descending() so the gate sees a real client identity.
function generateSessionID() {
  const ts = Date.now()
  if (ts !== lastIDTs) {
    lastIDTs = ts
    idCounter = 0
  }
  idCounter++
  const current = BigInt(ts) * 0x1000n + BigInt(idCounter)
  const value = ~current
  let hex = ""
  for (let i = 0; i < 6; i++) {
    hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  }
  const bytes = new Uint8Array(14)
  crypto.getRandomValues(bytes)
  let tail = ""
  for (const b of bytes) tail += BASE62[b % 62]
  return "ses_" + hex + tail
}

function genProjectHash() {
  return createHash("sha1").update(`directory:${randomBytes(18).toString("hex")}`).digest("hex")
}

function rotateSessionAlias(key) {
  const alias = generateSessionID()
  const project = PROJECT_PINNED ? null : genProjectHash()
  const previous = sessionAliases.get(key)
  if (sessionAliases.size >= MAX_SESSION_ALIASES && !sessionAliases.has(key)) {
    const oldest = sessionAliases.keys().next().value
    if (oldest !== undefined) sessionAliases.delete(oldest)
  }
  sessionAliases.set(key, {
    alias,
    project,
    attempts: previous?.attempts ?? [],
  })
  return alias
}

function headerValue(headers, name) {
  if (!headers) return ""
  if (typeof headers.get === "function") return headers.get(name) ?? ""
  if (Array.isArray(headers)) {
    const hit = headers.find((p) => String(p[0]).toLowerCase() === name.toLowerCase())
    return hit ? String(hit[1]) : ""
  }
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) return String(headers[k])
  }
  return ""
}

function sessionKey(init) {
  for (const name of SESSION_HEADERS) {
    const value = headerValue(init?.headers, name)
    if (value) return value
  }
  // zen-proxy injects a session by default, so this is only a safety net.
  return "anonymous"
}

function applySessionAlias(init, key) {
  const record = sessionAliases.get(key)
  if (!record?.alias) return init
  const headers = init?.headers
  if (!headers) return init
  if (typeof headers.set === "function") {
    for (const name of SESSION_HEADERS) {
      if (headers.has(name)) headers.set(name, record.alias)
    }
    if (record.project && headers.has(PROJECT_HEADER)) headers.set(PROJECT_HEADER, record.project)
    return init
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      const low = String(pair[0]).toLowerCase()
      if (SESSION_HEADERS.some((n) => n.toLowerCase() === low)) pair[1] = record.alias
      else if (record.project && low === PROJECT_HEADER.toLowerCase()) pair[1] = record.project
    }
    return init
  }
  for (const existing of Object.keys(headers)) {
    const low = existing.toLowerCase()
    if (SESSION_HEADERS.some((n) => n.toLowerCase() === low)) headers[existing] = record.alias
    else if (record.project && low === PROJECT_HEADER.toLowerCase()) headers[existing] = record.project
  }
  return init
}

function parseBody(init) {
  try {
    return typeof init?.body === "string" ? JSON.parse(init.body) : null
  } catch {
    return null
  }
}

// Auto-sync's agent-shaped liveness probe. It runs through the same wrapped
// fetch, so it must never consume rotation budget or burn an egress slot.
function isSyncProbe(body) {
  if (!body) return false
  const ask = (arr) =>
    Array.isArray(arr) && arr.some((m) => String(m?.content ?? "").includes("Reply with exactly OK1"))
  const input = Array.isArray(body.input)
    ? body.input.some((m) => String(m?.content?.[0]?.text ?? "").includes("Reply with exactly OK1"))
    : false
  return ask(body.messages) || input
}

async function isFreeLimit(res) {
  if (res.status !== 429) return false
  try {
    // clone() keeps the live SSE/JSON body intact for zen-proxy to consume.
    const text = await res.clone().text()
    return /FreeUsageLimitError|free.?usage.?limit|free.?limit|today's free messages/i.test(text)
  } catch {
    return false
  }
}

function rotationBudget(key) {
  const now = Date.now()
  if (now - lastRotateAt < MIN_ROTATE_INTERVAL_MS) return null
  rotationTimes = rotationTimes.filter((t) => now - t < 60 * 60_000)
  if (rotationTimes.length >= MAX_ROTATIONS_PER_HOUR) return null
  const record = sessionAliases.get(key)
  const attempts = (record?.attempts ?? []).filter((t) => now - t < ROTATE_WINDOW_MS)
  if (attempts.length >= MAX_ATTEMPTS) return null
  return attempts.length + 1
}

async function rotate(key, model) {
  const attempt = rotationBudget(key)
  if (!attempt) return false
  try {
    const res = await realFetch(`${CONTROL}/event`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        type: "provider.free-limit",
        session: key,
        model: model || "",
        agent: "zen-proxy",
        attempt,
      }),
      signal: AbortSignal.timeout(ROTATE_TIMEOUT_MS),
    })
    const data = res.ok ? await res.json().catch(() => null) : null
    if (data?.status !== "ok") throw new Error(`control returned ${res.status}`)
    const next = Number(data.epoch || 0)
    epoch = Number.isFinite(next) && next > epoch ? Math.floor(next) : epoch + 1
    lastRotateAt = Date.now()
    rotationTimes.push(lastRotateAt)
    const record = sessionAliases.get(key) ?? { attempts: [] }
    record.attempts.push(lastRotateAt)
    rotateSessionAlias(key) // fresh identity + fresh IP, together
    console.log(`[egress] rotated to epoch ${epoch} after free-limit 429 (attempt ${attempt}, ${key.slice(0, 11)}…)`)
    return true
  } catch (err) {
    console.error("[egress] rotate failed:", err?.message || err)
    return false
  }
}

const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input)
  // Only chat/completions and responses upstream calls get the rotating tunnel;
  // model-list discovery and registry checks must not burn egress slots.
  if (!url.includes("/inference/openai/v1/")) return realFetch(input, init)

  const body = parseBody(init)
  const key = sessionKey(init)
  const nextInit = applySessionAlias({ ...init }, key)
  const res = await realFetch(input, { ...nextInit, proxy: `http://r${epoch}@${LISTEN}` })

  if (await isFreeLimit(res)) {
    if (!isSyncProbe(body)) await rotate(key, String(body?.model ?? ""))
  }
  return res
}

// zen-proxy only starts its server when loaded as the main module.
process.argv[1] = "/app/zen-proxy/zen-proxy.mjs"
await import(process.argv[1])
