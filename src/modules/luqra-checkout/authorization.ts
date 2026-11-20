import { AsyncLocalStorage } from "node:async_hooks"

export const luqraAuthorization = new AsyncLocalStorage<{
  sessionId: string
  amount: string
  authorize: () => Promise<string | null>
}>()
