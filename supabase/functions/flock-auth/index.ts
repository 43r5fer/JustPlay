import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ITERATIONS = 310_000;
const encoder = new TextEncoder();
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-flock-session",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};
type Body = { action?: string; username?: string; password?: string; newPassword?: string; remember?: boolean; displayName?: string; };

function response(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}
function normalizeUsername(value: unknown) { return String(value ?? "").trim().toLowerCase(); }
function getSessionToken(req: Request) { return String(req.headers.get("x-flock-session") ?? "").trim().toLowerCase(); }
function randomBytes(length: number) { const result = new Uint8Array(length); crypto.getRandomValues(result); return result; }
function toHex(value: Uint8Array) { return Array.from(value, byte => byte.toString(16).padStart(2, "0")).join(""); }
function fromHex(value: string) {
  if (!/^(?:[a-f0-9]{2})+$/.test(value)) throw new Error("Invalid cryptographic value.");
  const output = new Uint8Array(value.length / 2);
  for (let i = 0; i < output.length; i++) output[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return output;
}
async function sha256Hex(value: string) { return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))); }
async function derivePassword(password: string, saltHex: string, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations }, key, 256);
  return toHex(new Uint8Array(derived));
}
function timingSafeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let i = 0; i < length; i++) difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return difference === 0;
}
function getClientIp(req: Request) {
  return String(req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown").slice(0, 100);
}
async function takeLimit(label: string, key: string, limit: number, windowSeconds: number) {
  const bucketKey = await sha256Hex(label + "\n" + key);
  const { data, error } = await admin.rpc("flock_auth_take_attempt", {
    p_bucket_key: bucketKey, p_limit: limit, p_window_seconds: windowSeconds,
  });
  if (error) {
    console.error("[flock-auth] Rate limiter failed:", error.message);
    throw new Error("Account service is temporarily unavailable. Please try again.");
  }
  return data === true;
}
function validateCredentials(username: string, password: string) {
  if (!/^[a-z0-9_.-]{3,24}$/.test(username)) throw new Error("Username must be 3–24 characters: letters, numbers, dots, underscores or hyphens.");
  if (password.length < 8 || password.length > 128) throw new Error("Password must be 8–128 characters long.");
}
function publicUser(profile: Record<string, unknown>) {
  return { id: profile.id, username: profile.username, display_name: profile.display_name, friend_code: profile.friend_code };
}
async function createSession(userId: string, remember: boolean) {
  const token = toHex(randomBytes(32));
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + (remember ? 30 : 1) * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await admin.from("flock_auth_sessions").insert({ user_id: userId, token_hash: tokenHash, remembered: remember, expires_at: expiresAt });
  if (error) throw new Error("Flock could not start a secure session. Please try again.");
  return { token, expiresAt };
}
async function lookupSession(req: Request) {
  const token = getSessionToken(req);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const { data: session, error } = await admin.from("flock_auth_sessions").select("id,user_id,remembered,expires_at")
    .eq("token_hash", tokenHash).is("revoked_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (error || !session) return null;
  return { token, tokenHash, session };
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return response(405, { error: "Use POST for Flock account actions." });
  if (!SUPABASE_URL || !SERVICE_KEY) return response(503, { error: "Flock account service is not configured." });
  let body: Body;
  try { body = await req.json() as Body; }
  catch { return response(400, { error: "Invalid request body." }); }
  const action = String(body.action ?? "");
  const ip = getClientIp(req);
  try {
    if (action === "register") {
      const username = normalizeUsername(body.username);
      const password = String(body.password ?? "");
      const displayName = String(body.displayName ?? username).trim().slice(0, 80) || username;
      const remember = body.remember !== false;
      validateCredentials(username, password);
      if (!(await takeLimit("register-ip", ip, 6, 3600))) return response(429, { error: "Too many account attempts from this network. Try again in an hour." });
      if (!(await takeLimit("register-username", username, 4, 3600))) return response(429, { error: "Too many attempts for this username. Try again later." });
      const { data: existing, error: lookupError } = await admin.from("flock_credentials").select("user_id").eq("username", username).maybeSingle();
      if (lookupError) throw new Error("Could not check username availability.");
      if (existing) return response(409, { error: "That username is already taken." });
      let profile: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const digits = Number.parseInt(toHex(randomBytes(8)).slice(0, 12), 16) % 10_000_000_000;
        const friendCode = String(digits).padStart(10, "0");
        const { data, error } = await admin.from("flock_profiles")
          .insert({ username, display_name: displayName, friend_code: friendCode, bio: "" })
          .select("id,username,display_name,friend_code").single();
        if (!error && data) { profile = data as Record<string, unknown>; break; }
        if (error && !String(error.code).startsWith("23")) {
          console.error("[flock-auth] Profile creation failed:", error.message);
          throw new Error("Could not create the Flock profile. Please try again.");
        }
      }
      if (!profile) throw new Error("Could not allocate a friend code. Please try again.");
      const salt = toHex(randomBytes(16));
      const passwordHash = await derivePassword(password, salt);
      const { error: credentialError } = await admin.from("flock_credentials").insert({
        user_id: profile.id, username, password_salt: salt, password_hash: passwordHash, password_iterations: ITERATIONS,
      });
      if (credentialError) {
        await admin.from("flock_profiles").delete().eq("id", profile.id);
        if (credentialError.code === "23505") return response(409, { error: "That username is already taken." });
        console.error("[flock-auth] Credential creation failed:", credentialError.message);
        throw new Error("Could not finish creating your account. Please try again.");
      }
      const session = await createSession(String(profile.id), remember);
      return response(201, { sessionToken: session.token, expiresAt: session.expiresAt, remember, user: publicUser(profile) });
    }
    if (action === "login") {
      const username = normalizeUsername(body.username);
      const password = String(body.password ?? "");
      if (!/^[a-z0-9_.-]{3,24}$/.test(username) || password.length > 128 || password.length === 0) return response(400, { error: "Enter your username and password." });
      if (!(await takeLimit("login-ip-user", ip + "\n" + username, 8, 900))) return response(429, { error: "Too many sign-in attempts. Wait 15 minutes and try again." });
      const { data: credential, error: credError } = await admin.from("flock_credentials")
        .select("user_id,username,password_salt,password_hash,password_iterations").eq("username", username).maybeSingle();
      const candidate = await derivePassword(password, credential?.password_salt || "00000000000000000000000000000000", credential?.password_iterations || ITERATIONS);
      if (credError || !credential || !timingSafeEqual(candidate, credential.password_hash)) return response(401, { error: "That username or password is incorrect." });
      const { data: profile, error: profileError } = await admin.from("flock_profiles")
        .select("id,username,display_name,friend_code").eq("id", credential.user_id).single();
      if (profileError || !profile) return response(401, { error: "This Flock account is unavailable." });
      await admin.from("flock_credentials").update({ last_login_at: new Date().toISOString() }).eq("user_id", credential.user_id);
      const remember = body.remember !== false;
      const session = await createSession(String(credential.user_id), remember);
      return response(200, { sessionToken: session.token, expiresAt: session.expiresAt, remember, user: publicUser(profile) });
    }
    if (action === "session") {
      const current = await lookupSession(req);
      if (!current) return response(401, { error: "Your Flock session expired. Please sign in again." });
      const { data: profile, error } = await admin.from("flock_profiles").select("id,username,display_name,friend_code").eq("id", current.session.user_id).maybeSingle();
      if (error || !profile) return response(401, { error: "This Flock account could not be found." });
      await admin.from("flock_auth_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", current.session.id);
      return response(200, { remember: current.session.remembered, expiresAt: current.session.expires_at, user: publicUser(profile) });
    }
    if (action === "logout") {
      const current = await lookupSession(req);
      if (current) await admin.from("flock_auth_sessions").update({ revoked_at: new Date().toISOString() }).eq("id", current.session.id);
      return response(200, { ok: true });
    }
    if (action === "change-password") {
      const current = await lookupSession(req);
      if (!current) return response(401, { error: "Your Flock session expired. Please sign in again." });
      if (!(await takeLimit("password-change", ip + "\n" + current.session.user_id, 5, 900))) {
        return response(429, { error: "Too many password-change attempts. Wait 15 minutes and try again." });
      }
      const oldPassword = String(body.password ?? "");
      const newPassword = String(body.newPassword ?? "");
      if (newPassword.length < 8 || newPassword.length > 128) return response(400, { error: "New password must be 8–128 characters long." });
      const { data: credential, error } = await admin.from("flock_credentials")
        .select("user_id,password_salt,password_hash,password_iterations").eq("user_id", current.session.user_id).single();
      if (error || !credential) return response(401, { error: "Could not verify this account." });
      const candidate = await derivePassword(oldPassword, credential.password_salt, credential.password_iterations);
      if (!timingSafeEqual(candidate, credential.password_hash)) return response(401, { error: "Your current password is incorrect." });
      const salt = toHex(randomBytes(16));
      const hash = await derivePassword(newPassword, salt);
      const { error: updateError } = await admin.from("flock_credentials").update({
        password_salt: salt, password_hash: hash, password_iterations: ITERATIONS, updated_at: new Date().toISOString(),
      }).eq("user_id", current.session.user_id);
      if (updateError) throw new Error("Could not update password.");
      await admin.from("flock_auth_sessions").update({ revoked_at: new Date().toISOString() }).eq("user_id", current.session.user_id).neq("id", current.session.id);
      return response(200, { ok: true });
    }
    return response(400, { error: "Unknown Flock account action." });
  } catch (error) {
    console.error("[flock-auth]", error instanceof Error ? error.message : "Unknown error");
    return response(500, { error: error instanceof Error ? error.message : "Flock account service error." });
  }
});
