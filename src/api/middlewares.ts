import { defineMiddlewares } from "@medusajs/framework/http"

export default defineMiddlewares({
  routes: [
    {
      matcher: "/luqra/webhook",
      method: "POST",
      bodyParser: { preserveRawBody: true, sizeLimit: "64kb" },
    },
  ],
})
