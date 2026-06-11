import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) throw new Error("Sesión requerida.");

    const { current_password, new_password } = await request.json();
    if (typeof current_password !== "string" || typeof new_password !== "string" || new_password.length < 8) {
      throw new Error("Contraseñas inválidas.");
    }
    if (current_password === new_password) throw new Error("La nueva contraseña debe ser diferente.");

    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
    const verifierClient = createClient(url, anonKey);
    const serviceClient = createClient(url, serviceKey);

    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user?.email) throw new Error("Sesión inválida.");

    const { data: profile, error: profileError } = await serviceClient
      .from("academy_users")
      .select("id, active, must_change_password")
      .eq("auth_user_id", authData.user.id)
      .single();
    if (profileError || !profile?.active || !profile.must_change_password) {
      throw new Error("El cambio de contraseña temporal no está pendiente.");
    }

    const { error: verificationError } = await verifierClient.auth.signInWithPassword({
      email: authData.user.email,
      password: current_password,
    });
    if (verificationError) throw new Error("La contraseña temporal no es válida.");

    const { error: passwordError } = await serviceClient.auth.admin.updateUserById(authData.user.id, {
      password: new_password,
    });
    if (passwordError) throw passwordError;

    const { error: completionError } = await serviceClient
      .from("academy_users")
      .update({ must_change_password: false, updated_at: new Date().toISOString() })
      .eq("id", profile.id);
    if (completionError) throw completionError;

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
