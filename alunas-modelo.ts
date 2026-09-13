/* ===================================================================================
   ===== MAIS DUAS ALUNAS FICTÍCIAS (2026-09-01, dele) =====
   O João sozinho não mostrava contraste: ele está ADIANTADO, e um mock com um caso só faz toda
   tela parecer certa. Pedido dele: *"cria dados mockados de mais dois alunos, a Maria e a
   Natália... gere mais dados pra gente conseguir ver as diferenças, o que tá sendo usado e o que
   não tá"*.

   MARIA — atrasada dentro do prazo. Está na lição 37 quando o relógio do contrato pede 46: os
   ~12% de defasagem que ele pediu. É o caso que faz a barra do livro ficar ATRÁS da do tempo.
   NATÁLIA — o contrato venceu e o livro não terminou. Está na 55 de 71 com o prazo estourado há
   duas semanas: é o caso do `excesso`, que nenhuma tela tinha ainda como exercitar.

   POR QUE ELAS PRECISAM FALTAR TANTO, e isto é a aritmética da escola, não exagero do mock: o
   contrato de um ano rende de 97 a 103 aulas e o livro pede 71. Sobram ~30 aulas de folga, e é
   por isso que faltar não vira atraso na hora — só depois de gastar a folga. Para a Maria estar
   NOVE lições atrás, ela precisa ter perdido bem mais que nove aulas.

   ESTE MÓDULO SÓ ACRESCENTA. O `aluno-modelo.ts` esvazia a operação inteira antes de montar o
   João, e reusá-lo aqui apagaria o que já existe — inclusive as avaliações lançadas à mão. Aqui
   não há DELETE nenhum: cada aluna nasce pelas rotas do app, como o João nasce.
   =================================================================================== */
type Ajudantes = {
  A: (sql: string, ...p: any[]) => any[];
  G: (sql: string, ...p: any[]) => any;
  R: (sql: string, ...p: any[]) => any;
  API: Record<string, any>;
  agora: () => string;
};

type Perfil = {
  id: string; nome: string; livro: string;
  dias: [number, string][];      /* [getDay(), nome do dia na tabela `dias`] */
  hora: string;
  profs: string[];
  matricula: string;             /* dia da entrega do material — é ele que data o contrato */
  inicio: string;                /* primeira aula */
  alvoLicoes: number;            /* quantas lições ela deve ter cumprido HOJE */
  reposicoes: number;            /* aulas extras que quitam falta já ocorrida */
  anteposicoes: number;          /* aulas extras que adiantam falta que ainda vem */
  doisNoDia: number;             /* dias em que fez duas lições numa sentada */
  tarefas: number;               /* veio, contou frequência, não avançou lição */
  conta: string;                 /* a história em uma linha, para o log */
};

const PERFIS: Perfil[] = [
  {
    id: "9002", nome: "Maria Fernanda Alves", livro: "W2",
    dias: [[1, "Segunda"], [3, "Quarta"]], hora: "15:00", profs: ["Carlos E."],
    matricula: "2026-01-07", inicio: "2026-01-12",
    alvoLicoes: 37, reposicoes: 5, anteposicoes: 2, doisNoDia: 2, tarefas: 3,
    conta: "atrasada: o relógio pede 46 e ela está na 37",
  },
  {
    id: "9003", nome: "Natália Souza Prado", livro: "Teens 2",
    dias: [[2, "Terça"], [5, "Sexta"]], hora: "17:00", profs: ["Ana B.", "Carlos E."],
    matricula: "2025-08-18", inicio: "2025-08-19",
    alvoLicoes: 55, reposicoes: 6, anteposicoes: 1, doisNoDia: 3, tarefas: 4,
    conta: "contrato vencido há duas semanas com o livro por terminar",
  },
];

/* ponto com minutos variados: entrada e saída redondas em cem dias seguidos não parecem
   lançamento de gente, e a coluna de duração fica sem nada para mostrar. Os pares são desvios em
   MINUTOS em relação à hora da aula — assim servem para qualquer horário, sem conta de fuso. */
const DESVIOS: [number, number][] = [[-2, 61], [2, 60], [0, 57], [4, 62], [-4, 60], [1, 63]];
const somaMin = (hhmm: string, min: number) => {
  const [h, m] = hhmm.split(":").map(Number);
  const t = h * 60 + m + min;
  return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
};

export function montarAlunas({ A, G, R, API, agora }: Ajudantes) {
  const hoje = new Date().toISOString().slice(0, 10);
  /* o calendário letivo decide o que é dia de aula — feriado não é falta de ninguém. Dois anos,
     porque a Natália começou em 2025. */
  const letivo = new Map<string, boolean>();
  for (const ano of [2025, 2026])
    for (const m of API.getCalendario({ ano }).meses)
      for (const d of m.dias) if (d.doMes) letivo.set(d.iso, d.letivo);

  for (const p of PERFIS) {
    if (G("SELECT 1 FROM alunos WHERE id_matricula=?", p.id)) {
      console.log(`   ${p.id} ${p.nome}: já existe — mantida`);
      continue;
    }
    /* ─────────────────── cadastro, contrato e agenda ─────────────────── */
    API.salvarAluno({ id: p.id, nome: p.nome, situacao: "Matriculado" });
    /* o histórico vem ANTES da matrícula: `salvarMatricula` data o percurso pela situação mais
       antiga que achar, e sem histórico carimba hoje — o contrato inteiro nasceria em setembro */
    API.salvarHistoricoAluno({ idMatricula: p.id, situacao: "Matriculado", data: p.matricula, livro: p.livro });
    API.salvarMatricula({ idMatricula: p.id, livro: p.livro, modalidade: "Inter",
      vip: false, tipoEncontro: "Presencial", confirmado: true });
    API.salvarAgendaLivro({ idMatricula: p.id, livro: p.livro, professores: p.profs, confirmado: true,
      itens: p.dias.map(([, nome]) => ({ dia: nome, horario: p.hora })) });

    /* ─────────────────── a estrutura do estágio ─────────────────── */
    const eg0 = API.getEstagios();
    const eg = eg0.estagios.find((e: any) => e.livro === p.livro);
    if (!eg) { console.log(`   ${p.nome}: estágio de "${p.livro}" não existe no catálogo — pulada`); continue; }
    const mod = eg0.modelos.find((m: any) => m.id === eg.modeloId);
    if (eg.licoesProprias?.length) {
      console.log(`   estrutura do ${p.livro}: ${eg.licoesProprias.length} lições já cadastradas — mantidas`);
    } else {
      /* mesma fórmula da tela e do aluno-modelo: as extras de abertura, e cada capítulo com as
         lições alternando input/output e uma Review no fim */
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
      console.log(`   estrutura do ${p.livro}: ${m.linhas} lições geradas pela fórmula do modelo`);
    }

    /* ─────────────────── material ─────────────────── */
    try {
      API.adicionarUnidades({ itemId: eg.itemEstoqueId, quantidade: 3 });
      const livres = API.unidadesParaEntrega({ livro: p.livro });
      const u = Array.isArray(livres) ? livres[0] : livres.unidades[0];
      if (u) API.entregarMaterial({ idMatricula: p.id, livro: p.livro, data: p.matricula, hora: "16:00",
        unidadeId: typeof u === "object" ? u.id : u });
    } catch (e) { console.log(`   ${p.nome}: material não entregue (${(e as Error).message})`); }

    /* ─────────────────── a agenda de dias letivos ─────────────────── */
    const diasDaSemana = new Set(p.dias.map(([n]) => n));
    const agenda: string[] = [];
    for (let d = new Date(p.inicio + "T12:00:00"); d.toISOString().slice(0, 10) < hoje; d.setDate(d.getDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      if (diasDaSemana.has(d.getDay()) && letivo.get(iso) !== false) agenda.push(iso);
    }
    /* ===== QUANTAS FALTAS PARA CHEGAR NA LIÇÃO ALVO =====
       As lições cumpridas são: os dias de grade em que ela veio (menos os de tarefa, que não
       avançam), mais o segundo tempo dos dias de duas lições, mais as aulas extras. Resolvendo
       para a falta:  faltas = agenda − tarefas − (alvo − dois − extras) */
    const extras = p.reposicoes + p.anteposicoes;
    const vindasQueAvancam = p.alvoLicoes - p.doisNoDia - extras;
    const faltas = agenda.length - p.tarefas - vindasQueAvancam;
    if (faltas < 0) { console.log(`   ${p.nome}: a agenda não comporta ${p.alvoLicoes} lições — pulada`); continue; }

    /* espalha as faltas por toda a linha do tempo em vez de amontoá-las: aluno que some some aos
       poucos, e amontoar deixaria meses inteiros limpos e outros inteiros vazios */
    const passo = agenda.length / (faltas + 1);
    const diasFalta = new Set<string>();
    for (let i = 1; i <= faltas; i++) diasFalta.add(agenda[Math.min(agenda.length - 1, Math.round(i * passo))]);
    /* os dias de tarefa e de duas lições saem dos que sobraram, bem distribuídos */
    const presentes = agenda.filter((d) => !diasFalta.has(d));
    const pega = (quantos: number, de: string[]) => {
      const r: string[] = [], salto = Math.max(1, Math.floor(de.length / (quantos + 1)));
      for (let i = 1; i <= quantos && i * salto < de.length; i++) r.push(de[i * salto]);
      return r;
    };
    const diasTarefa = new Set(pega(p.tarefas, presentes));
    const diasDois = new Set(pega(p.doisNoDia, presentes.filter((d) => !diasTarefa.has(d))));

    /* ─────────────────── frequência ─────────────────── */
    let nP = 0;
    agenda.forEach((data, i) => {
      if (diasFalta.has(data)) {
        API.lancarPresencaLote({ itens: [{ idMatricula: p.id, livro: p.livro, data, status: "F" }] });
        return;
      }
      const [dE, dS] = DESVIOS[i % DESVIOS.length];
      /* dia de duas lições: ela fica a sentada inteira, e a saída vai uma hora além */
      const fim = somaMin(p.hora, dS + (diasDois.has(data) ? 60 : 0));
      API.registrarPonto({ idMatricula: p.id, livro: p.livro, data, tipo: "entrada", hora: somaMin(p.hora, dE) });
      API.registrarPonto({ idMatricula: p.id, livro: p.livro, data, tipo: "saida", hora: fim, confirmado: true });
      nP++;
    });

    /* ===== AS AULAS EXTRAS =====
       Reposição paga falta que JÁ aconteceu; anteposição paga uma que ainda vem — e por isso fica
       fora da fila FIFO. Cada uma cai num dia que NÃO é da grade dela: é o que a define. */
    const foraDaGrade: string[] = [];
    for (let d = new Date(p.inicio + "T12:00:00"); d.toISOString().slice(0, 10) < hoje; d.setDate(d.getDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      if (!diasDaSemana.has(d.getDay()) && d.getDay() !== 0 && d.getDay() !== 6 && letivo.get(iso) !== false)
        foraDaGrade.push(iso);
    }
    const faltasOrdenadas = [...diasFalta].sort();
    const usados = new Set<string>();
    const proximoApos = (limite: string) => foraDaGrade.find((d) => d > limite && !usados.has(d));
    let rep = 0, ant = 0;
    for (const f of faltasOrdenadas) {
      if (rep >= p.reposicoes) break;
      const d = proximoApos(f);
      if (!d) break;
      usados.add(d); rep++;
      API.lancarAvulso({ idMatricula: p.id, livro: p.livro, data: d, hora: p.hora,
        motivo: "Reposição", observacao: `quita a falta de ${f.slice(8, 10)}/${f.slice(5, 7)}`, comPresenca: true });
      API.registrarPonto({ idMatricula: p.id, livro: p.livro, data: d, tipo: "entrada", hora: p.hora });
      API.registrarPonto({ idMatricula: p.id, livro: p.livro, data: d, tipo: "saida",
        hora: somaMin(p.hora, 58), confirmado: true });
    }
    for (const f of faltasOrdenadas.slice().reverse()) {
      if (ant >= p.anteposicoes) break;
      /* a anteposição vem ANTES da falta que ela cobre */
      const d = foraDaGrade.slice().reverse().find((x) => x < f && !usados.has(x));
      if (!d) break;
      usados.add(d); ant++;
      API.lancarAvulso({ idMatricula: p.id, livro: p.livro, data: d, hora: p.hora,
        motivo: "Anteposição", observacao: `adiantou a aula de ${f.slice(8, 10)}/${f.slice(5, 7)}`, comPresenca: true });
      API.registrarPonto({ idMatricula: p.id, livro: p.livro, data: d, tipo: "entrada", hora: p.hora });
      API.registrarPonto({ idMatricula: p.id, livro: p.livro, data: d, tipo: "saida",
        hora: somaMin(p.hora, 57), confirmado: true });
    }

    /* ─────── o que ainda não tem rota, escrito direto (mesmo formato do aluno-modelo) ─────── */
    const anota = (data: string, valor: string, detalhe: string) =>
      R(`INSERT INTO diario (momento,id_matricula,livro,data,tipo,valor,detalhe)
         VALUES (?,?,?,?,'ajuste',?,?)`, agora(), p.id, p.livro, data, valor, detalhe);
    for (const d of diasTarefa) {
      R("UPDATE presenca SET aulas_feitas=0 WHERE id_matricula=? AND livro=? AND data=? AND status='P'", p.id, p.livro, d);
      anota(d, "tarefa", "aula de tarefa: aconteceu e não avançou lição");
    }
    for (const d of diasDois) {
      R("UPDATE presenca SET aulas_feitas=2 WHERE id_matricula=? AND livro=? AND data=? AND status='P'", p.id, p.livro, d);
      anota(d, "2", "duas lições na mesma sentada");
    }
    /* o "Matriculado" que `salvarMatricula` carimbou com a data de hoje: a aluna foi matriculada
       uma vez só, e duas linhas iguais no mesmo contrato viram ruído na linha do tempo */
    R(`DELETE FROM aluno_situacao_historico
       WHERE id_matricula=? AND livro=? AND situacao='Matriculado' AND data<>?`, p.id, p.livro, p.matricula);

    const plan = API.getPlanejamento({ idMatricula: p.id, livro: p.livro });
    const pct = (x: number | null) => x == null ? "—" : (x * 100).toFixed(1) + "%";
    console.log(`   ${p.id} ${p.nome} · ${p.livro} · ${p.dias.map(([, n]) => n.slice(0, 3)).join("/")} ${p.hora}`);
    console.log(`      ${p.conta}`);
    console.log(`      agenda ${agenda.length} · ${nP} presenças · ${faltas} faltas · ` +
                `${rep} reposições · ${ant} anteposições · ${diasTarefa.size} de tarefa · ${diasDois.size} com duas lições`);
    console.log(`      livro ${pct(plan.progressoLivro)} × tempo ${pct(plan.progressoTempo)} · ` +
                `posição ${plan.posicao?.licao ?? "—"} · esperada ${plan.licaoEsperada ?? "—"} · ` +
                `defasagem ${plan.aulasAtraso ?? "—"} · excesso ${pct(plan.excesso)}`);
  }
}
