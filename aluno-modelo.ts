/* aluno-modelo.ts — deixa o banco VIRGEM e monta um único aluno fictício, completo.
   ────────────────────────────────────────────────────────────────────────────────
   Para que serve: ter um banco de trabalho que não seja o da escola. O `wizard.db` da
   recepção tem 163 pessoas reais e a operação de verdade; testar uma tela nova nele é
   ruim por dois motivos — mexe em dado que importa, e o repositório é PÚBLICO.

   O que faz:
     1. APAGA toda a operação (aluno, aula, presença, estoque movimentado, professores).
     2. PRESERVA o catálogo: livros, dias, situações, estágios, materiais, calendário.
     3. Cria o João da Silva (9001) em Kids 2 3rd Edition, terças e quintas às 13:00,
        matriculado em 13/04/2026, com frequência até hoje — faltas, reposições,
        anteposições, aulas de tarefa e um dia de duas lições.

   Como usa:
     deno run -A aluno-modelo.ts --de=wizard.db --db=wizard-ensaio.db

   `--de=` tira a cópia do banco de origem antes de limpar (VACUUM INTO, seguro mesmo com o
   painel de verdade no ar). Sem ele, trabalha no `--db` que já existir.

   O `--db` é OBRIGATÓRIO e recusa `wizard.db`: este script apaga dados, e apagar o banco
   da recepção por um argumento esquecido não é um risco que valha correr. Para começar do
   zero:  deno run -A main.ts --init   (com WIZ_DB apontando para a cópia)

   Ele sobe o servidor sozinho na 8421 (a porta do ensaio) e o desliga no fim — o painel de
   verdade pode ficar aberto na 8420 o tempo todo. A construção passa
   pelas ROTAS DO APP de propósito: SQL na mão produz dados que o app nunca produziria —
   sem diário de auditoria, sem as travas de domínio, sem o percurso aberto junto da
   matrícula. Só os dois ajustes que ainda não têm rota (aula de tarefa e o dia de duas
   lições) são escritos direto, no mesmo formato que as migrações de acerto usam. */
import { DatabaseSync } from "node:sqlite";

const PASTA = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const arg = Deno.args.find((a) => a.startsWith("--db="))?.slice(5);
if (!arg) {
  console.error("Falta --db=<arquivo>. Ex.: deno run -A aluno-modelo.ts --db=wizard-ensaio.db");
  Deno.exit(1);
}
if (arg === "wizard.db") {
  console.error("Recusado: 'wizard.db' é o banco da recepção. Use uma CÓPIA.");
  Deno.exit(1);
}
/* `--de=` tira a cópia aqui dentro, com VACUUM INTO — e não com `copy` do Windows.
   A diferença passou a importar em 2026-08-25: com o ensaio numa porta própria, o painel de
   verdade fica NO AR durante a cópia, e copiar arquivo de um SQLite aberto pega um estado
   possivelmente torto (o `.db-journal` cobre parte dos casos, não todos). VACUUM INTO lê pelo
   próprio SQLite e devolve um banco consistente mesmo com escrita acontecendo — é o mesmo
   mecanismo que `copiaDeSeguranca()` usa no main.ts antes de cada migração. */
const de = Deno.args.find((a) => a.startsWith("--de="))?.slice(5);
if (de) {
  try {
    await Deno.remove(PASTA + arg); // VACUUM INTO recusa destino que já existe
  } catch { /* não existia: é o caso normal */ }
  const orig = new DatabaseSync(PASTA + de, { readOnly: true });
  orig.exec(`VACUUM INTO '${(PASTA + arg).replace(/'/g, "''")}'`);
  orig.close();
  console.log(`cópia consistente de ${de} → ${arg} (VACUUM INTO, seguro com o banco aberto)`);
}
/* 8421 é a porta do ENSAIO (2026-08-25): este script sobe o servidor sobre a cópia e o painel de
   verdade continua na 8420, sem ser incomodado. Antes disto o ensaio disputava a 8420 e montar o
   aluno-modelo obrigava a fechar o Wizard que estava aberto.
   A porta é FIXA de propósito. Se estiver ocupada, o script RECUSA e diz — nada de procurar a
   próxima livre, que foi justamente o que produziu a escalada 8421 → 8422 → 8430. */
const PORTA = Number(Deno.env.get("WIZ_PORT") || 8421);
try {
  const t = await Deno.connect({ hostname: "127.0.0.1", port: PORTA });
  t.close();
  console.error(`A porta ${PORTA} está ocupada — feche o ensaio que já está no ar e rode de novo.`);
  Deno.exit(1);
} catch (e) {
  if (!(e instanceof Deno.errors.ConnectionRefused)) throw e; // livre: é o que se quer
}
/* PROF vai pelo NOME e não pelo id: `idsDosProfs` casa por `funcionarios.nome` — e descarta
   em silêncio o que não encontra, então "FP001" some sem erro nenhum e a aula nasce sem professor. */
const ID = "9001", LIVRO = "KIDS 2", PROF = ["Ana B."];
const MATRICULA = "2026-04-13"; // segunda: assinou o contrato
const INICIO = "2026-04-14";    // terça: primeira aula

/* ─────────────────────────────── 1. limpeza ─────────────────────────────── */
/* Operação nasce do dia a dia e é o que vira mock. Os PROFESSORES saem junto: são pessoas
   reais num repositório público, exatamente a mesma razão pela qual os alunos saem. */
const OPERACAO = [
  "aula_professor", "aulas", "presenca", "diario", "encontro_avulso",
  "aluno_situacao_historico", "aluno_horario_historico", "aluno_estagio",
  "aluno_livro", "alunos", "entrega_material", "devolucao_material",
  "estoque_unidade", "estoque_evento_item", "estoque_evento",
  "turma_professor", "turma_dia", "turmas", "aviso_silenciado", "funcionarios",
];
const db = new DatabaseSync(PASTA + arg);
db.exec("PRAGMA foreign_keys = OFF");
let apagadas = 0;
for (const t of OPERACAO) {
  try {
    apagadas += Number(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get()!.c);
    db.prepare(`DELETE FROM ${t}`).run();
  } catch { /* tabela que este banco ainda não tem: nada a apagar */ }
}
db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${OPERACAO.map(() => "?").join(",")})`)
  .run(...OPERACAO);
/* dois professores fictícios: a aula precisa de alguém, e o vínculo faz parte do modelo */
db.prepare("INSERT INTO funcionarios (id,nome_completo,nome) VALUES ('FP001','Ana Beatriz Nogueira','Ana B.')").run();
db.prepare("INSERT INTO funcionarios (id,nome_completo,nome) VALUES ('FP002','Carlos Eduardo Ramos','Carlos E.')").run();
/* marcas de semeadura que reconstruiriam, no próximo boot, a operação recém-apagada */
for (const k of ["estoque_semeado", "seed_historico_v1", "percurso_semeado", "contratos_numerados"])
  db.prepare("DELETE FROM config WHERE chave=?").run(k);
db.exec("PRAGMA foreign_keys = ON");
db.close();
console.log(`limpeza: ${apagadas} linha(s) de operação apagadas; catálogo preservado`);

/* ─────────────────────────── 2. sobe o servidor ──────────────────────────── */
const proc = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", PASTA + "main.ts"],
  env: { ...Deno.env.toObject(), WIZ_DB: arg, WIZ_PORT: String(PORTA) },
  stdout: "piped", stderr: "piped",
}).spawn();
const API = `http://127.0.0.1:${PORTA}/api/`;
let vivo = false;
for (let i = 0; i < 60 && !vivo; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try { await fetch(`http://127.0.0.1:${PORTA}/`); vivo = true; } catch { /* ainda subindo */ }
}
if (!vivo) { console.error("o servidor não subiu na porta " + PORTA); proc.kill(); Deno.exit(1); }

async function run(rota: string, arg: unknown = {}) {
  const r = await fetch(API + rota, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(arg),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${rota}: HTTP ${r.status} — ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}

try {
  /* ───────────────────────── 3. o calendário decide ──────────────────────── */
  /* Dia não letivo não vira falta: o feriado não é ausência do aluno. Quem sabe quais são
     é o próprio app — Tiradentes e Corpus Christi caem em terça e quinta em 2026. */
  const cal = await run("getCalendario", { ano: 2026 });
  const letivo = new Map<string, boolean>();
  for (const m of cal.meses) for (const d of m.dias) if (d.doMes) letivo.set(d.iso, d.letivo);
  const HOJE = new Date().toISOString().slice(0, 10);

  /* hoje fica SEM lançamento de propósito: é o que as telas de frequência mostram como
     "a vir", e sem isso o quadro da sala nasce vazio no dia em que se abre o app */
  const agenda: string[] = [];
  for (let d = new Date(INICIO + "T12:00:00"); d.toISOString().slice(0, 10) < HOJE;
       d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if ((d.getDay() === 2 || d.getDay() === 4) && letivo.get(iso)) agenda.push(iso);
  }

  const FALTAS = new Set(["2026-05-05", "2026-05-21", "2026-06-16",
                          "2026-07-09", "2026-07-30", "2026-08-11"]);
  /* reposição PAGA falta que já aconteceu; anteposição paga uma que ainda vai acontecer —
     por isso ela fica FORA da fila FIFO ("é tipo fatura de cartão, você adianta") */
  const REPOSICOES: [string, string][] = [
    ["2026-05-08", "quita a falta de 05/05"], ["2026-05-27", "quita a falta de 21/05"],
    ["2026-06-19", "quita a falta de 16/06"], ["2026-07-15", "quita a falta de 09/07"]];
  const ANTEPOSICOES: [string, string][] = [
    ["2026-07-29", "mãe avisou da viagem: adiantou a aula de 30/07"],
    ["2026-08-05", "adiantou a aula de 11/08"]];
  /* ────────────────────────── 4. cadastro e agenda ───────────────────────── */
  await run("salvarAluno", { id: ID, nome: "João da Silva", situacao: "Matriculado" });
  /* O HISTÓRICO VEM PRIMEIRO, e a ordem não é gosto: `salvarMatricula` abre o percurso datando
     pela situação mais antiga que encontrar, e sem histórico ele carimba HOJE — o contrato
     inteiro nasceria em agosto e a linha do tempo do aluno perderia o sentido.
     Ele ainda assim grava um segundo "Matriculado" com a data de hoje; esse sobrando é apagado
     no fim, junto dos outros ajustes. */
  await run("salvarHistoricoAluno",
    { idMatricula: ID, situacao: "Matriculado", data: MATRICULA, livro: LIVRO });
  await run("salvarMatricula", { idMatricula: ID, livro: LIVRO, modalidade: "Inter",
    vip: false, tipoEncontro: "Presencial", confirmado: true });
  await run("salvarAgendaLivro", { idMatricula: ID, livro: LIVRO, professores: PROF,
    confirmado: true,
    itens: [{ dia: "Terça", horario: "13:00" }, { dia: "Quinta", horario: "13:00" }] });

  /* ──────────────────── 5. a estrutura de lições do Kids 2 ───────────────── */
  /* Mesma fórmula da tela: as extras de abertura, e depois cada capítulo com as lições
     alternando input/output e uma Review no fim. Sem isto o planejamento não tem contra o
     que comparar — `estagio_licao` nasce vazia num banco novo. */
  const eg0 = await run("getEstagios");
  const eg = eg0.estagios.find((e: any) => e.livro === LIVRO);
  const mod = eg0.modelos.find((m: any) => m.id === eg.modeloId);
  /* SE O ESTÁGIO JÁ TEM LIÇÕES, NÃO ENCOSTA. Rodando sobre uma cópia do banco da recepção, o
     Kids 2 traz a estrutura que ele digitou à mão — `materializarEstrutura` começa com um
     DELETE, e reescrever aquilo pela fórmula apagaria trabalho editorial de verdade só para
     chegar a um resultado parecido. A fórmula só entra quando não há nada, que é o caso do
     banco nascido de `--init`. */
  if (eg.licoesProprias?.length) {
    console.log(`estrutura do ${LIVRO}: ${eg.licoesProprias.length} lições já cadastradas — mantidas`);
  } else {
    const linhas: any[] = [];
    for (const x of eg.extras.filter((e: any) => e.posicao === "abertura"))
      linhas.push({ numero: null, descricao: x.rotulo, bloco: null, tipo: "especial" });
    for (let c = 1; c <= mod.capitulos; c++) {
      for (let l = 1; l <= mod.licoesPorCapitulo; l++) {
        const n = (eg.licaoInicial - 1) + (c - 1) * mod.licoesPorCapitulo + l;
        linhas.push({ numero: n, descricao: `Lesson ${n}`, bloco: c,
                      tipo: l % 2 ? "input" : "output" });
      }
      linhas.push({ numero: null, descricao: `Review ${c}`, bloco: c, tipo: "review" });
    }
    const m = await run("materializarEstrutura", { alvo: "estagio", alvoId: eg.id, linhas });
    console.log(`estrutura do ${LIVRO}: ${m.linhas} lições geradas pela fórmula do modelo`);
  }

  /* `salvarMatricula` JÁ abre o percurso, datando pela situação (13/04, a matrícula) — que é
     a régua do contrato, 12 meses a partir da assinatura. Fica como o app decidiu; o início
     das ATIVIDADES (14/04) é a primeira presença, e é o que a linha do tempo mostra. */
  const pc = (await run("getPercursoAluno", { idMatricula: ID }))[0];

  /* ──────────────────────────── 6. material ──────────────────────────────── */
  await run("adicionarUnidades", { itemId: eg.itemEstoqueId, quantidade: 6 });
  const livres = await run("unidadesParaEntrega", { livro: LIVRO });
  const u = Array.isArray(livres) ? livres[0] : livres.unidades[0];
  await run("entregarMaterial", { idMatricula: ID, livro: LIVRO, data: MATRICULA,
    hora: "16:30", unidadeId: typeof u === "object" ? u.id : u });

  /* ─────────────────────────── 7. a frequência ───────────────────────────── */
  /* horas com variação de minutos: ponto que bate 13:00/14:00 em 36 dias seguidos não
     parece lançamento de gente, e a coluna de duração fica sem nada para mostrar */
  const HORAS: [string, string][] = [["12:58", "14:01"], ["13:02", "14:00"], ["13:00", "13:58"],
    ["13:05", "14:03"], ["12:56", "14:00"], ["13:01", "14:02"]];
  let presencas = 0, faltas = 0;
  for (let i = 0; i < agenda.length; i++) {
    const data = agenda[i];
    if (FALTAS.has(data)) {
      await run("lancarPresencaLote",
        { itens: [{ idMatricula: ID, livro: LIVRO, data, status: "F" }] });
      faltas++; continue;
    }
    const [ent, sai] = HORAS[i % HORAS.length];
    await run("registrarPonto", { idMatricula: ID, livro: LIVRO, data, tipo: "entrada", hora: ent });
    await run("registrarPonto",
      { idMatricula: ID, livro: LIVRO, data, tipo: "saida", hora: sai, confirmado: true });
    presencas++;
  }
  for (const [grupo, motivo, ent, sai] of
       [[REPOSICOES, "Reposição", "13:02", "14:00"], [ANTEPOSICOES, "Anteposição", "13:00", "13:59"]] as const) {
    for (const [data, obs] of grupo) {
      await run("lancarAvulso", { idMatricula: ID, livro: LIVRO, data, hora: "13:00",
        motivo, observacao: obs, comPresenca: true });
      await run("registrarPonto", { idMatricula: ID, livro: LIVRO, data, tipo: "entrada", hora: ent });
      await run("registrarPonto",
        { idMatricula: ID, livro: LIVRO, data, tipo: "saida", hora: sai, confirmado: true });
    }
  }
  /* ──────────────── 8. o que ainda não tem rota, escrito direto ─────────────── */
  /* AULA DE TAREFA: `aulas_feitas = 0` quer dizer "a aula aconteceu, conta na frequência e o
     planejamento não anda". O conceito existe no planejador desde 25/08, mas nenhuma tela
     ainda o grava — então aqui é SQL, no mesmo formato dos acertos de dado do main.ts.
     O DIA DE DUAS LIÇÕES é o primeiro: Welcome Lesson e Lesson 1 numa hora só. É o caso que
     faz o planejamento fundir as duas células do mesmo lançamento. */
  const db2 = new DatabaseSync(PASTA + arg);
  const anota = (data: string, valor: string, detalhe: string) =>
    db2.prepare(`INSERT INTO diario (momento,id_matricula,livro,data,tipo,valor,detalhe)
       VALUES (datetime('now','localtime'),?,?,?,'ajuste',?,?)`).run(ID, LIVRO, data, valor, detalhe);
  for (const d of ["2026-05-26", "2026-06-23"]) {
    db2.prepare(`UPDATE presenca SET aulas_feitas=0
       WHERE id_matricula=? AND livro=? AND data=? AND status='P'`).run(ID, LIVRO, d);
    anota(d, "tarefa", "aula de tarefa: aconteceu e não avançou lição");
  }
  db2.prepare(`UPDATE presenca SET aulas_feitas=2
     WHERE id_matricula=? AND livro=? AND data=?`).run(ID, LIVRO, INICIO);
  anota(INICIO, "2", "primeiro dia: Welcome Lesson e Lesson 1 na mesma hora");
  /* o "Matriculado" que `salvarMatricula` carimbou com a data de hoje: o aluno foi matriculado
     uma vez só, em abril, e duas linhas iguais no mesmo contrato viram ruído na linha do tempo */
  db2.prepare(`DELETE FROM aluno_situacao_historico
     WHERE id_matricula=? AND livro=? AND situacao='Matriculado' AND data<>?`)
    .run(ID, LIVRO, MATRICULA);
  db2.close();
  console.log("ajustes: 2 aulas de tarefa e o primeiro dia com duas lições");

  const plan = await run("getPlanejamento", { idMatricula: ID, livro: LIVRO });
  console.log(`aluno 9001 João da Silva · ${LIVRO} ${eg.edicaoNome ?? ""} · Ter/Qui 13:00`);
  console.log(`   contrato ${pc.dataInicio} → ${pc.vence} · ${pc.totalLicoes} lições`);
  console.log(`   ${presencas} presenças, ${faltas} faltas, ${REPOSICOES.length} reposições, ` +
              `${ANTEPOSICOES.length} anteposições`);
  console.log(`   posição no planejamento: ${plan.posicao?.licao} (${plan.dadas} lições dadas)`);
} finally {
  proc.kill();
  await proc.status;
}
