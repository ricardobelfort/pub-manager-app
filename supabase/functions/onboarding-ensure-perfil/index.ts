import { createClient } from "npm:@supabase/supabase-js@2";

type ApiOk = { sucesso: true; dados: any };
type ApiErr = { sucesso: false; erro: { codigo: string; mensagem: string; detalhes?: any } };
const ok = (dados: any): ApiOk => ({ sucesso: true, dados });
const erro = (codigo: string, mensagem: string, detalhes?: any): ApiErr => ({
  sucesso: false,
  erro: { codigo, mensagem, detalhes: detalhes ?? {} },
});
const json = (payload: any, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json(erro("METODO_INVALIDO", "Use POST."), 405);

    const supabaseUrl = Deno.env.get("APP_SUPABASE_URL");
    const serviceKey = Deno.env.get("APP_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) return json(erro("CONFIG_SERVIDOR", "Secrets não configuradas."), 500);

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json(erro("NAO_AUTENTICADO", "Envie Bearer token."), 401);
    const userToken = authHeader.substring("Bearer ".length);

    const sbUser = createClient(supabaseUrl, serviceKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
      auth: { persistSession: false },
    });

    const { data: authData, error: authErr } = await sbUser.auth.getUser();
    if (authErr || !authData?.user) return json(erro("NAO_AUTENTICADO", "Token inválido."), 401);

    const userId = authData.user.id;
    const userEmail = authData.user.email ?? null;

    const body = await req.json().catch(() => ({}));
    const nome_completo =
      typeof body?.nome_completo === "string" && body.nome_completo.trim().length >= 3 ? body.nome_completo.trim() : null;

    const sbAdmin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const upsertData: any = { id: userId, email: userEmail, ativo: true };
    if (nome_completo) upsertData.nome_completo = nome_completo;

    const { error: errUp } = await sbAdmin.from("perfis").upsert(upsertData);
    if (errUp) return json(erro("DB_ERRO", "Falha ao preparar perfil.", { detalhe: errUp.message }), 500);

    const { data: perfil, error: errSel } = await sbAdmin
      .from("perfis")
      .select("id, email, nome_completo, inquilino_id, papel, ativo")
      .eq("id", userId)
      .single();

    if (errSel) return json(erro("DB_ERRO", "Falha ao ler perfil.", { detalhe: errSel.message }), 500);

    const onboarding_pendente = !perfil?.inquilino_id;

    return json(ok({ perfil, onboarding_pendente }), 200);
  } catch (e) {
    return json(erro("ERRO_INESPERADO", "Erro inesperado.", { detalhe: String(e?.message ?? e) }), 500);
  }
});
