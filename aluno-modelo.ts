/* aluno-modelo.ts — o aluno fictício do modo `--mock`.
   ────────────────────────────────────────────────────────────────────────────────
   Chamado UMA vez, por `main.ts`, quando um banco de mock nasce. Não é executável e não
   abre banco nenhum: recebe os ajudantes de `main.ts` e trabalha na conexão que já existe.

   Para que serve: desenvolver sem tocar no `wizard.db` da escola. Ele tem 163 pessoas reais
   e a operação de verdade — mexer ali para testar uma tela é ruim por dois motivos, o dado
   importa e o repositório é PÚBLICO.

   O que faz:
     1. APAGA a operação que veio do seed (alunos, aulas, entregas, professores).
     2. PRESERVA o catálogo: livros, dias, situações, estágios, materiais, calendário.
     3. Cria o João da Silva (9001) em Kids 2 3rd Edition, terças e quintas às 13:00,
        matriculado em 13/04/2026, com frequência até ontem — faltas, reposições,
        anteposições, aulas de tarefa e um dia de duas lições.

   A construção passa pelas ROTAS DO APP (`API.*`) de propósito. SQL na mão produziria dados que
   o app nunca produziria — sem diário de auditoria, sem as travas de domínio, sem o percurso
   aberto junto da matrícula —, e testar contra um mock desses não prova nada. Só os dois
   ajustes que ainda não têm rota (aula de tarefa e o dia de duas lições) são escritos direto. */

type Ajudantes = {
  A: (sql: string, ...p: any[]) => any[];
  G: (sql: string, ...p: any[]) => any;
  R: (sql: string, ...p: any[]) => any;
  API: Record<string, any>;
  agora: () => string;
};

const ID = "9001", LIVRO = "KIDS 2";
/* PROF vai pelo NOME e não pelo id: `idsDosProfs` casa por `funcionarios.nome` — e descarta em
   silêncio o que não encontra, então um id aqui sumiria sem erro e a aula nasceria sem professor. */
const PROF = ["Ana B."];
const MATRICULA = "2026-04-13"; // segunda: assinou o contrato
const INICIO = "2026-04-14";    // terça: primeira aula

/* Operação nasce do dia a dia da escola e é o que vira mock. Os PROFESSORES saem junto: são
   pessoas reais num repositório público, exatamente a mesma razão pela qual os alunos saem. */
const OPERACAO = [
  "aula_professor", "aulas", "presenca", "diario", "encontro_avulso",
  "aluno_situacao_historico", "aluno_horario_historico", "aluno_estagio",
  "aluno_livro", "alunos", "entrega_material", "devolucao_material",
  "estoque_unidade", "estoque_evento_item", "estoque_evento",
  "turma_professor", "turma_dia", "turmas", "aviso_silenciado", "funcionarios",
];

const FALTAS = new Set(["2026-05-05", "2026-05-21", "2026-06-16",
                        "2026-07-09", "2026-07-30", "2026-08-11"]);
/* reposição PAGA falta que já aconteceu; anteposição paga uma que ainda vai acontecer — e por
   isso ela fica FORA da fila FIFO ("é tipo fatura de cartão, você adianta") */
const REPOSICOES: [string, string][] = [
  ["2026-05-08", "quita a falta de 05/05"], ["2026-05-27", "quita a falta de 21/05"],
  ["2026-06-19", "quita a falta de 16/06"], ["2026-07-15", "quita a falta de 09/07"]];
const ANTEPOSICOES: [string, string][] = [
  ["2026-07-29", "mãe avisou da viagem: adiantou a aula de 30/07"],
  ["2026-08-05", "adiantou a aula de 11/08"]];
const TAREFA = ["2026-05-26", "2026-06-23"]; // aconteceu, conta frequência, não avança lição
/* ponto com minutos variados: entrada 13:00 e saída 14:00 em trinta e seis dias seguidos não
   parece lançamento de gente, e a coluna de duração fica sem nada para mostrar */
const HORAS: [string, string][] = [["12:58", "14:01"], ["13:02", "14:00"], ["13:00", "13:58"],
  ["13:05", "14:03"], ["12:56", "14:00"], ["13:01", "14:02"]];

export function montarAlunoModelo({ A, G, R, API, agora }: Ajudantes) {
  /* ─────────────────────────── 1. esvazia a operação ──────────────────────── */
  let apagadas = 0;
  R("PRAGMA foreign_keys = OFF");
  for (const t of OPERACAO) {
    try {
      apagadas += Number(G(`SELECT COUNT(*) c FROM ${t}`)?.c ?? 0);
      R(`DELETE FROM ${t}`);
    } catch { /* tabela que este banco ainda não tem: nada a apagar */ }
  }
  R(`DELETE FROM sqlite_sequence WHERE name IN (${OPERACAO.map(() => "?").join(",")})`, ...OPERACAO);
  /* dois professores fictícios: a aula precisa de alguém, e o vínculo faz parte do modelo */
  R("INSERT INTO funcionarios (id,nome_completo,nome) VALUES ('FP001','Ana Beatriz Nogueira','Ana B.')");
  R("INSERT INTO funcionarios (id,nome_completo,nome) VALUES ('FP002','Carlos Eduardo Ramos','Carlos E.')");
  R("PRAGMA foreign_keys = ON");

  /* ────────────────────────── 2. cadastro e agenda ────────────────────────── */
  API.salvarAluno({ id: ID, nome: "João da Silva", situacao: "Matriculado" });
  /* O HISTÓRICO VEM PRIMEIRO, e a ordem não é gosto: `salvarMatricula` abre o percurso datando
     pela situação mais antiga que encontrar, e sem histórico ele carimba HOJE — o contrato
     inteiro nasceria em agosto e a linha do tempo do aluno perderia o sentido. */
  API.salvarHistoricoAluno({ idMatricula: ID, situacao: "Matriculado", data: MATRICULA, livro: LIVRO });
  API.salvarMatricula({ idMatricula: ID, livro: LIVRO, modalidade: "Inter",
    vip: false, tipoEncontro: "Presencial", confirmado: true });
  API.salvarAgendaLivro({ idMatricula: ID, livro: LIVRO, professores: PROF, confirmado: true,
    itens: [{ dia: "Terça", horario: "13:00" }, { dia: "Quinta", horario: "13:00" }] });

  /* ───────────────────── 3. a estrutura de lições do Kids 2 ───────────────── */
  /* Mesma fórmula da tela: as extras de abertura, e cada capítulo com as lições alternando
     input/output e uma Review no fim. Sem isto o planejamento não tem contra o que comparar —
     `estagio_licao` nasce vazia num banco novo.
     SE JÁ HOUVER LIÇÕES, NÃO ENCOSTA: `materializarEstrutura` começa com um DELETE, e num banco
     que veio de uma cópia da recepção isso apagaria a estrutura digitada à mão. */
  const eg0 = API.getEstagios();
  const eg = eg0.estagios.find((e: any) => e.livro === LIVRO);
  const mod = eg0.modelos.find((m: any) => m.id === eg.modeloId);
  if (eg.licoesProprias?.length) {
    console.log(`   estrutura do ${LIVRO}: ${eg.licoesProprias.length} lições já cadastradas — mantidas`);
  } else {
    const linhas: any[] = [];
    for (const x of eg.extras.filter((e: any) => e.posicao === "abertura"))
      linhas.push({ numero: null, descricao: x.rotulo, bloco: null, tipo: "especial" });
    for (let c = 1; c <= mod.capitulos; c++) {
      for (let l = 1; l <= mod.licoesPorCapitulo; l++) {
        const n = (eg.licaoInicial - 1) + (c - 1) * mod.licoesPorCapitulo + l;
        linhas.push({ numero: n, descricao: `Lesson ${n}`, bloco: c, tipo: l % 2 ? "input" : "output" });
      }
      linhas.push({ numero: null, descricao: `Review ${c}`, bloco: c, tipo: "review" });
    }
    const m = API.materializarEstrutura({ alvo: "estagio", alvoId: eg.id, linhas });
    console.log(`   estrutura do ${LIVRO}: ${m.linhas} lições geradas pela fórmula do modelo`);
  }

  /* ─────────────────────────────── 4. material ────────────────────────────── */
  API.adicionarUnidades({ itemId: eg.itemEstoqueId, quantidade: 6 });
  const livres = API.unidadesParaEntrega({ livro: LIVRO });
  const u = Array.isArray(livres) ? livres[0] : livres.unidades[0];
  API.entregarMaterial({ idMatricula: ID, livro: LIVRO, data: MATRICULA, hora: "16:30",
    unidadeId: typeof u === "object" ? u.id : u });

  /* ────────────────────────────── 5. frequência ───────────────────────────── */
  /* Dia não letivo não vira falta: o feriado não é ausência do aluno. Quem sabe quais são é o
     próprio app — em 2026, Tiradentes e Corpus Christi caem em terça e quinta.
     HOJE fica sem lançamento de propósito: é o que as telas de frequência mostram como "a vir",
     e sem isso o quadro da sala nasce vazio no dia em que se abre o app. */
  const letivo = new Map<string, boolean>();
  for (const m of API.getCalendario({ ano: 2026 }).meses)
    for (const d of m.dias) if (d.doMes) letivo.set(d.iso, d.letivo);
  const hoje = new Date().toISOString().slice(0, 10);
  const agenda: string[] = [];
  for (let d = new Date(INICIO + "T12:00:00"); d.toISOString().slice(0, 10) < hoje;
       d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if ((d.getDay() === 2 || d.getDay() === 4) && letivo.get(iso)) agenda.push(iso);
  }

  let presencas = 0, faltas = 0;
  agenda.forEach((data, i) => {
    if (FALTAS.has(data)) {
      API.lancarPresencaLote({ itens: [{ idMatricula: ID, livro: LIVRO, data, status: "F" }] });
      faltas++; return;
    }
    const [ent, sai] = HORAS[i % HORAS.length];
    API.registrarPonto({ idMatricula: ID, livro: LIVRO, data, tipo: "entrada", hora: ent });
    API.registrarPonto({ idMatricula: ID, livro: LIVRO, data, tipo: "saida", hora: sai, confirmado: true });
    presencas++;
  });
  for (const [grupo, motivo, ent, sai] of
       [[REPOSICOES, "Reposição", "13:02", "14:00"],
        [ANTEPOSICOES, "Anteposição", "13:00", "13:59"]] as const) {
    for (const [data, obs] of grupo) {
      API.lancarAvulso({ idMatricula: ID, livro: LIVRO, data, hora: "13:00",
        motivo, observacao: obs, comPresenca: true });
      API.registrarPonto({ idMatricula: ID, livro: LIVRO, data, tipo: "entrada", hora: ent });
      API.registrarPonto({ idMatricula: ID, livro: LIVRO, data, tipo: "saida", hora: sai, confirmado: true });
    }
  }

  /* ──────────────── 6. o que ainda não tem rota, escrito direto ───────────── */
  /* AULA DE TAREFA: `aulas_feitas = 0` quer dizer "a aula aconteceu, conta na frequência e o
     planejamento não anda". O conceito existe no planejador desde 25/08, mas nenhuma tela ainda
     o grava — então aqui é SQL, no mesmo formato dos acertos de dado do main.ts.
     O DIA DE DUAS LIÇÕES é o primeiro: Welcome Lesson e Lesson 1 numa hora só. É o caso que faz o
     planejamento fundir as duas células do mesmo lançamento. */
  const anota = (data: string, valor: string, detalhe: string) =>
    R(`INSERT INTO diario (momento,id_matricula,livro,data,tipo,valor,detalhe)
       VALUES (?,?,?,?,'ajuste',?,?)`, agora(), ID, LIVRO, data, valor, detalhe);
  for (const d of TAREFA) {
    R(`UPDATE presenca SET aulas_feitas=0
       WHERE id_matricula=? AND livro=? AND data=? AND status='P'`, ID, LIVRO, d);
    anota(d, "tarefa", "aula de tarefa: aconteceu e não avançou lição");
  }
  R("UPDATE presenca SET aulas_feitas=2 WHERE id_matricula=? AND livro=? AND data=?", ID, LIVRO, INICIO);
  anota(INICIO, "2", "primeiro dia: Welcome Lesson e Lesson 1 na mesma hora");
  /* o "Matriculado" que `salvarMatricula` carimbou com a data de hoje: o aluno foi matriculado
     uma vez só, em abril, e duas linhas iguais no mesmo contrato viram ruído na linha do tempo */
  R(`DELETE FROM aluno_situacao_historico
     WHERE id_matricula=? AND livro=? AND situacao='Matriculado' AND data<>?`, ID, LIVRO, MATRICULA);

  const pc = API.getPercursoAluno({ idMatricula: ID })[0];
  const plan = API.getPlanejamento({ idMatricula: ID, livro: LIVRO });
  console.log(`   mock: 9001 João da Silva · ${LIVRO} ${eg.edicaoNome ?? ""} · Ter/Qui 13:00`);
  console.log(`   contrato ${pc.dataInicio} → ${pc.vence} · ${apagadas} linha(s) do seed apagadas`);
  console.log(`   ${presencas} presenças, ${faltas} faltas, ${REPOSICOES.length} reposições, ` +
              `${ANTEPOSICOES.length} anteposições · posição ${plan.posicao?.licao} (${plan.dadas} dadas)`);
}
