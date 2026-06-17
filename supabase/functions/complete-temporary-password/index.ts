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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) throw new Error("Sesion requerida.");

    const { new_password } = await request.json();
    if (typeof new_password !== "string" || new_password.length < 8) {
      throw new Error("Contrasena invalida.");
    }

    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
    const serviceClient = createClient(url, serviceKey);

    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user?.id) throw new Error("Sesion invalida.");

    const { data: profile, error: profileError } = await serviceClient
      .from("academy_users")
      .select("id, active, must_change_password")
      .eq("auth_user_id", authData.user.id)
      .single();
    if (profileError || !profile?.active) {
      throw new Error("La cuenta no esta disponible.");
    }

    const { error: passwordError } = await serviceClient.auth.admin.updateUserById(authData.user.id, {
      password: new_password,
    });
    if (passwordError) throw passwordError;

    if (profile.must_change_password) {
      const { error: completionError } = await serviceClient
        .from("academy_users")
        .update({ must_change_password: false, updated_at: new Date().toISOString() })
        .eq("id", profile.id);
      if (completionError) throw completionError;
    }

    return jsonResponse({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ ok: false, error: message });
  }
});
