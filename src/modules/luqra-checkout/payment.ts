import { randomUUID } from "node:crypto"
import { completeCartWorkflowId } from "@medusajs/medusa/core-flows"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { LuqraCheckoutService } from "./index"
import { providerId, usdAmount } from "../luqra-payment/gateway"

import { luqraAuthorization } from "./authorization"

export const cartPattern = /^cart_[A-Za-z0-9]{1,64}$/
export const sessionPattern = /^payses_[A-Za-z0-9]{1,64}$/

export function attempts(scope: MedusaContainer) {
  return scope.resolve<LuqraCheckoutService>("luqraCheckout")
}

export async function lockCheckout<T>(scope: MedusaContainer, id: string, run: () => Promise<T>) {
  const locking = scope.resolve(Modules.LOCKING)
  const key = `luqra-checkout:${id}`
  const ownerId = randomUUID()
  await locking.acquire(key, { ownerId, expire: 120 })
  try {
    return await run()
  } finally {
    await locking.release(key, { ownerId })
  }
}

export async function getCheckout(scope: MedusaContainer, id: string, sessionId: string) {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: [cart] } = await query.graph({
    entity: "cart",
    fields: ["id", "total", "currency_code", "email", "billing_address.*", "payment_collection.payment_sessions.*"],
    filters: { id },
  })
  const sessions = cart?.payment_collection?.payment_sessions ?? []
  const session = sessions[0]
  const sessionMatches = session?.id === sessionId && session.provider_id === providerId

  if (
    !cart || !sessionMatches || sessions.length !== 1 || cart.currency_code !== "usd" ||
    session.currency_code !== "usd" || usdAmount(cart.total) !== usdAmount(session.amount)
  ) throw new Error("The checkout session changed.")
  return { cart, amount: usdAmount(cart.total) }
}

export async function finishCheckout(
  scope: MedusaContainer,
  cartId: string,
  sessionId: string,
  amount: string,
  authorize: () => Promise<string | null>,
) {
  const { amount: currentAmount } = await getCheckout(scope, cartId, sessionId)
  if (currentAmount !== amount) throw new Error("Luqra payment does not match the cart.")

  const { result, transaction: workflow, errors } = await luqraAuthorization.run(
    { sessionId, amount, authorize },
    () => scope.resolve(Modules.WORKFLOW_ENGINE).run(completeCartWorkflowId, {
      input: { id: cartId },
      throwOnError: false,
    }),
  )
  if (workflow.hasFinished() && errors?.length) {
    const payments = attempts(scope)
    const [attempt] = await payments.listLuqraAttempts({ id: sessionId, state: "paid" })
    if (attempt) {
      // Medusa compensates failures after capture. Flag this attempt for
      // reconciliation before a later webhook can complete it again.
      await payments.updateLuqraAttempts({ id: sessionId, state: "review" })
    }
    throw new Error("Medusa could not complete the checkout.")
  }
  if (!workflow.hasFinished() || !result?.id) throw new Error("The order is still processing.")

  const { data: [order] } = await scope.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: "order",
    fields: ["id", "display_id", "currency_code", "total", "summary", "items.product_handle", "payment_collections.captured_amount"],
    filters: { id: result.id },
  })
  const paid = Number(order?.summary?.paid_total ?? 0)
  const collections: Array<{ captured_amount?: unknown } | null> = order?.payment_collections ?? []
  const captured = collections.reduce(
    (sum, collection) => sum + Number(collection?.captured_amount ?? 0),
    0,
  )
  if (!order || usdAmount(order.total) !== amount || Math.max(paid, captured) < Number(amount)) {
    throw new Error("Medusa has not recorded a paid order.")
  }
  return order
}
