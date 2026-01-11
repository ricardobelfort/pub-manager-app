import { createClient } from "npm:@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";

type ApiOk = { sucesso: true; dados: any };
type ApiErr = { sucesso: false; erro: { codigo: string; mensagem: string; detalhes?: any } };

function ok(dados: any): ApiOk {
  return { sucesso: true, dados };
}
function erro(codigo: string, mensagem: string, detalhes?: any): ApiErr {
  return { sucesso: false, erro: { codigo, mensagem, detalhes: detalhes ?? {} } };
}
function json(payload: any, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function assertString(val: unknown, field: string, minLen = 1): string {
  if (typeof val !== "string") throw new Error(`${field} inválido`);
  const s = val.trim();
  if (s.length < minLen) throw new Error(`${field} inválido`);
  return s;
}

const PERMISSOES_POR_PAPEL: Record<string, string[]> = {
  dono: [
    "COMANDA_CRIAR",
    "COMANDA_ADICIONAR_ITEM",
    "COMANDA_ADICIONAR_GORJETA",
    "COMANDA_FECHAR",
    "PAGAMENTO_REGISTRAR_BAR",
    "PAGAMENTO_REGISTRAR_LAVAJATO",
    "REPASSE_GORJETA",
    "ESTOQUE_AJUSTAR",
    "LAVAJATO_CRIAR_ORDEM",
    "LAVAJATO_ADICIONAR_ITEM",
    "LAVAJATO_FINALIZAR",
    "USUARIOS_GERIR",
    "CONFIG_GERIR",
  ],
  gerente: [
    "COMANDA_CRIAR",
    "COMANDA_ADICIONAR_ITEM",
    "COMANDA_ADICIONAR_GORJETA",
    "COMANDA_FECHAR",
    "PAGAMENTO_REGISTRAR_BAR",
    "PAGAMENTO_REGISTRAR_LAVAJATO",
    "REPASSE_GORJETA",
    "ESTOQUE_AJUSTAR",
    "LAVAJATO_CRIAR_ORDEM",
    "LAVAJATO_ADICIONAR_ITEM",
    "LAVAJATO_FINALIZAR",
    "USUARIOS_GERIR",
    "CONFIG_GERIR",
  ],
  garcom: [
    "COMANDA_CRIAR",
    "COMANDA_ADICIONAR_ITEM",
    "COMANDA_ADICIONAR_GORJETA",
    "COMANDA_FECHAR",
    "PAGAMENTO_REGISTRAR_BAR",
  ],
  funcionario: [
    "LAVAJATO_CRIAR_ORDEM",
    "LAVAJATO_ADICIONAR_ITEM",
    "LAVAJATO_FINALIZAR",
  ],
};

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json(erro("METODO_INVALIDO", "Use POST."), 405);

    const supabaseUrl = Deno.env.get("APP_SUPABASE_URL");
    const serviceKey = Deno.env.get("APP_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      return json(erro("CONFIG_SERVIDOR", "Secrets do servidor não configuradas."), 500);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json(erro("NAO_AUTENTICADO", "Envie Authorization: Bearer <token>."), 401);
    }
    const userToken = authHeader.substring("Bearer ".length);

    // Service role + header do usuário para identificar o auth.uid()
    const sbUser = createClient(supabaseUrl, serviceKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
      auth: { persistSession: false },
    });

    const { data: authData, error: authErr } = await sbUser.auth.getUser();
    if (authErr || !authData?.user) return json(erro("NAO_AUTENTICADO", "Token inválido ou expirado."), 401);

    const userId = authData.user.id;
    const userEmail = authData.user.email ?? null;

    const body = await req.json().catch(() => ({}));
    const nome_inquilino = assertString(body?.nome_inquilino, "nome_inquilino", 2);
    const slug = assertString(body?.slug, "slug", 2).toLowerCase();
    const nome_completo_dono = assertString(body?.nome_completo_dono, "nome_completo_dono", 3);

    const sbAdmin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // valida slug disponível
    const { data: existente, error: errExist } = await sbAdmin
      .from("inquilinos")
      .select("id, slug")
      .eq("slug", slug)
      .maybeSingle();

    if (errExist) return json(erro("DB_ERRO", "Falha ao verificar slug.", { detalhe: errExist.message }), 500);
    if (existente?.id) return json(erro("SLUG_INDISPONIVEL", "Este slug já está em uso.", { slug }), 409);

    // cria inquilino
    const { data: inq, error: errInq } = await sbAdmin
      .from("inquilinos")
      .insert({ nome: nome_inquilino, slug, status: "trial" })
      .select("id, nome, slug, status, criado_em")
      .single();

    if (errInq) return json(erro("DB_ERRO", "Falha ao criar inquilino.", { detalhe: errInq.message }), 500);

    const inquilino_id = inq.id;

    // configurações padrão (linha)
    const { error: errCfg } = await sbAdmin.from("configuracoes_inquilino").insert({ inquilino_id });
    if (errCfg) return json(erro("DB_ERRO", "Falha ao criar configurações.", { detalhe: errCfg.message }), 500);

    // caixas padrão
    const { data: caixas, error: errCaixas } = await sbAdmin
      .from("caixas")
      .insert([
        { inquilino_id, nome: "Caixa Bar", tipo: "bar" },
        { inquilino_id, nome: "Caixa Lavajato", tipo: "lavajato" },
      ])
      .select("id, tipo, nome");

    if (errCaixas) return json(erro("DB_ERRO", "Falha ao criar caixas.", { detalhe: errCaixas.message }), 500);

    // perfil do dono
    const { error: errPerfil } = await sbAdmin.from("perfis").upsert({
      id: userId,
      inquilino_id,
      email: userEmail,
      nome_completo: nome_completo_dono,
      papel: "dono",
      ativo: true,
    });
    if (errPerfil) return json(erro("DB_ERRO", "Falha ao vincular perfil do dono.", { detalhe: errPerfil.message }), 500);

    // pool do turno
    const { data: pool, error: errPool } = await sbAdmin
      .from("recebedores_gorjeta")
      .insert({ inquilino_id, tipo: "pool", nome: "Pool do Turno", perfil_id: null, ativo: true })
      .select("id, nome, tipo")
      .single();

    if (errPool) return json(erro("DB_ERRO", "Falha ao criar pool de gorjeta.", { detalhe: errPool.message }), 500);

    // permissões por papel (tenant)
    const rows: Array<{ inquilino_id: string; papel: string; permissao_chave: string; permitido: boolean }> = [];
    for (const papel of Object.keys(PERMISSOES_POR_PAPEL)) {
      for (const perm of PERMISSOES_POR_PAPEL[papel]) rows.push({ inquilino_id, papel, permissao_chave: perm, permitido: true });
    }
    const { error: errPerm } = await sbAdmin.from("permissoes_por_papel").insert(rows);
    if (errPerm) return json(erro("DB_ERRO", "Falha ao criar permissões por papel.", { detalhe: errPerm.message }), 500);

    // auditoria mínima (opcional)
    await sbAdmin.from("eventos_auditoria").insert({
      inquilino_id,
      tipo: "CONFIG_ALTERADA",
      origem_tipo: "onboarding",
      origem_id: null,
      dados: { acao: "criar_inquilino", slug },
      criado_por: userId,
    });

    return json(ok({ inquilino: inq, caixas, recebedor_pool_turno: pool }), 200);
  } catch (e) {
    return json(erro("ERRO_INESPERADO", "Erro inesperado no servidor.", { detalhe: String(e?.message ?? e) }), 500);
  }
});