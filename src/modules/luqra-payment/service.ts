import type {
  AuthorizePaymentInput, CancelPaymentInput, CapturePaymentInput,
  GetPaymentStatusInput, InitiatePaymentInput, RefundPaymentInput,
  RetrievePaymentInput, UpdatePaymentInput, WebhookActionResult,
} from "@medusajs/framework/types"
import { AbstractPaymentProvider, BigNumber, PaymentSessionStatus } from "@medusajs/framework/utils"
import { safeEqual, signCapture, transact, transactionPattern, usdAmount } from "./gateway"

import { luqraAuthorization } from "../luqra-checkout/authorization"

type Options = { secret: string }

export default class LuqraPaymentProvider extends AbstractPaymentProvider<Options> {
  static identifier = "luqra"

  constructor(container: Record<string, unknown>, private readonly options: Options) {
    super(container, options)
  }

  private captureRecord(data?: Record<string, unknown>) {
    const { session, transaction, amount, proof } = data ?? {}
    if (
      typeof session !== "string" || typeof transaction !== "string" ||
      !transactionPattern.test(transaction) || typeof amount !== "string" ||
      typeof proof !== "string" ||
      !safeEqual(proof, signCapture(this.options.secret, session, transaction, amount))
    ) return null
    return { session, transaction, amount, proof }
  }

  async initiatePayment({ data, currency_code, amount }: InitiatePaymentInput) {
    const session = data?.session_id
    if (currency_code !== "usd" || typeof session !== "string") {
      throw new Error("Luqra requires a USD payment session.")
    }
    return { id: session, data: { session, amount: usdAmount(new BigNumber(amount).numeric) } }
  }

  async authorizePayment({ data, context }: AuthorizePaymentInput) {
    const authorization = luqraAuthorization.getStore()
    const session = context?.idempotency_key
    if (!authorization || session !== authorization.sessionId || data?.amount !== authorization.amount) {
      return { status: PaymentSessionStatus.REQUIRES_MORE, data }
    }

    const transaction = await authorization.authorize()
    if (!transaction) return { status: PaymentSessionStatus.REQUIRES_MORE, data }
    const amount = authorization.amount
    const proof = signCapture(this.options.secret, session, transaction, amount)
    return { status: PaymentSessionStatus.CAPTURED, data: { session, transaction, amount, proof } }
  }

  async capturePayment({ data }: CapturePaymentInput) {
    const capture = this.captureRecord(data)
    if (!capture) throw new Error("Luqra sale has not been confirmed.")
    return { data: capture }
  }

  async cancelPayment({ data }: CancelPaymentInput) {
    const capture = this.captureRecord(data)
    if (!capture) return {}
    const result = await transact({ type: "void", transactionid: capture.transaction })
    if (result.get("response") !== "1") throw new Error("Luqra did not confirm the void.")
    return { data: capture }
  }

  async refundPayment({ data, amount }: RefundPaymentInput) {
    const capture = this.captureRecord(data)
    if (!capture) throw new Error("Luqra sale has not been confirmed.")
    const refundAmount = usdAmount(new BigNumber(amount).numeric)
    if (Number(refundAmount) > Number(capture.amount)) throw new Error("Invalid Luqra refund amount.")
    const result = await transact({
      type: "refund",
      transactionid: capture.transaction,
      amount: refundAmount,
    })
    if (result.get("response") !== "1") throw new Error("Luqra did not confirm the refund.")
    return { data: capture }
  }

  async updatePayment({ data, amount, currency_code }: UpdatePaymentInput) {
    if (currency_code !== "usd") throw new Error("Luqra requires USD.")
    const capture = this.captureRecord(data)
    const amountDue = usdAmount(new BigNumber(amount).numeric)
    if (capture && capture.amount !== amountDue) throw new Error("Luqra payment total changed.")
    return { amount, data: capture ?? { session: data?.session, amount: amountDue } }
  }

  async getPaymentStatus({ data }: GetPaymentStatusInput) {
    return {
      status: this.captureRecord(data)
        ? PaymentSessionStatus.CAPTURED
        : PaymentSessionStatus.PENDING,
    }
  }

  async retrievePayment({ data }: RetrievePaymentInput) {
    const capture = this.captureRecord(data)
    return { data: capture ? { transaction: capture.transaction } : {} }
  }

  async deletePayment() { return {} }

  async getWebhookActionAndData(): Promise<WebhookActionResult> {
    return { action: "not_supported" }
  }
}
