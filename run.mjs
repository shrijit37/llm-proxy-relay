// Thin wrapper around zen-proxy: routes its upstream LLM fetches through the
// in-container CONNECT egress proxy and rotates that egress on free-tier 429s.
// This replaces the OpenCode-plugin rotation hook without touching OpenCode.
import { readFileSync, writeFileSync } from "node:fs"

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
writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))

const realFetch = globalThis.fetch
let epoch = 0

async function rotate(model) {
  try {
    const res = await realFetch(`${CONTROL}/event`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        type: "provider.free-limit",
        session: "zen-proxy",
        model: model || "",
        agent: "zen-proxy",
        attempt: 2,
      }),
      signal: AbortSignal.timeout(55_000),
    })
    const data = res.ok ? await res.json().catch(() => null) : null
    if (data?.status === "ok") {
      const next = Number(data.epoch || 0)
      epoch = Number.isFinite(next) && next > epoch ? Math.floor(next) : epoch + 1
      console.log(`[egress] rotated to epoch ${epoch} after free-limit 429`)
      return
    }
  } catch (err) {
    console.error("[egress] rotate failed:", err?.message || err)
  }
  epoch += 1
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input)
  // Only chat/completions and responses upstream calls get the rotating tunnel;
  // model-list discovery uses a different path and must not burn egress slots.
  const isChat = url.includes("/inference/openai/v1/")
  if (!isChat) return realFetch(input, init)

  const res = await realFetch(input, { ...init, proxy: `http://r${epoch}@${LISTEN}` })
  if (res.status === 429) await rotate(String(init?.body?.model ?? ""))
  return res
}

// zen-proxy only starts its server when loaded as the main module.
process.argv[1] = "/app/zen-proxy/zen-proxy.mjs"
await import(process.argv[1])
