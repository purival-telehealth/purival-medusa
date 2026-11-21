import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { z } from "zod"
import {
  attempts, cartPattern, finishCheckout, getCheckout, lockCheckout, sessionPattern,
} from "../../../modules/luqra-checkout/payment"
import {
  referencePrefix, safeEqual, transact, transactionPattern,
} from "../../../modules/luqra-payment/gateway"

const inputSchema = z.object({
  cartId: z.string().regex(cartPattern),
  sessionId: z.string().regex(sessionPattern),
  amount: z.string().regex(/^\d{1,6}\.\d{2}$/),
  paymentToken: z.string().regex(/^[A-Za-z0-9._-]{8,512}$/).optional(),
})

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const secret = process.env.LUQRA_CHECKOUT_SECRET?.trim()
  if (!secret || !process.env.LUQRA_CAPTURE_SECRET || !process.env.LUQRA_API_KEY) {
    return res.status(503).json({ error: "Luqra checkout unavailable." })
  }
  if (!safeEqual(req.get("authorization") ?? "", `Bearer ${secret}`)) {
    return res.status(401).json({ error: "Unauthorized." })
  }

  const parsed = inputSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: "Invalid payment request." })
  const { cartId, sessionId, paymentToken, amount: quotedAmount } = parsed.data
  const payments = attempts(req.scope)

  let stage = "acquire-lock"
  let declined = false
  try {
    const order = await lockCheckout(req.scope, cartId, async () => {
      stage = "validate-cart-and-session"
      const { cart, amount } = await getCheckout(req.scope, cartId, sessionId)
      if (amount !== quotedAmount) throw new Error("The checkout total changed.")
      stage = "read-payment-attempt"
      let [attempt] = await payments.listLuqraAttempts({ cart_id: cartId })
      if (attempt && (attempt.id !== sessionId || attempt.amount !== amount)) {
        throw new Error("Luqra payment session changed.")
      }

      if (attempt?.transaction_id && attempt.state === "paid") {
        stage = "recover-paid-order"
        return finishCheckout(req.scope, cartId, sessionId, amount, async () => attempt.transaction_id)
      }
      if (attempt?.state === "declined" && !paymentToken) {
        declined = true
        throw new Error("Luqra declined the payment.")
      }
      if (!attempt && !paymentToken) {
        return null
      }
      if (attempt?.state === "review" || attempt?.state === "pending" || !paymentToken) {
        throw new Error("Luqra payment is still being verified.")
      }

      const billing = cart.billing_address
      const email = cart.email
      if (!billing || !email) throw new Error("Luqra billing details are unavailable.")

      let submitted = false
      stage = "complete-cart-before-payment"
      return finishCheckout(req.scope, cartId, sessionId, amount, async () => {
        if (submitted) {
          return attempt?.state === "paid" ? attempt.transaction_id : null
        }
        submitted = true
        stage = "persist-payment-attempt"
        // Persist the claim before contacting the gateway. Only a confirmed
        // decline releases it. Timeouts are reconciled through the webhook.
        attempt = attempt
          ? await payments.updateLuqraAttempts({ id: attempt.id, state: "pending" })
          : await payments.createLuqraAttempts({ id: sessionId, cart_id: cartId, amount, state: "pending" })

        stage = "submit-gateway-sale"
        const result = await transact({
          type: "sale",
          orderid: `${referencePrefix}${sessionId}`,
          amount,
          currency: "USD",
          payment_token: paymentToken,
          firstname: billing.first_name ?? "",
          lastname: billing.last_name ?? "",
          address1: billing.address_1 ?? "",
          city: billing.city ?? "",
          state: billing.province ?? "",
          zip: billing.postal_code ?? "",
          country: "US",
          email,
        }).catch(() => null)
        if (result?.get("response") === "2") {
          await payments.updateLuqraAttempts({ id: attempt.id, state: "declined" })
          declined = true
          return null
        }
        const transaction = result?.get("transactionid") ?? ""
        if (result?.get("response") !== "1" || !transactionPattern.test(transaction)) return null

        stage = "record-approved-sale"
        attempt = await payments.updateLuqraAttempts({ id: attempt.id, state: "paid", transaction_id: transaction })
        stage = "complete-paid-order"
        return transaction
      })
    })
    if (!order) return res.status(404).json({ status: "not_submitted" })
    return res.json({ order })
  } catch {
    if (!declined && (paymentToken || stage !== "read-payment-attempt")) {
      req.scope.resolve(ContainerRegistrationKeys.LOGGER).warn(
        `Luqra checkout needs verification: stage=${stage} session=${sessionId}`,
      )
    }
    return declined
      ? res.status(402).json({ status: "declined" })
      : res.status(409).json({ status: "pending" })
  }
}
