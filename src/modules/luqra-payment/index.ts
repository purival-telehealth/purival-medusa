import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import LuqraPaymentProvider from "./service"

export default ModuleProvider(Modules.PAYMENT, { services: [LuqraPaymentProvider] })
