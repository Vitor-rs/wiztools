/* ===================================================================================
   ===== OS ALUNOS QUE SAEM, E O QUE ESTÁ SAINDO (2026-09-19) =====
   O mock tinha três alunos e todos os três matriculados: a tela de evasão nasceria vazia em toda
   seção, e tela vazia não se testa — o defeito aparece no dia em que a escola usa.

   Seis casos, um por caminho de saída que existe de verdade na recepção. Cinco vêm dos números
   medidos no banco da escola em 19/09 (54 desativados, 49 sem data nenhuma, 14 evadidos sem um
   único registro na linha do tempo); o sexto é o que ainda dá para salvar:

     9004 Bruno    — EVADIU POR FALTA. Veio até maio e sumiu. É o caso que o gatilho da rede pega
                     (8 faltas consecutivas), e o único em que o sistema poderia ter avisado antes.
     9005 Camila   — RESCINDIU COM AULA. Mudou de cidade em agosto, avisou, saiu em dia.
     9006 Diego    — CANCELOU sem nunca ter vindo. Matriculou, não apareceu, desistiu. Para a rede
                     não é evasão de aluno: é cancelamento antes do início do plano.
     9007 Elaine   — TRANCOU e não voltou. Trancado NÃO é saída: o horário dela continua reservado,
                     e é isso que faz dela o caso mais caro — some da conta e ocupa vaga.
     9008 Felipe   — AINDA ESTÁ AQUI, e está indo embora: cinco faltas seguidas, quase um mês sem
                     aparecer, nenhuma saída registrada. É a linha de cima da fila de risco.
     9009 Gabriela — A SAÍDA COMO ELA É HOJE: alguém trocou o campo do cadastro para "Evadido" e
                     pronto. Sem data, sem motivo, com a matrícula e o horário ainda de pé. É o
                     caso que a repescagem tem de consertar — 49 assim no banco da escola.

   SÓ ACRESCENTA, como o `alunas-modelo.ts`: nenhum DELETE, e cada aluno só nasce se ainda não
   existir. Quem já estiver no banco fica como está, inclusive se o Vitor tiver mexido nele.
   =================================================================================== */
type Ajudantes = {
  A: (sql: string, ...p: any[]) => any[];
  G: (sql: string, ...p: any[]) => any;
  R: (sql: string, ...p: any[]) => any;
  API: Record<string, any>;
  agora: () => string;
};

type Perfil = {
  id: string;
  nome: string;
  livro: string;
  hora: string;
  dias: [number, string][];      /* [getDay(), nome do dia] */
  matricula: string;             /* data da matrícula (entra no histórico antes do contrato) */
  ultimaAula: string | null;     /* último dia em que ele veio; null = nunca veio */
  faltasDepois: number;          /* dias de grade lançados como falta DEPOIS da última aula */
  saida: null | {
    situacao: string;            /* Evadido · Cancelado · Trancado · Encerrado */
    motivo: string;              /* o nome na lista de Cadastros */
    data: string;
    observacao?: string;
    semRegistro?: boolean;       /* true = o jeito antigo: troca o campo do cadastro e mais nada */
  };
};

const PERFIS: Perfil[] = [
  { id: "9004", nome: "Bruno Carvalho Lima", livro: "KIDS 2", hora: "13:00",
    dias: [[2, "Terça"], [4, "Quinta"]], matricula: "2026-02-10",
    ultimaAula: "2026-05-21", faltasDepois: 8,
    saida: { situacao: "Evadido", motivo: "Parou de vir, sem avisar", data: "2026-05-21",
      observacao: "A mãe não atendeu as ligações." } },
  { id: "9005", nome: "Camila Ferreira Rocha", livro: "W2", hora: "15:00",
    dias: [[1, "Segunda"], [3, "Quarta"]], matricula: "2026-01-14",
    ultimaAula: "2026-08-12", faltasDepois: 0,
    saida: { situacao: "Evadido", motivo: "Mudou de cidade", data: "2026-08-12",
      observacao: "Transferida para Campo Grande pelo trabalho do pai." } },
  { id: "9006", nome: "Diego Nunes Prado", livro: "KIDS 2", hora: "13:00",
    dias: [[2, "Terça"], [4, "Quinta"]], matricula: "2026-03-03",
    ultimaAula: null, faltasDepois: 0,
    saida: { situacao: "Cancelado", motivo: "Desistiu antes de começar", data: "2026-03-17",
      observacao: "Matriculou e não chegou a começar o plano." } },
  { id: "9007", nome: "Elaine Souza Martins", livro: "Teens 2", hora: "17:00",
    dias: [[5, "Sexta"]], matricula: "2025-09-12",
    ultimaAula: "2026-04-24", faltasDepois: 0,
    saida: { situacao: "Trancado", motivo: "Saúde ou problema de família", data: "2026-04-24",
      observacao: "Trancou por seis meses; combinou de voltar em outubro." } },
  { id: "9008", nome: "Felipe Antunes Vieira", livro: "KIDS 2", hora: "13:00",
    dias: [[2, "Terça"], [4, "Quinta"]], matricula: "2026-04-07",
    ultimaAula: "2026-08-25", faltasDepois: 5, saida: null },
  { id: "9009", nome: "Gabriela Lopes Dias", livro: "W2", hora: "15:00",
    dias: [[1, "Segunda"], [3, "Quarta"]], matricula: "2026-02-04",
    ultimaAula: "2026-06-29", faltasDepois: 3,
    saida: { situacao: "Evadido", motivo: "", data: "", semRegistro: true } },
];

export function montarEvadidos({ A: _A, G, R, API, agora }: Ajudantes) {
  const hoje = new Date().toISOString().slice(0, 10);
  /* o calendário manda: lançar presença em dia fechado é recusado pelo servidor desde 19/09, e o
     mock não pode nascer batendo de frente com a própria regra da casa */
  const letivo = new Map<string, boolean>();
  for (const ano of [2025, 2026])
    for (const m of API.getCalendario({ ano }).meses)
      for (const d of m.dias) if (d.doMes) letivo.set(d.iso, d.letivo);

  const motivos: any[] = API.getMotivosSaida().motivos;
  const acharMotivo = (nome: string) => motivos.find((m: any) => m.nome === nome) || null;

  for (const p of PERFIS) {
    if (G("SELECT 1 FROM alunos WHERE id_matricula=?", p.id)) {
      console.log(`   ${p.id} ${p.nome}: já existe — mantido`);
      continue;
    }
    try {
      API.salvarAluno({ id: p.id, nome: p.nome, situacao: "Matriculado" });
      API.salvarMatricula({ idMatricula: p.id, livro: p.livro, modalidade: "Inter",
        vip: false, tipoEncontro: "Presencial", confirmado: true });
      /* ARMADILHA QUE O PRIMEIRO ENSAIO PEGOU: `salvarMatricula` grava sozinha um "Matriculado" com a
         data de HOJE — e a situação corrente sai do registro mais RECENTE da linha do tempo. Com a
         saída datada em maio e a entrada datada hoje, os quatro que saíram voltavam a aparecer como
         matriculados, e o percurso reabria. Em vez de inserir a entrada antes (o que daria duas), a
         entrada que ela criou é RE-DATADA: uma linha só, na data certa, e `sincronizarPercurso` leva
         junto o início do contrato. */
      const ent = G(`SELECT id FROM aluno_situacao_historico WHERE id_matricula=? AND livro=?
                     ORDER BY id DESC LIMIT 1`, p.id, p.livro);
      if (ent) API.editarHistoricoAluno({ id: ent.id, situacao: "Matriculado", data: p.matricula, livro: p.livro });
      API.salvarAgendaLivro({ idMatricula: p.id, livro: p.livro, confirmado: true,
        itens: p.dias.map(([, nome]) => ({ dia: nome, horario: p.hora })) });

      /* ─────────── a frequência: veio até a última aula, faltou depois ─────────── */
      const diasDaSemana = new Set(p.dias.map(([n]) => n));
      const grade: string[] = [];
      for (let d = new Date(p.matricula + "T12:00:00"); d.toISOString().slice(0, 10) <= hoje; d.setDate(d.getDate() + 1)) {
        const iso = d.toISOString().slice(0, 10);
        if (diasDaSemana.has(d.getDay()) && letivo.get(iso) !== false) grade.push(iso);
      }
      const vindas = p.ultimaAula ? grade.filter((d) => d <= p.ultimaAula!) : [];
      const depois = grade.filter((d) => p.ultimaAula == null || d > p.ultimaAula).slice(0, p.faltasDepois);
      const itens = [
        ...vindas.map((data) => ({ idMatricula: p.id, livro: p.livro, data, status: "P" })),
        ...depois.map((data) => ({ idMatricula: p.id, livro: p.livro, data, status: "F" })),
      ];
      if (itens.length) API.lancarPresencaLote({ itens });

      /* ─────────── a saída ─────────── */
      if (!p.saida) {
        console.log(`   ${p.id} ${p.nome}: ativo, ${vindas.length} presença(s) e ${depois.length} falta(s) seguidas`);
        continue;
      }
      if (p.saida.semRegistro) {
        /* O JEITO ANTIGO, de propósito: o campo do cadastro trocado na mão, sem data, sem motivo e
           com a matrícula e o horário ainda de pé. É o estado de 49 alunos no banco da escola, e é
           exatamente o que a repescagem existe para consertar — o mock precisa ter um. */
        R("UPDATE alunos SET situacao=? WHERE id_matricula=?", p.saida.situacao, p.id);
        console.log(`   ${p.id} ${p.nome}: ${p.saida.situacao} no cadastro, SEM registro de saída (caso de repescagem)`);
        continue;
      }
      const mot = acharMotivo(p.saida.motivo);
      if (p.saida.situacao === "Trancado") {
        /* trancar não passa pelo encerrar: ele volta ao MESMO estágio, e o horário dele não se
           libera. A saída vai direto para a linha do tempo, com motivo. */
        API.salvarHistoricoAluno({ idMatricula: p.id, situacao: "Trancado", data: p.saida.data, livro: p.livro,
          motivoId: mot?.id ?? null, observacao: p.saida.observacao ?? null });
      } else {
        const est = p.saida.situacao === "Cancelado" ? "cancelado" : "evadido";
        API.encerrarLivro({ idMatricula: p.id, livro: p.livro, confirmado: true, estado: est,
          data: p.saida.data, motivoId: mot?.id ?? null, observacao: p.saida.observacao ?? null });
      }
      const st = G("SELECT status, situacao FROM v_alunos WHERE id_matricula=?", p.id);
      console.log(`   ${p.id} ${p.nome}: ${st?.situacao || p.saida.situacao} em ${p.saida.data}`
        + (mot ? ` — ${mot.nome}${mot.tipoRede ? " (" + mot.tipoRede + ")" : ""}` : " — sem motivo"));
    } catch (e) {
      console.warn(`   ${p.id} ${p.nome}: não subiu (${(e as Error).message})`);
    }
  }
  return { perfis: PERFIS.length, em: agora() };
}
