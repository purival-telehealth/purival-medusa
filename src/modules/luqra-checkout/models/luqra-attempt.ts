import { model } from "@medusajs/framework/utils"

const LuqraAttempt = model.define("luqra_attempt", {
  id: model.id().primaryKey(),
  cart_id: model.text().unique(),
  amount: model.text(),
  transaction_id: model.text().nullable(),
  state: model.enum(["pending", "declined", "paid", "review"]).default("pending"),
})

export default LuqraAttempt
