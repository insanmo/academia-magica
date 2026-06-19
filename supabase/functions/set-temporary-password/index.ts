import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function findAuthUserIdByEmail(serviceClient: ReturnType<typeof createClient>, email: string) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await serviceClient.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const user = data.users.find((item) => item.email?.toLowerCase() === email.toLowerCase());
    if (user?.id) return user.id;
    if (data.users.length < 1000) return null;
  }
  return null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) throw new Error("Sesion requerida.");

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serviceClient = createClient(url, serviceKey);
    const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!accessToken) throw new Error("Sesion requerida.");
    const { data: authData, error: authError } = await serviceClient.auth.getUser(accessToken);
    if (authError || !authData.user) throw new Error("Sesion invalida.");

    const { request_type, request_id, indra_email, temporary_password } = await request.json();
    if (!["account", "password"].includes(request_type) || !request_id || typeof temporary_password !== "string" || temporary_password.length < 8) {
      throw new Error("Solicitud o contrasena temporal invalida.");
    }
    const requestEmail = typeof indra_email === "string" ? indra_email.trim().toLowerCase() : "";

    const { data: actor, error: actorError } = await serviceClient
      .from("academy_users")
      .select("id, role, house_id, active")
      .eq("auth_user_id", authData.user.id)
      .single();
    if (actorError || !actor?.active || !["focal", "admin"].includes(actor.role)) {
      throw new Error("No autorizado.");
    }

    if (request_type === "password") {
      let { data: resetRequest, error: resetError } = await serviceClient
        .from("academy_password_reset_requests")
        .select("id, user_id, status")
        .eq("id", request_id)
        .maybeSingle();

      if ((!resetRequest || resetError) && requestEmail) {
        const { data: fallbackUser, error: fallbackUserError } = await serviceClient
          .from("academy_users")
          .select("id")
          .eq("indra_email", requestEmail)
          .maybeSingle();
        if (fallbackUserError) throw fallbackUserError;

        const fallback = fallbackUser?.id ? await serviceClient
          .from("academy_password_reset_requests")
          .select("id, user_id, status")
          .eq("status", "pending")
          .eq("user_id", fallbackUser.id)
          .order("requested_at", { ascending: false })
          .limit(1)
          .maybeSingle() : { data: null, error: null };
        resetRequest = fallback.data || null;
        resetError = fallback.error || null;
      }
      if (resetError || !resetRequest) throw new Error("La solicitud ya no esta disponible.");

      const { data: target, error: targetError } = await serviceClient
        .from("academy_users")
        .select("id, auth_user_id, indra_email, house_id, role, active")
        .eq("id", resetRequest.user_id)
        .maybeSingle();
      if (targetError) throw targetError;
      if (!target?.active) throw new Error("La cuenta no esta disponible.");
      if (actor.role === "focal" && actor.house_id !== target.house_id) throw new Error("Un focal solo puede recuperar cuentas de su casa.");
      if (actor.role === "focal" && target.role !== "student") throw new Error("Solo un administrador puede recuperar cuentas del equipo administrativo.");

      let authUserId = target.auth_user_id;
      if (!authUserId) {
        authUserId = await findAuthUserIdByEmail(serviceClient, target.indra_email);
        if (!authUserId) throw new Error("La cuenta no tiene usuario de autenticacion asociado.");
        const { error: linkError } = await serviceClient
          .from("academy_users")
          .update({ auth_user_id: authUserId, updated_at: new Date().toISOString() })
          .eq("id", target.id);
        if (linkError) throw linkError;
      }

      const { error: passwordError } = await serviceClient.auth.admin.updateUserById(authUserId, { password: temporary_password });
      if (passwordError) throw passwordError;
      const { error: profileError } = await serviceClient
        .from("academy_users")
        .update({
          must_change_password: true,
          admission_letter_seen: target.role === "student" ? false : target.admission_letter_seen,
          updated_at: new Date().toISOString(),
        })
        .eq("id", resetRequest.user_id);
      if (profileError) throw profileError;
      const { error: requestError } = await serviceClient
        .from("academy_password_reset_requests")
        .update({ status: "completed", resolved_by: actor.id, resolved_at: new Date().toISOString() })
        .eq("id", resetRequest.id)
        .neq("status", "completed");
      if (requestError) throw requestError;
    } else {
      let { data: accountRequest, error: accountError } = await serviceClient
        .from("academy_account_requests")
        .select("id, full_name, indra_email, house_id, status")
        .eq("id", request_id)
        .maybeSingle();

      if ((!accountRequest || accountError || accountRequest.status !== "pending") && requestEmail) {
        const fallback = await serviceClient
          .from("academy_account_requests")
          .select("id, full_name, indra_email, house_id, status")
          .eq("status", "pending")
          .eq("indra_email", requestEmail)
          .order("requested_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        accountRequest = fallback.data;
        accountError = fallback.error;
      }
      if (accountError || !accountRequest || accountRequest.status !== "pending") throw new Error("La solicitud ya no esta disponible.");
      if (actor.role === "focal" && actor.house_id !== accountRequest.house_id) throw new Error("Un focal solo puede aprobar cuentas de su casa.");

      const { data: existingProfile, error: profileReadError } = await serviceClient
        .from("academy_users")
        .select("id, role, active, auth_user_id")
        .eq("indra_email", accountRequest.indra_email)
        .maybeSingle();
      if (profileReadError) throw profileReadError;
      if (existingProfile && !existingProfile.active) throw new Error("Esta cuenta fue deshabilitada.");
      if (existingProfile?.auth_user_id) throw new Error("La cuenta ya existe.");

      const { data: authCreated, error: createError } = await serviceClient.auth.admin.createUser({
        email: accountRequest.indra_email,
        password: temporary_password,
        email_confirm: true,
      });
      if (createError || !authCreated.user) throw createError || new Error("No se pudo crear la cuenta.");

      const isStaffProfile = existingProfile && ["focal", "admin"].includes(existingProfile.role);
      const { error: profileError } = existingProfile
        ? await serviceClient.from("academy_users").update({
            auth_user_id: authCreated.user.id,
            must_change_password: true,
            ...(existingProfile.role === "student" ? { admission_letter_seen: false } : {}),
            ...(isStaffProfile ? {} : { full_name: accountRequest.full_name, house_id: accountRequest.house_id }),
            updated_at: new Date().toISOString(),
          }).eq("id", existingProfile.id)
        : await serviceClient.from("academy_users").insert({
            auth_user_id: authCreated.user.id,
            full_name: accountRequest.full_name,
            indra_email: accountRequest.indra_email,
            role: "student",
            house_id: accountRequest.house_id,
            admission_letter_seen: false,
            must_change_password: true,
          });
      if (profileError) {
        await serviceClient.auth.admin.deleteUser(authCreated.user.id);
        throw profileError;
      }
      const { error: requestError } = await serviceClient
        .from("academy_account_requests")
        .update({ status: "completed", resolved_by: actor.id, resolved_at: new Date().toISOString() })
        .eq("id", accountRequest.id);
      if (requestError) throw requestError;
    }

    return jsonResponse({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ ok: false, error: message });
  }
});
