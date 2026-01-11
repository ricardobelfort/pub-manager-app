import { createClient } from "npm:@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";

type ApiOk = { sucesso: true; dados: any };
type ApiErr = { sucesso: false; erro: { codigo: string; mensagem: string; detalhes?: any } };
const ok = (dados: any): ApiOk => ({ sucesso: true, dados });
const erro = (codigo: string, mensagem: string, detalhes?: any): ApiErr => ({
  sucesso: false,
  erro: { codigo, mensagem, detalhes: detalhes ?? {} },
});
const json = (payload: any, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

function assertEmail(v: unknown) {
  if (typeof v !== "string") throw new Error("email inválido");
  const s = v.trim().toLowerCase();
  if (!s.includes("@") || s.length < 6) throw new Error("email inválido");
  return s;
}
function assertPapel(v: unknown) {
  const allowed = ["dono", "gerente", "garcom", "funcionario"];
  if (typeof v !== "string") throw new Error("papel inválido");
  const s = v.trim().toLowerCase();
  if (!allowed.includes(s)) throw new Error("papel inválido");
  return s;
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
    const sbAdmin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: perfil, error: errPerfil } = await sbAdmin
      .from("perfis")
      .select("id, inquilino_id, papel, ativo")
      .eq("id", userId)
      .single();

    if (errPerfil || !perfil?.inquilino_id) return json(erro("ONBOARDING_PENDENTE", "Usuário sem inquilino."), 403);
    if (!perfil.ativo) return json(erro("USUARIO_INATIVO", "Usuário inativo."), 403);
    if (!["dono", "gerente"].includes(perfil.papel)) {
      return json(erro("SEM_PERMISSAO", "Apenas dono/gerente pode convidar usuários."), 403);
    }

    const body = await req.json().catch(() => ({}));
    const email = assertEmail(body?.email);
    const papel = assertPapel(body?.papel ?? "funcionario");
    const dias = Number.isFinite(body?.dias_validade) ? Number(body?.dias_validade) : 7;
    const dias_validade = Math.max(1, Math.min(30, dias));

    const token = randomToken();
    const expira_em = new Date(Date.now() + dias_validade * 24 * 60 * 60 * 1000).toISOString();

    const { data: convite, error: errConv } = await sbAdmin
      .from("convites")
      .insert({
        inquilino_id: perfil.inquilino_id,
        email_convidado: email,
        papel,
        token,
        expira_em,
        criado_por: userId,
      })
      .select("id, email_convidado, papel, token, expira_em, criado_em")
      .single();

    if (errConv) return json(erro("DB_ERRO", "Falha ao criar convite.", { detalhe: errConv.message }), 500);

    await sbAdmin.from("eventos_auditoria").insert({
      inquilino_id: perfil.inquilino_id,
      tipo: "CONVITE_CRIADO",
      origem_tipo: "convite",
      origem_id: convite.id,
      dados: { email, papel, expira_em },
      criado_por: userId,
    });

    return json(ok({ convite }), 200);
  } catch (e) {
    return json(erro("ERRO_INESPERADO", "Erro inesperado.", { detalhe: String(e?.message ?? e) }), 500);
  }
});
