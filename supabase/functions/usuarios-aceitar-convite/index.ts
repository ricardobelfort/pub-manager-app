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
    const userEmail = authData.user.email?.toLowerCase() ?? null;

    const body = await req.json().catch(() => ({}));
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token || token.length < 20) return json(erro("DADOS_INVALIDOS", "Token inválido."), 400);

    const sbAdmin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: convite, error: errConv } = await sbAdmin
      .from("convites")
      .select("*")
      .eq("token", token)
      .single();

    if (errConv || !convite) return json(erro("CONVITE_INVALIDO", "Convite não encontrado."), 404);
    if (convite.aceito_em) return json(erro("CONVITE_USADO", "Este convite já foi utilizado."), 409);
    if (new Date(convite.expira_em).getTime() < Date.now()) return json(erro("CONVITE_EXPIRADO", "Este convite expirou."), 410);

    if (userEmail && convite.email_convidado?.toLowerCase() !== userEmail) {
      return json(
        erro("EMAIL_DIFERENTE", "Este convite é para outro email.", {
          email_convite: convite.email_convidado,
          email_logado: userEmail,
        }),
        403,
      );
    }

    const { error: errPerfil } = await sbAdmin.from("perfis").upsert({
      id: userId,
      inquilino_id: convite.inquilino_id,
      email: userEmail,
      papel: convite.papel,
      ativo: true,
    });
    if (errPerfil) return json(erro("DB_ERRO", "Falha ao vincular perfil.", { detalhe: errPerfil.message }), 500);

    const { error: errUpd } = await sbAdmin.from("convites").update({ aceito_em: new Date().toISOString() }).eq("id", convite.id);
    if (errUpd) return json(erro("DB_ERRO", "Falha ao finalizar convite.", { detalhe: errUpd.message }), 500);

    if (convite.papel === "garcom") {
      const { data: existente } = await sbAdmin
        .from("recebedores_gorjeta")
        .select("id")
        .eq("inquilino_id", convite.inquilino_id)
        .eq("perfil_id", userId)
        .maybeSingle();

      if (!existente?.id) {
        await sbAdmin.from("recebedores_gorjeta").insert({
          inquilino_id: convite.inquilino_id,
          tipo: "pessoa",
          nome: userEmail ?? "Garçom",
          perfil_id: userId,
          ativo: true,
        });
      }
    }

    await sbAdmin.from("eventos_auditoria").insert({
      inquilino_id: convite.inquilino_id,
      tipo: "CONVITE_ACEITO",
      origem_tipo: "convite",
      origem_id: convite.id,
      dados: { papel: convite.papel, email: userEmail },
      criado_por: userId,
    });

    return json(ok({ inquilino_id: convite.inquilino_id, papel: convite.papel }), 200);
  } catch (e) {
    return json(erro("ERRO_INESPERADO", "Erro inesperado.", { detalhe: String(e?.message ?? e) }), 500);
  }
});
