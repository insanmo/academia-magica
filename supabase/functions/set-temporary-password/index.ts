import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) throw new Error("Sesión requerida.");

    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const serviceClient = createClient(url, serviceKey);
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) throw new Error("Sesión inválida.");

    const { request_type, request_id, temporary_password } = await request.json();
    if (!["account", "password"].includes(request_type) || !request_id || typeof temporary_password !== "string" || temporary_password.length < 8) {
      throw new Error("Solicitud o contraseña temporal inválida.");
    }

    const { data: actor, error: actorError } = await serviceClient
      .from("academy_users")
      .select("id, role, house_id, active")
      .eq("auth_user_id", authData.user.id)
      .single();
    if (actorError || !actor?.active || !["focal", "admin"].includes(actor.role)) {
      throw new Error("No autorizado.");
    }

    if (request_type === "password") {
      const { data: resetRequest, error: resetError } = await serviceClient
        .from("academy_password_reset_requests")
        .select("id, user_id, status, user:academy_users!inner(auth_user_id, house_id, role, active)")
        .eq("id", request_id)
        .single();
      if (resetError || !resetRequest || resetRequest.status !== "pending") throw new Error("La solicitud ya no está disponible.");

      const target = Array.isArray(resetRequest.user) ? resetRequest.user[0] : resetRequest.user;
      if (!target?.auth_user_id || !target.active) throw new Error("La cuenta no está disponible.");
      if (actor.role === "focal" && actor.house_id !== target.house_id) throw new Error("Un focal solo puede recuperar cuentas de su casa.");
      if (actor.role === "focal" && target.role !== "student") throw new Error("Solo un administrador puede recuperar cuentas del equipo administrativo.");

      const { error: passwordError } = await serviceClient.auth.admin.updateUserById(target.auth_user_id, { password: temporary_password });
      if (passwordError) throw passwordError;
      const { error: profileError } = await serviceClient.from("academy_users")
        .update({ must_change_password: true, updated_at: new Date().toISOString() }).eq("id", resetRequest.user_id);
      if (profileError) throw profileError;
      const { error: requestError } = await serviceClient.from("academy_password_reset_requests")
        .update({ status: "completed", resolved_by: actor.id, resolved_at: new Date().toISOString() }).eq("id", resetRequest.id);
      if (requestError) throw requestError;
    } else {
      const { data: accountRequest, error: accountError } = await serviceClient
        .from("academy_account_requests")
        .select("id, full_name, indra_email, house_id, status")
        .eq("id", request_id)
        .single();
      if (accountError || !accountRequest || accountRequest.status !== "pending") throw new Error("La solicitud ya no está disponible.");
      if (actor.role === "focal" && actor.house_id !== accountRequest.house_id) throw new Error("Un focal solo puede aprobar cuentas de su casa.");

      const { data: existingProfile, error: profileReadError } = await serviceClient.from("academy_users")
        .select("id, role, active, auth_user_id").eq("indra_email", accountRequest.indra_email).maybeSingle();
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
            ...(isStaffProfile ? {} : { full_name: accountRequest.full_name, house_id: accountRequest.house_id }),
            updated_at: new Date().toISOString(),
          }).eq("id", existingProfile.id)
        : await serviceClient.from("academy_users").insert({
            auth_user_id: authCreated.user.id,
            full_name: accountRequest.full_name,
            indra_email: accountRequest.indra_email,
            role: "student",
            house_id: accountRequest.house_id,
            must_change_password: true,
          });
      if (profileError) {
        await serviceClient.auth.admin.deleteUser(authCreated.user.id);
        throw profileError;
      }
      const { error: requestError } = await serviceClient.from("academy_account_requests")
        .update({ status: "completed", resolved_by: actor.id, resolved_at: new Date().toISOString() }).eq("id", accountRequest.id);
      if (requestError) throw requestError;
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
