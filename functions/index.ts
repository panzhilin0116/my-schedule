// Function 入口：只做装配，业务逻辑全在 handler.mjs（可被 node 直接测试）。
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { serveSite } from "./adapter.mjs";
import { handleApp } from "./handler.mjs";

Deno.serve(serveSite(handleApp, {
  createClient,
  env: (name: string) => Deno.env.get(name),
}));
