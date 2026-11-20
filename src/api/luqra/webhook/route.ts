import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { z } from "zod"
import { attempts, finishCheckout, lockCheckout } from "../../../modules/luqra-checkout/payment"
import { referencePrefix, transactionPattern, verifiedWebhook } from "../../../modules/luqra-payment/gateway"

const sale = z.object({
  order_id: z.string().regex(/^purival_payses_[A-Za-z0-9]{1,64}$/),
  transaction_id: z.string().regex(transactionPattern),
  currency: z.literal("USD"),
  transaction_type: z.literal("cc"),
  features: z.object({ is_test_mode: z.boolean() }),
  action: z.object({ amount: z.string().regex(/^\d{1,6}\.\d{2}$/) }),
})

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const secret = process.env.LUQRA_WEBHOOK_SIGNING_KEY?.trim()
  const environment = process.env.LUQRA_ENVIRONMENT
  if (!secret || (environment !== "production" && environment !== "sandbox")) {
    return res.status(503).json({ error: "Webhook unavailable." })
  }
  const raw = req.rawBody
  if (!raw || raw.length > 65536) return res.sendStatus(400)
  if (!verifiedWebhook(secret, req.get("Webhook-Signature") ?? "", Buffer.from(raw))) {
    return res.sendStatus(401)
  }
  const event = req.body as { event_type?: string; event_body?: { order_id?: unknown } } | undefined
  const orderId = event?.event_body?.order_id
  if (
    event?.event_type !== "transaction.sale.success" ||
    typeof orderId !== "string" || !orderId.startsWith(referencePrefix)
  ) return res.sendStatus(204)

  const parsed = sale.safeParse(event.event_body)
  if (!parsed.success) return res.sendStatus(400)
  const payload = parsed.data
  if (payload.features.is_test_mode !== (environment === "sandbox")) return res.sendStatus(204)

  const sessionId = payload.order_id.slice(referencePrefix.length)
  const payments = attempts(req.scope)
  try {
    const [attempt] = await payments.listLuqraAttempts({ id: sessionId })
    if (!attempt) return res.sendStatus(204)

    await lockCheckout(req.scope, attempt.cart_id, async () => {
      const current = await payments.retrieveLuqraAttempt(sessionId)
      if (
        current.amount !== payload.action.amount ||
        current.state === "declined" ||
        (current.transaction_id && current.transaction_id !== payload.transaction_id)
      ) throw new Error("Luqra event did not match the checkout.")
      if (current.state === "review") return
      if (current.state === "pending") {
        await payments.updateLuqraAttempts({
          id: sessionId, state: "paid", transaction_id: payload.transaction_id,
        })
      }
      await finishCheckout(req.scope, current.cart_id, sessionId, current.amount, async () => payload.transaction_id)
    })
    return res.sendStatus(204)
  } catch {
    return res.sendStatus(503)
  }
}
