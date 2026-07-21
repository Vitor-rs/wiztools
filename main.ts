/* main.ts — Wizard local: Deno 2.2+ + SQLite (node:sqlite, zero dependências)
   Iniciar banco:  deno run -A main.ts --init
   Rodar:          deno run -A main.ts   →  http://localhost:8420  */
import { DatabaseSync } from "node:sqlite";

const PASTA = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/* backup automático: 1 snapshot do banco por dia em OneDrive\WizardBackup (o OneDrive ainda guarda
   histórico de versões de cada arquivo). Roda ANTES de abrir o banco — nunca copia meio-escrito.
   O banco vivo fica FORA da pasta do OneDrive de propósito: sincronizador + SQLite aberto corrompe. */
try {
  const oneDrive = Deno.env.get("OneDrive");
  if (oneDrive) {
    const dir = oneDrive + "\\WizardBackup";
    Deno.mkdirSync(dir, { recursive: true });
    const destino = dir + "\\wizard-" + new Date().toISOString().slice(0, 10) + ".db";
    let existe = true; try { Deno.statSync(destino); } catch { existe = false; }
    if (!existe) { Deno.copyFileSync(PASTA + "wizard.db", destino); console.log("Backup do dia salvo em " + destino); }
  }
} catch (e) { console.warn("Backup no OneDrive falhou (o app segue normal): " + (e as Error).message); }

const db = new DatabaseSync(PASTA + "wizard.db");
const A = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[];
const G = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any;
const R = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);

if (Deno.args.includes("--init")) {
  db.exec(await Deno.readTextFile(PASTA + "schema.sql"));
  db.exec("PRAGMA foreign_keys = OFF;"); // seed.sql grava aulas antes de aluno_livro existir; a migração abaixo preenche
  db.exec(await Deno.readTextFile(PASTA + "seed.sql"));
  db.exec("PRAGMA foreign_keys = ON;");
  migrarAlunoLivro();
  console.log("wizard.db criado com schema + dados.");
  Deno.exit(0);
}

/* migração idempotente: pré-existência de aluno_livro pra cada (id_matricula,livro) hoje em aulas —
   modalidade/vip inferidos da turma casada (se houver) ou do tipo_padrao do livro (vip=0, avulso) */
function migrarAlunoLivro() {
  const pares = A("SELECT DISTINCT id_matricula, livro FROM aulas");
  for (const p of pares) {
    if (G("SELECT 1 FROM aluno_livro WHERE id_matricula=? AND livro=?", p.id_matricula, p.livro)) continue;
    const lv = G("SELECT * FROM livros WHERE nome=?", p.livro);
    const linha = G("SELECT * FROM aulas WHERE id_matricula=? AND livro=? LIMIT 1", p.id_matricula, p.livro);
    const profs = linha ? A("SELECT f.nome FROM aula_professor ap JOIN funcionarios f ON f.id=ap.funcionario_id WHERE ap.aula_id=?", linha.id).map((x: any) => x.nome) : [];
    const turma = linha ? A("SELECT t.* FROM turmas t JOIN turma_dia td ON td.turma_id=t.id WHERE td.dia=? AND t.hora_inicio=? AND t.status='Ativa' AND (t.livro=? OR t.livro IS NULL)", linha.dia, linha.hora, p.livro)
      .find((t: any) => { const tp = A("SELECT f.nome FROM turma_professor tp JOIN funcionarios f ON f.id=tp.funcionario_id WHERE tp.turma_id=?", t.id).map((x: any) => x.nome); return !tp.length || !profs.length || tp.some((x: string) => profs.includes(x)); }) : undefined;
    const mod = turma ? "Conn" : (lv?.tipo_padrao || "Conn");
    R("INSERT INTO aluno_livro VALUES (?,?,?,?,?)", p.id_matricula, p.livro, mod, 0, "Presencial");
  }
  if (pares.length) console.log("aluno_livro: " + pares.length + " matrícula(s) migrada(s) a partir de aulas existentes.");
}

/* ===== helpers de domínio (mesmas regras do painel do Sheets) ===== */
const profsDaTurma = (id: string) => A("SELECT f.nome FROM turma_professor tp JOIN funcionarios f ON f.id=tp.funcionario_id WHERE tp.turma_id=?", id).map(r => r.nome);
const diasDaTurma = (id: string) => A("SELECT td.dia FROM turma_dia td JOIN dias d ON d.nome=td.dia WHERE td.turma_id=? ORDER BY d.ordem", id).map(r => r.dia);
/* turma não guarda mais modalidade própria — pro nome/exibição, deriva da matrícula (aluno_livro) da
   MAIORIA dos integrantes REAIS atuais (mesma regra de casamento de getIntegrantesTurma: livro igual
   e, se houver gêmea, mesma professora — não basta compartilhar dia+hora com a turma); sem integrantes
   ainda, cai no tipo_padrao do livro (ou Inter). */
function modalidadeDaTurma(t: { id: string; hora_inicio: string; livro: string | null }): string {
  const profsTurma = profsDaTurma(t.id);
  const contagem: Record<string, number> = {};
  for (const r of A("SELECT a.id, a.id_matricula, a.livro FROM aulas a JOIN turma_dia td ON td.dia=a.dia AND td.turma_id=? WHERE a.hora=?", t.id, t.hora_inicio)) {
    if (t.livro && r.livro !== t.livro) continue; // livro diferente = avulso, não integrante desta sala
    const pa = A("SELECT f.nome FROM aula_professor ap JOIN funcionarios f ON f.id=ap.funcionario_id WHERE ap.aula_id=?", r.id).map((x: any) => x.nome);
    if (profsTurma.length && pa.length && !pa.some((p: string) => profsTurma.includes(p))) continue; // gêmea de outra professora
    const mat = getMatricula(r.id_matricula, r.livro);
    if (mat && mat.vip !== 1) contagem[mat.modalidade] = (contagem[mat.modalidade] || 0) + 1; // VIP = sem turma, não vota
  }
  const melhor = Object.entries(contagem).sort((a, b) => b[1] - a[1])[0];
  if (melhor) return melhor[0];
  const lv = t.livro ? G("SELECT tipo_padrao FROM livros WHERE nome=?", t.livro) : null;
  return lv?.tipo_padrao || "Inter";
}
function turmaObj(t: any) {
  const dias = diasDaTurma(t.id), profs = profsDaTurma(t.id), mod = modalidadeDaTurma(t);
  const nome = "Tur-" + mod.toUpperCase() + (t.livro ? " | " + t.livro : "") + " | " + dias.join("+")
    + " | " + t.hora_inicio + "-" + t.hora_fim + (profs.length ? " | " + profs.join("/") : "");
  return { id: t.id, nome, livro: t.livro || "", blocoDias: dias.join("+"), horario: t.hora_inicio, horaFim: t.hora_fim,
    professores: profs, status: t.status, modalidade: mod };
}
const getTurmas = () => A("SELECT * FROM turmas").map(turmaObj);
function turmasDoSlot(dia: string, hora: string, profs: string[], livro?: string) {
  let m = getTurmas().filter(t => t.status === "Ativa" && t.horario === hora && t.blocoDias.includes(dia) && (!livro || !t.livro || t.livro === livro));
  if (m.length > 1 && profs.length) { const pm = m.filter(t => t.professores.some(p => profs.includes(p))); if (pm.length) m = pm; }
  return m;
}
const idsDosProfs = (nomes: string[]) => nomes.map(n => G("SELECT id FROM funcionarios WHERE nome=?", n)?.id).filter(Boolean) as string[];
/* categoria de apresentação do livro (dashboard): outros idiomas primeiro (Kids Esp é espanhol,
   não entra em Kids), depois faixa etária pela linha do livro */
function categoriaLivro(nome: string): string {
  if (/^(Español|Italiano|Port|Kids Esp)/i.test(nome)) return "Outros Idiomas";
  if (/^Teens/i.test(nome)) return "Teens";
  if (/^W\d/i.test(nome)) return "Ws";
  return "Kids"; // TOTS, L. Kids, KIDS, Next Gen, Pre-Teens
}
const getMatricula = (idMatricula: string, livro: string) => G("SELECT * FROM aluno_livro WHERE id_matricula=? AND livro=?", idMatricula, livro);
/* garante que exista matrícula no livro novo antes de uma cascata mudar aulas.livro (a FK exige) —
   herda modalidade/vip/tipo_encontro da matrícula de origem quando existir */
function garantirMatricula(idMatricula: string, livro: string, origemLivro?: string) {
  if (G("SELECT 1 FROM aluno_livro WHERE id_matricula=? AND livro=?", idMatricula, livro)) return;
  const base = origemLivro ? getMatricula(idMatricula, origemLivro) : null;
  const lv = G("SELECT * FROM livros WHERE nome=?", livro);
  R("INSERT INTO aluno_livro VALUES (?,?,?,?,?)", idMatricula, livro, base?.modalidade || lv?.tipo_padrao || "Conn", base?.vip || 0, base?.tipo_encontro || "Presencial");
}
/* remove a matrícula antiga se não sobrou nenhuma aula nela — sem isso, uma troca de livro (cascata de
   turma ou trocarLivroAluno) deixava um livro "fantasma" vazio na ficha do aluno (aluno só guarda o
   ESTADO ATUAL, não todo livro que já fez). */
function limparMatriculaSeVazia(idMatricula: string, livro: string) {
  if (!G("SELECT 1 FROM aulas WHERE id_matricula=? AND livro=?", idMatricula, livro))
    R("DELETE FROM aluno_livro WHERE id_matricula=? AND livro=?", idMatricula, livro);
}

/* ===== blocos de hora (fichas de impressão + prévia ao vivo, mesma lógica) ===== */
const GRUPOS_DIAS = [["Segunda", "Quarta"], ["Terça", "Quinta"], ["Sexta"], ["Sábado"]];
const grupoDoDia = (dia: string) => GRUPOS_DIAS.find(g => g.includes(dia)) || [dia];

type Linha = { id_matricula: string; nomeAluno: string; dia: string; hora: string; livro: string; profs: string[]; pendente?: boolean; matPendente?: { modalidade: string; vip: boolean } };

/* mescla horas contíguas do MESMO aluno+dia+livro+professores num único registro com contagem de
   aulas (ex.: 07:00 + 08:00 seguidas = 1 registro "2 aulas", horaFim = +2h) — cobre o caso de 2 lições
   no mesmo dia (ex.: espanhol de segunda 7h-9h) sem exigir que isso seja modelado como turma. */
function mesclarHoras(linhas: Linha[]): (Linha & { aulas: number })[] {
  const porGrupo: Record<string, Linha[]> = {};
  for (const l of linhas) (porGrupo[l.id_matricula + "|" + l.dia + "|" + l.livro + "|" + l.profs.slice().sort().join(",")] ||= []).push(l);
  const resultado: (Linha & { aulas: number })[] = [];
  for (const grupo of Object.values(porGrupo)) {
    grupo.sort((a, b) => a.hora < b.hora ? -1 : a.hora > b.hora ? 1 : 0);
    let atual: (Linha & { aulas: number }) | null = null;
    for (const l of grupo) {
      const proxima = atual ? ("0" + (parseInt(atual.hora, 10) + atual.aulas)).slice(-2) + ":00" : null;
      if (atual && l.hora === proxima) { atual.aulas++; if (l.pendente) atual.pendente = true; }
      else { atual = { ...l, aulas: 1 }; resultado.push(atual); }
    }
  }
  return resultado;
}

function montarBlocos(
  dias: string[],
  alunoOverlay?: { idMatricula: string; livro: string; itens: { idMatricula: string; nome: string; livro: string; professores: string[]; dia: string; hora: string }[]; modalidade?: string; vip?: boolean },
) {
  const prio: Record<string, number> = {}; A("SELECT * FROM prioridade").forEach(r => prio[r.tipo] = r.prioridade);
  const dInfo: Record<string, any> = {}; A("SELECT * FROM dias").forEach(r => dInfo[r.nome] = r);
  const lInfo: Record<string, any> = {}; A("SELECT * FROM livros").forEach(r => lInfo[r.nome] = r);
  /* coleta as aulas de TODOS os dias (não só os do grupo impresso): a coluna Dias mostra a semana
     completa do aluno naquele livro — quem faz Ter+Sex sai "3ª|6ª" tanto na ficha de Ter/Qui quanto
     na de Sexta (antes cada ficha mostrava só os dias do próprio grupo, e o outro dia "sumia"). */
  const linhas: Linha[] = [];
  const pendDias = alunoOverlay ? new Set(alunoOverlay.itens.map((it: any) => it.dia)) : null;
  for (const a of A("SELECT a.*, al.nome nomeAluno FROM aulas a JOIN alunos al ON al.id_matricula=a.id_matricula JOIN v_alunos v ON v.id_matricula=a.id_matricula WHERE v.status='Ativado'")) {
    // substituído pela agenda pendente — mesma regra de salvarAgendaLivro: mesmo livro em qualquer dia OU o mesmo slot (troca de livro assume o slot)
    if (alunoOverlay && a.id_matricula === alunoOverlay.idMatricula && (a.livro === alunoOverlay.livro || pendDias!.has(a.dia))) continue;
    const profs = A("SELECT f.nome FROM aula_professor ap JOIN funcionarios f ON f.id=ap.funcionario_id WHERE ap.aula_id=?", a.id).map((x: any) => x.nome);
    linhas.push({ id_matricula: a.id_matricula, nomeAluno: a.nomeAluno, dia: a.dia, hora: a.hora, livro: a.livro, profs });
  }
  if (alunoOverlay) {
    const matPendente = alunoOverlay.modalidade ? { modalidade: alunoOverlay.modalidade, vip: !!alunoOverlay.vip } : undefined;
    for (const it of alunoOverlay.itens)
      linhas.push({ id_matricula: it.idMatricula, nomeAluno: it.nome, dia: it.dia, hora: it.hora, livro: it.livro, profs: it.professores, pendente: true, matPendente });
  }

  const mesclados = mesclarHoras(linhas);
  /* dias completos da semana por aluno×livro (com contagem de aulas por dia) — alimenta a coluna Dias */
  const diasLivro: Record<string, Record<string, number>> = {};
  for (const a of mesclados) {
    const k = a.id_matricula + "|" + a.livro;
    (diasLivro[k] ||= {})[a.dia] = Math.max(diasLivro[k][a.dia] || 0, a.aulas);
  }

  const blocos: Record<string, any> = {};
  for (const a of mesclados) {
    if (!dias.includes(a.dia)) continue; // o POSICIONAMENTO em blocos segue só os dias do grupo impresso
    const mat = a.matPendente || getMatricula(a.id_matricula, a.livro);
    const vip = !!(mat && (mat.vip === 1 || mat.vip === true));
    const mod = mat?.modalidade || lInfo[a.livro]?.tipo_padrao || "Conn";
    const lv = lInfo[a.livro] || { kids: 0 };
    const t = (!vip && mod === "Conn") ? turmasDoSlot(a.dia, a.hora, a.profs, a.livro)[0] : undefined;
    const tipoKey = vip ? "Vip " + mod : (mod === "Conn" && lv.kids === 1 ? "Kids" : mod);
    /* aluno avulso com 2+ aulas seguidas (ex.: Sáb 09–11) fica no bloco da PRIMEIRA hora, de 1h —
       o "(2 au)" na coluna Dias é que informa a extensão; só turma-sala define bloco mais longo */
    const fimIndividual = ("0" + (parseInt(a.hora, 10) + 1)).slice(-2) + ":00";
    const chave = (!vip && mod === "Inter") ? "I|" + a.hora : t ? "T|" + t.id + "|" + a.hora : "A|" + tipoKey + "|" + a.livro + "|" + a.hora + "|" + a.profs.join("/");
    const b = blocos[chave] ||= { hora: a.hora, fim: t ? t.horaFim : fimIndividual,
      turmaId: t ? t.id : null, tipoKey, mod, vip, diasTurma: t ? t.blocoDias.split("+").map((x: string) => dInfo[x]?.curto || x) : [], alunos: {}, profs: [] };
    const al = b.alunos[a.id_matricula + "|" + a.livro] ||= { id: a.id_matricula, nome: a.nomeAluno, livro: a.livro, profs: [], pendente: false };
    if (a.pendente) al.pendente = true;
    a.profs.forEach(p => { if (!b.profs.includes(p)) b.profs.push(p); if (!al.profs.includes(p)) al.profs.push(p); });
  }
  const lista = Object.values(blocos).map((b: any) => ({ ...b,
    alunos: Object.values(b.alunos)
      .sort((p: any, q: any) => (lInfo[p.livro]?.ordem ?? 999) - (lInfo[q.livro]?.ordem ?? 999) || String(p.nome).localeCompare(String(q.nome), "pt")) // ordem pedagógica dos livros, não alfabética
      .map((al: any) => { const da = diasLivro[al.id + "|" + al.livro] || {};
        return { ...al, dias: Object.keys(da).map((x: string) => dInfo[x]).sort((p: any, q: any) => p.ordem - q.ordem)
          .map((x: any) => x.codigo + (da[x.nome] > 1 ? " (" + da[x.nome] + " au)" : "")).join("|") }; }) }));
  lista.sort((x: any, y: any) => x.hora !== y.hora ? (x.hora < y.hora ? -1 : 1) : (prio[x.tipoKey === "Kids" ? "Conn" : x.tipoKey] || 0) - (prio[y.tipoKey === "Kids" ? "Conn" : y.tipoKey] || 0));
  return lista;
}

/* ===== API (mesmo contrato do painel GAS) ===== */
const api: Record<string, (a: any) => unknown> = {
  getDominios() {
    const horariosPorDia: Record<string, string[]> = {};
    A("SELECT ha.dia,ha.hora FROM horario_ativo ha JOIN dias d ON d.nome=ha.dia WHERE ha.ativo=1 ORDER BY d.ordem,ha.hora")
      .forEach(r => (horariosPorDia[r.dia] = horariosPorDia[r.dia] || []).push(r.hora));
    return { situacoes: A("SELECT situacao, ativa FROM situacoes").map(r => ({ situacao: r.situacao, ativa: r.ativa === 1 })),
      modalidades: [...new Set(A("SELECT tipo FROM prioridade").map(r => String(r.tipo).replace(/^Vip\s+/i, "")))],
      dias: Object.keys(horariosPorDia), horariosPorDia,
      livros: A("SELECT * FROM livros ORDER BY ordem").map(r => ({ nome: r.nome, tipoPadrao: r.tipo_padrao, kids: r.kids === 1, tipoFixo: r.tipo_fixo === 1, categoria: categoriaLivro(r.nome) })),
      professores: A("SELECT * FROM funcionarios").map(r => ({ id: r.id, nomeCompleto: r.nome_completo, nome: r.nome })),
      turmas: getTurmas() };
  },
  getAlunos: () => A("SELECT * FROM v_alunos").map(r => ({ id: r.id_matricula, nome: r.nome, situacao: r.situacao, status: r.status })),
  salvarAluno(a) {
    if (!a?.id || !a?.nome) throw new Error("Nome e ID são obrigatórios.");
    if (!G("SELECT 1 FROM situacoes WHERE situacao=?", a.situacao)) throw new Error("Situação inválida: " + a.situacao);
    const existe = G("SELECT 1 FROM alunos WHERE id_matricula=?", a.id);
    existe ? R("UPDATE alunos SET nome=?,situacao=? WHERE id_matricula=?", a.nome, a.situacao, a.id)
           : R("INSERT INTO alunos VALUES (?,?,?)", a.id, a.nome, a.situacao);
    return { ok: true, criado: !existe, status: G("SELECT status FROM v_alunos WHERE id_matricula=?", a.id)?.status };
  },
  excluirAluno: (id) => ({ ok: true, aulasRemovidas: R("DELETE FROM aulas WHERE id_matricula=?", id).changes, aluno: R("DELETE FROM alunos WHERE id_matricula=?", id).changes }),

  /* ===== matrículas em livro (fonte da verdade de modalidade/VIP/tipo de encontro) ===== */
  getMatriculasAluno: (id) => A("SELECT * FROM aluno_livro WHERE id_matricula=?", id).map(r => ({
    livro: r.livro, modalidade: r.modalidade, vip: r.vip === 1, tipoEncontro: r.tipo_encontro })),
  salvarMatricula({ idMatricula, livro, modalidade, vip, tipoEncontro }: any) {
    if (!idMatricula || !livro) throw new Error("Aluno e livro são obrigatórios.");
    if (!G("SELECT 1 FROM alunos WHERE id_matricula=?", idMatricula)) throw new Error("Aluno não encontrado.");
    const lv = G("SELECT * FROM livros WHERE nome=?", livro); if (!lv) throw new Error("Livro inválido: " + livro);
    let mod = modalidade || lv.tipo_padrao;
    if (lv.tipo_fixo === 1) mod = lv.tipo_padrao; // TOTS/L. Kids: modalidade travada
    const existe = G("SELECT 1 FROM aluno_livro WHERE id_matricula=? AND livro=?", idMatricula, livro);
    existe ? R("UPDATE aluno_livro SET modalidade=?,vip=?,tipo_encontro=? WHERE id_matricula=? AND livro=?", mod, vip ? 1 : 0, tipoEncontro || "Presencial", idMatricula, livro)
           : R("INSERT INTO aluno_livro VALUES (?,?,?,?,?)", idMatricula, livro, mod, vip ? 1 : 0, tipoEncontro || "Presencial");
    return { ok: true, criado: !existe, modalidade: mod };
  },
  excluirMatricula({ idMatricula, livro }: any) {
    const aulasRemovidas = R("DELETE FROM aulas WHERE id_matricula=? AND livro=?", idMatricula, livro).changes;
    const removida = R("DELETE FROM aluno_livro WHERE id_matricula=? AND livro=?", idMatricula, livro).changes as number > 0;
    return { ok: true, aulasRemovidas, removida };
  },
  /* troca o livro de UMA matrícula do aluno (ex.: terminou TOTS 6, avançou pra L. Kids 2): a nova
     matrícula herda modalidade/vip/tipo_encontro, a agenda (dias/horas/professores) migra junto, e a
     matrícula antiga é removida — o aluno só guarda o livro ATUAL, não todo livro que já fez. */
  trocarLivroAluno({ idMatricula, livroAntigo, livroNovo }: any) {
    if (!idMatricula || !livroAntigo || !livroNovo) throw new Error("Aluno, livro atual e livro novo são obrigatórios.");
    if (livroAntigo === livroNovo) return { ok: true, aulasMovidas: 0 };
    const antiga = getMatricula(idMatricula, livroAntigo); if (!antiga) throw new Error("Matrícula em " + livroAntigo + " não encontrada.");
    if (G("SELECT 1 FROM aluno_livro WHERE id_matricula=? AND livro=?", idMatricula, livroNovo)) throw new Error("Aluno já está matriculado em " + livroNovo + " — remova uma das duas matrículas antes.");
    const lvNovo = G("SELECT * FROM livros WHERE nome=?", livroNovo); if (!lvNovo) throw new Error("Livro inválido: " + livroNovo);
    let mod = antiga.modalidade;
    if (lvNovo.tipo_fixo === 1) mod = lvNovo.tipo_padrao; // TOTS/L. Kids: modalidade travada
    R("INSERT INTO aluno_livro VALUES (?,?,?,?,?)", idMatricula, livroNovo, mod, antiga.vip, antiga.tipo_encontro);
    const aulasMovidas = R("UPDATE aulas SET livro=? WHERE id_matricula=? AND livro=?", livroNovo, idMatricula, livroAntigo).changes;
    R("DELETE FROM aluno_livro WHERE id_matricula=? AND livro=?", idMatricula, livroAntigo);
    return { ok: true, aulasMovidas, modalidade: mod };
  },

  /* ===== histórico de situação (linha do tempo manual: matrícula/rematrícula/etc por data) ===== */
  getHistoricoAluno: (id) => A("SELECT * FROM aluno_situacao_historico WHERE id_matricula=? ORDER BY data", id).map(r => ({ id: r.id, situacao: r.situacao, data: r.data })),
  salvarHistoricoAluno({ idMatricula, situacao, data }: any) {
    if (!idMatricula || !situacao || !data) throw new Error("Situação e data são obrigatórias.");
    if (!G("SELECT 1 FROM situacoes WHERE situacao=?", situacao)) throw new Error("Situação inválida: " + situacao);
    R("INSERT INTO aluno_situacao_historico (id_matricula,situacao,data) VALUES (?,?,?)", idMatricula, situacao, data);
    return { ok: true };
  },
  excluirHistoricoAluno: (id) => ({ ok: R("DELETE FROM aluno_situacao_historico WHERE id=?", id).changes > 0 }),

  getAulasAluno: (id) => A("SELECT * FROM aulas WHERE id_matricula=?", id).map(r => ({ linha: r.id, dia: r.dia, horario: r.hora, livro: r.livro,
    professores: A("SELECT f.nome FROM aula_professor ap JOIN funcionarios f ON f.id=ap.funcionario_id WHERE ap.aula_id=?", r.id).map(x => x.nome) })),
  salvarAgendaLivro(p) { // sincroniza a agenda do aluno NESTE livro (desmarcar = remover; mesmo slot = troca de livro)
    if (!p?.itens) throw new Error("Dados incompletos.");
    const mat = getMatricula(p.idMatricula, p.livro);
    if (!mat) throw new Error("Matricule o aluno no livro " + p.livro + " antes de definir os horários.");
    /* slots que o aluno JÁ ocupava antes deste salvamento: uma aula legada num horário que foi
       desativado na matriz depois pode ser MANTIDA (aviso, nunca bloqueio) — só slot novo em hora
       desativada é erro. Sem isso, desativar uma hora apagava a aula em silêncio no próximo save. */
    const ocupados = new Set(A("SELECT dia, hora FROM aulas WHERE id_matricula=?", p.idMatricula).map(r => r.dia + "|" + r.hora));
    const avisos: string[] = [];
    for (const it of p.itens) {
      if (!G("SELECT 1 FROM horario_ativo WHERE dia=? AND hora=? AND ativo=1", it.dia, it.horario)) {
        if (!ocupados.has(it.dia + "|" + it.horario)) throw new Error("Horário " + it.horario + " não está ativado para " + it.dia + ".");
        avisos.push(it.dia + " " + it.horario + ": horário desativado na matriz — aula mantida porque já existia.");
      }
      if (mat.vip !== 1 && mat.modalidade === "Conn") { // VIP não tem turma e Inter não casa com turma (mesma regra de montarBlocos)
        const tu = turmasDoSlot(it.dia, it.horario, p.professores || [])[0];
        if (tu && tu.livro && tu.livro !== p.livro) avisos.push(it.dia + " " + it.horario + ": o aluno fica na turma " + tu.nome + " com livro diferente — considere atualizar o livro da turma.");
      }
    }
    let removidas = R("DELETE FROM aulas WHERE id_matricula=? AND livro=?", p.idMatricula, p.livro).changes as number;
    let salvas = 0;
    const fids = idsDosProfs(p.professores || []);
    for (const it of p.itens) {
      removidas += R("DELETE FROM aulas WHERE id_matricula=? AND dia=? AND hora=?", p.idMatricula, it.dia, it.horario).changes as number;
      const r = R("INSERT INTO aulas (id_matricula,dia,hora,livro) VALUES (?,?,?,?)", p.idMatricula, it.dia, it.horario, p.livro);
      fids.forEach(f => R("INSERT INTO aula_professor VALUES (?,?)", r.lastInsertRowid, f)); salvas++;
    }
    return { ok: true, salvas, removidas, avisos };
  },
  getTurmas: () => getTurmas(),
  salvarTurma(t) {
    if (!t.blocoDias || !t.horario || !t.horaFim) throw new Error("Dias e horários são obrigatórios.");
    if (t.horaFim <= t.horario) throw new Error("Horário impossível: o fim deve ser depois do início.");
    const lv = t.livro ? G("SELECT * FROM livros WHERE nome=?", t.livro) : null;
    if (t.livro && !lv) throw new Error("Livro inválido: " + t.livro);
    const dias = String(t.blocoDias).split("+").map((x: string) => x.trim()).filter(Boolean);
    const avisos: string[] = []; // horário desativado na matriz: alerta, nunca bloqueia (regra da casa)
    for (const d of dias) for (let h = parseInt(t.horario, 10); h < parseInt(t.horaFim, 10); h++) {
      const hh = ("0" + h).slice(-2) + ":00";
      if (!G("SELECT 1 FROM horario_ativo WHERE dia=? AND hora=? AND ativo=1", d, hh))
        avisos.push(d + " " + hh + ": horário desativado na matriz — nenhum aluno poderá ser agendado nele.");
    }
    const meus = t.professores || [];
    const gemea = getTurmas().find(x => x.id !== t.id && x.status === "Ativa" && x.livro === (t.livro || "") && x.horario === t.horario && x.blocoDias === dias.join("+")
      && (!meus.length || !x.professores.length || x.professores.some(p => meus.includes(p))));
    if (gemea) throw new Error("Já existe a turma " + gemea.nome + " com o mesmo livro, dias e horário. Diferencie pela professora (salas distintas).");
    let id = t.id, antiga = id ? G("SELECT * FROM turmas WHERE id=?", id) : null;
    if (!id) { const max = G("SELECT MAX(CAST(SUBSTR(id,2) AS INTEGER)) m FROM turmas")?.m || 0; id = "T" + String(max + 1).padStart(3, "0"); }
    let aulasAtualizadas = 0;
    if (antiga) {
      if (antiga.livro && t.livro && antiga.livro !== t.livro) { // cascata: livro da sala mudou → aulas de TODOS os alunos dela (garante matrícula no livro novo primeiro)
        const profsAnt = profsDaTurma(id);
        for (const a of A("SELECT a.id, a.id_matricula FROM aulas a JOIN turma_dia td ON td.dia=a.dia AND td.turma_id=? WHERE a.hora=? AND a.livro=?", id, antiga.hora_inicio, antiga.livro)) {
          const pa = A("SELECT f.nome FROM aula_professor ap JOIN funcionarios f ON f.id=ap.funcionario_id WHERE ap.aula_id=?", a.id).map(x => x.nome);
          if (!profsAnt.length || !pa.length || pa.some(p => profsAnt.includes(p))) {
            garantirMatricula(a.id_matricula, t.livro, antiga.livro);
            R("UPDATE aulas SET livro=? WHERE id=?", t.livro, a.id); aulasAtualizadas++;
            limparMatriculaSeVazia(a.id_matricula, antiga.livro);
          }
        }
      }
      R("UPDATE turmas SET livro=?,hora_inicio=?,hora_fim=?,status=? WHERE id=?", t.livro || null, t.horario, t.horaFim, t.status || "Ativa", id);
      R("DELETE FROM turma_dia WHERE turma_id=?", id); R("DELETE FROM turma_professor WHERE turma_id=?", id);
    } else R("INSERT INTO turmas VALUES (?,?,?,?,?)", id, t.livro || null, t.horario, t.horaFim, t.status || "Ativa");
    dias.forEach((d: string) => R("INSERT INTO turma_dia VALUES (?,?)", id, d));
    idsDosProfs(meus).forEach(f => R("INSERT INTO turma_professor VALUES (?,?)", id, f));
    return { ok: true, id, nome: turmaObj(G("SELECT * FROM turmas WHERE id=?", id)).nome, aulasAtualizadas, avisos };
  },
  excluirTurma: (id) => ({ ok: R("DELETE FROM turmas WHERE id=?", id).changes > 0 }),
  atualizarLivroTurma({ idTurma, novoLivro }: any) {
    const t = G("SELECT * FROM turmas WHERE id=?", idTurma); if (!t) throw new Error("Turma " + idTurma + " não encontrada.");
    if (!G("SELECT 1 FROM livros WHERE nome=?", novoLivro)) throw new Error("Livro inválido: " + novoLivro);
    const profs = profsDaTurma(idTurma); let n = 0;
    for (const a of A("SELECT a.id, a.id_matricula FROM aulas a JOIN turma_dia td ON td.dia=a.dia AND td.turma_id=? WHERE a.hora=? AND a.livro=?", idTurma, t.hora_inicio, t.livro)) {
      const pa = A("SELECT f.nome FROM aula_professor ap JOIN funcionarios f ON f.id=ap.funcionario_id WHERE ap.aula_id=?", a.id).map(x => x.nome);
      if (!profs.length || !pa.length || pa.some(p => profs.includes(p))) {
        garantirMatricula(a.id_matricula, novoLivro, t.livro);
        R("UPDATE aulas SET livro=? WHERE id=?", novoLivro, a.id); n++;
        limparMatriculaSeVazia(a.id_matricula, t.livro);
      }
    }
    R("UPDATE turmas SET livro=? WHERE id=?", novoLivro, idTurma);
    return { ok: true, de: t.livro, para: novoLivro, aulasAtualizadas: n };
  },
  getIntegrantesTurma(idTurma) {
    const t = getTurmas().find(x => x.id === idTurma); if (!t) throw new Error("Turma não encontrada.");
    const por: Record<string, any> = {};
    for (const r of A("SELECT a.*, al.nome nomeAluno FROM aulas a JOIN alunos al ON al.id_matricula=a.id_matricula JOIN turma_dia td ON td.dia=a.dia AND td.turma_id=? WHERE a.hora=?", idTurma, t.horario)) {
      const pa = A("SELECT f.nome FROM aula_professor ap JOIN funcionarios f ON f.id=ap.funcionario_id WHERE ap.aula_id=?", r.id).map(x => x.nome);
      const mesma = pa.some(p => t.professores.includes(p));
      if (t.livro && r.livro !== t.livro && !mesma) continue;          // outro livro + outra professora = avulso
      if (t.professores.length && pa.length && !mesma) continue;        // gêmea: professora diferente = outra turma
      if (getMatricula(r.id_matricula, r.livro)?.vip === 1) continue;   // VIP = sem turma (montarBlocos também exclui)
      const m = por[r.id_matricula] ||= { id: r.id_matricula, nome: r.nomeAluno, dias: [], livros: [] };
      if (!m.dias.includes(r.dia)) m.dias.push(r.dia);
      if (!m.livros.includes(r.livro)) m.livros.push(r.livro);
    }
    return Object.values(por).map((m: any) => ({ ...m, divergente: t.livro ? m.livros.some((x: string) => x !== t.livro) : false }));
  },
  removerAlunoDaTurma({ idMatricula, idTurma }: any) {
    const t = G("SELECT * FROM turmas WHERE id=?", idTurma); if (!t) throw new Error("Turma não encontrada.");
    const n = R("DELETE FROM aulas WHERE id_matricula=? AND hora=? AND dia IN (SELECT dia FROM turma_dia WHERE turma_id=?)", idMatricula, t.hora_inicio, idTurma).changes;
    return { ok: true, aulasRemovidas: n };
  },
  getMatriz() {
    const dias = A("SELECT nome FROM dias WHERE nome IN (SELECT DISTINCT dia FROM horario_ativo) ORDER BY ordem").map(r => r.nome);
    const horas = A("SELECT DISTINCT hora FROM horario_ativo ORDER BY hora").map(r => r.hora);
    return { dias, horas, valores: horas.map(h => dias.map(d => G("SELECT ativo FROM horario_ativo WHERE dia=? AND hora=?", d, h)?.ativo === 1 ? 1 : 0)) };
  },
  salvarMatriz(valores) {
    const m = api.getMatriz({}) as any;
    m.horas.forEach((h: string, i: number) => m.dias.forEach((d: string, j: number) => R("UPDATE horario_ativo SET ativo=? WHERE dia=? AND hora=?", valores[i][j] === 1 ? 1 : 0, d, h)));
    return { ok: true };
  },
  /* visão geral (aba Início): 1 linha por matrícula (aluno×livro), pronta pra grade — dias como
     códigos ("3ª","Sáb"), professores como lista (o front rende pílulas) e faixa horário–fim */
  getVisaoGeral() {
    const dInfo: Record<string, any> = {}; A("SELECT * FROM dias").forEach(r => dInfo[r.nome] = r);
    return A(`SELECT al.id_matricula idm, al.livro, al.modalidade, al.vip, al.tipo_encontro tipo,
        alu.nome, alu.situacao, v.status FROM aluno_livro al
        JOIN alunos alu ON alu.id_matricula=al.id_matricula JOIN v_alunos v ON v.id_matricula=al.id_matricula
        ORDER BY alu.nome, al.livro`).map(r => {
      const aulas = A("SELECT dia, hora FROM aulas WHERE id_matricula=? AND livro=? ORDER BY hora", r.idm, r.livro);
      const profs = aulas.length ? A(`SELECT DISTINCT f.nome FROM aula_professor ap JOIN aulas a ON a.id=ap.aula_id
        JOIN funcionarios f ON f.id=ap.funcionario_id WHERE a.id_matricula=? AND a.livro=?`, r.idm, r.livro).map((x: any) => x.nome) : [];
      const dias = [...new Set(aulas.map((a: any) => a.dia))].map(d => dInfo[d]).filter(Boolean)
        .sort((p: any, q: any) => p.ordem - q.ordem).map((d: any) => d.codigo);
      const horaFim = aulas.length ? ("0" + (parseInt(aulas[aulas.length - 1].hora, 10) + 1)).slice(-2) + ":00" : "";
      return { id: r.idm, nome: r.nome, situacao: r.situacao, status: r.status, livro: r.livro, modalidade: r.modalidade,
        vip: r.vip === 1, tipoEncontro: r.tipo, dias, horario: aulas[0]?.hora || "", horaFim, professores: profs };
    });
  },
  fichas: ({ dias }: any) => montarBlocos(dias), // dados p/ aba Impressão — mesmas regras do Gerador.gs

  /* prévia ao vivo (não grava nada): mesma agenda pendente que salvarAgendaLivro salvaria, mas só simulada.
     modalidade/vip: se a matrícula já existe, vem do banco; se for uma matrícula nova ainda não salva,
     o chamador manda modalidade/vip junto pra prévia refletir a configuração pendente também. */
  previewAgendaAluno({ idMatricula, nome, livro, professores, itens, modalidade, vip }: any) {
    if (!livro || !itens || !itens.length) return [];
    const dias = [...new Set(itens.flatMap((it: any) => grupoDoDia(it.dia)))] as string[];
    const overlay = { idMatricula: idMatricula || "__preview__", livro, modalidade, vip,
      itens: itens.map((it: any) => ({ idMatricula: idMatricula || "__preview__", nome: nome || "(novo aluno)", livro, professores: professores || [], dia: it.dia, hora: it.horario || it.hora })) };
    // só o(s) bloco(s) que de fato contêm a edição pendente (não todo bloco que calhe de cair na mesma hora)
    return montarBlocos(dias, overlay).filter((b: any) => b.alunos.some((al: any) => al.pendente));
  },
  /* prévia ao vivo de uma turma-sala (livro/dias/horário/professores ainda não salvos).
     Usa os integrantes REAIS atuais da turma (mesma regra de getIntegrantesTurma) — evita reatribuir
     alunos de OUTRA turma que calhe de compartilhar o mesmo livro/horário quando falta professora para
     desempatar (ver Esquema/pendências). Modalidade/VIP de cada membro vêm da própria matrícula dele. */
  previewTurma(t: any) {
    if (!t?.blocoDias || !t?.horario) return [];
    const dias = String(t.blocoDias).split("+").map((x: string) => x.trim()).filter(Boolean);
    const dInfo: Record<string, any> = {}; A("SELECT * FROM dias").forEach(r => dInfo[r.nome] = r);
    const lv = t.livro ? G("SELECT * FROM livros WHERE nome=?", t.livro) : null;
    const diasTurma = dias.map((d: string) => dInfo[d]?.curto || d);

    const existente = t.id ? getTurmas().find(x => x.id === t.id) : undefined;
    const alunosMap: Record<string, any> = {};
    const contagem: Record<string, number> = {}; // modalidade por MAIORIA dos integrantes (mesma regra de modalidadeDaTurma)
    if (existente) {
      for (const r of A("SELECT a.*, al.nome nomeAluno FROM aulas a JOIN alunos al ON al.id_matricula=a.id_matricula JOIN turma_dia td ON td.dia=a.dia AND td.turma_id=? WHERE a.hora=?", existente.id, existente.horario)) {
        const pa = A("SELECT f.nome FROM aula_professor ap JOIN funcionarios f ON f.id=ap.funcionario_id WHERE ap.aula_id=?", r.id).map((x: any) => x.nome);
        const mesma = pa.some((p: string) => existente.professores.includes(p));
        if (existente.livro && r.livro !== existente.livro && !mesma) continue; // outro livro + outra professora = avulso
        if (existente.professores.length && pa.length && !mesma) continue; // gêmea: professora diferente = outra turma
        const mat = getMatricula(r.id_matricula, r.livro);
        if (mat?.vip === 1) continue; // VIP = sem turma (montarBlocos também exclui)
        // simula a cascata de salvarTurma: só quem estava no livro ANTIGO da turma acompanha o livro pendente
        const livroPendente = (existente.livro && r.livro === existente.livro && t.livro) ? t.livro : r.livro;
        if (mat) contagem[mat.modalidade] = (contagem[mat.modalidade] || 0) + 1;
        const al = alunosMap[r.id_matricula] ||= { nome: r.nomeAluno, dias: [], livro: livroPendente, profs: pa };
        if (!al.dias.includes(r.dia)) al.dias.push(r.dia);
      }
    }
    const melhor = Object.entries(contagem).sort((a, b) => b[1] - a[1])[0];
    const mod = melhor ? melhor[0] : (lv?.tipo_padrao || "Inter"); // sem integrantes: mesmo fallback de modalidadeDaTurma
    const vip = false; // turma nunca é VIP (VIP = sem turma)
    const tipoKey = mod === "Conn" && lv?.kids === 1 ? "Kids" : mod;
    const alunos = Object.values(alunosMap).map((al: any) => ({ ...al,
      dias: al.dias.map((x: string) => dInfo[x]).sort((p: any, q: any) => p.ordem - q.ordem).map((x: any) => x.codigo).join("|") }));
    return [{ hora: t.horario, fim: t.horaFim, turmaId: t.id || null, tipoKey, mod, vip, diasTurma, alunos, profs: t.professores || [] }];
  },
};

/* ===== servidor ===== */
Deno.serve({ port: 8420 }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) {
    try {
      const fn = url.pathname.slice(5);
      if (!api[fn]) throw new Error("Função desconhecida: " + fn);
      const args = req.method === "POST" ? await req.json() : Object.fromEntries(url.searchParams);
      if (fn === "fichas" && typeof (args as any).dias === "string") (args as any).dias = (args as any).dias.split(",");
      return Response.json(api[fn](args));
    } catch (e) { return Response.json({ erro: (e as Error).message }, { status: 400 }); }
  }
  const arquivo = url.pathname === "/" ? "app.html" : decodeURIComponent(url.pathname.slice(1));
  if (arquivo.includes("..") || arquivo.includes("\\")) return new Response("não encontrado", { status: 404 });
  const tipo = arquivo.endsWith(".html") ? "text/html; charset=utf-8"
    : arquivo.endsWith(".js") ? "application/javascript; charset=utf-8"
    : arquivo.endsWith(".css") ? "text/css; charset=utf-8"
    : "text/plain; charset=utf-8";
  try { return new Response(await Deno.readTextFile(PASTA + arquivo), { headers: { "content-type": tipo } }); }
  catch { return new Response("não encontrado", { status: 404 }); }
});
console.log("Wizard local em http://localhost:8420  (painel único: Alunos, Turmas, Horários e Impressão)");
