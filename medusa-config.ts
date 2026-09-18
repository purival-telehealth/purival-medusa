
import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

/**
 * Railway's internal Redis proxy resolves to an IPv6 address. ioredis dials
 * IPv6 first and can silently hang when the host only answers on IPv4.
 * Appending family=0 makes Node try both families (Happy Eyeballs), which
 * is the reliable default on Railway. Idempotent: existing family= wins.
 */
const normalizeRedisUrl = (url?: string): string | undefined => {
  if (!url) return url
  if (/([?&])family=/.test(url)) return url
  return url + (url.includes('?') ? '&' : '?') + 'family=0'
}

const redisUrl = normalizeRedisUrl(process.env.REDIS_URL)
const stripeApiKey = process.env.STRIPE_API_KEY?.trim()
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim()
const s3Bucket = process.env.S3_BUCKET?.trim()
const s3Endpoint = process.env.S3_ENDPOINT?.trim()
const s3AccessKeyId = process.env.S3_ACCESS_KEY_ID?.trim()
const s3SecretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim()
const s3FileUrl = process.env.S3_FILE_URL?.trim()

// Production modules (event bus, workflow engine, cache, locks) all run on
// Redis so that a server deployment and a worker deployment share events
// and state. Without REDIS_URL (local dev) Medusa falls back to the in-memory
// defaults, so npm run dev works with no extra services.
const redisModules = redisUrl
  ? [
      {
        resolve: '@medusajs/medusa/event-bus-redis',
        options: { redisUrl },
      },
      {
        resolve: '@medusajs/medusa/workflow-engine-redis',
        options: {
          redis: { redisUrl },
        },
      },
      {
        resolve: '@medusajs/medusa/caching',
        options: {
          providers: [
            {
              resolve: '@medusajs/caching-redis',
              id: 'caching-redis',
              is_default: true,
              options: { redisUrl },
            },
          ],
        },
      },
      {
        resolve: '@medusajs/medusa/locking',
        options: {
          providers: [
            {
              resolve: '@medusajs/medusa/locking-redis',
              id: 'locking-redis',
              is_default: true,
              options: { redisUrl },
            },
          ],
        },
      },
    ]
  : []

// Register Stripe only when a server-side secret key is configured. The same
// configuration is loaded by the API server and background worker so payment
// workflows and webhook events use one provider definition.
const stripeModules = stripeApiKey
  ? [
      {
        resolve: '@medusajs/medusa/payment',
        options: {
          providers: [
            {
              resolve: '@medusajs/medusa/payment-stripe',
              id: 'stripe',
              options: {
                apiKey: stripeApiKey,
                webhookSecret: stripeWebhookSecret,
                capture: false,
                automatic_payment_methods: true,
              },
            },
          ],
        },
      },
    ]
  : []

// Railway containers use ephemeral disks, so production product media must
// be stored outside the container. When all required variables are present,
// Medusa uploads files to the Purival Cloudflare R2 bucket.
const fileModules =
  s3Bucket && s3Endpoint && s3AccessKeyId && s3SecretAccessKey && s3FileUrl
    ? [
        {
          resolve: '@medusajs/medusa/file',
          options: {
            providers: [
              {
                resolve: '@medusajs/medusa/file-s3',
                id: 's3',
                options: {
                  bucket: s3Bucket,
                  endpoint: s3Endpoint,
                  access_key_id: s3AccessKeyId,
                  secret_access_key: s3SecretAccessKey,
                  region: process.env.S3_REGION?.trim() || 'auto',
                  prefix: process.env.S3_PREFIX?.trim() || 'products/',
                  file_url: s3FileUrl,
                  additional_client_config: { forcePathStyle: true },
                },
              },
            ],
          },
        },
      ]
    : []

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    redisUrl,
    workerMode: process.env.MEDUSA_WORKER_MODE as 'shared' | 'server' | 'worker',
    http: {
      // Defaults keep local dev and zero-config deploys working; set STORE_CORS
      // to your storefront origin(s) in production.
      storeCors: process.env.STORE_CORS || 'http://localhost:3000,http://localhost:8000',
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    },
  },
  admin: {
    // The worker never serves or builds the admin. DISABLE_MEDUSA_ADMIN wins
    // when set; otherwise it is derived from MEDUSA_WORKER_MODE.
    disable: process.env.DISABLE_MEDUSA_ADMIN
      ? process.env.DISABLE_MEDUSA_ADMIN === 'true'
      : process.env.MEDUSA_WORKER_MODE === 'worker',
    backendUrl: process.env.MEDUSA_BACKEND_URL || undefined,
  },
  modules: [...redisModules, ...stripeModules, ...fileModules],
})
