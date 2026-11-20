import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20261120000000 extends Migration {
  async up() {
    this.addSql(`
      create table if not exists "luqra_attempt" (
        "id" text primary key,
        "cart_id" text not null unique,
        "amount" text not null,
        "transaction_id" text unique,
        "state" text not null default 'pending' check ("state" in ('pending', 'declined', 'paid', 'review')),
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null
      );
    `)
  }
}
