import { createHmac, timingSafeEqual } from "node:crypto"

export const providerId = "pp_luqra_luqra"
export const transactionPattern = /^[1-9][0-9]{0,31}$/
export const referencePrefix = "purival_"

export function safeEqual(left: string, right: string) {
  const first = Buffer.from(left)
  const second = Buffer.from(right)
  return first.length === second.length && timingSafeEqual(first, second)
}

export function signCapture(secret: string, sessionId: string, transaction: string, amount: string) {
  return createHmac("sha256", secret)
    .update(`luqra-capture:${sessionId}:${transaction}:${amount}`)
    .digest("hex")
}

export function verifiedWebhook(secret: string, header: string, raw: Buffer) {
  const signature = /^t=([A-Za-z0-9_-]{1,128}),\s*s=([0-9a-f]{64})$/i.exec(header)
  if (!signature) return false
  const expected = createHmac("sha256", secret)
    .update(`${signature[1]}.`)
    .update(raw)
    .digest("hex")
  return safeEqual(expected, signature[2].toLowerCase())
}

export function usdAmount(value: unknown) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0 || number > 999999.99) {
    throw new Error("Invalid Luqra amount.")
  }
  const formatted = number.toFixed(2)
  if (Number(formatted) !== number) throw new Error("Invalid Luqra amount precision.")
  return formatted
}

export async function transact(fields: Record<string, string>) {
  const environment = process.env.LUQRA_ENVIRONMENT
  const apiKey = process.env.LUQRA_API_KEY?.trim()
  if (!apiKey || (environment !== "sandbox" && environment !== "production")) {
    throw new Error("Luqra is unavailable.")
  }
  const host = environment === "sandbox" ? "sandbox.nmi.com" : "secure.nmi.com"
  const result = await fetch(`https://${host}/api/transact.php`, {
    method: "POST",
    body: new URLSearchParams({ ...fields, security_key: apiKey }),
    redirect: "error",
    signal: AbortSignal.timeout(12000),
  })
  if (!result.ok) throw new Error("Luqra returned an unconfirmed result.")
  return new URLSearchParams(await result.text())
}
