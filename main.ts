/* main.ts — Wizard local: Deno 2.2+ + SQLite (node:sqlite, zero dependências)
   Iniciar banco:  deno run -A main.ts --init
   Rodar:          deno run -A main.ts   →  http://localhost:8420  */
import { DatabaseSync } from "node:sqlite";

const PASTA = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const db = new DatabaseSync(PASTA + "wizard.db");
const A = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[];
const G = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any;
const R = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);

/* Banco novo, a partir do schema + dados de partida. Vem ANTES das migrações de subida de propósito:
   elas pressupõem as tabelas do schema.sql já existindo, e num arquivo recém-nascido o índice em
   `aulas` morria com "no such table: main.aulas" — ou seja, instalar numa máquina nova não funcionava.
   Nada se perde na troca de ordem: o schema.sql já nasce com tudo que as migrações aplicariam. */
if (Deno.args.includes("--init")) {
  db.exec(await Deno.readTextFile(PASTA + "schema.sql"));
  db.exec("PRAGMA foreign_keys = OFF;"); // seed.sql grava aulas antes de aluno_livro existir; a migração abaixo preenche
  db.exec(await Deno.readTextFile(PASTA + "seed.sql"));
  db.exec("PRAGMA foreign_keys = ON;");
  migrarAlunoLivro();
  console.log("wizard.db criado com schema + dados.");
  Deno.exit(0);
}

db.exec("CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)"); // migração aditiva (preferências, ex.: pasta de backup)
/* presença: 1 linha = aluno × livro × DIA (a hora não entra — regra da recepção: se o aluno vem
   fora do horário dele, a presença vale para o dia, no horário próprio dele). `livro` é texto solto
   de propósito (sem FK pra aluno_livro): trocar de livro não pode apagar histórico de frequência.
   Lançamento em data FUTURA é legítimo: aluno que avisa que vai viajar tem a falta lançada adiantada.
   O corpo é const porque serve a dois usos que NUNCA podem divergir: criar a tabela num banco novo e
   reconstruí-la (reconstruirTabela, mais abaixo) num banco que nasceu antes destas regras. */
const CORPO_PRESENCA = `
  id_matricula TEXT NOT NULL REFERENCES alunos(id_matricula) ON DELETE CASCADE,
  livro TEXT NOT NULL,                 -- texto solto de propósito: trocar de livro não apaga frequência
  data TEXT NOT NULL CHECK (data GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'), -- 'AAAA-MM-DD'
  status TEXT NOT NULL CHECK (status IN ('P','F','N')), -- Presente | Falta | Não aula (não conta pra nada)
  entrada TEXT CHECK (entrada IS NULL OR entrada GLOB '[0-2][0-9]:[0-5][0-9]'), -- check-in na recepção
  saida   TEXT CHECK (saida   IS NULL OR saida   GLOB '[0-2][0-9]:[0-5][0-9]'), -- check-out
  aulas_feitas INTEGER,                -- quantas lições cumpridas no dia (NULL = todas as previstas)
  licoes TEXT,                         -- QUAIS lições, por hora: '11:00' ou '10:00,11:00'
  auto INTEGER NOT NULL DEFAULT 0 CHECK (auto IN (0,1)), -- 1 = falta lançada pelo fecho do dia, não por gente
  minutos INTEGER GENERATED ALWAYS AS (   -- duração da aula: derivada, nunca dessincroniza
    CASE WHEN entrada IS NOT NULL AND saida IS NOT NULL THEN
      (CAST(substr(saida,1,2) AS INTEGER)*60 + CAST(substr(saida,4,2) AS INTEGER))
    - (CAST(substr(entrada,1,2) AS INTEGER)*60 + CAST(substr(entrada,4,2) AS INTEGER)) END) VIRTUAL,
  CHECK (saida IS NULL OR entrada IS NOT NULL),  -- não existe saída sem entrada
  CHECK (saida IS NULL OR saida >= entrada),     -- saída nunca antes da entrada
  CHECK (status='P' OR entrada IS NULL),         -- só quem esteve presente tem ponto
  PRIMARY KEY (id_matricula, livro, data)`;
db.exec(`CREATE TABLE IF NOT EXISTS presenca (${CORPO_PRESENCA})`);

/* migrações aditivas idempotentes: rodam a cada subida e são seguras num banco já em uso
   (a recepção só recebe código novo — o wizard.db dela nunca é recriado). */
/* table_xinfo (e não table_info): colunas GERADAS não aparecem em table_info, então a migração
   tentava recriá-las a cada subida e o servidor morria com "duplicate column name". */
function colunas(tabela: string) { return A(`PRAGMA table_xinfo(${tabela})`).map(c => c.name); }
function addColuna(tabela: string, coluna: string, def: string) {
  if (!colunas(tabela).includes(coluna)) { R(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${def}`); console.log("migração: " + tabela + "." + coluna + " criada"); }
}
addColuna("presenca", "entrada", "TEXT"); // 'HH:MM' — check-in feito na recepção
addColuna("presenca", "saida", "TEXT");   // 'HH:MM' — check-out
/* marca a falta que o FECHO DO DIA lançou sozinho (ver aplicarFaltasAutomaticas). Serve para a tela
   dizer "ninguém decidiu isto, o dia acabou e ninguém lançou nada" — uma falta digitada por gente e
   uma falta por omissão valem a mesma coisa na frequência, mas não merecem a mesma confiança. */
addColuna("presenca", "auto", "INTEGER NOT NULL DEFAULT 0");
/* duração da aula em minutos: coluna GERADA, o SQLite calcula a partir de entrada/saída.
   Não é campo gravado de propósito — assim nunca fica dessincronizado de um ajuste de horário. */
/* aulas_feitas: quantas LIÇÕES o aluno cumpriu no dia. NULL = cumpriu todas as previstas (o caso
   normal). Quem faz 2 aulas seguidas e sai depois da primeira fica com 1 — a falta é da AULA, não
   do dia, e a ficha impressa precisa distinguir "veio e fez tudo" de "veio e fez metade". */
addColuna("presenca", "aulas_feitas", "INTEGER");
/* licoes: QUAIS lições foram cumpridas, como lista de horas ('11:00' ou '10:00,11:00'). Saber
   apenas a quantidade não basta — faltar a 1ª e fazer a 2ª é diferente de fazer a 1ª e sair, e a
   ficha precisa dizer qual. É a fonte da verdade; aulas_feitas guarda a contagem correspondente. */
addColuna("presenca", "licoes", "TEXT");
/* diário: trilha de auditoria append-only. Cada lançamento vira uma linha com id próprio, para
   responder "quem marcou o quê e quando" mesmo depois de o registro atual ser alterado. */
db.exec(`CREATE TABLE IF NOT EXISTS diario (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  momento TEXT NOT NULL,               -- 'AAAA-MM-DD HH:MM:SS' do relógio da recepção
  id_matricula TEXT NOT NULL,
  livro TEXT,
  data TEXT,                           -- o dia letivo a que o lançamento se refere
  tipo TEXT NOT NULL,                  -- entrada | saida | status | aulas | limpeza
  valor TEXT,                          -- o que foi gravado (hora, P/F/N, nº de aulas...)
  detalhe TEXT                         -- texto livre: motivo, aviso confirmado, etc.
)`);
db.exec("CREATE INDEX IF NOT EXISTS ix_diario_matricula ON diario(id_matricula, data)");
db.exec("CREATE INDEX IF NOT EXISTS ix_diario_momento ON diario(momento)");
/* Encontro AVULSO: aluno que vem num dia/hora fora da agenda dele (reposição, anteposição, reforço,
   preparação). `aulas` é a agenda FIXA — dia da semana, toda semana — e não sabe falar de UMA data,
   então é isto que faz o aluno brotar no bloco daquela hora nas duas telas de lançamento.
   Dois fluxos, mesma tabela: lançado na hora junto com a presença, ou lançado ANTES pela recepção
   ("fulano vem às 15h"), aí sem presença até alguém confirmar que ele chegou. Previsto que não veio
   fica em branco e não vira falta sozinho — falta é sempre lançamento humano. */
db.exec(`CREATE TABLE IF NOT EXISTS encontro_avulso (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  id_matricula TEXT NOT NULL REFERENCES alunos(id_matricula) ON DELETE CASCADE,
  livro TEXT NOT NULL,                 -- texto solto, como em presenca: trocar de livro não apaga histórico
  data TEXT NOT NULL CHECK (data GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  hora TEXT NOT NULL CHECK (hora GLOB '[0-2][0-9]:[0-5][0-9]'),
  motivo TEXT NOT NULL CHECK (motivo IN ('Reposição','Anteposição','Reforço','Preparação','Outro')),
  observacao TEXT,
  momento TEXT NOT NULL,
  UNIQUE (id_matricula, livro, data, hora)
)`);
db.exec("CREATE INDEX IF NOT EXISTS ix_avulso_data ON encontro_avulso(data, hora)");
db.exec("CREATE INDEX IF NOT EXISTS ix_avulso_matricula ON encontro_avulso(id_matricula)");
/* TROCA DE HORÁRIO: aluno da Wizard muda de horário com frequência — alguns duas vezes no mês.
   `aulas` guarda só o horário ATUAL, então trocar apagava silenciosamente o anterior e não sobrava
   como saber desde quando ele está na terça/quinta.
   Isso importa para a frequência: o sistema interno da escola recalcula a presença do aluno desde o
   começo quando o horário muda, e passa a julgar por terça/quinta um período em que ele fazia
   segunda/quarta. Guardando QUANDO cada troca aconteceu, cada período pode ser lido com o horário
   que valia nele. Aqui a tabela só REGISTRA — nenhum cálculo de frequência depende dela ainda.
   `antes`/`depois` são a agenda em texto canônico ('2ª 14:00 · 4ª 14:00'): é histórico para ler,
   não índice para consultar, e texto sobrevive a livro trocado e a hora desativada na matriz. */
db.exec(`CREATE TABLE IF NOT EXISTS aluno_horario_historico (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  id_matricula TEXT NOT NULL REFERENCES alunos(id_matricula) ON DELETE CASCADE,
  livro TEXT NOT NULL,                 -- texto solto, como em presenca
  antes TEXT NOT NULL,                 -- agenda que estava valendo ('' = não tinha)
  depois TEXT NOT NULL,                -- agenda que passou a valer ('' = ficou sem horário)
  momento TEXT NOT NULL                -- 'AAAA-MM-DD HH:MM:SS' do relógio da recepção
)`);
db.exec("CREATE INDEX IF NOT EXISTS ix_hhist_matricula ON aluno_horario_historico(id_matricula, livro)");

/* ===== ESTOQUE DE MATERIAL =====
   Modelo tirado do caderno de papel da escola, não de um ERP. A coluna "05/05 Pedido" do caderno
   mostrou que as colunas dele não são só contagens: são EVENTOS DATADOS de tipos diferentes. Daí
   `estoque_evento` (contagem | pedido | remessa) com uma linha por item em `estoque_evento_item`.
   A SAÍDA não é evento digitado: é derivada de `entrega_material` (o livro que foi para um aluno),
   porque a recepção pensa "entreguei o W4 para a Ana", não "saíram 3 W4".
   SALDO = última contagem + remessas − entregas POSTERIORES a ela. A contagem é a palavra final:
   ninguém registra cada livro que sai, e quem corrige a deriva é a próxima conferência. */
db.exec(`CREATE TABLE IF NOT EXISTS estoque_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  descricao TEXT NOT NULL,
  codigo TEXT,                         -- código interno curto, DIGITADO (não há leitor de barras)
  livro TEXT REFERENCES livros(nome),  -- NULL quando o item não é livro (Wiz.pen, mochila)
  unidade TEXT NOT NULL DEFAULT 'unidade' CHECK (unidade IN ('unidade','kit')),
  finalidade TEXT NOT NULL DEFAULT 'venda' CHECK (finalidade IN ('venda','consumo','professor')),
  minimo INTEGER NOT NULL DEFAULT 0,   -- Est. Mín. do Sponte: alimenta a sugestão de pedido
  ativo INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0,1)),
  ordem INTEGER NOT NULL DEFAULT 900   -- ordem pedagógica (livros.ordem); não-livros vão para o fim
)`);
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_estoque_item_livro ON estoque_item(livro) WHERE livro IS NOT NULL");
db.exec(`CREATE TABLE IF NOT EXISTS estoque_evento (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL CHECK (tipo IN ('contagem','pedido','remessa')),
  data TEXT NOT NULL CHECK (data GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  observacao TEXT,
  momento TEXT NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS estoque_evento_item (
  evento_id INTEGER NOT NULL REFERENCES estoque_evento(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES estoque_item(id) ON DELETE CASCADE,
  quantidade INTEGER NOT NULL,
  nota TEXT,                           -- o "3 no 1º ano" a lápis na margem do caderno
  PRIMARY KEY (evento_id, item_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS estoque_kit_item (
  kit_id INTEGER NOT NULL REFERENCES estoque_item(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES estoque_item(id) ON DELETE CASCADE,
  quantidade INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (kit_id, item_id)
)`);
/* Entrega: o livro que foi para a mão do aluno. Ligada à MATRÍCULA (id_matricula + livro), que é o
   que a recepção tem em mãos. `data` é EDITÁVEL e começa nula quando a entrega é deduzida das
   matrículas que já existiam — não há registro histórico de quando cada livro foi entregue, e
   inventar uma data seria pior que admitir que não se sabe. */
db.exec(`CREATE TABLE IF NOT EXISTS entrega_material (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  id_matricula TEXT NOT NULL REFERENCES alunos(id_matricula) ON DELETE CASCADE,
  livro TEXT NOT NULL,                 -- texto solto, como em presenca
  item_id INTEGER REFERENCES estoque_item(id) ON DELETE SET NULL,
  data TEXT,                           -- NULL = entregue em data desconhecida (deduzida da matrícula)
  deduzida INTEGER NOT NULL DEFAULT 0 CHECK (deduzida IN (0,1)), -- 1 = veio do vínculo automático
  momento TEXT NOT NULL,
  UNIQUE (id_matricula, livro)
)`);
db.exec("CREATE INDEX IF NOT EXISTS ix_entrega_item ON entrega_material(item_id, data)");
db.exec("CREATE INDEX IF NOT EXISTS ix_ev_item ON estoque_evento_item(item_id)");

/* ===== BIBLIOTECA · ESTÁGIOS =====
   O estágio é o livro como ESTRUTURA PEDAGÓGICA — o livro físico que se conta vive em
   `estoque_item`. Os dois se ligam, mas não são a mesma coisa: o Kids 4 tem duas edições
   (2014 e 3rd Edition) e um item de estoque para cada.

   A ideia que sustenta o módulo: **o estágio não guarda lições**. Ele guarda um MODELO
   (quantas lições por capítulo, quantos capítulos) e as lições são geradas por cálculo. Toda a
   Wizard cabe em três modelos, porque todo livro tem exatamente 60 lições comuns — o que muda é
   o agrupamento (6 capítulos de 10, ou 10 de 6) e daí quantas revisões existem.
   As ÚNICAS lições digitadas são as especiais (Welcome, Useful Language...) e as remind, porque
   elas não seguem regra nenhuma. */
db.exec(`CREATE TABLE IF NOT EXISTS estagio_modelo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  licoes_por_capitulo INTEGER NOT NULL,
  capitulos INTEGER NOT NULL
)`);
/* `licao_inicial` é DADO, não regra derivada. A dedução "porta de entrada reinicia na lição 1" é
   um bom padrão, mas quebra no Kids 4 de 2014, que começa na 61 enquanto a 3rd Edition começa na
   1. Guardar o número resolve a exceção sem caso especial no código. */
db.exec(`CREATE TABLE IF NOT EXISTS estagio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sigla TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  idioma TEXT NOT NULL DEFAULT 'Inglês',
  categoria TEXT NOT NULL DEFAULT 'Kids',
  grupo TEXT,
  modelo_id INTEGER REFERENCES estagio_modelo(id),
  licao_inicial INTEGER NOT NULL DEFAULT 1,
  entrada INTEGER NOT NULL DEFAULT 0 CHECK (entrada IN (0,1)),
  ordem INTEGER NOT NULL DEFAULT 100,        -- posição na trilha da categoria
  idade_min INTEGER, idade_max INTEGER,      -- informativos, preenchidos à mão
  escala_ativa INTEGER NOT NULL DEFAULT 0 CHECK (escala_ativa IN (0,1)),
  cefr_min TEXT, cefr_max TEXT, gse_min INTEGER, gse_max INTEGER,
  edicao_nome TEXT, edicao_ano INTEGER,
  status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','legado','lancamento')),
  livro TEXT REFERENCES livros(nome),        -- ponte com matrículas/aulas/impressão
  item_estoque_id INTEGER REFERENCES estoque_item(id) ON DELETE SET NULL,
  descricao TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS estagio_licao_extra (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estagio_id INTEGER NOT NULL REFERENCES estagio(id) ON DELETE CASCADE,
  ordem INTEGER NOT NULL DEFAULT 1,
  rotulo TEXT NOT NULL,
  posicao TEXT NOT NULL DEFAULT 'abertura' CHECK (posicao IN ('abertura','flutuante'))
)`);
/* trilha: LISTA, não coluna. Do Kids 4 pode-se ir ao Next Gen OU ao Pre-Teens, e a sequência é
   sugestão — o aluno pode saltar (Teens 2 → W4). */
db.exec(`CREATE TABLE IF NOT EXISTS estagio_proximo (
  de_id INTEGER NOT NULL REFERENCES estagio(id) ON DELETE CASCADE,
  para_id INTEGER NOT NULL REFERENCES estagio(id) ON DELETE CASCADE,
  PRIMARY KEY (de_id, para_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS estagio_equivalente (
  a_id INTEGER NOT NULL REFERENCES estagio(id) ON DELETE CASCADE,
  b_id INTEGER NOT NULL REFERENCES estagio(id) ON DELETE CASCADE,
  PRIMARY KEY (a_id, b_id)
)`);
db.exec("CREATE INDEX IF NOT EXISTS ix_estagio_livro ON estagio(livro)");
db.exec("CREATE INDEX IF NOT EXISTS ix_licao_extra ON estagio_licao_extra(estagio_id)");

/* ===== CONTRATO =====
   A matrícula é o número do ALUNO, gerada quando ele é cadastrado. O contrato é o vínculo dele
   com UM curso: `matrícula/N`, onde N é a ordem em que os vínculos foram criados — não importa o
   livro nem o idioma. A Rafaela tem o Little Kids 2 como /2 e o espanhol como /3.
   Guardamos só o N: a parte antes da barra é a própria matrícula e duplicá-la só criaria chance
   de divergir. */
addColuna("aluno_livro", "contrato_seq", "INTEGER");

/* sigla curta a partir do nome do livro ('L. Kids 2' → 'LK2', 'Español 4' → 'ESP4').
   É SUGESTÃO: o código de verdade é o interno da escola, que ninguém digitou ainda. Serve para
   buscar enquanto isso, e o campo é editável na tela. */
function siglaLivro(nome: string) {
  const num = (nome.match(/\d+/) || [""])[0];
  const palavras = nome.replace(/\d+/g, "").replace(/[.\-]/g, " ").trim().split(/\s+/).filter(Boolean);
  const base = palavras.length > 1 ? palavras.map(p => p[0]).join("") : (palavras[0] || "").slice(0, 4);
  return (base + num).toUpperCase().replace(/[^A-Z0-9]/g, "");
}
/* Semeadura do estoque. Roda uma vez só (marca em `config`), porque ela DEDUZ entregas a partir das
   matrículas que já existem: rodar de novo repovoaria entregas que a recepção tivesse apagado, e
   aluno matriculado DEPOIS da semeadura deve mesmo aparecer como pendente — ele ainda não recebeu
   o livro. Os ITENS, esses, são reconciliados sempre: livro novo no catálogo vira item novo. */
function semearEstoque() {
  for (const lv of A("SELECT nome, ordem FROM livros ORDER BY ordem")) {
    if (G("SELECT 1 FROM estoque_item WHERE livro=?", lv.nome)) continue;
    R("INSERT INTO estoque_item (descricao,codigo,livro,unidade,finalidade,minimo,ordem) VALUES (?,?,?,'unidade','venda',0,?)",
      lv.nome, siglaLivro(lv.nome), lv.nome, lv.ordem);
  }
  if (G("SELECT valor FROM config WHERE chave='estoque_semeado'")) return { itens: 0, entregas: 0 };
  /* único item não-livro com evidência: a linha "wizpens" do caderno. Não invento mochila/pasta —
     o que a escola controla de verdade se descobre contando, não supondo. */
  if (!G("SELECT 1 FROM estoque_item WHERE descricao='Wiz.pen'"))
    R("INSERT INTO estoque_item (descricao,codigo,livro,unidade,finalidade,minimo,ordem) VALUES ('Wiz.pen','WIZPEN',NULL,'unidade','venda',0,901)");
  /* entregas deduzidas: quem está matriculado num livro está estudando com ele, logo já o recebeu.
     Sem data — não existe registro de quando cada um recebeu, e inventar seria pior que admitir.
     A tela deixa a data editável justamente para a recepção preencher o que souber. */
  let entregas = 0;
  for (const m of A(`SELECT al.id_matricula, al.livro FROM aluno_livro al
      JOIN alunos a ON a.id_matricula=al.id_matricula
      JOIN situacoes s ON s.situacao=a.situacao WHERE s.ativa=1`)) {
    if (G("SELECT 1 FROM entrega_material WHERE id_matricula=? AND livro=?", m.id_matricula, m.livro)) continue;
    const it = G("SELECT id FROM estoque_item WHERE livro=?", m.livro);
    R("INSERT INTO entrega_material (id_matricula,livro,item_id,data,deduzida,momento) VALUES (?,?,?,NULL,1,?)",
      m.id_matricula, m.livro, it?.id ?? null, agora());
    entregas++;
  }
  R("INSERT OR REPLACE INTO config (chave,valor) VALUES ('estoque_semeado',?)", agora());
  console.log("estoque: semeado — " + entregas + " entrega(s) deduzida(s) das matrículas ativas");
  return { itens: A("SELECT 1 FROM estoque_item").length, entregas };
}

/* Catálogo de estágios da Wizard, do relato do Vitor (2026-08-09).
   [sigla, nome, idioma, categoria, grupo, modelo, licaoInicial, entrada, ordem, status,
    edicaoNome, edicaoAno, livro, especiais[], remind] */
const CAT_ESTAGIOS: any[] = [
  ["TOTS 2","TOTS 2","Inglês","Kids","Tots","cap11",1,1,1,"ativo","Oficial",null,"TOTS 2",["Welcome Lesson","Classroom Talk"],4],
  ["TOTS 4","TOTS 4","Inglês","Kids","Tots","cap11",61,0,2,"ativo","Oficial",null,"TOTS 4",["Welcome Back Lesson"],4],
  ["TOTS 6","TOTS 6","Inglês","Kids","Tots","cap11",121,0,3,"ativo","Oficial",null,"TOTS 6",["Welcome Back Lesson"],4],
  ["L. Kids 2","Little Kids 2","Inglês","Kids","Little Kids","cap11",1,1,4,"ativo","Oficial",null,"L. Kids 2",["Welcome Lesson"],4],
  ["L. Kids 4","Little Kids 4","Inglês","Kids","Little Kids","cap11",61,0,5,"ativo","Oficial",null,"L. Kids 4",["Welcome Back Lesson"],4],
  ["KIDS 2","Kids 2","Inglês","Kids","Kids","cap7",1,1,6,"ativo","3rd Edition",2020,"KIDS 2",["Welcome Lesson"],0],
  ["KIDS 4","Kids 4","Inglês","Kids","Kids","cap7",1,1,7,"ativo","3rd Edition",2020,"KIDS 4",["Welcome Lesson"],0],
  /* mesma posição de trilha do anterior, edição antiga: numera 61–120 em vez de 1–60 */
  ["KIDS 4 ANT","Kids 4 — edição antiga","Inglês","Kids","Kids","cap7",61,0,7,"legado","Antiga",2014,"KIDS 4",["Welcome Lesson"],0],
  ["NG","NEW K6 (Next Generation)","Inglês","Kids","Next Generation","cap7",1,1,8,"legado","Oficial",2014,"Next Gen",["Useful Language"],0],
  ["PRE","Pre-Teens","Inglês","Kids","Pre-Teens","cap7",1,1,8,"lancamento","Oficial",2025,"Pre-Teens",["Welcome Lesson"],0],
  ["T2","New Teens 2","Inglês","Teens","Teens 3rd","cap7",1,1,1,"ativo","3rd Edition",null,"Teens 2",["Useful Language"],0],
  ["T4","New Teens 4","Inglês","Teens","Teens 3rd","cap7",61,0,2,"ativo","3rd Edition",null,"Teens 4",["Welcome Back Lesson"],0],
  ["T6","New Teens 6","Inglês","Teens","Teens 3rd","cap7",121,0,3,"ativo","3rd Edition",null,"Teens 6",["Welcome Back Lesson"],0],
  ["T8","New Teens 8","Inglês","Teens","Teens 3rd","cap7",181,0,4,"ativo","3rd Edition",null,"Teens 8",["Welcome Back Lesson"],0],
  ["W2","New W2","Inglês","W","W New","cap7",1,1,1,"ativo","New",null,"W2",["Useful Language"],0],
  ["W4","New W4","Inglês","W","W New","cap7",61,0,2,"ativo","New",null,"W4",["Welcome Back Lesson"],0],
  ["W6","New W6","Inglês","W","W New","cap7",121,0,3,"ativo","New",null,"W6",["Welcome Back Lesson"],0],
  ["W8","New W8","Inglês","W","W New","cap7",181,0,4,"ativo","New",null,"W8",["Welcome Back Lesson"],0],
  ["W10","New W10","Inglês","W","W New","cap7",241,0,5,"ativo","New",null,"W10",["Welcome Back Lesson"],0],
  ["W12","New W12","Inglês","W","W New","cap7",301,0,6,"ativo","New",null,"W12",["Welcome Back Lesson"],0],
  ["ESP2","Español 2","Espanhol","Outros Idiomas","Spanish","cap7i",1,1,1,"ativo","Oficial",null,"Español 2",[],0],
  ["ESP4","Español 4","Espanhol","Outros Idiomas","Spanish","cap7i",61,0,2,"ativo","Oficial",null,"Español 4",[],0],
  ["ESP6","Español 6","Espanhol","Outros Idiomas","Spanish","cap7i",121,0,3,"ativo","Oficial",null,"Español 6",[],0],
  ["ITA2","Italiano 2","Italiano","Outros Idiomas","Italian","cap7i",1,1,1,"ativo","Oficial",null,"Italiano 2",[],0],
  ["ITA4","Italiano 4","Italiano","Outros Idiomas","Italian","cap7i",61,0,2,"ativo","Oficial",null,"Italiano 4",[],0],
  ["ITA6","Italiano 6","Italiano","Outros Idiomas","Italian","cap7i",121,0,3,"ativo","Oficial",null,"Italiano 6",[],0],
];
/* trilha: [de, para]. Sequência dentro da categoria + as alternativas e o salto do Teens 8. */
const CAT_PROXIMO: string[][] = [
  ["TOTS 2","TOTS 4"],["TOTS 4","TOTS 6"],["TOTS 6","L. Kids 2"],["L. Kids 2","L. Kids 4"],
  ["L. Kids 4","KIDS 2"],["KIDS 2","KIDS 4"],["KIDS 4","NG"],["KIDS 4","PRE"],
  ["NG","T2"],["PRE","T2"],
  ["T2","T4"],["T4","T6"],["T6","T8"],["T8","W10"],
  ["W2","W4"],["W4","W6"],["W6","W8"],["W8","W10"],["W10","W12"],
  ["ESP2","ESP4"],["ESP4","ESP6"],["ITA2","ITA4"],["ITA4","ITA6"],
];
const CAT_EQUIV: string[][] = [["T2","W2"],["T4","W4"],["T6","W6"],["T8","W8"],["NG","PRE"]];

/* Semeadura do catálogo. Os MODELOS são reconciliados sempre; os ESTÁGIOS só na primeira vez
   (marca em `config`), porque depois o Vitor edita idade, escala e edição à mão e uma segunda
   semeadura desfaria o trabalho dele. */
function semearEstagios() {
  const mods: Record<string, number> = {};
  for (const [chave, nome, lpc, caps] of [
    ["cap11", "Capítulo de 11", 10, 6],
    ["cap7", "Capítulo de 7", 6, 10],
    ["cap7i", "Capítulo de 7 · outros idiomas", 6, 10],
  ] as any[]) {
    let m = G("SELECT id FROM estagio_modelo WHERE nome=?", nome);
    if (!m) m = { id: Number(R("INSERT INTO estagio_modelo (nome,licoes_por_capitulo,capitulos) VALUES (?,?,?)", nome, lpc, caps).lastInsertRowid) };
    mods[chave] = m.id;
  }
  if (G("SELECT valor FROM config WHERE chave='estagios_semeados'")) return { novos: 0 };
  let novos = 0;
  for (const e of CAT_ESTAGIOS) {
    const [sigla, nome, idioma, cat, grupo, mod, licIni, entrada, ordem, status, edNome, edAno, livro, especiais, remind] = e;
    if (G("SELECT 1 FROM estagio WHERE sigla=?", sigla)) continue;
    /* escala CEFR/GSE nasce ATIVA só em Teens e W: a Wizard não define subnível de criança, e
       outros idiomas não usam a escala. Os valores em si o Vitor preenche à mão. */
    const escala = (cat === "Teens" || cat === "W") ? 1 : 0;
    const item = livro ? G("SELECT id FROM estoque_item WHERE livro=?", livro) : null;
    const r = R(`INSERT INTO estagio (sigla,nome,idioma,categoria,grupo,modelo_id,licao_inicial,entrada,
        ordem,escala_ativa,edicao_nome,edicao_ano,status,livro,item_estoque_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      sigla, nome, idioma, cat, grupo, mods[mod], licIni, entrada, ordem, escala,
      edNome, edAno, status, livro, item?.id ?? null);
    const id = Number(r.lastInsertRowid);
    (especiais as string[]).forEach((rot, i) =>
      R("INSERT INTO estagio_licao_extra (estagio_id,ordem,rotulo,posicao) VALUES (?,?,?,'abertura')", id, i + 1, rot));
    for (let i = 1; i <= (remind as number); i++)
      R("INSERT INTO estagio_licao_extra (estagio_id,ordem,rotulo,posicao) VALUES (?,?,?,'flutuante')", id, i, "Remind " + i);
    novos++;
  }
  const idDe = (s: string) => G("SELECT id FROM estagio WHERE sigla=?", s)?.id;
  for (const [a, b] of CAT_PROXIMO) {
    const x = idDe(a), y = idDe(b);
    if (x && y) R("INSERT OR IGNORE INTO estagio_proximo (de_id,para_id) VALUES (?,?)", x, y);
  }
  /* equivalência é SIMÉTRICA: grava os dois sentidos para a consulta não precisar de OR */
  for (const [a, b] of CAT_EQUIV) {
    const x = idDe(a), y = idDe(b);
    if (x && y) { R("INSERT OR IGNORE INTO estagio_equivalente (a_id,b_id) VALUES (?,?)", x, y);
                  R("INSERT OR IGNORE INTO estagio_equivalente (a_id,b_id) VALUES (?,?)", y, x); }
  }
  R("INSERT OR REPLACE INTO config (chave,valor) VALUES ('estagios_semeados',?)", agora());
  console.log("estágios: catálogo semeado — " + novos + " estágio(s)");
  return { novos };
}

/* Numera os contratos que já existem: a ordem é a de criação do vínculo, e como `aluno_livro`
   não tem data, o critério é o rowid — que é justamente a ordem em que as linhas entraram. */
function numerarContratos() {
  if (G("SELECT valor FROM config WHERE chave='contratos_numerados'")) return { alunos: 0 };
  let n = 0;
  for (const a of A("SELECT DISTINCT id_matricula FROM aluno_livro")) {
    let seq = 0;
    for (const m of A("SELECT rowid FROM aluno_livro WHERE id_matricula=? ORDER BY rowid", a.id_matricula))
      R("UPDATE aluno_livro SET contrato_seq=? WHERE rowid=?", ++seq, m.rowid);
    n++;
  }
  R("INSERT OR REPLACE INTO config (chave,valor) VALUES ('contratos_numerados',?)", agora());
  console.log("contratos: numerados para " + n + " aluno(s)");
  return { alunos: n };
}
addColuna("presenca", "minutos", `INTEGER GENERATED ALWAYS AS (
  CASE WHEN entrada IS NOT NULL AND saida IS NOT NULL THEN
    (CAST(substr(saida,1,2) AS INTEGER)*60 + CAST(substr(saida,4,2) AS INTEGER))
  - (CAST(substr(entrada,1,2) AS INTEGER)*60 + CAST(substr(entrada,4,2) AS INTEGER)) END) VIRTUAL`);
/* ===== reconstrução de tabela: a única forma de acrescentar CHECK a uma tabela que já existe =====
   ALTER TABLE ADD COLUMN não sabe acrescentar regra de tabela. Como a `presenca` da recepção nasceu
   do CREATE TABLE lá de cima, que na época não tinha CHECK nenhum, as regras de domínio existiam só
   no app — e regra que só existe no app é contornável por qualquer escrita que não passe por ele.
   Aqui elas passam a existir no BANCO. Procedimento oficial do SQLite (lang_altertable.html,
   "Making Other Kinds Of Table Schema Changes"), na ordem que ele manda. */
let copiaFeita = false;
function copiaDeSeguranca() { // VACUUM INTO: cópia consistente mesmo com o banco aberto (não é cópia de arquivo)
  if (copiaFeita) return;
  const destino = PASTA + "wizard-antes-checks-" + new Date().toISOString().replace(/[T:]/g, "-").slice(0, 19) + ".db";
  db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  console.log("migração: cópia de segurança em " + destino);
  copiaFeita = true;
}
/* Idempotente pela `marca`: um trecho do DDL que só existe depois que as regras foram aplicadas.
   Num banco já correto não faz absolutamente nada — nem a cópia de segurança. */
function reconstruirTabela(tabela: string, marca: string, corpo: string) {
  const atual = G("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", tabela)?.sql as string | undefined;
  if (!atual || atual.includes(marca)) return; // tabela ainda não existe, ou já tem as regras
  const gravaveis = (t: string) => A(`PRAGMA table_xinfo(${t})`).filter(c => c.hidden === 0).map(c => c.name); // hidden 2/3 = GERADA: não se escreve nela
  copiaDeSeguranca();
  db.exec("PRAGMA foreign_keys = OFF");      // fora da transação: dentro dela o PRAGMA é ignorado em silêncio
  db.exec("PRAGMA legacy_alter_table = ON"); // rename "burro": impede o SQLite de reescrever as FKs de quem aponta pra cá
  db.exec("BEGIN");
  try {
    db.exec(`CREATE TABLE ${tabela}_novo (${corpo})`);
    const novas = gravaveis(`${tabela}_novo`);
    const cols = gravaveis(tabela).filter(c => novas.includes(c)).join(", ");
    db.exec(`INSERT INTO ${tabela}_novo (${cols}) SELECT ${cols} FROM ${tabela}`);
    const antes = G(`SELECT COUNT(*) c FROM ${tabela}`).c, depois = G(`SELECT COUNT(*) c FROM ${tabela}_novo`).c;
    if (antes !== depois) throw new Error(`copiou ${depois} de ${antes} linha(s)`);
    db.exec(`DROP TABLE ${tabela}`);
    db.exec(`ALTER TABLE ${tabela}_novo RENAME TO ${tabela}`);
    const fk = A("PRAGMA foreign_key_check");
    if (fk.length) throw new Error(`${fk.length} violação(ões) de chave estrangeira`);
    db.exec("COMMIT");
    console.log(`migração: ${tabela} reconstruída com as regras no banco (${depois} linha(s) preservada(s))`);
  } catch (e) {
    db.exec("ROLLBACK");
    /* Diagnóstico, só no caminho de erro: repassa linha a linha numa tabela TEMP com as regras novas
       para dizer QUAIS registros o banco recusa. Sem isso sobra "CHECK constraint failed", que não dá
       para agir — achar a linha errada na mão fica inviável assim que a tabela cresce. */
    const ruins: string[] = [];
    try {
      db.exec(`CREATE TEMP TABLE _diag (${corpo})`);
      const novas = A("PRAGMA temp.table_xinfo(_diag)").filter(c => c.hidden === 0).map(c => c.name);
      const cols = gravaveis(tabela).filter(c => novas.includes(c));
      const lista = cols.join(", "), coringas = cols.map(() => "?").join(",");
      for (const linha of A(`SELECT ${lista} FROM ${tabela}`)) {
        try { R(`INSERT INTO _diag (${lista}) VALUES (${coringas})`, ...cols.map(c => linha[c])); }
        catch { if (ruins.length < 5) ruins.push(JSON.stringify(linha)); }
      }
      db.exec("DROP TABLE _diag");
    } catch { /* o diagnóstico é bônus: se ele próprio falhar, o erro original ainda é reportado */ }
    throw new Error(`${tabela}: ${(e as Error).message}` + (ruins.length ? ` — corrija: ${ruins.join(" | ")}` : ""));
  } finally {
    db.exec("PRAGMA legacy_alter_table = OFF");
    db.exec("PRAGMA foreign_keys = ON");
  }
}
/* Falha aqui NÃO pode derrubar o servidor: recepção sem app é pior que recepção sem CHECK por mais um
   dia (a validação do app segue de pé). A transação já garantiu que o banco ficou como estava. */
try {
  reconstruirTabela("presenca", "status='P' OR entrada IS NULL", CORPO_PRESENCA);
  reconstruirTabela("aluno_livro", "modalidade IN ('Conn','Inter','On')", `
  id_matricula TEXT NOT NULL REFERENCES alunos(id_matricula) ON DELETE CASCADE,
  livro TEXT NOT NULL REFERENCES livros(nome),
  modalidade TEXT NOT NULL CHECK (modalidade IN ('Conn','Inter','On')),
  vip INTEGER NOT NULL DEFAULT 0 CHECK (vip IN (0,1)), -- VIP = sem turma (regra aplicada no app)
  tipo_encontro TEXT NOT NULL DEFAULT 'Presencial' CHECK (tipo_encontro IN ('Presencial','Online')),
  PRIMARY KEY (id_matricula, livro)`);
} catch (e) { console.warn("aviso: regras de domínio não aplicadas ao banco (o app segue validando) — " + (e as Error).message); }

/* ===== situação por LIVRO, e a situação que faltava =====
   A situação é do CURSO, não da pessoa: quem faz Little Kids 2 e Kids Esp 1 ao mesmo tempo pode
   estar rematriculado num e trancado no outro, e o histórico sem livro não sabia dizer de qual
   matrícula estava falando. Texto solto igual a `presenca.livro`: trocar de livro não pode apagar
   a linha do tempo do aluno. NULL = registro antigo, de antes desta coluna existir. */
addColuna("aluno_situacao_historico", "livro", "TEXT");
/* 'Retornado' é a contraparte de 'Trancado': o aluno que pausou o curso no meio do livro e voltou.
   Sem ela, a volta só podia ser registrada como Matriculado/Rematriculado, que significam outra
   coisa — rematrícula é quem terminou o livro e foi para o seguinte. Conta como ATIVO. */
R("INSERT OR IGNORE INTO situacoes (situacao, ativa) VALUES ('Retornado', 1)");

/* índices: o banco nasceu sem nenhum, então toda consulta era varredura de tabela. Com o histórico
   de presença crescendo todo dia, isso passa a doer — CREATE IF NOT EXISTS é idempotente.
   (Vêm depois da reconstrução de propósito: DROP TABLE leva junto os índices da tabela.) */
for (const ix of [
  "CREATE INDEX IF NOT EXISTS ix_aulas_matricula ON aulas(id_matricula)",
  "CREATE INDEX IF NOT EXISTS ix_aulas_dia_hora ON aulas(dia, hora)",
  "CREATE INDEX IF NOT EXISTS ix_aulas_livro ON aulas(id_matricula, livro)",
  "CREATE INDEX IF NOT EXISTS ix_presenca_data ON presenca(data)",
  "CREATE INDEX IF NOT EXISTS ix_presenca_matricula ON presenca(id_matricula)",
  "CREATE INDEX IF NOT EXISTS ix_aula_prof_func ON aula_professor(funcionario_id)",
  "CREATE INDEX IF NOT EXISTS ix_turma_dia_dia ON turma_dia(dia)",
  "CREATE INDEX IF NOT EXISTS ix_aluno_livro_livro ON aluno_livro(livro)",
  "CREATE INDEX IF NOT EXISTS ix_hist_matricula ON aluno_situacao_historico(id_matricula)",
]) db.exec(ix);
/* o índice único passou a incluir o LIVRO: sem ele, a aluna que se rematricula em inglês e em
   espanhol no mesmo dia teria o segundo registro recusado como duplicata. O DROP é necessário
   porque `CREATE INDEX IF NOT EXISTS` não altera um índice que já existe com outras colunas —
   e é idempotente: na segunda subida o índice já está na forma nova e o DROP/CREATE só o repõe. */
try {
  db.exec("DROP INDEX IF EXISTS ux_hist_unico");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_hist_unico ON aluno_situacao_historico(id_matricula, situacao, data, IFNULL(livro,''))");
} catch { console.warn("aviso: há registros de situação duplicados (mesmo aluno/situação/data/livro) — índice único não aplicado"); }

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
    R("INSERT INTO aluno_livro (id_matricula, livro, modalidade, vip, tipo_encontro) VALUES (?,?,?,?,?)", p.id_matricula, p.livro, mod, 0, "Presencial");
  }
  if (pares.length) console.log("aluno_livro: " + pares.length + " matrícula(s) migrada(s) a partir de aulas existentes.");
}

/* ===== backup (aba Backup) =====
   Política: toda cópia vai SEMPRE para uma pasta oculta do Windows (%LOCALAPPDATA%\WizardBackup —
   o AppData é oculto por padrão) e TAMBÉM para o OneDrive quando existir (destino preferido,
   listado primeiro). A pasta do OneDrive é configurável na aba Backup (tabela config); sem
   configuração, usa %OneDrive%\WizardBackup. O banco VIVO fica fora do OneDrive de propósito
   (sincronizador + SQLite aberto corrompe) — só as cópias vão pra lá. */
const dirBackupLocal = () => (Deno.env.get("LOCALAPPDATA") || PASTA) + "\\WizardBackup";
/* pasta configurada é gravada RELATIVA à raiz do OneDrive quando o usuário escolhe algo dentro
   dela — assim o mesmo wizard.db copiado para outro computador (usuário Windows diferente, ex.:
   "user" no notebook vs "Wizard Naviraí" na recepção) reconstrói o caminho certo usando a raiz
   OneDrive de CADA máquina, em vez de carregar um "C:\Users\user\..." travado que só existe aqui.
   Caminho absoluto de disco/rede fora do OneDrive (ex.: "C:\..." fora dele, "\\servidor\...")
   continua gravado como está — não há como tornar isso portável. */
function dirBackupOneDrive(): string | null {
  const cfg = G("SELECT valor FROM config WHERE chave='backup_onedrive'")?.valor;
  const od = Deno.env.get("OneDrive");
  if (cfg) return /^[A-Za-z]:\\|^\\\\/.test(cfg) ? cfg : (od ? od + "\\" + cfg.replace(/^\\+/, "") : null);
  return od ? od + "\\WizardBackup" : null;
}
function gravarPastaOneDrive(p: string): string {
  const od = Deno.env.get("OneDrive");
  return (od && p.toLowerCase().startsWith(od.toLowerCase() + "\\")) ? p.slice(od.length + 1) : p;
}
function alvosBackup() {
  const alvos = [{ destino: "HD (pasta oculta)", dir: dirBackupLocal() }];
  const od = dirBackupOneDrive();
  if (od) alvos.unshift({ destino: "OneDrive", dir: od }); // preferência: OneDrive primeiro
  return alvos;
}
/* copia wizard.db para todos os alvos; pularExistentes=true dá a semântica "1 por dia por destino" */
function executarBackup(nome: string, pularExistentes: boolean) {
  let journal = false; try { Deno.statSync(PASTA + "wizard.db-journal"); journal = true; } catch { /* sem journal = sem escrita em andamento */ }
  if (journal) throw new Error("Há uma escrita em andamento no banco — tente de novo em alguns segundos.");
  const feitos: { destino: string; caminho: string }[] = []; const erros: string[] = [];
  for (const a of alvosBackup()) {
    const caminho = a.dir + "\\" + nome;
    try {
      if (pularExistentes) { try { Deno.statSync(caminho); continue; } catch { /* ainda não existe hoje */ } }
      Deno.mkdirSync(a.dir, { recursive: true });
      Deno.copyFileSync(PASTA + "wizard.db", caminho);
      feitos.push({ destino: a.destino, caminho });
    } catch (e) { erros.push(a.destino + ": " + (e as Error).message); }
  }
  return { feitos, erros };
}
try { // backup diário na subida do servidor (a leitura da config acima já recuperou journal pendente)
  const r = executarBackup("wizard-" + new Date().toISOString().slice(0, 10) + ".db", true);
  r.feitos.forEach(f => console.log("Backup do dia salvo em " + f.caminho));
  r.erros.forEach(e => console.warn("Backup falhou (o app segue normal) — " + e));
} catch (e) { console.warn("Backup adiado: " + (e as Error).message); }

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
  R("INSERT INTO aluno_livro (id_matricula, livro, modalidade, vip, tipo_encontro) VALUES (?,?,?,?,?)", idMatricula, livro, base?.modalidade || lv?.tipo_padrao || "Conn", base?.vip || 0, base?.tipo_encontro || "Presencial");
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

/* datas: sempre em horário LOCAL (toISOString converteria pra UTC e viraria o dia à noite) */
const NOMES_DIA = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const dataISO = (d: Date) => d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
/* colunas da ficha do mês: todas as datas do mês de `ref` cujo dia da semana está no grupo
   (ex.: Seg+Qua → todas as segundas e quartas de julho) — é o que as 12 colunas estreitas do
   template impresso representam */
function datasDoMes(ref: Date, dias: string[]) {
  const ano = ref.getFullYear(), mes = ref.getMonth(), out: { data: string; dia: string; numero: number }[] = [];
  for (const d = new Date(ano, mes, 1); d.getMonth() === mes; d.setDate(d.getDate() + 1))
    if (dias.includes(NOMES_DIA[d.getDay()])) out.push({ data: dataISO(d), dia: NOMES_DIA[d.getDay()], numero: d.getDate() });
  return out;
}

type Linha = { id_matricula: string; nomeAluno: string; dia: string; hora: string; livro: string; profs: string[]; pendente?: boolean; matPendente?: { modalidade: string; vip: boolean }; avulso?: { motivo: string; observacao: string | null } };

/* mescla horas contíguas do MESMO aluno+dia+livro+professores num único registro com contagem de
   aulas (ex.: 07:00 + 08:00 seguidas = 1 registro "2 aulas", horaFim = +2h) — cobre o caso de 2 lições
   no mesmo dia (ex.: espanhol de segunda 7h-9h) sem exigir que isso seja modelado como turma. */
function mesclarHoras(linhas: Linha[]): (Linha & { aulas: number })[] {
  const porGrupo: Record<string, Linha[]> = {};
  /* avulso entra na chave: um encontro fora da agenda não pode ser somado a uma aula regular
     contígua e virar "2 au" — são coisas diferentes, e o avulso precisa da própria linha */
  for (const l of linhas) (porGrupo[l.id_matricula + "|" + l.dia + "|" + l.livro + "|" + (l.avulso ? "A" : "R") + "|" + l.profs.slice().sort().join(",")] ||= []).push(l);
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
  dataAvulsos?: string, // data específica: traz também quem vem fora da agenda (só o lançador usa)
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
  /* Encontros avulsos da DATA pedida. Só o lançador informa a data — a ficha impressa chama sem ela
     e continua saindo exatamente igual (lá o aluno de reposição já aparece na ficha do horário
     REGULAR dele, com a coluna do dia em que veio; são duas visões diferentes e não se misturam). */
  if (dataAvulsos) {
    const diaSemana = NOMES_DIA[new Date(dataAvulsos + "T12:00:00").getDay()];
    if (dias.includes(diaSemana)) {
      for (const e of A(`SELECT e.*, al.nome nomeAluno FROM encontro_avulso e
        JOIN alunos al ON al.id_matricula=e.id_matricula
        JOIN v_alunos v ON v.id_matricula=e.id_matricula
        WHERE e.data=? AND v.status='Ativado'`, dataAvulsos)) {
        /* se ele JÁ tem aula regular nessa hora, então é o horário dele mesmo: nada a acrescentar
           (evita linha duplicada quando alguém lança avulso por engano no próprio slot) */
        if (linhas.some(l => l.id_matricula === e.id_matricula && l.dia === diaSemana && l.hora === e.hora && l.livro === e.livro)) continue;
        linhas.push({ id_matricula: e.id_matricula, nomeAluno: e.nomeAluno, dia: diaSemana, hora: e.hora,
          livro: e.livro, profs: [], avulso: { motivo: e.motivo, observacao: e.observacao ?? null } });
      }
    }
  }

  const mesclados = mesclarHoras(linhas);
  /* dias completos da semana por aluno×livro (com contagem de aulas por dia) — alimenta a coluna Dias */
  const diasLivro: Record<string, Record<string, number>> = {};
  for (const a of mesclados) {
    if (a.avulso) continue; // a coluna Dias mostra a agenda FIXA: uma reposição não vira dia do aluno
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
    const al = b.alunos[a.id_matricula + "|" + a.livro] ||= { id: a.id_matricula, nome: a.nomeAluno, livro: a.livro, profs: [], pendente: false, avulso: a.avulso || null };
    if (a.pendente) al.pendente = true;
    if (!a.avulso) al.avulso = null; // linha regular manda: se ele tem aula fixa aqui, não é avulso
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

/* ===== presença: colunas do mês + preenchimento (compartilhado entre lançador e ficha impressa) =====
   As colunas do mês SÃO as colunas estreitas do template impresso: dia da semana em cima, número do
   dia do mês embaixo. Lançador e impressão usam exatamente a mesma fonte pra nunca divergirem. */
const MESES_PT = ["JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO", "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO"];
const COLUNAS_FICHA = 12; // colunas estreitas do template impresso — número FIXO, por regra da casa

/* presenças do mês indexadas por aluno+livro: {id|livro: {data: status}} — uma consulta só */
/* índice da ficha impressa. Cada data traz o status E se a presença foi PARCIAL: quem tem 2 lições
   no dia e cumpriu 1 não pode sair como "P" limpo, senão a folha induz que fez as duas. */
function indicePresencas(ini: string, fim: string) {
  /* horas das lições de cada aluno×livro×dia, em ordem: transformam a hora gravada em ORDINAL
     (1ª, 2ª), que é o que a ficha mostra ao lado do P */
  const horas: Record<string, string[]> = {};
  A("SELECT id_matricula, livro, dia, hora FROM aulas ORDER BY hora")
    .forEach(r => (horas[r.id_matricula + "|" + r.livro + "|" + r.dia] ||= []).push(r.hora));
  const idx: Record<string, Record<string, any>> = {};
  A("SELECT * FROM presenca WHERE data BETWEEN ? AND ?", ini, fim).forEach(p => {
    const dia = NOMES_DIA[new Date(p.data + "T12:00:00").getDay()];
    const lst = horas[p.id_matricula + "|" + p.livro + "|" + dia] || [];
    const prev = lst.length || 1;
    const cumpridas: string[] = p.licoes ? String(p.licoes).split(",") : [];
    const feitas = p.aulas_feitas ?? (cumpridas.length || null);
    (idx[p.id_matricula + "|" + p.livro] ||= {})[p.data] = {
      status: p.status, feitas, previstas: prev,
      parcial: prev > 1 && feitas != null && feitas < prev,
      // ordinais das lições cumpridas: [2] quando faltou a primeira e fez a segunda
      ordinais: cumpridas.map(h => lst.indexOf(h) + 1).filter(n => n > 0).sort((a, b) => a - b),
    };
  });
  return idx;
}
/* igual ao anterior, mas com o registro completo (status + entrada + saída) — usado só pelo
   lançador; a impressão continua no índice de status puro, que é tudo de que ela precisa */
function indicePontos(ini: string, fim: string) {
  const horas: Record<string, string[]> = {};
  A("SELECT id_matricula, livro, dia, hora FROM aulas ORDER BY hora")
    .forEach(r => (horas[r.id_matricula + "|" + r.livro + "|" + r.dia] ||= []).push(r.hora));
  const idx: Record<string, Record<string, any>> = {};
  A("SELECT * FROM presenca WHERE data BETWEEN ? AND ?", ini, fim).forEach(p => {
    const dia = NOMES_DIA[new Date(p.data + "T12:00:00").getDay()];
    const lst = horas[p.id_matricula + "|" + p.livro + "|" + dia] || [];
    const cumpridas: string[] = p.licoes ? String(p.licoes).split(",") : [];
    (idx[p.id_matricula + "|" + p.livro] ||= {})[p.data] = {
      status: p.status, entrada: p.entrada || null, saida: p.saida || null, minutos: p.minutos ?? null,
      aulasFeitas: p.aulas_feitas ?? null, previstas: lst.length || 1,
      auto: p.auto === 1,   // falta que o fecho do dia lançou: a tela marca com um "!"
      // ordinais prontos para a tela: [2] = fez só a segunda lição
      ordinais: cumpridas.map(h => lst.indexOf(h) + 1).filter(n => n > 0).sort((a, b) => a - b),
    };
  });
  return idx;
}

/* Colunas de UM bloco = as datas que JÁ TÊM lançamento para os alunos dele, em ordem cronológica.
   O horário do aluno NÃO amarra a coluna: quem é de Ter/Qui e veio na quarta (reposição) ou se
   antecipou cria a coluna do dia 22 (4ª) na própria ficha de Ter/Qui — é exatamente o que a
   recepção fazia à mão, escrevendo o dia numa coluna estreita ainda vazia. Chamamos esse caso de
   off-day (`foraDoGrupo`); on-day é o dia regular do aluno.
   `incluirGrupo`: o lançador também traz as datas regulares do grupo (senão não haveria célula
   onde clicar pra lançar); a impressão NÃO — lá só aparece o que tem dado, e as colunas restantes
   saem em branco pra preencher à mão, como sempre foi. */
function blocosComColunas(blocos: any[], ref: Date, grupo: string[], incluirGrupo: boolean, limite = 0) {
  const dInfo: Record<string, any> = {}; A("SELECT * FROM dias").forEach(r => dInfo[r.nome] = r);
  const ano = ref.getFullYear(), mes = ref.getMonth();
  const idx = indicePresencas(dataISO(new Date(ano, mes, 1)), dataISO(new Date(ano, mes + 1, 0)));
  const base = incluirGrupo ? datasDoMes(ref, grupo).map(c => c.data) : [];
  const hojeISO = dataISO(new Date()), noGrupo = new Set(grupo);
  /* dias regulares de cada aluno×livro: separam on-day de off-day de verdade */
  const regulares: Record<string, Set<string>> = {};
  A("SELECT DISTINCT id_matricula, livro, dia FROM aulas")
    .forEach(r => (regulares[r.id_matricula + "|" + r.livro] ||= new Set()).add(r.dia));
  const diaDaData = (data: string) => NOMES_DIA[new Date(data + "T12:00:00").getDay()];
  return blocos.map(b => {
    const datas = new Set<string>(base);
    for (const al of b.alunos) {
      const chave = al.id + "|" + al.livro, reg = regulares[chave] || new Set<string>();
      for (const data of Object.keys(idx[chave] || {})) {
        const w = diaDaData(data);
        /* entra se é dia DESTA ficha, ou se é reposição/anteposição de verdade (dia que não é
           regular do aluno) — assim um sábado do aluno não polui a ficha de Ter/Qui e vice-versa,
           mas a reposição aparece em toda ficha onde ele tem bloco, como a recepção anota à mão */
        if (noGrupo.has(w) || !reg.has(w)) datas.add(data);
      }
    }
    let colunas = [...datas].sort().map(data => {
      const nome = diaDaData(data);
      return { data, dia: nome, codigo: dInfo[nome]?.codigo || nome, curto: dInfo[nome]?.curto || nome,
        numero: new Date(data + "T12:00:00").getDate(), hoje: data === hojeISO, foraDoGrupo: !noGrupo.has(nome) };
    });
    if (limite && colunas.length > limite) colunas = colunas.slice(0, limite);
    return { ...b, colunas, alunos: b.alunos.map((al: any) => ({ ...al, presencas: idx[al.id + "|" + al.livro] || {} })) };
  });
}

/* SALDO de um item de estoque.
   Vale a ÚLTIMA CONTAGEM, mais as remessas e menos as entregas POSTERIORES a ela. Pedido não entra:
   pedir não é ter. O "posteriores" é o que impede contagem dupla — entrega anterior à contagem já
   está embutida no número que a pessoa viu na prateleira, e descontá-la de novo tiraria do estoque
   um livro que já não estava lá. Entrega SEM data conta como anterior a tudo: se não se sabe quando
   saiu, o mais seguro é supor que a última contagem já a viu.
   Sem contagem nenhuma devolve null — "não sei", que é diferente de zero. */
function saldoItem(itemId: number): number | null {
  const base = G(`SELECT ev.data, ei.quantidade q FROM estoque_evento_item ei
    JOIN estoque_evento ev ON ev.id=ei.evento_id
    WHERE ei.item_id=? AND ev.tipo='contagem' ORDER BY ev.data DESC, ev.id DESC LIMIT 1`, itemId);
  if (!base) return null;
  const entrou = G(`SELECT COALESCE(SUM(ei.quantidade),0) s FROM estoque_evento_item ei
    JOIN estoque_evento ev ON ev.id=ei.evento_id
    WHERE ei.item_id=? AND ev.tipo='remessa' AND ev.data > ?`, itemId, base.data)?.s || 0;
  const saiu = G(`SELECT COUNT(*) s FROM entrega_material
    WHERE item_id=? AND data IS NOT NULL AND data > ?`, itemId, base.data)?.s || 0;
  return base.q + entrou - saiu;
}
/* Entregas pelo ponto de vista da MATRÍCULA: toda matrícula ativa precisa do livro dela, e a
   ausência de linha em entrega_material é o que significa "ainda não recebeu". É a lista que
   responde "quem está sem o livro na mão" — o caderno de papel nunca deu isso.
   LEFT JOIN em estoque_item pelo livro: matrícula em livro que não tem item de estoque (Kids Esp 1,
   Port 2) aparece assim mesmo, com item nulo, em vez de sumir da lista. */
function listaEntregas() {
  return A(`SELECT al.id_matricula, al.livro, a.nome, a.situacao,
                   e.id AS entrega_id, e.data, e.deduzida, e.item_id,
                   i.id AS item_livro_id, i.descricao AS item_desc
            FROM aluno_livro al
            JOIN alunos a ON a.id_matricula=al.id_matricula
            JOIN situacoes s ON s.situacao=a.situacao AND s.ativa=1
            LEFT JOIN entrega_material e ON e.id_matricula=al.id_matricula AND e.livro=al.livro
            LEFT JOIN estoque_item i ON i.livro=al.livro
            ORDER BY a.nome`).map(r => ({
    idMatricula: r.id_matricula, livro: r.livro, nome: r.nome, situacao: r.situacao,
    entregaId: r.entrega_id ?? null, data: r.data ?? null, deduzida: r.deduzida === 1,
    itemId: r.item_id ?? r.item_livro_id ?? null, itemDesc: r.item_desc ?? null,
  }));
}
/* quanto ainda está encomendado e não chegou, item a item, percorrendo a linha do tempo: cada
   pedido soma, cada remessa abate o que ela de fato trouxe. Olhar só a DATA da última remessa
   daria o pedido inteiro por atendido — e caixa que chega quase nunca traz o pedido inteiro. */
function pedidoPendenteItem(itemId: number): number {
  let pend = 0;
  for (const r of A(`SELECT ev.tipo, ei.quantidade q FROM estoque_evento_item ei
    JOIN estoque_evento ev ON ev.id=ei.evento_id
    WHERE ei.item_id=? AND ev.tipo IN ('pedido','remessa') ORDER BY ev.data, ev.id`, itemId)) {
    if (r.tipo === "pedido") pend += r.q; else pend = Math.max(0, pend - r.q);
  }
  return pend;
}

/* abaixo disso a saída provavelmente foi clique errado — a aula da Wizard tem 1h */
const AULA_CURTA_MIN = 20;
/* tolerância para considerar que o aluno cumpriu TODAS as lições do dia: 2 lições valem 120min,
   mas 1h15 já é aceito (acontece de vencerem duas lições em menos tempo). Abaixo disso o app
   pergunta quantas lições ele fez de verdade, em vez de assumir. */
const TOLERANCIA_MIN = 45;
/* as lições daquele dia, em ordem: são elas que o app oferece para a recepção marcar quais o
   aluno cumpriu (a 1ª, a 2ª, ou ambas) */
const licoesDoDia = (idMatricula: string, livro: string, data: string): string[] => {
  const dia = NOMES_DIA[new Date(data + "T12:00:00").getDay()];
  return A("SELECT hora FROM aulas WHERE id_matricula=? AND livro=? AND dia=? ORDER BY hora",
    idMatricula, livro, dia).map(r => r.hora);
};
const aulasPrevistas = (idMatricula: string, livro: string, data: string) => licoesDoDia(idMatricula, livro, data).length;
const agora = () => {
  const a = new Date();
  return dataISO(a) + " " + ("0" + a.getHours()).slice(-2) + ":" + ("0" + a.getMinutes()).slice(-2) + ":" + ("0" + a.getSeconds()).slice(-2);
};
const anotar = (id_matricula: string, livro: string | null, data: string | null, tipo: string, valor?: string | null, detalhe?: string | null) => {
  R("INSERT INTO diario (momento,id_matricula,livro,data,tipo,valor,detalhe) VALUES (?,?,?,?,?,?,?)",
    agora(), id_matricula, livro, data, tipo, valor ?? null, detalhe ?? null);
};
/* Agenda em texto canônico, para comparar duas versões e para guardar no histórico de trocas.
   Ordenada por dia da semana e hora — sem isso, marcar os mesmos dias em ordem diferente na tela
   pareceria troca de horário e dispararia a pergunta à toa. Usa o CÓDIGO do dia ('2ª'), que é como
   a escola escreve nas fichas. */
const textoAgenda = (pares: { dia: string; hora: string }[]) => {
  const ord: Record<string, number> = {}, cod: Record<string, string> = {};
  A("SELECT nome, ordem, codigo FROM dias").forEach(d => { ord[d.nome] = d.ordem; cod[d.nome] = d.codigo; });
  return [...new Set(pares.map(p => p.dia + "|" + p.hora))]
    .map(k => { const [dia, hora] = k.split("|"); return { dia, hora }; })
    .sort((a, b) => (ord[a.dia] || 0) - (ord[b.dia] || 0) || a.hora.localeCompare(b.hora))
    .map(p => (cod[p.dia] || p.dia) + " " + p.hora).join(" · ");
};
const agendaTexto = (idMatricula: string, livro: string) =>
  textoAgenda(A("SELECT dia, hora FROM aulas WHERE id_matricula=? AND livro=?", idMatricula, livro));
const agendaTextoDeItens = (itens: any[]) =>
  textoAgenda((itens || []).map(i => ({ dia: i.dia, hora: i.horario })));
const emMinutos = (hhmm: string) => parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3, 5), 10);
const minutosEntre = (ini: string, fim: string) => emMinutos(fim) - emMinutos(ini);
const fmtMin = (m: number) => m >= 60 ? Math.floor(m/60) + "h" + (m%60 ? " " + (m%60) + "min" : "") : m + "min";

/* status vazio/null apaga o lançamento (volta a "não preenchido") */
function gravarPresenca({ idMatricula, livro, data, status }: any) {
  if (!idMatricula || !livro || !data) throw new Error("Dados incompletos para lançar presença.");
  if (!status) { R("DELETE FROM presenca WHERE id_matricula=? AND livro=? AND data=?", idMatricula, livro, data);
    anotar(idMatricula, livro, data, "limpeza", null, "status removido"); return { ok: true, status: null }; }
  if (!["P", "F", "N"].includes(status)) throw new Error("Status inválido: use P (presente), F (falta) ou N (não aula).");
  /* colunas explícitas: a tabela ganhou entrada/saida e o VALUES posicional passou a quebrar
     ("table presenca has 6 columns but 4 values were supplied") — marcar falta/não aula parou
     de funcionar em silêncio. Falta e não-aula também zeram o ponto: quem não veio não tem
     entrada nem saída (é o que o CHECK do banco cobra). */
  R(`INSERT INTO presenca (id_matricula, livro, data, status) VALUES (?,?,?,?)
     ON CONFLICT(id_matricula, livro, data) DO UPDATE SET
       status  = excluded.status,
       entrada = CASE WHEN excluded.status = 'P' THEN presenca.entrada ELSE NULL END,
       saida   = CASE WHEN excluded.status = 'P' THEN presenca.saida   ELSE NULL END,
       aulas_feitas = CASE WHEN excluded.status = 'P' THEN presenca.aulas_feitas ELSE NULL END,
       licoes       = CASE WHEN excluded.status = 'P' THEN presenca.licoes       ELSE NULL END,
       auto         = 0`,   /* gente mexeu: deixa de ser falta por omissão, mesmo que o valor
                               não mude — o "!" some porque agora alguém respondeu por ela */
    idMatricula, livro, data, status);
  anotar(idMatricula, livro, data, "status", status);
  /* devolve o registro como ficou: marcar 'P' PRESERVA a entrada/saída que o professor lançou na
     sala, e a tela da recepção precisa mostrar essa hora em vez de supor que zerou. */
  const g = G("SELECT entrada, saida, minutos, aulas_feitas FROM presenca WHERE id_matricula=? AND livro=? AND data=?", idMatricula, livro, data);
  return { ok: true, status, entrada: g?.entrada ?? null, saida: g?.saida ?? null,
    minutos: g?.minutos ?? null, aulasFeitas: g?.aulas_feitas ?? null };
}

/* ===== FECHO DO DIA: falta automática de quem ninguém tocou =====
   Quem tinha aula e terminou o dia sem NADA lançado (nem presença, nem falta, nem não-aula) recebe
   falta marcada `auto=1`. Isso inverte uma regra antiga da casa — "falta é sempre entrada humana" —
   a pedido do Vitor, porque na prática o aluno somia da tela e a ficha do mês saía com buraco.

   Três travas, porque isto escreve no banco da escola sozinho:

   1. MARCA D'ÁGUA em `config`. Na PRIMEIRA subida ela é gravada como HOJE e nada é processado —
      assim o recurso nunca lança falta retroativa em julho, que seriam milhares de linhas erradas.
   2. JANELA de 7 dias. Servidor parado uma semana não volta despejando falta em duas semanas.
   3. O dia precisa ter ao menos UM lançamento de qualquer aluno. Dia sem nenhum lançamento é
      feriado, recesso ou dia em que ninguém usou o lançador — e aí falta automática é mentira.
      Esta é a trava que mais importa: prefere-se não lançar do que lançar errado. */
const JANELA_FECHO_DIAS = 7;
function aplicarFaltasAutomaticas() {
  const hoje = dataISO(new Date());
  const marca = G("SELECT valor FROM config WHERE chave='faltas_auto_ate'")?.valor as string | undefined;
  if (!marca) {   // primeira subida: só planta a marca, não mexe em nada do passado
    R("INSERT INTO config VALUES ('faltas_auto_ate',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor", hoje);
    console.log("fecho do dia: marca d'água plantada em " + hoje + " (nada retroativo será lançado)");
    return;
  }
  if (marca >= hoje) return;
  const limite = new Date(); limite.setDate(limite.getDate() - JANELA_FECHO_DIAS);
  let d = new Date(marca + "T12:00:00"); d.setDate(d.getDate() + 1);
  const ontem = new Date(); ontem.setDate(ontem.getDate() - 1);
  let total = 0;
  for (; dataISO(d) <= dataISO(ontem); d.setDate(d.getDate() + 1)) {
    const dia = dataISO(d);
    if (d < limite) continue;                                     // fora da janela: pula sem lançar
    if (NOMES_DIA[d.getDay()] === "Domingo") continue;
    if (!G("SELECT 1 FROM presenca WHERE data=? LIMIT 1", dia)) continue;   // dia sem movimento nenhum
    const nomeDia = NOMES_DIA[d.getDay()];
    const faltantes = A(`SELECT DISTINCT a.id_matricula, a.livro FROM aulas a
       JOIN v_alunos v ON v.id_matricula=a.id_matricula
       WHERE a.dia=? AND v.status='Ativado'
         AND NOT EXISTS (SELECT 1 FROM presenca p
              WHERE p.id_matricula=a.id_matricula AND p.livro=a.livro AND p.data=?)`, nomeDia, dia);
    for (const f of faltantes) {
      R("INSERT INTO presenca (id_matricula, livro, data, status, auto) VALUES (?,?,?,'F',1)",
        f.id_matricula, f.livro, dia);
      anotar(f.id_matricula, f.livro, dia, "status", "F", "falta automática: o dia fechou sem lançamento");
      total++;
    }
  }
  R("UPDATE config SET valor=? WHERE chave='faltas_auto_ate'", dataISO(ontem));
  if (total) console.log("fecho do dia: " + total + " falta(s) automática(s) lançada(s) até " + dataISO(ontem));
}
try { aplicarFaltasAutomaticas(); } catch (e) { console.warn("fecho do dia falhou (segue o baile):", e); }
/* aqui e não junto das migrações: semearEstoque usa `agora()`, que é declarado bem depois no
   arquivo. Falhar aqui não pode derrubar a subida — recepção sem estoque ainda é recepção. */
try { semearEstoque(); } catch (e) { console.warn("semeadura do estoque falhou (segue o baile):", e); }
try { semearEstagios(); } catch (e) { console.warn("semeadura dos estágios falhou (segue o baile):", e); }
try { numerarContratos(); } catch (e) { console.warn("numeração de contratos falhou (segue o baile):", e); }

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
  /* ordenado pelo contrato: a lista passa a contar a história do aluno na ordem em que aconteceu */
  getMatriculasAluno: (id) => A("SELECT * FROM aluno_livro WHERE id_matricula=? ORDER BY contrato_seq, rowid", id).map(r => ({
    livro: r.livro, modalidade: r.modalidade, vip: r.vip === 1, tipoEncontro: r.tipo_encontro,
    contratoSeq: r.contrato_seq, contrato: r.contrato_seq ? id + "/" + r.contrato_seq : null })),
  salvarMatricula({ idMatricula, livro, modalidade, vip, tipoEncontro }: any) {
    if (!idMatricula || !livro) throw new Error("Aluno e livro são obrigatórios.");
    if (!G("SELECT 1 FROM alunos WHERE id_matricula=?", idMatricula)) throw new Error("Aluno não encontrado.");
    const lv = G("SELECT * FROM livros WHERE nome=?", livro); if (!lv) throw new Error("Livro inválido: " + livro);
    let mod = modalidade || lv.tipo_padrao;
    if (lv.tipo_fixo === 1) mod = lv.tipo_padrao; // TOTS/L. Kids: modalidade travada
    const existe = G("SELECT 1 FROM aluno_livro WHERE id_matricula=? AND livro=?", idMatricula, livro);
    if (existe) {
      R("UPDATE aluno_livro SET modalidade=?,vip=?,tipo_encontro=? WHERE id_matricula=? AND livro=?", mod, vip ? 1 : 0, tipoEncontro || "Presencial", idMatricula, livro);
      return { ok: true, criado: false, modalidade: mod };
    }
    /* CONTRATO: a ordem do vínculo dentro do aluno, independente de livro ou idioma. */
    const seq = (G("SELECT MAX(contrato_seq) m FROM aluno_livro WHERE id_matricula=?", idMatricula)?.m || 0) + 1;
    R("INSERT INTO aluno_livro (id_matricula, livro, modalidade, vip, tipo_encontro, contrato_seq) VALUES (?,?,?,?,?,?)",
      idMatricula, livro, mod, vip ? 1 : 0, tipoEncontro || "Presencial", seq);
    /* Gatilho pedido pelo Vitor: o PRIMEIRO contrato do aluno é uma matrícula; do segundo em
       diante é rematrícula — é o que distingue quem entrou agora de quem renovou para o livro
       seguinte. Fica registrado no histórico COM o livro, e a situação corrente acompanha.
       Não sobrescreve o que já houver na mesma data/livro (o índice único cuida disso). */
    const situacao = seq === 1 ? "Matriculado" : "Rematriculado";
    let registrada = false;
    try {
      R("INSERT INTO aluno_situacao_historico (id_matricula,situacao,data,livro) VALUES (?,?,?,?)",
        idMatricula, situacao, dataISO(new Date()), livro);
      R("UPDATE alunos SET situacao=? WHERE id_matricula=?", situacao, idMatricula);
      registrada = true;
    } catch { /* já existia registro igual — não é erro, o vínculo continua valendo */ }
    return { ok: true, criado: true, modalidade: mod, contrato: idMatricula + "/" + seq, situacao, registrada };
  },
  /* a sequência do contrato é editável: a numeração histórica pode não bater com a ordem em que
     as linhas entraram no banco, e quem sabe o número certo é a recepção */
  salvarContrato({ idMatricula, livro, seq }: any) {
    const n = parseInt(seq, 10);
    if (!n || n < 1) throw new Error("O número do contrato deve ser 1 ou maior.");
    if (G("SELECT 1 FROM aluno_livro WHERE id_matricula=? AND contrato_seq=? AND livro<>?", idMatricula, n, livro))
      throw new Error("Este aluno já tem outro contrato com o número " + n + ".");
    const r = R("UPDATE aluno_livro SET contrato_seq=? WHERE id_matricula=? AND livro=?", n, idMatricula, livro);
    if (!r.changes) throw new Error("Matrícula não encontrada.");
    return { ok: true, contrato: idMatricula + "/" + n };
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
    R("INSERT INTO aluno_livro (id_matricula, livro, modalidade, vip, tipo_encontro) VALUES (?,?,?,?,?)", idMatricula, livroNovo, mod, antiga.vip, antiga.tipo_encontro);
    const aulasMovidas = R("UPDATE aulas SET livro=? WHERE id_matricula=? AND livro=?", livroNovo, idMatricula, livroAntigo).changes;
    R("DELETE FROM aluno_livro WHERE id_matricula=? AND livro=?", idMatricula, livroAntigo);
    return { ok: true, aulasMovidas, modalidade: mod };
  },

  /* ===== histórico de situação (linha do tempo manual: matrícula/rematrícula/etc por data) ===== */
  /* mais recente primeiro: a pergunta que se faz olhando esta lista é "em que pé ele está", e a
     resposta é sempre a última linha. Livro desempata registros do mesmo dia. */
  getHistoricoAluno: (id) => A("SELECT * FROM aluno_situacao_historico WHERE id_matricula=? ORDER BY data DESC, livro", id)
    .map(r => ({ id: r.id, situacao: r.situacao, data: r.data, livro: r.livro || null })),
  salvarHistoricoAluno({ idMatricula, situacao, data, livro }: any) {
    if (!idMatricula || !situacao || !data) throw new Error("Situação e data são obrigatórias.");
    if (!G("SELECT 1 FROM situacoes WHERE situacao=?", situacao)) throw new Error("Situação inválida: " + situacao);
    /* o livro é opcional (registro geral do aluno), mas se vier tem de ser um livro em que ele
       esteve matriculado — senão a pílula do histórico apontaria para um curso que nunca existiu.
       Aceita também livro de matrícula JÁ ENCERRADA, por isso a checagem é em `livros` e não em
       `aluno_livro`: quem encerrou o W2 e foi para o W4 não tem mais a linha do W2, e ainda assim
       precisa poder registrar "Encerrado · W2". */
    if (livro && !G("SELECT 1 FROM livros WHERE nome=?", livro)) throw new Error("Livro inválido: " + livro);
    R("INSERT INTO aluno_situacao_historico (id_matricula,situacao,data,livro) VALUES (?,?,?,?)",
      idMatricula, situacao, data, livro || null);
    return { ok: true };
  },
  excluirHistoricoAluno: (id) => ({ ok: R("DELETE FROM aluno_situacao_historico WHERE id=?", id).changes > 0 }),

  getAulasAluno: (id) => A("SELECT * FROM aulas WHERE id_matricula=?", id).map(r => ({ linha: r.id, dia: r.dia, horario: r.hora, livro: r.livro,
    professores: A("SELECT f.nome FROM aula_professor ap JOIN funcionarios f ON f.id=ap.funcionario_id WHERE ap.aula_id=?", r.id).map(x => x.nome) })),
  /* ===== ESTOQUE =====
     Uma rota só monta a tela inteira: itens, eventos e a matriz de quantidades. São ~30 itens e
     poucas dezenas de eventos — buscar tudo de uma vez é mais barato que N chamadas, e a grade
     precisa do conjunto completo para calcular saldo de qualquer jeito. */
  getEstoque() {
    const itens = A("SELECT * FROM estoque_item ORDER BY ordem, descricao").map(i => ({
      id: i.id, descricao: i.descricao, codigo: i.codigo || "", livro: i.livro || null,
      unidade: i.unidade, finalidade: i.finalidade, minimo: i.minimo, ativo: i.ativo === 1,
      ordem: i.ordem, categoria: i.livro ? categoriaLivro(i.livro) : "Materiais",
    }));
    const eventos = A("SELECT * FROM estoque_evento ORDER BY data, id").map(e => ({
      id: e.id, tipo: e.tipo, data: e.data, observacao: e.observacao || "",
      itens: Object.fromEntries(A("SELECT item_id, quantidade, nota FROM estoque_evento_item WHERE evento_id=?", e.id)
        .map(r => [r.item_id, { q: r.quantidade, nota: r.nota || null }])),
    }));
    /* entregas viram colunas de SAÍDA agregadas por período entre contagens — uma coluna por dia de
       entrega encheria a grade (são 127 matrículas). O dia exato fica na entrega e aparece no
       detalhe. Entrega sem data não entra em período nenhum: não dá para saber quando saiu, então
       ela conta como já absorvida por qualquer contagem (o livro não está na prateleira hoje). */
    const kits = Object.fromEntries(A("SELECT * FROM estoque_item WHERE unidade='kit'").map(k =>
      [k.id, A("SELECT item_id, quantidade FROM estoque_kit_item WHERE kit_id=?", k.id)
        .map(r => ({ itemId: r.item_id, quantidade: r.quantidade }))]));
    /* saldo e pendência vêm calculados do servidor: são as duas contas que a tela não pode errar,
       e deixá-las no cliente as duplicaria (a grade e a lista de entregas precisam das duas). */
    itens.forEach((i: any) => {
      i.saldo = saldoItem(i.id);
      i.pedidoPendente = pedidoPendenteItem(i.id);
      const falta = i.minimo - (i.saldo ?? 0) - i.pedidoPendente;
      i.sugestao = i.saldo == null ? 0 : Math.max(0, falta);
    });
    /* colunas de SAÍDA: entregas COM data, agrupadas pelo período entre contagens em que caíram.
       Entrega sem data não vira coluna — ela é justamente a que não se sabe quando aconteceu. */
    const contagens = A("SELECT data FROM estoque_evento WHERE tipo='contagem' ORDER BY data").map(r => r.data);
    const hoje = dataISO(new Date());
    /* O período ABERTO existe SEMPRE, como sentinela acima de qualquer data. A primeira versão só o
       criava quando `hoje > última contagem`, e aí uma entrega posterior à contagem caía no balde
       FECHADO dela — a grade desenhava a saída ANTES da contagem enquanto o saldo (que lê o banco
       direto) já a descontava. Grade contradizendo o saldo é pior que grade sem a coluna. */
    const ABERTO = "9999-12-31";
    const limites = contagens.concat([ABERTO]);
    const baldes: Record<string, Record<number, number>> = {};
    const quem: Record<string, any[]> = {};
    for (const e of A(`SELECT e.*, a.nome FROM entrega_material e JOIN alunos a ON a.id_matricula=e.id_matricula
                       WHERE e.data IS NOT NULL AND e.item_id IS NOT NULL`)) {
      const lim = limites.find(l => e.data <= l) as string;
      (baldes[lim] ||= {})[e.item_id] = ((baldes[lim] || {})[e.item_id] || 0) + 1;
      (quem[lim] ||= []).push({ itemId: e.item_id, nome: e.nome, data: e.data, livro: e.livro });
    }
    const saidas = Object.keys(baldes).map(lim => {
      const aberta = lim === ABERTO;
      /* a coluna aberta é rotulada pela data mais recente que ela contém (ou hoje, o que for maior):
         '9999' é sentinela de cálculo e não pode vazar para a tela */
      const maxData = (quem[lim] || []).reduce((m, q) => q.data > m ? q.data : m, hoje);
      return { id: "s|" + lim, tipo: "saida", data: aberta ? maxData : lim, aberta,
        itens: baldes[lim], quem: quem[lim] || [] };
    });
    return { itens, eventos, saidas, kits, entregas: listaEntregas() };
  },
  getEntregas: () => listaEntregas(),
  salvarItemEstoque(p: any) {
    if (!p?.descricao) throw new Error("A descrição do item é obrigatória.");
    if (p.livro && !G("SELECT 1 FROM livros WHERE nome=?", p.livro)) throw new Error("Livro inválido: " + p.livro);
    const campos = [p.descricao, p.codigo || null, p.livro || null, p.unidade || "unidade",
      p.finalidade || "venda", Number(p.minimo) || 0, p.ativo === false ? 0 : 1, Number(p.ordem) || 900];
    if (p.id) { R(`UPDATE estoque_item SET descricao=?,codigo=?,livro=?,unidade=?,finalidade=?,minimo=?,ativo=?,ordem=? WHERE id=?`, ...campos, p.id); return { ok: true, id: p.id }; }
    const r = R(`INSERT INTO estoque_item (descricao,codigo,livro,unidade,finalidade,minimo,ativo,ordem) VALUES (?,?,?,?,?,?,?,?)`, ...campos);
    return { ok: true, id: Number(r.lastInsertRowid) };
  },
  excluirItemEstoque: ({ id }: any) => ({ ok: R("DELETE FROM estoque_item WHERE id=?", id).changes > 0 }),
  salvarEventoEstoque(p: any) {
    if (!p?.tipo || !p?.data) throw new Error("Tipo e data são obrigatórios.");
    if (p.id) { R("UPDATE estoque_evento SET data=?, observacao=? WHERE id=?", p.data, p.observacao || null, p.id); return { ok: true, id: p.id }; }
    const r = R("INSERT INTO estoque_evento (tipo,data,observacao,momento) VALUES (?,?,?,?)", p.tipo, p.data, p.observacao || null, agora());
    const id = Number(r.lastInsertRowid);
    /* contagem nova nasce com o SALDO ESPERADO, não com a cópia da contagem anterior: com uma
       remessa no meio, copiar a anterior apagaria sozinho o que o sistema já sabia. O trabalho da
       pessoa é conferir e corrigir onde diverge, que é o que ela faz de prancheta na mão. */
    if (p.tipo === "contagem" && p.preencher !== false)
      for (const it of A("SELECT id FROM estoque_item WHERE ativo=1")) {
        const s = saldoItem(it.id);
        if (s != null) R("INSERT INTO estoque_evento_item (evento_id,item_id,quantidade) VALUES (?,?,?)", id, it.id, s);
      }
    return { ok: true, id };
  },
  excluirEventoEstoque: ({ id }: any) => ({ ok: R("DELETE FROM estoque_evento WHERE id=?", id).changes > 0 }),
  /* célula da grade: quantidade nula APAGA a linha. Vazio e zero são coisas diferentes — zero é
     "conferi e não tem", vazio é "não contei". */
  gravarCelulaEstoque({ eventoId, itemId, quantidade, nota }: any) {
    if (!eventoId || !itemId) throw new Error("Evento e item são obrigatórios.");
    if (quantidade == null || quantidade === "")
      R("DELETE FROM estoque_evento_item WHERE evento_id=? AND item_id=?", eventoId, itemId);
    else
      R(`INSERT INTO estoque_evento_item (evento_id,item_id,quantidade,nota) VALUES (?,?,?,?)
         ON CONFLICT(evento_id,item_id) DO UPDATE SET quantidade=excluded.quantidade, nota=excluded.nota`,
        eventoId, itemId, Math.max(0, parseInt(quantidade, 10) || 0), nota || null);
    return { ok: true, saldo: saldoItem(itemId) };
  },
  /* entregar = registrar que o livro daquela matrícula foi para a mão do aluno. Sem quantidade:
     é um livro, o dele. A data pode vir vazia e ser preenchida depois. */
  entregarMaterial({ idMatricula, livro, data }: any) {
    if (!idMatricula || !livro) throw new Error("Matrícula e livro são obrigatórios.");
    const it = G("SELECT id FROM estoque_item WHERE livro=?", livro);
    R(`INSERT INTO entrega_material (id_matricula,livro,item_id,data,deduzida,momento) VALUES (?,?,?,?,0,?)
       ON CONFLICT(id_matricula,livro) DO UPDATE SET data=excluded.data, deduzida=0`,
      idMatricula, livro, it?.id ?? null, data || null, agora());
    return { ok: true, saldo: it ? saldoItem(it.id) : null };
  },
  /* a data da entrega é editável justamente porque as deduzidas nascem sem data — ninguém sabe
     quando aqueles livros saíram, e chutar seria pior que deixar em branco */
  ajustarEntrega({ idMatricula, livro, data }: any) {
    const r = R("UPDATE entrega_material SET data=?, deduzida=0 WHERE id_matricula=? AND livro=?", data || null, idMatricula, livro);
    if (!r.changes) throw new Error("Entrega não encontrada.");
    return { ok: true };
  },
  removerEntrega({ idMatricula, livro }: any) {
    const it = G("SELECT id FROM estoque_item WHERE livro=?", livro);
    R("DELETE FROM entrega_material WHERE id_matricula=? AND livro=?", idMatricula, livro);
    return { ok: true, saldo: it ? saldoItem(it.id) : null };
  },
  salvarKitItem({ kitId, itemId, quantidade }: any) {
    if (!kitId || !itemId) throw new Error("Kit e item são obrigatórios.");
    if (kitId === itemId) throw new Error("Um kit não pode conter ele mesmo.");
    const q = Math.max(1, parseInt(quantidade, 10) || 1);
    R(`INSERT INTO estoque_kit_item (kit_id,item_id,quantidade) VALUES (?,?,?)
       ON CONFLICT(kit_id,item_id) DO UPDATE SET quantidade=excluded.quantidade`, kitId, itemId, q);
    return { ok: true };
  },
  removerKitItem: ({ kitId, itemId }: any) => ({ ok: R("DELETE FROM estoque_kit_item WHERE kit_id=? AND item_id=?", kitId, itemId).changes > 0 }),

  /* ===== BIBLIOTECA · ESTÁGIOS =====
     Uma rota monta a tela inteira: são 26 estágios e 3 modelos, e a grade precisa do conjunto
     para desenhar a trilha de qualquer jeito. */
  getEstagios() {
    const modelos = A("SELECT * FROM estagio_modelo ORDER BY id").map(m => ({
      id: m.id, nome: m.nome, licoesPorCapitulo: m.licoes_por_capitulo, capitulos: m.capitulos,
      comuns: m.licoes_por_capitulo * m.capitulos }));
    const prox: Record<number, number[]> = {}, equiv: Record<number, number[]> = {};
    A("SELECT * FROM estagio_proximo").forEach(r => (prox[r.de_id] ||= []).push(r.para_id));
    A("SELECT * FROM estagio_equivalente").forEach(r => (equiv[r.a_id] ||= []).push(r.b_id));
    /* ordem PEDAGÓGICA das categorias, não alfabética: por nome, "Outros Idiomas" caía entre
       Kids e Teens e quebrava a leitura da progressão. */
    const estagios = A(`SELECT * FROM estagio ORDER BY
        CASE categoria WHEN 'Kids' THEN 1 WHEN 'Teens' THEN 2 WHEN 'W' THEN 3 ELSE 4 END,
        ordem, id`).map(e => ({
      id: e.id, sigla: e.sigla, nome: e.nome, idioma: e.idioma, categoria: e.categoria,
      grupo: e.grupo || "", modeloId: e.modelo_id, licaoInicial: e.licao_inicial,
      entrada: e.entrada === 1, ordem: e.ordem,
      idadeMin: e.idade_min, idadeMax: e.idade_max,
      escalaAtiva: e.escala_ativa === 1, cefrMin: e.cefr_min || "", cefrMax: e.cefr_max || "",
      gseMin: e.gse_min, gseMax: e.gse_max,
      edicaoNome: e.edicao_nome || "", edicaoAno: e.edicao_ano,
      status: e.status, livro: e.livro || null, itemEstoqueId: e.item_estoque_id || null,
      descricao: e.descricao || "",
      /* 'abertura' antes de 'flutuante' — e alfabeticamente já é essa a ordem, então ASC basta.
         Com DESC as remind vinham primeiro e a Welcome Lesson aparecia depois delas. */
      extras: A("SELECT * FROM estagio_licao_extra WHERE estagio_id=? ORDER BY posicao, ordem", e.id)
        .map(x => ({ id: x.id, ordem: x.ordem, rotulo: x.rotulo, posicao: x.posicao })),
      proximos: prox[e.id] || [], equivalentes: equiv[e.id] || [],
      /* quantos alunos estão neste estágio hoje — o vínculo é pelo LIVRO, que é o que
         `aluno_livro` conhece; edições diferentes do mesmo livro somam no mesmo número */
      alunos: e.livro ? (G(`SELECT COUNT(*) n FROM aluno_livro al JOIN alunos a ON a.id_matricula=al.id_matricula
          JOIN situacoes s ON s.situacao=a.situacao AND s.ativa=1 WHERE al.livro=?`, e.livro)?.n || 0) : 0,
    }));
    return { modelos, estagios, livros: A("SELECT nome FROM livros ORDER BY ordem").map(r => r.nome) };
  },
  salvarEstagio(p: any) {
    if (!p?.sigla || !p?.nome) throw new Error("Sigla e nome são obrigatórios.");
    if (p.livro && !G("SELECT 1 FROM livros WHERE nome=?", p.livro)) throw new Error("Livro inválido: " + p.livro);
    const num = (v: any) => (v === "" || v == null ? null : Number(v));
    const campos = [p.sigla, p.nome, p.idioma || "Inglês", p.categoria || "Kids", p.grupo || null,
      num(p.modeloId), Number(p.licaoInicial) || 1, p.entrada ? 1 : 0, Number(p.ordem) || 100,
      num(p.idadeMin), num(p.idadeMax), p.escalaAtiva ? 1 : 0,
      p.cefrMin || null, p.cefrMax || null, num(p.gseMin), num(p.gseMax),
      p.edicaoNome || null, num(p.edicaoAno), p.status || "ativo", p.livro || null,
      num(p.itemEstoqueId), p.descricao || null];
    if (p.id) {
      R(`UPDATE estagio SET sigla=?,nome=?,idioma=?,categoria=?,grupo=?,modelo_id=?,licao_inicial=?,
         entrada=?,ordem=?,idade_min=?,idade_max=?,escala_ativa=?,cefr_min=?,cefr_max=?,gse_min=?,
         gse_max=?,edicao_nome=?,edicao_ano=?,status=?,livro=?,item_estoque_id=?,descricao=? WHERE id=?`,
        ...campos, p.id);
      return { ok: true, id: p.id };
    }
    const r = R(`INSERT INTO estagio (sigla,nome,idioma,categoria,grupo,modelo_id,licao_inicial,entrada,
       ordem,idade_min,idade_max,escala_ativa,cefr_min,cefr_max,gse_min,gse_max,edicao_nome,edicao_ano,
       status,livro,item_estoque_id,descricao) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...campos);
    return { ok: true, id: Number(r.lastInsertRowid) };
  },
  excluirEstagio: ({ id }: any) => ({ ok: R("DELETE FROM estagio WHERE id=?", id).changes > 0 }),
  salvarLicaoExtra(p: any) {
    if (!p?.estagioId || !p?.rotulo) throw new Error("Estágio e rótulo são obrigatórios.");
    if (p.id) { R("UPDATE estagio_licao_extra SET rotulo=?, posicao=?, ordem=? WHERE id=?",
      p.rotulo, p.posicao || "abertura", Number(p.ordem) || 1, p.id); return { ok: true, id: p.id }; }
    const prox = (G("SELECT MAX(ordem) m FROM estagio_licao_extra WHERE estagio_id=? AND posicao=?",
      p.estagioId, p.posicao || "abertura")?.m || 0) + 1;
    const r = R("INSERT INTO estagio_licao_extra (estagio_id,ordem,rotulo,posicao) VALUES (?,?,?,?)",
      p.estagioId, prox, p.rotulo, p.posicao || "abertura");
    return { ok: true, id: Number(r.lastInsertRowid) };
  },
  excluirLicaoExtra: ({ id }: any) => ({ ok: R("DELETE FROM estagio_licao_extra WHERE id=?", id).changes > 0 }),
  ligarEstagios(p: any) {
    const t = p.tipo === "equivalente" ? "estagio_equivalente" : "estagio_proximo";
    const [ca, cb] = p.tipo === "equivalente" ? ["a_id", "b_id"] : ["de_id", "para_id"];
    if (p.remover) {
      R(`DELETE FROM ${t} WHERE ${ca}=? AND ${cb}=?`, p.a, p.b);
      if (p.tipo === "equivalente") R(`DELETE FROM ${t} WHERE ${ca}=? AND ${cb}=?`, p.b, p.a);
    } else {
      R(`INSERT OR IGNORE INTO ${t} (${ca},${cb}) VALUES (?,?)`, p.a, p.b);
      if (p.tipo === "equivalente") R(`INSERT OR IGNORE INTO ${t} (${ca},${cb}) VALUES (?,?)`, p.b, p.a);
    }
    return { ok: true };
  },

  getHorariosHistoricoAluno: ({ idMatricula }: any) =>
    A("SELECT * FROM aluno_horario_historico WHERE id_matricula=? ORDER BY momento DESC", idMatricula)
      .map(r => ({ id: r.id, livro: r.livro, antes: r.antes, depois: r.depois, momento: r.momento })),

  salvarAgendaLivro(p) { // sincroniza a agenda do aluno NESTE livro (desmarcar = remover; mesmo slot = troca de livro)
    if (!p?.itens) throw new Error("Dados incompletos.");
    const mat = getMatricula(p.idMatricula, p.livro);
    if (!mat) throw new Error("Matricule o aluno no livro " + p.livro + " antes de definir os horários.");
    /* agenda que estava valendo ANTES de qualquer escrita, para decidir se isto é uma troca.
       Só é troca quando já HAVIA horário e ele mudou: definir horário pela primeira vez não pergunta
       nada (é o cadastro normal), e salvar sem mexer nos dias também não. */
    const antes = agendaTexto(p.idMatricula, p.livro);
    const depois = agendaTextoDeItens(p.itens);
    const ehTroca = antes !== "" && antes !== depois;
    if (ehTroca && !p.confirmado) return { ok: false, precisaTroca: true, antes, depois, livro: p.livro };
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
    /* registra a troca DEPOIS de gravar: se algo acima estourasse, o histórico ficaria contando uma
       mudança que não aconteceu. Só a troca de verdade entra — o primeiro horário não é troca. */
    if (ehTroca) {
      R("INSERT INTO aluno_horario_historico (id_matricula,livro,antes,depois,momento) VALUES (?,?,?,?,?)",
        p.idMatricula, p.livro, antes, depois, agora());
      anotar(p.idMatricula, p.livro, null, "horario", depois, "troca de horário: " + (antes || "sem horário") + " → " + (depois || "sem horário"));
    }
    return { ok: true, salvas, removidas, avisos, trocou: ehTroca, antes, depois };
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
  /* ficha impressa: além dos blocos, devolve as colunas do mês JÁ PREENCHIDAS com o que foi lançado.
     É o que permite reimprimir no meio do mês sem recopiar as presenças à mão — a folha sai com os
     P/X que já estão no sistema. `mes` opcional ('AAAA-MM') para reimprimir mês anterior. */
  fichas({ dias, mes }: any) {
    const ref = mes ? new Date(mes + "-01T12:00:00") : new Date();
    return { blocos: blocosComColunas(montarBlocos(dias), ref, dias, false, COLUNAS_FICHA),
      mesNome: MESES_PT[ref.getMonth()], mes: ref.getFullYear() + "-" + ("0" + (ref.getMonth() + 1)).slice(-2) };
  },

  /* ===== lançador de presença (check-in) =====
     Mesmos blocos da impressão (montarBlocos), só que com as colunas do mês já preenchidas com o
     que foi lançado. Sem `hora`, escolhe o bloco da hora atual; se não houver nada rodando agora,
     devolve o bloco mais próximo do horário (a recepção quase sempre lança no meio da aula). */
  /* Lançador (check-in): as colunas são a SEMANA CORRENTE (Segunda→Sábado), não o mês.
     A ficha impressa continua com as 12 colunas do mês — são visões diferentes do mesmo dado. */
  getLancador({ data, hora }: any = {}) {
    const dInfo: Record<string, any> = {}; A("SELECT * FROM dias").forEach(r => dInfo[r.nome] = r);
    const agora = new Date();
    const ref = data ? new Date(data + "T12:00:00") : agora; // meio-dia: imune a fuso/horário de verão
    const dia = NOMES_DIA[ref.getDay()];

    /* a data entra aqui para trazer também quem vem FORA da agenda naquele dia (reposição, aluno
       previsto pela recepção). A ficha impressa chama montarBlocos sem data e não muda. */
    const doDia = montarBlocos([dia], undefined, dataISO(ref));
    const horas = [...new Set(doDia.map((b: any) => b.hora))].sort();
    let horaSel = hora || null;
    if (!horaSel && horas.length) { // hora atual, ou a mais próxima dela
      const hAgora = ("0" + agora.getHours()).slice(-2) + ":00";
      horaSel = horas.includes(hAgora) ? hAgora
        : horas.reduce((m, h) => Math.abs(parseInt(h, 10) - agora.getHours()) < Math.abs(parseInt(m, 10) - agora.getHours()) ? h : m, horas[0]);
    }
    const blocos = doDia.filter((b: any) => b.hora === horaSel);

    /* ===== ARRASTO: o bloco aberto recebe quem veio dos horários anteriores de HOJE =====
       Dois motivos diferentes para um aluno de bloco anterior continuar aparecendo, e cada um vira
       um grupo com divisória própria na tela:

       EM AULA (`emAulaDe`) — entrou e ninguém registrou a saída. A aula dele atravessou a virada da
       hora: quem entrou 13h37 continua em aula às 14h05, e some do bloco das 13h se a tela só
       mostrar o horário. Ele acompanha os blocos seguintes até a saída ser lançada.
       SEM LANÇAMENTO (`arrastadoDe`) — ninguém tocou: nem presença, nem falta, nem não-aula. Segue
       empilhado até alguém decidir, ou até o fecho do dia lançar a falta.

       Quem já tem falta, não-aula ou saída registrada NÃO é arrastado: aquele aluno está resolvido.
       A agenda não muda em nenhum caso — isto é exibição.
       Só HOJE: em dia passado o fecho já resolveu, em dia futuro não há o que arrastar. */
    if (dataISO(ref) === dataISO(agora) && horaSel && blocos.length) {
      const jaNoBloco = new Set<string>();
      blocos.forEach((b: any) => b.alunos.forEach((al: any) => jaNoBloco.add(al.id + "|" + al.livro)));
      const emAula: any[] = [], atrasados: any[] = [];
      for (const b of doDia) {
        if (b.hora >= horaSel) continue;
        for (const al of b.alunos) {
          const k = al.id + "|" + al.livro;
          if (jaNoBloco.has(k)) continue;          // ele também tem aula neste horário: não é arrasto
          const p = G("SELECT status, entrada, saida FROM presenca WHERE id_matricula=? AND livro=? AND data=?",
            al.id, al.livro, dataISO(ref));
          if (p && !(p.status === "P" && p.entrada && !p.saida)) continue;   // resolvido: sai da tela
          jaNoBloco.add(k);                        // some de uma vez só, mesmo vindo de 3 blocos atrás
          if (p) emAula.push({ ...al, emAulaDe: b.hora });
          else   atrasados.push({ ...al, arrastadoDe: b.hora });
        }
      }
      /* todos vão para o PRIMEIRO bloco da hora: são grupos à parte, com divisória própria, e
         espalhá-los entre blocos irmãos só faria a régua de leitura pular de tabela em tabela.
         Ordem PRÓPRIA e pedagógica dentro de cada grupo: livro (Kids 2 antes de Kids 4...) e depois
         nome. Não herda a ordem de chegada, senão o grupo se rearrumaria a cada hora que passa.
         EM AULA vem antes de SEM LANÇAMENTO: quem está na sala agora pede ação mais cedo do que
         quem talvez nem venha. */
      if (emAula.length || atrasados.length) {
        const ordemLivro: Record<string, number> = {};
        A("SELECT nome, ordem FROM livros").forEach(r => ordemLivro[r.nome] = r.ordem);
        const porLivro = (p: any, q: any) => (ordemLivro[p.livro] ?? 999) - (ordemLivro[q.livro] ?? 999)
          || String(p.nome).localeCompare(String(q.nome), "pt");
        emAula.sort(porLivro); atrasados.sort(porLivro);
        blocos[0] = { ...blocos[0], alunos: [...blocos[0].alunos, ...emAula, ...atrasados] };
      }
    }

    // semana da data de referência: segunda → sábado (domingo não é dia letivo)
    const seg = new Date(ref); seg.setDate(seg.getDate() - ((seg.getDay() + 6) % 7));
    const hojeISO = dataISO(agora);
    const semana = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(seg); d.setDate(seg.getDate() + i);
      const nome = NOMES_DIA[d.getDay()];
      return { data: dataISO(d), dia: nome, codigo: dInfo[nome]?.codigo || nome,
        curto: dInfo[nome]?.curto || nome, numero: d.getDate(), hoje: dataISO(d) === hojeISO };
    });

    // dias regulares do aluno (com nº de aulas) — alimenta as pílulas de "Dias"
    const regulares: Record<string, Record<string, number>> = {};
    for (const r of A("SELECT id_matricula, livro, dia, COUNT(*) n FROM aulas GROUP BY 1,2,3"))
      (regulares[r.id_matricula + "|" + r.livro] ||= {})[r.dia] = r.n;
    /* on-day/off-day considera dia E HORA: o bloco é de um horário específico, então quem faz
       segunda 14h não é "da segunda" num bloco das 18h — a coluna sai apagada mesmo tendo aula
       naquele dia em outro horário. Lançar continua permitido (reposição). */
    const regularesNaHora: Record<string, Set<string>> = {};
    if (horaSel) for (const r of A("SELECT DISTINCT id_matricula, livro, dia FROM aulas WHERE hora=?", horaSel))
      (regularesNaHora[r.id_matricula + "|" + r.livro] ||= new Set()).add(r.dia);

    const idx = indicePontos(semana[0].data, semana[5].data);
    const comAlunos = blocos.map((b: any) => ({ ...b, alunos: b.alunos.map((al: any) => {
      const chave = al.id + "|" + al.livro;
      const reg = regulares[chave] || {};
      const mat = getMatricula(al.id, al.livro);
      return { ...al,
        modalidade: mat?.modalidade || b.mod, vip: mat?.vip === 1,
        tipoEncontro: mat?.tipo_encontro || "Presencial",
        // pílulas: um item por dia regular, com a contagem de aulas dentro
        diasPilulas: Object.keys(reg).map(d => dInfo[d]).filter(Boolean)
          .sort((p: any, q: any) => p.ordem - q.ordem)
          .map((d: any) => ({ codigo: d.codigo, curto: d.curto, aulas: reg[d.nome] })),
        regular: Object.fromEntries(semana.map(s => [s.data, !!regularesNaHora[chave]?.has(s.dia)])), // false = off-day (apagado)
        pontos: Object.fromEntries(semana.map(s => [s.data, idx[chave]?.[s.data] || null])),
      };
    }) }));

    return { data: dataISO(ref), dia, diaCurto: dInfo[dia]?.curto || dia, hora: horaSel, horas,
      semana, blocos: comAlunos, ehHoje: dataISO(ref) === hojeISO,
      agora: ("0" + agora.getHours()).slice(-2) + ":" + ("0" + agora.getMinutes()).slice(-2) };
  },
  lancarPresenca: (p: any) => gravarPresenca(p),
  /* Só o mapa de lançamentos do intervalo, sem remontar blocos: as duas telas (recepção e sala de
     aula) rodam em MÁQUINAS diferentes sobre a mesma linha de `presenca`, então cada uma precisa
     enxergar o que a outra acabou de lançar sem recarregar a página inteira. */
  getPontosSemana: ({ ini, fim }: any) => {
    if (!ini || !fim) throw new Error("Informe o intervalo (ini e fim).");
    return indicePontos(ini, fim);
  },
  /* check-in / check-out: grava a hora do relógio da recepção. Entrada implica presença ('P');
     limpar a entrada zera o lançamento do dia (volta a "não lançado"). */
  registrarPonto({ idMatricula, livro, data, tipo, hora, limpar, manterPresenca, confirmado, licoes }: any) {
    if (!idMatricula || !livro || !data || !tipo) throw new Error("Dados incompletos para registrar o ponto.");
    if (tipo !== "entrada" && tipo !== "saida") throw new Error("Tipo inválido: use entrada ou saida.");
    const agora = new Date();
    const relogio = ("0" + agora.getHours()).slice(-2) + ":" + ("0" + agora.getMinutes()).slice(-2);
    const hhmm = hora || relogio;
    const atual = G("SELECT * FROM presenca WHERE id_matricula=? AND livro=? AND data=?", idMatricula, livro, data);
    if (limpar) {
      if (tipo === "saida") { R("UPDATE presenca SET saida=NULL, aulas_feitas=NULL, licoes=NULL WHERE id_matricula=? AND livro=? AND data=?", idMatricula, livro, data);
        anotar(idMatricula, livro, data, "limpeza", null, "saída desfeita"); return { ok: true, entrada: atual?.entrada || null, saida: null, status: atual?.status || null }; }
      /* Desfazer só a ENTRADA, MANTENDO a presença. É a reversão "não entrou ainda" do quadro da
         sala: o aluno chegou à escola (a recepção lançou o P) mas não entrou na aula, então o
         cartão tem de voltar para a coluna RECEPÇÃO — não para "A vir", que quer dizer que ninguém
         viu esse aluno hoje. Sem isto a única limpeza possível era apagar a linha inteira, e era
         exatamente isso que jogava o cartão para a primeira coluna.
         A saída é zerada junto porque o banco não admite saída sem entrada (CHECK); na prática não
         se perde nada, já que quem está "em aula" ainda não tem saída. */
      if (manterPresenca && atual) {
        R(`UPDATE presenca SET status='P', entrada=NULL, saida=NULL, aulas_feitas=NULL, licoes=NULL
           WHERE id_matricula=? AND livro=? AND data=?`, idMatricula, livro, data);
        anotar(idMatricula, livro, data, "limpeza", null, "entrada desfeita; presença mantida");
        return { ok: true, entrada: null, saida: null, status: "P" };
      }
      R("DELETE FROM presenca WHERE id_matricula=? AND livro=? AND data=?", idMatricula, livro, data);
      anotar(idMatricula, livro, data, "limpeza", null, "lançamento do dia removido");
      return { ok: true, entrada: null, saida: null, status: null };
    }
    /* A hora pode vir digitada (edição do ponto na célula), então aqui ela é dado de fora e precisa
       ser conferida — o CHECK do banco pega '99:99', mas não pega '25:00' virando lixo silencioso,
       nem ponto no futuro. Ponto é carimbo de relógio: ninguém entrou num horário que não chegou.
       Vale só para entrada/saída — FALTA em data futura continua livre (aluno que avisa viagem),
       porque isso é lancarPresenca, não passa por aqui. Limpar também escapa: desfazer é sempre
       permitido, senão um ponto errado ficaria preso. */
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) throw new Error("Horário inválido: use HH:MM, entre 00:00 e 23:59.");
    const hojeISO = dataISO(agora);
    if (data > hojeISO) throw new Error("Não dá para registrar ponto em " + data + ": esse dia ainda não chegou.");
    if (data === hojeISO && hhmm > relogio) throw new Error("São " + relogio + " agora — não dá para registrar " + hhmm + ", que ainda não chegou.");
    if (tipo === "entrada") {
      /* editar a entrada para depois da saída já gravada viraria "CHECK constraint failed" cru na
         tela — a regra é a mesma, só dita em português */
      if (atual?.saida && hhmm > atual.saida) throw new Error("A entrada (" + hhmm + ") não pode ser depois da saída (" + atual.saida + ").");
      R(`INSERT INTO presenca (id_matricula,livro,data,status,entrada) VALUES (?,?,?,'P',?)
         ON CONFLICT(id_matricula,livro,data) DO UPDATE SET status='P', entrada=excluded.entrada`,
        idMatricula, livro, data, hhmm);
      anotar(idMatricula, livro, data, "entrada", hhmm);
      return { ok: true, entrada: hhmm, saida: atual?.saida || null, status: "P" };
    }
    if (!atual?.entrada) throw new Error("Registre a entrada antes da saída."); // CHECK do banco também barra
    if (hhmm < atual.entrada) throw new Error("A saída (" + hhmm + ") não pode ser antes da entrada (" + atual.entrada + ").");
    /* saída cedo demais é quase sempre clique errado (o funcionário aperta saída logo após a
       entrada). Não bloqueia — só devolve o aviso para a tela confirmar, porque sair mais cedo
       de verdade acontece (aluno passou mal, foi buscado antes). */
    const dur = minutosEntre(atual.entrada, hhmm);
    if (dur < AULA_CURTA_MIN && !confirmado)
      return { ok: false, precisaConfirmar: true, minutos: dur, entrada: atual.entrada, saida: hhmm,
        aviso: "Só " + dur + " minuto(s) desde a entrada (" + atual.entrada + ")." };
    /* saiu antes de dar tempo de cumprir todas as lições do dia: a falta é da AULA, então em vez
       de assumir presença cheia o app pergunta quantas lições ele fez. */
    const doDia = licoesDoDia(idMatricula, livro, data), previstas = doDia.length;
    if (previstas > 1 && licoes == null && dur < previstas * 60 - TOLERANCIA_MIN && !confirmado) {
      /* sugere pelas horas que a permanência de fato cobriu: quem entrou às 11h num dia de 10h+11h
         provavelmente perdeu a primeira, não a segunda — o palpite parte do relógio, não do total */
      const sug = doDia.filter(h => {
        const ini = emMinutos(h), fim = ini + 60, ent = emMinutos(atual.entrada), sai = emMinutos(hhmm);
        return Math.min(fim, sai) - Math.max(ini, ent) >= 30;   // ficou pelo menos metade da lição
      });
      return { ok: false, precisaAulas: true, previstas, licoesDoDia: doDia,
        sugestao: sug.length ? sug : [doDia[0]], minutos: dur, entrada: atual.entrada, saida: hhmm,
        aviso: fmtMin(dur) + " desde a entrada (" + atual.entrada + "), mas o dia tem " + previstas + " lições." };
    }
    const lst = Array.isArray(licoes) && licoes.length ? doDia.filter(h => licoes.includes(h)) : null;
    R("UPDATE presenca SET saida=?, licoes=COALESCE(?, licoes), aulas_feitas=COALESCE(?, aulas_feitas) WHERE id_matricula=? AND livro=? AND data=?",
      hhmm, lst ? lst.join(",") : null, lst ? lst.length : null, idMatricula, livro, data);
    const grav = G("SELECT licoes, aulas_feitas a FROM presenca WHERE id_matricula=? AND livro=? AND data=?", idMatricula, livro, data);
    anotar(idMatricula, livro, data, "saida", hhmm,
      lst ? "lições cumpridas: " + lst.join(", ") + " (de " + previstas + ")" : null);
    return { ok: true, entrada: atual.entrada, saida: hhmm, status: "P", minutos: dur,
      licoes: grav?.licoes ? String(grav.licoes).split(",") : null, aulasFeitas: grav?.a ?? null, previstas };
  },
  /* aba "Presenças hoje": quem já passou pela recepção, em ordem cronológica de entrada */
  getPresencasHoje({ data }: any = {}) {
    const alvo = data || dataISO(new Date());
    const linhas = A(`SELECT p.*, a.nome FROM presenca p JOIN alunos a ON a.id_matricula=p.id_matricula
      WHERE p.data=? AND p.status='P' AND p.entrada IS NOT NULL ORDER BY p.entrada, a.nome`, alvo);
    const linhasOut = linhas.map(l => {
      const mat = getMatricula(l.id_matricula, l.livro);
      return { id: l.id_matricula, nome: l.nome, livro: l.livro, entrada: l.entrada, saida: l.saida,
        minutos: l.minutos ?? null, modalidade: mat?.modalidade || null, vip: mat?.vip === 1, presente: !l.saida };
    });
    return { data: alvo, total: linhasOut.length, linhas: linhasOut,
      minutosTotais: linhasOut.reduce((t, l) => t + (l.minutos || 0), 0) };
  },
  /* lote: marcar a coluna inteira de uma data (feriado/férias = 'N' para todo mundo do bloco) */
  lancarPresencaLote({ itens }: any) {
    if (!Array.isArray(itens)) throw new Error("Nada para lançar.");
    itens.forEach(gravarPresenca);
    return { ok: true, total: itens.length };
  },
  /* frequência do aluno (accordion na aba Alunos): tudo que já foi lançado, em qualquer dia/livro.
     'N' (não aula) fica FORA do cálculo de aproveitamento — não conta como presença nem como falta. */
  /* Frequência do aluno em UMA lista só, mais recente primeiro.
     Antes, os encontros fora da agenda saíam numa seção separada embaixo ("Fora do horário fixo"),
     e a mesma data podia aparecer duas vezes — uma na presença, outra no encontro. Contam a mesma
     história, então viraram a mesma linha: o dia que não é o do horário dele fica na lista normal,
     em ordem de data, apenas com um sinal de alerta. Separar por tipo obrigava a ler duas listas
     para reconstruir a sequência do aluno, que é justamente o que se quer olhar aqui. */
  getFrequenciaAluno({ idMatricula }: any) {
    const dInfo: Record<string, any> = {}; A("SELECT * FROM dias").forEach(r => dInfo[r.nome] = r);
    /* dias regulares POR LIVRO: é contra eles que se decide se a data caiu fora do horário dele.
       Por livro e não por aluno — quem faz inglês na terça e espanhol no sábado tem dois conjuntos,
       e o sábado só é "fora" para o inglês. */
    const regulares: Record<string, Set<string>> = {};
    for (const r of A("SELECT DISTINCT livro, dia FROM aulas WHERE id_matricula=?", idMatricula))
      (regulares[r.livro] ||= new Set()).add(r.dia);
    const avuls: Record<string, any> = {};
    for (const e of A("SELECT * FROM encontro_avulso WHERE id_matricula=?", idMatricula))
      avuls[e.livro + "|" + e.data] = e;

    const monta = (data: string, livro: string, extra: any) => {
      const d = new Date(data + "T12:00:00");
      const diaNome = NOMES_DIA[d.getDay()];
      const av = avuls[livro + "|" + data];
      const reg = regulares[livro];
      return { data, livro, numero: d.getDate(), diaCurto: dInfo[diaNome]?.curto || "",
        mes: MESES_PT[d.getMonth()],
        /* "fora do horário" = o aluno tem agenda neste livro e este dia da semana não está nela.
           Sem agenda nenhuma não há como estar fora dela — aluno avulso não é irregular. */
        foraDoHorario: !!(reg && reg.size && !reg.has(diaNome)),
        avulso: av ? { id: av.id, hora: av.hora, motivo: av.motivo, observacao: av.observacao || null } : null,
        ...extra };
    };

    const linhas = A("SELECT * FROM presenca WHERE id_matricula=? ORDER BY data DESC, livro", idMatricula)
      .map(l => monta(l.data, l.livro, { status: l.status,
        entrada: l.entrada || null, saida: l.saida || null, minutos: l.minutos ?? null,
        auto: l.auto === 1 }));
    /* encontro previsto que nunca virou presença: entra na lista sem status. É o caso que mais
       interessa depois ("marcamos reposição e ele não veio") e some se a lista só olhar presenca. */
    const comPresenca = new Set(linhas.map(l => l.livro + "|" + l.data));
    for (const k of Object.keys(avuls)) {
      if (comPresenca.has(k)) continue;
      const e = avuls[k];
      linhas.push(monta(e.data, e.livro, { status: null, entrada: null, saida: null, minutos: null, auto: false }));
    }
    linhas.sort((a, b) => a.data < b.data ? 1 : a.data > b.data ? -1 : String(a.livro).localeCompare(String(b.livro), "pt"));

    const r = { P: 0, F: 0, N: 0 };
    linhas.forEach(l => { if (l.status && l.status in r) (r as any)[l.status]++; });
    const base = r.P + r.F; // não aula não entra na conta
    const minutos = linhas.reduce((t, l) => t + (l.minutos || 0), 0);   // tempo de aula efetivamente cumprido
    return { linhas, resumo: { ...r, total: linhas.length, aproveitamento: base ? Math.round(r.P * 100 / base) : null,
      minutos, comPonto: linhas.filter(l => l.minutos != null).length,
      fora: linhas.filter(l => l.foraDoHorario).length } };
  },
  /* busca rápida: tudo que a janelinha de lançar precisa saber sobre o aluno naquele dia —
     inclusive o horário PRÓPRIO dele (a presença é do dia; a hora exibida é só informativa) */
  infoPresencaAluno({ idMatricula, data }: any) {
    const dInfo: Record<string, any> = {}; A("SELECT * FROM dias").forEach(r => dInfo[r.nome] = r);
    const alu = G("SELECT * FROM v_alunos WHERE id_matricula=?", idMatricula);
    if (!alu) throw new Error("Aluno não encontrado.");
    const diaData = data ? NOMES_DIA[new Date(data + "T12:00:00").getDay()] : null;
    const matriculas = A("SELECT * FROM aluno_livro WHERE id_matricula=?", idMatricula).map(m => {
      const aulas = A("SELECT dia, hora FROM aulas WHERE id_matricula=? AND livro=?", idMatricula, m.livro);
      const dias = [...new Set(aulas.map((a: any) => a.dia))].sort((p, q) => (dInfo[p]?.ordem || 0) - (dInfo[q]?.ordem || 0));
      return { livro: m.livro, modalidade: m.modalidade, vip: m.vip === 1,
        dias: dias.map(d => dInfo[d]?.codigo || d),
        horarioNoDia: diaData ? [...new Set(aulas.filter((a: any) => a.dia === diaData).map((a: any) => a.hora))].sort() : [],
        ehDiaDele: diaData ? dias.includes(diaData) : false,
        status: G("SELECT status FROM presenca WHERE id_matricula=? AND livro=? AND data=?", idMatricula, m.livro, data)?.status || null,
        /* encontros avulsos já registrados nesse dia: a janelinha mostra para não duplicar e
           permitir desmarcar quem foi anunciado e acabou não vindo */
        avulsos: data ? A("SELECT id, hora, motivo, observacao FROM encontro_avulso WHERE id_matricula=? AND livro=? AND data=? ORDER BY hora",
          idMatricula, m.livro, data) : [] };
    });
    /* Horas oferecidas no seletor do encontro avulso: a matriz de horários UNIDA às horas que de fato
       têm aula nesse dia. Só a matriz não bastava — existem aulas em horas que foram desativadas na
       matriz depois (o app preserva esses slots de propósito), e o resultado era não conseguir
       marcar o avulso justamente na hora que está aberta na tela. */
    const horasDoDia = diaData ? [...new Set([
      ...A("SELECT hora FROM horario_ativo WHERE dia=? AND ativo=1", diaData).map(r => r.hora),
      ...A("SELECT DISTINCT hora FROM aulas WHERE dia=?", diaData).map(r => r.hora),
    ])].sort() : [];
    return { id: alu.id_matricula, nome: alu.nome, situacao: alu.situacao, status: alu.status, matriculas, data: data || null, horasDoDia };
  },
  /* ===== encontro avulso: o aluno vem fora da agenda dele =====
     Dois usos, uma gravação só. comPresenca=true é o lançamento MOMENTÂNEO (ele está aqui na
     frente); false é o PRÉVIO, quando a recepção soube pelo WhatsApp que ele vem às 15h — aí não
     existe presença nenhuma ainda, só a linha aparecendo na grade para o professor já contar com ele. */
  lancarAvulso({ idMatricula, livro, data, hora, motivo, observacao, comPresenca }: any) {
    if (!idMatricula || !livro || !data || !hora) throw new Error("Informe aluno, livro, data e hora.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data))) throw new Error("Data inválida.");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(hora))) throw new Error("Hora inválida: use HH:MM.");
    const MOTIVOS = ["Reposição", "Anteposição", "Reforço", "Preparação", "Outro"];
    if (!MOTIVOS.includes(motivo)) throw new Error("Escolha o motivo do encontro.");
    if (!G("SELECT 1 FROM aluno_livro WHERE id_matricula=? AND livro=?", idMatricula, livro))
      throw new Error("O aluno não tem matrícula em " + livro + ".");
    const obs = (observacao || "").trim() || null;
    R(`INSERT INTO encontro_avulso (id_matricula, livro, data, hora, motivo, observacao, momento)
       VALUES (?,?,?,?,?,?,datetime('now','localtime'))
       ON CONFLICT(id_matricula, livro, data, hora) DO UPDATE SET
         motivo=excluded.motivo, observacao=excluded.observacao, momento=excluded.momento`,
      idMatricula, livro, data, hora, motivo, obs);
    anotar(idMatricula, livro, data, "avulso", hora, motivo + (obs ? " — " + obs : ""));
    const presenca = comPresenca ? gravarPresenca({ idMatricula, livro, data, status: "P" }) : null;
    return { ok: true, hora, motivo, observacao: obs, presenca };
  },
  removerAvulso({ id }: any) {
    const e = G("SELECT * FROM encontro_avulso WHERE id=?", id);
    if (!e) throw new Error("Encontro não encontrado.");
    R("DELETE FROM encontro_avulso WHERE id=?", id);
    anotar(e.id_matricula, e.livro, e.data, "limpeza", e.hora, "encontro avulso removido");
    return { ok: true };
  },
  /* histórico do aluno: os encontros fora da agenda, com o que já foi lançado em cada um.
     Inclui o previsto que nunca virou presença — é justamente o que interessa saber depois. */
  getAvulsosAluno({ idMatricula }: any) {
    const dInfo: Record<string, any> = {}; A("SELECT * FROM dias").forEach(r => dInfo[r.nome] = r);
    return A(`SELECT e.*, p.status, p.entrada, p.saida, p.minutos
      FROM encontro_avulso e
      LEFT JOIN presenca p ON p.id_matricula=e.id_matricula AND p.livro=e.livro AND p.data=e.data
      WHERE e.id_matricula=? ORDER BY e.data DESC, e.hora`, idMatricula).map(e => {
      const d = new Date(e.data + "T12:00:00");
      return { id: e.id, data: e.data, hora: e.hora, livro: e.livro, motivo: e.motivo,
        observacao: e.observacao || null, momento: e.momento,
        diaCurto: dInfo[NOMES_DIA[d.getDay()]]?.curto || "", numero: d.getDate(),
        status: e.status || null, entrada: e.entrada || null, saida: e.saida || null, minutos: e.minutos ?? null };
    });
  },

  /* ===== horário em lote =====
     Turma fechada (Conn) costuma ter o mesmo padrão de horas para todo mundo — ex.: italiano de
     sábado, 10h às 12h, que são DUAS aulas por aluno. Em vez de marcar 10 e 11 aluno por aluno,
     a recepção monta o horário de um e replica para os colegas do bloco. */
  getColegasDeHorario({ idMatricula, itens }: any) {
    if (!Array.isArray(itens) || !itens.length) throw new Error("Marque ao menos um dia/horário.");
    const chaves = new Set(itens.map((it: any) => it.dia + "|" + it.horario));
    /* colega = quem tem aula em ALGUM dos slots marcados (é o que caracteriza "mesmo bloco").
       O livro de cada um é preservado: numa sala Inter os livros diferem entre alunos. */
    const ids = new Set<string>();
    for (const it of itens)
      A("SELECT DISTINCT id_matricula FROM aulas WHERE dia=? AND hora=?", it.dia, it.horario)
        .forEach(r => ids.add(r.id_matricula));
    ids.add(idMatricula);
    return [...ids].map(id => {
      const aulas = A(`SELECT a.dia, a.hora, a.livro FROM aulas a WHERE a.id_matricula=? ORDER BY a.hora`, id);
      const livro = aulas.find(a => chaves.has(a.dia + "|" + a.hora))?.livro || aulas[0]?.livro || null;
      const doLivro = aulas.filter(a => a.livro === livro);
      const atuais = new Set(doLivro.map(a => a.dia + "|" + a.hora));
      const mat = livro ? getMatricula(id, livro) : null;
      return { id, nome: G("SELECT nome FROM alunos WHERE id_matricula=?", id)?.nome, livro,
        modalidade: mat?.modalidade || null, vip: mat?.vip === 1,
        horarioAtual: doLivro.map(a => ({ dia: a.dia, horario: a.hora })),
        aulasNoLivro: doLivro.length,
        // já bate exatamente com o horário proposto? então não há o que aplicar
        igual: atuais.size === chaves.size && [...chaves].every(k => atuais.has(k)),
        ehOAluno: id === idMatricula };
    }).sort((a, b) => String(a.nome).localeCompare(String(b.nome), "pt"));
  },
  /* aplica o mesmo conjunto de dia/hora aos alunos escolhidos, cada um no SEU livro e mantendo
     os professores que já tinha (o vínculo de professor é outro fluxo, não se mexe aqui). */
  aplicarHorarioEmLote({ itens, alunos }: any) {
    if (!Array.isArray(itens) || !itens.length) throw new Error("Marque ao menos um dia/horário.");
    if (!Array.isArray(alunos) || !alunos.length) throw new Error("Escolha ao menos um aluno.");
    for (const it of itens)
      if (!G("SELECT 1 FROM horario_ativo WHERE dia=? AND hora=? AND ativo=1", it.dia, it.horario))
        throw new Error("Horário " + it.horario + " não está ativado para " + it.dia + ".");
    let alterados = 0, aulasCriadas = 0;
    const avisos: string[] = [];
    for (const al of alunos) {
      const livro = al.livro;
      if (!livro || !getMatricula(al.id, livro)) { avisos.push(al.nome + ": sem matrícula no livro — ignorado."); continue; }
      // professores atuais desse aluno neste livro, para não se perderem ao recriar as aulas
      const profs = A(`SELECT DISTINCT f.nome FROM aula_professor ap JOIN aulas a ON a.id=ap.aula_id
        JOIN funcionarios f ON f.id=ap.funcionario_id WHERE a.id_matricula=? AND a.livro=?`, al.id, livro).map((x: any) => x.nome);
      const fids = idsDosProfs(profs);
      R("DELETE FROM aulas WHERE id_matricula=? AND livro=?", al.id, livro);
      for (const it of itens) {
        R("DELETE FROM aulas WHERE id_matricula=? AND dia=? AND hora=?", al.id, it.dia, it.horario); // um aluno não fica em 2 lugares
        const r = R("INSERT INTO aulas (id_matricula,dia,hora,livro) VALUES (?,?,?,?)", al.id, it.dia, it.horario, livro);
        fids.forEach(f => R("INSERT INTO aula_professor VALUES (?,?)", r.lastInsertRowid, f));
        aulasCriadas++;
      }
      alterados++;
    }
    return { ok: true, alunos: alterados, aulas: aulasCriadas, avisos };
  },

  /* ===== funcionários / professores (CRUD da aba Professores) ===== */
  getFuncionarios: () => A("SELECT * FROM funcionarios ORDER BY nome").map(f => ({
    id: f.id, nome: f.nome, nomeCompleto: f.nome_completo,
    // quantos vínculos existem — a exclusão precisa avisar antes de desfazer trabalho
    aulas: G("SELECT COUNT(*) n FROM aula_professor WHERE funcionario_id=?", f.id).n,
    turmas: G("SELECT COUNT(*) n FROM turma_professor WHERE funcionario_id=?", f.id).n,
    alunos: G(`SELECT COUNT(DISTINCT a.id_matricula) n FROM aula_professor ap
               JOIN aulas a ON a.id=ap.aula_id WHERE ap.funcionario_id=?`, f.id).n,
  })),
  salvarFuncionario({ id, nome, nomeCompleto }: any) {
    const curto = String(nome || "").trim(), completo = String(nomeCompleto || "").trim();
    if (!curto || !completo) throw new Error("Informe o nome curto e o nome completo.");
    const dono = G("SELECT id FROM funcionarios WHERE nome=?", curto);
    if (dono && dono.id !== id) throw new Error("Já existe um funcionário com o nome curto \"" + curto + "\".");
    if (id) {
      if (!G("SELECT 1 FROM funcionarios WHERE id=?", id)) throw new Error("Funcionário não encontrado.");
      R("UPDATE funcionarios SET nome=?, nome_completo=? WHERE id=?", curto, completo, id);
      return { ok: true, id, criado: false };
    }
    // id sequencial FP001, FP002... continuando de onde parou
    const ult = G("SELECT id FROM funcionarios WHERE id GLOB 'FP[0-9][0-9][0-9]' ORDER BY id DESC LIMIT 1")?.id;
    const novo = "FP" + ("00" + ((ult ? parseInt(ult.slice(2), 10) : 0) + 1)).slice(-3);
    R("INSERT INTO funcionarios VALUES (?,?,?)", novo, completo, curto);
    return { ok: true, id: novo, criado: true };
  },
  excluirFuncionario({ id, forcar }: any) {
    const f = G("SELECT * FROM funcionarios WHERE id=?", id);
    if (!f) throw new Error("Funcionário não encontrado.");
    const aulas = G("SELECT COUNT(*) n FROM aula_professor WHERE funcionario_id=?", id).n;
    const turmas = G("SELECT COUNT(*) n FROM turma_professor WHERE funcionario_id=?", id).n;
    if ((aulas || turmas) && !forcar) return { ok: false, precisaConfirmar: true, aulas, turmas, nome: f.nome };
    R("DELETE FROM aula_professor WHERE funcionario_id=?", id);   // FK sem cascade: desvincula antes
    R("DELETE FROM turma_professor WHERE funcionario_id=?", id);
    R("DELETE FROM funcionarios WHERE id=?", id);
    return { ok: true, aulas, turmas };
  },

  /* ===== vínculo de professores em lote =====
     Quem está no mesmo dia+hora (o "bloco") normalmente tem os mesmos professores. Em vez de
     vincular aluno por aluno, o app oferece aplicar ao slot inteiro — mas sempre por escolha
     explícita, porque atendimento individual existe (ex.: mãe e filho só com um professor). */
  getColegasDoSlot({ dia, hora, idMatricula }: any) {
    if (!dia || !hora) throw new Error("Informe dia e hora.");
    return A(`SELECT a.id, a.id_matricula, a.livro, al.nome FROM aulas a
              JOIN alunos al ON al.id_matricula=a.id_matricula
              WHERE a.dia=? AND a.hora=? ORDER BY al.nome`, dia, hora)
      .map(r => ({ idAula: r.id, id: r.id_matricula, nome: r.nome, livro: r.livro,
        professores: A(`SELECT f.nome FROM aula_professor ap JOIN funcionarios f ON f.id=ap.funcionario_id
                        WHERE ap.aula_id=?`, r.id).map((x: any) => x.nome),
        ehOAluno: r.id_matricula === idMatricula }));
  },
  /* aplica os professores às aulas escolhidas. `alunos` = lista de id_matricula; sem ela, aplica
     a todos do slot. Substitui o vínculo daquele slot (não acumula). */
  aplicarProfessoresNoSlot({ dia, hora, professores, alunos }: any) {
    if (!dia || !hora) throw new Error("Informe dia e hora.");
    const fids = idsDosProfs(professores || []);
    if (!fids.length) throw new Error("Escolha ao menos um professor.");
    const alvo = new Set((alunos || []).map(String));
    const aulas = A("SELECT id, id_matricula FROM aulas WHERE dia=? AND hora=?", dia, hora)
      .filter(r => !alvo.size || alvo.has(String(r.id_matricula)));
    for (const a of aulas) {
      R("DELETE FROM aula_professor WHERE aula_id=?", a.id);
      fids.forEach(f => R("INSERT INTO aula_professor VALUES (?,?)", a.id, f));
    }
    return { ok: true, aulasAtualizadas: aulas.length, alunos: new Set(aulas.map(a => a.id_matricula)).size };
  },

  /* ===== backup (aba Backup) ===== */
  getBackupInfo() {
    const listar = (dir: string | null) => {
      if (!dir) return [];
      try {
        return [...Deno.readDirSync(dir)].filter(f => f.isFile && f.name.endsWith(".db"))
          .map(f => { const st = Deno.statSync(dir + "\\" + f.name);
            return { nome: f.name, bytes: st.size, modificado: st.mtime ? st.mtime.toISOString() : "" }; })
          .sort((a, b) => b.modificado.localeCompare(a.modificado)).slice(0, 12);
      } catch { return []; }
    };
    return { oneDriveRaiz: Deno.env.get("OneDrive") || null,
      personalizada: !!G("SELECT 1 FROM config WHERE chave='backup_onedrive'"),
      pastaOneDrive: dirBackupOneDrive(), pastaLocal: dirBackupLocal(),
      backupsOneDrive: listar(dirBackupOneDrive()), backupsLocal: listar(dirBackupLocal()) };
  },
  salvarPastaBackup({ pasta }: any) {
    const p = String(pasta || "").trim();
    if (!p) { R("DELETE FROM config WHERE chave='backup_onedrive'"); return { ok: true, pasta: dirBackupOneDrive(), padrao: true }; }
    Deno.mkdirSync(p, { recursive: true }); // valida a escolha: cria a pasta e testa escrita antes de gravar
    const teste = p + "\\.wizard-teste-escrita"; Deno.writeTextFileSync(teste, "ok"); Deno.removeSync(teste);
    R("INSERT INTO config VALUES ('backup_onedrive',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor", gravarPastaOneDrive(p));
    return { ok: true, pasta: p, padrao: false };
  },
  fazerBackupAgora: () => executarBackup("wizard-" + new Date().toISOString().replace(/[T:]/g, "-").slice(0, 19) + ".db", false),

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
/* ===== estações da escola =====
   O banco vive num lugar só: o Dell da recepção. Os notebooks NÃO rodam servidor nem têm cópia do
   banco — eles abrem o navegador apontando para o Dell, e por isso o servidor escuta em 0.0.0.0
   (só localhost deixaria a rede de fora). Como todos falam com o MESMO servidor, o papel de cada
   estação não pode vir do hostname da máquina que serve: vem do IP de QUEM PEDE.
   IPs conforme o inventário das três máquinas (rede 192.168.3.x). */
const ESTACOES: Record<string, { nome: string; papel: "recepcao" | "sala" }> = {
  "192.168.3.121": { nome: "Recepção — Dell (cabo)", papel: "recepcao" },
  "192.168.3.122": { nome: "Recepção — Dell (Wi-Fi)", papel: "recepcao" },
  "192.168.3.6": { nome: "Notebook Asus", papel: "sala" },
  "192.168.3.65": { nome: "Notebook Samsung", papel: "sala" },
};
/* quem abre no próprio servidor é a recepção (o Dell olhando para si mesmo). Uma máquina
   desconhecida — celular, notebook novo, IP trocado pelo DHCP — entra como sala, que é o perfil
   mais restrito: lança entrada/saída e não mexe no status. */
function estacaoDoIP(ip: string) {
  if (ESTACOES[ip]) return { ip, ...ESTACOES[ip], conhecida: true };
  const local = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  return { ip, nome: local ? "Esta máquina (servidor)" : "Estação não cadastrada", papel: local ? "recepcao" : "sala", conhecida: local };
}

/* ===== avisos em tempo real (WebSocket) =====
   Substitui a espera do polling: quando a recepção lança, a sala vê na hora, e vice-versa. O
   polling de 15s continua no cliente como rede de segurança, para o caso de a conexão cair. */
const clientesWS = new Set<WebSocket>();
function avisarTodos(evento: string) {
  const msg = JSON.stringify({ evento, momento: Date.now() });
  for (const ws of [...clientesWS]) {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(msg); else clientesWS.delete(ws); }
    catch { clientesWS.delete(ws); }
  }
}

Deno.serve({ port: 8420, hostname: "0.0.0.0" }, async (req, info) => {
  const url = new URL(req.url);
  const ip = (info?.remoteAddr as Deno.NetAddr | undefined)?.hostname ?? "127.0.0.1";
  if (url.pathname === "/ws") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => clientesWS.add(socket);
    socket.onclose = () => clientesWS.delete(socket);
    socket.onerror = () => clientesWS.delete(socket);
    return response;
  }
  if (url.pathname === "/api/getEstacao") return Response.json(estacaoDoIP(ip));
  if (url.pathname.startsWith("/api/")) {
    try {
      const fn = url.pathname.slice(5);
      if (!api[fn]) throw new Error("Função desconhecida: " + fn);
      const args = req.method === "POST" ? await req.json() : Object.fromEntries(url.searchParams);
      if (fn === "fichas" && typeof (args as any).dias === "string") (args as any).dias = (args as any).dias.split(",");
      const resposta = api[fn](args);
      /* qualquer função que NÃO seja consulta mudou algo: avisa as outras estações na hora */
      if (!/^(get|preview|info)/.test(fn)) avisarTodos(fn);
      return Response.json(resposta);
    } catch (e) { return Response.json({ erro: (e as Error).message }, { status: 400 }); }
  }
  const arquivo = url.pathname === "/" ? "app.html" : decodeURIComponent(url.pathname.slice(1));
  if (arquivo.includes("..") || arquivo.includes("\\")) return new Response("não encontrado", { status: 404 });
  const tipo = arquivo.endsWith(".html") ? "text/html; charset=utf-8"
    : arquivo.endsWith(".js") ? "application/javascript; charset=utf-8"
    : arquivo.endsWith(".css") ? "text/css; charset=utf-8"
    : arquivo.endsWith(".webmanifest") ? "application/manifest+json; charset=utf-8"
    : arquivo.endsWith(".png") ? "image/png"
    : arquivo.endsWith(".ico") ? "image/x-icon"
    : arquivo.endsWith(".svg") ? "image/svg+xml"
    : "text/plain; charset=utf-8";
  /* readFile (binário) sempre — readTextFile decodificaria PNG/ICO como UTF-8 e corromperia os bytes.
     no-store no HTML/JS/CSS: depois de um `git pull` na recepção o navegador precisa pegar a versão
     nova, e não a do cache (já aconteceu de a tela rodar código antigo depois de atualizar). */
  const volatil = /\.(html|js|css|webmanifest)$/.test(arquivo) && !arquivo.startsWith("resources/vendor/");
  const cabecalhos: Record<string, string> = { "content-type": tipo };
  if (volatil) cabecalhos["cache-control"] = "no-store, must-revalidate";
  try { return new Response(await Deno.readFile(PASTA + arquivo), { headers: cabecalhos }); }
  catch { return new Response("não encontrado", { status: 404 }); }
});
console.log("Wizard local em http://localhost:8420  (painel único: Alunos, Turmas, Horários e Impressão)");
/* endereços por onde os notebooks alcançam esta máquina — a recepção precisa saber qual digitar
   nos outros computadores, e o IP do Wi-Fi muda de vez em quando */
try {
  for (const [nome, faixas] of Object.entries(Deno.networkInterfaces().reduce((m: Record<string, string[]>, i) => {
    if (i.family === "IPv4" && i.address !== "127.0.0.1") (m[i.name] ||= []).push(i.address);
    return m;
  }, {}))) console.log(`   na rede (${nome}): http://${faixas.join(" / ")}:8420`);
} catch { /* sem permissão de rede: não é essencial */ }

