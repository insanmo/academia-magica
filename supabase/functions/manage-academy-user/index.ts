import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALLOWED_DOMAIN = "indracompany.com";
const ROLES = new Set(["student", "focal", "admin"]);

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value: unknown) {
  return String(value || "").trim();
}

function validateEmail(email: string) {
  if (!email.endsWith(`@${ALLOWED_DOMAIN}`) || !/^[^@]+@[^@]+$/.test(email)) {
    throw new Error("Correo Indra invalido.");
  }
}

function validateUserInput(input: Record<string, unknown>) {
  const fullName = normalizeText(input.full_name);
  const indraEmail = normalizeEmail(input.indra_email);
  const role = normalizeText(input.role || "student").toLowerCase();
  const houseId = normalizeText(input.house_id);
  if (fullName.length < 3 || fullName.length > 120) throw new Error("Nombre invalido.");
  validateEmail(indraEmail);
  if (!ROLES.has(role)) throw new Error("Rol invalido.");
  if (role !== "admin" && !houseId) throw new Error("La casa es obligatoria para participantes y focals.");
  return { fullName, indraEmail, role, houseId: houseId || null };
}

async function findAuthUserIdByEmail(serviceClient: ReturnType<typeof createClient>, email: string) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await serviceClient.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const user = data.users.find((item) => item.email?.toLowerCase() === email);
    if (user?.id) return user.id;
    if (data.users.length < 1000) return null;
  }
  return null;
}

async function ensureHouse(serviceClient: ReturnType<typeof createClient>, houseId: string | null) {
  if (!houseId) return;
  const { data, error } = await serviceClient.from("academy_houses").select("id").eq("id", houseId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Casa invalida.");
}

async function requireAdmin(request: Request) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) throw new Error("Sesion requerida.");

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const serviceClient = createClient(url, serviceKey);

  const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!accessToken) throw new Error("Sesion requerida.");
  const { data: authData, error: authError } = await serviceClient.auth.getUser(accessToken);
  if (authError || !authData.user) throw new Error("Sesion invalida.");

  const { data: actor, error: actorError } = await serviceClient
    .from("academy_users")
    .select("id, role, active")
    .eq("auth_user_id", authData.user.id)
    .maybeSingle();
  if (actorError) throw actorError;
  if (!actor?.active || actor.role !== "admin") throw new Error("Solo el administrador puede mantener usuarios.");

  return { serviceClient, actor, authUserId: authData.user.id };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { serviceClient, actor, authUserId } = await requireAdmin(request);
    const payload = await request.json();
    const action = normalizeText(payload.action);

    if (action === "list") {
      const { data, error } = await serviceClient
        .from("academy_users")
        .select("id, auth_user_id, full_name, indra_email, role, house_id, admission_letter_seen, active, must_change_password, created_at, updated_at, house:academy_houses(id, name, code, icon)")
        .order("full_name");
      if (error) throw error;
      return jsonResponse({ ok: true, users: data || [] });
    }

    if (action === "create") {
      const input = validateUserInput(payload.user || {});
      await ensureHouse(serviceClient, input.houseId);
      const temporaryPassword = normalizeText(payload.temporary_password);

      const { data: existingProfile, error: existingError } = await serviceClient
        .from("academy_users")
        .select("id")
        .eq("indra_email", input.indraEmail)
        .maybeSingle();
      if (existingError) throw existingError;
      if (existingProfile) throw new Error("Ya existe un usuario con ese correo.");

      let authUserIdForProfile = await findAuthUserIdByEmail(serviceClient, input.indraEmail);
      if (temporaryPassword) {
        if (temporaryPassword.length < 8) throw new Error("La contrasena temporal debe tener al menos 8 caracteres.");
        if (authUserIdForProfile) {
          const { error } = await serviceClient.auth.admin.updateUserById(authUserIdForProfile, {
            password: temporaryPassword,
            email: input.indraEmail,
            email_confirm: true,
          });
          if (error) throw error;
        } else {
          const { data: created, error } = await serviceClient.auth.admin.createUser({
            email: input.indraEmail,
            password: temporaryPassword,
            email_confirm: true,
          });
          if (error || !created.user) throw error || new Error("No se pudo crear Auth.");
          authUserIdForProfile = created.user.id;
        }
      }

      const { error: insertError } = await serviceClient.from("academy_users").insert({
        auth_user_id: authUserIdForProfile,
        full_name: input.fullName,
        indra_email: input.indraEmail,
        role: input.role,
        house_id: input.houseId,
        active: payload.active !== false,
        admission_letter_seen: false,
        must_change_password: Boolean(authUserIdForProfile),
      });
      if (insertError) throw insertError;
      return jsonResponse({ ok: true });
    }

    const userId = normalizeText(payload.user_id);
    if (!userId) throw new Error("Usuario requerido.");
    const { data: target, error: targetError } = await serviceClient
      .from("academy_users")
      .select("*")
      .eq("id", userId)
      .maybeSingle();
    if (targetError) throw targetError;
    if (!target) throw new Error("Usuario no encontrado.");

    if (action === "update") {
      const input = validateUserInput(payload.user || {});
      await ensureHouse(serviceClient, input.houseId);

      if (input.indraEmail !== target.indra_email) {
        const { data: duplicate, error: duplicateError } = await serviceClient
          .from("academy_users")
          .select("id")
          .eq("indra_email", input.indraEmail)
          .neq("id", target.id)
          .maybeSingle();
        if (duplicateError) throw duplicateError;
        if (duplicate) throw new Error("Ya existe otro usuario con ese correo.");
        if (target.auth_user_id) {
          const { error } = await serviceClient.auth.admin.updateUserById(target.auth_user_id, {
            email: input.indraEmail,
            email_confirm: true,
          });
          if (error) throw error;
        }
      }

      const { error: updateError } = await serviceClient
        .from("academy_users")
        .update({
          full_name: input.fullName,
          indra_email: input.indraEmail,
          role: input.role,
          house_id: input.houseId,
          active: payload.active !== false,
          admission_letter_seen: payload.admission_letter_seen === true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", target.id);
      if (updateError) throw updateError;
      return jsonResponse({ ok: true });
    }

    if (action === "set_password") {
      const temporaryPassword = normalizeText(payload.temporary_password);
      if (temporaryPassword.length < 8) throw new Error("La contrasena temporal debe tener al menos 8 caracteres.");
      let targetAuthId = target.auth_user_id as string | null;
      if (!targetAuthId) targetAuthId = await findAuthUserIdByEmail(serviceClient, target.indra_email);
      if (targetAuthId) {
        const { error } = await serviceClient.auth.admin.updateUserById(targetAuthId, {
          password: temporaryPassword,
          email_confirm: true,
        });
        if (error) throw error;
      } else {
        const { data: created, error } = await serviceClient.auth.admin.createUser({
          email: target.indra_email,
          password: temporaryPassword,
          email_confirm: true,
        });
        if (error || !created.user) throw error || new Error("No se pudo crear Auth.");
        targetAuthId = created.user.id;
      }
      const { error: updateError } = await serviceClient
        .from("academy_users")
        .update({
          auth_user_id: targetAuthId,
          active: true,
          must_change_password: true,
          admission_letter_seen: target.role === "student" ? false : target.admission_letter_seen,
          updated_at: new Date().toISOString(),
        })
        .eq("id", target.id);
      if (updateError) throw updateError;
      return jsonResponse({ ok: true });
    }

    if (action === "disable") {
      if (target.auth_user_id === authUserId || target.id === actor.id) throw new Error("No puedes deshabilitar tu propia cuenta.");
      const { error } = await serviceClient
        .from("academy_users")
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq("id", target.id);
      if (error) throw error;
      return jsonResponse({ ok: true });
    }

    if (action === "delete") {
      if (target.auth_user_id === authUserId || target.id === actor.id) throw new Error("No puedes eliminar tu propia cuenta.");
      if (target.auth_user_id) {
        const { error } = await serviceClient.auth.admin.deleteUser(target.auth_user_id);
        if (error) throw error;
      }
      const { error } = await serviceClient.from("academy_users").delete().eq("id", target.id);
      if (error) throw error;
      return jsonResponse({ ok: true });
    }

    throw new Error("Accion invalida.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ ok: false, error: message });
  }
});
