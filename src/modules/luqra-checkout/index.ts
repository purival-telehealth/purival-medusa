import { MedusaService, Module } from "@medusajs/framework/utils"
import LuqraAttempt from "./models/luqra-attempt"

export class LuqraCheckoutService extends MedusaService({ LuqraAttempt }) {}

export default Module("luqraCheckout", { service: LuqraCheckoutService })
