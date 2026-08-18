/* main.ts — Wizard local: Deno 2.2+ + SQLite (node:sqlite, zero dependências)
   Iniciar banco:  deno run -A main.ts --init
   Rodar:          deno run -A main.ts   →  http://localhost:8420  */
import { DatabaseSync } from "node:sqlite";

const PASTA = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
/* WIZ_DB / WIZ_PORT: só para ENSAIO. Sem as variáveis nada muda — é wizard.db na 8420, como sempre,
   e os atalhos da recepção não sabem que elas existem. Servem para subir uma segunda instância sobre
   uma CÓPIA do banco enquanto o painel dele continua aberto: antes disso, ensaiar exigia editar a
   porta e o nome do arquivo aqui dentro e lembrar de desfazer os dois — e esquecer de desfazer um
   deles é justamente o acidente que a variável evita. */
const ENSAIO = !!Deno.env.get("WIZ_DB");
const db = new DatabaseSync(PASTA + (Deno.env.get("WIZ_DB") || "wizard.db"));
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
  hora TEXT CHECK (hora IS NULL OR (data IS NOT NULL AND hora GLOB '[0-2][0-9]:[0-5][0-9]')),
  deduzida INTEGER NOT NULL DEFAULT 0 CHECK (deduzida IN (0,1)), -- 1 = veio do vínculo automático
  momento TEXT NOT NULL,
  UNIQUE (id_matricula, livro)
)`);
/* ===== A HORA DA ENTREGA (2026-08-16) =====
   `momento` já existia, e não serve: ele é quando a LINHA foi escrita. Nas 122 entregas deduzidas
   `momento` é 09/08 00:29 — o instante da semeadura, não o de nenhuma entrega. E como `data` é
   editável, preencher "saiu em 12/07" deixa `momento` falando de outro dia. São dois fatos, e um
   não substitui o outro: `data`+`hora` são O QUE ACONTECEU, `momento` é QUANDO FOI DIGITADO. Mesma
   separação de `encontro_avulso`, e a mesma palavra para a mesma coisa.
   Nula = sabe-se o dia e não a hora. É o caso de toda entrega anterior a esta coluna e de toda data
   preenchida à mão depois: quem digita "saiu em 12/07" quase nunca sabe a hora, e o campo em branco
   diz isso melhor que um 00:00 inventado.
   O CHECK recusa hora sem dia — 14:32 de nenhum dia não é informação. */
addColuna("entrega_material", "hora",
  "TEXT CHECK (hora IS NULL OR (data IS NOT NULL AND hora GLOB '[0-2][0-9]:[0-5][0-9]'))");
/* ===== A DEVOLUÇÃO (2026-08-17) =====
   Pedido dele: *"devolução de material ao estoque"* — o aluno cancela e devolve o livro.
   Isso NÃO é o "desfazer entrega" que já existia. Desfazer é dizer *a entrega nunca aconteceu*:
   apaga a linha e o assunto morre. Devolver é o contrário — a entrega aconteceu, o aluno teve o
   livro na mão por três meses, e agora ele voltou. Apagar a entrega para representar a devolução
   perderia justamente o que a escola quer saber depois ("este exemplar já rodou").

   Por isso são duas coisas separadas:
   - `entrega_material.devolvida` — a data da ÚLTIMA devolução. Nula = o aluno ainda está com o
     livro. É a coluna que a tela lê para saber o estado de agora.
   - `devolucao_material` — o registro histórico, uma linha por devolução. Precisa ser tabela
     própria porque `entrega_material` tem UNIQUE(id_matricula,livro): o mesmo aluno pode receber,
     devolver e receber de novo, e nesse ciclo a linha da entrega é reescrita enquanto o histórico
     não pode ser.
   `unidade_id` fica gravado aqui mesmo depois de o exemplar voltar para a prateleira — é o elo que
   responde "por quantas mãos este número de etiqueta já passou". A unidade em si volta livre,
   com o `entrada` INTOCADO: ela retoma o lugar dela na fila, exatamente como em `removerEntrega`. */
addColuna("entrega_material", "devolvida",
  "TEXT CHECK (devolvida IS NULL OR devolvida GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')");
db.exec(`CREATE TABLE IF NOT EXISTS devolucao_material (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  id_matricula TEXT NOT NULL REFERENCES alunos(id_matricula) ON DELETE CASCADE,
  livro TEXT NOT NULL,                 -- texto solto, como em entrega_material e presenca
  item_id INTEGER REFERENCES estoque_item(id) ON DELETE SET NULL,
  unidade_id INTEGER REFERENCES estoque_unidade(id) ON DELETE SET NULL,
  data TEXT NOT NULL CHECK (data GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  hora TEXT CHECK (hora IS NULL OR hora GLOB '[0-2][0-9]:[0-5][0-9]'),
  motivo TEXT,
  momento TEXT NOT NULL                -- quando a LINHA foi escrita, como em entrega_material
)`);
db.exec("CREATE INDEX IF NOT EXISTS ix_devolucao_mat ON devolucao_material(id_matricula, livro)");
/* ===== A UNIDADE FÍSICA (2026-08-10) =====
   Decisão dele, depois de ver que a contagem era herança do caderno: *"a contagem não faz sentido,
   era uma coisa que a gente fazia na mão porque quando entregava material tinha que recontar. Como
   estamos usando um software agora, não precisa."*
   Então o saldo deixa de ser "última contagem ± movimento" e passa a ser **quantas unidades não
   entregues existem**. Cada exemplar que chega é uma linha, com o instante da entrada.

   `entrada` guarda até os MILISSEGUNDOS porque é ela que ordena a fila: *"quem chegou primeiro sai
   primeiro"*. Sem os milissegundos, dez exemplares do mesmo kit chegando na mesma remessa teriam o
   mesmo carimbo e a ordem viraria sorteio do banco.
   `origem` distingue o que veio de remessa do que veio da conversão da contagem de 06/08 — sem
   isso, o trabalho que ele já fez no caderno sumiria do saldo no dia da virada. */
db.exec(`CREATE TABLE IF NOT EXISTS estoque_unidade (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES estoque_item(id) ON DELETE CASCADE,
  remessa_id INTEGER REFERENCES estoque_evento(id) ON DELETE SET NULL,
  entrada TEXT NOT NULL,                 -- 'YYYY-MM-DD HH:MM:SS.mmm' — ordena a fila
  origem TEXT NOT NULL DEFAULT 'remessa' CHECK (origem IN ('remessa','contagem','manual')),
  codigo TEXT,                           -- código de barras da etiqueta, quando houver
  entrega_id INTEGER REFERENCES entrega_material(id) ON DELETE SET NULL,
  saida TEXT,                            -- quando saiu para a mão do aluno
  momento TEXT NOT NULL
)`);
/* ===== O NÚMERO ESCRITO NA ETIQUETA (2026-08-16) =====
   Decisão dele: *"todo livro que chegar eu vou numerar ele de 1, 2, 3, eu vou escrever o número com
   a caneta na etiqueta dele"*. É o identificador que a MÃO alcança — o código de barras vem impresso
   e não distingue dois exemplares do mesmo kit, e o instante com milissegundos ninguém lê na
   prateleira. Numerando, "leva o W2 número 4" vira uma frase possível no balcão.

   **Contínuo POR MATERIAL**, começando em 1, exatamente como ele descreveu: *"temos três W2, aí
   chegaram mais dois; esses dois que chegaram vamos numerar de 4 e 5, e assim por diante para todos
   os materiais."* Não é global (não existe "exemplar 137 da escola") nem reinicia a cada remessa
   (dois exemplares com o mesmo número na prateleira seria justamente o que a etiqueta evita).

   O próximo é `MAX(numero)+1` daquele material, contando também os JÁ ENTREGUES — a linha continua
   no banco depois da entrega, então o número sai de circulação junto com o livro. A única forma de
   reaproveitar um número é APAGAR o exemplar, que é gesto deliberado e raro (e aí a etiqueta velha
   normalmente sumiu junto).
   Nulo = exemplar anterior a esta coluna, e `numerarUnidades()` os alcança na primeira subida. */
addColuna("estoque_unidade", "numero", "INTEGER");
/* ===== CONFERIDO ≠ CHEGADA (2026-08-16) =====
   O botão "confirmar" da aba Entradas reescrevia `entrada` para o instante do clique. Mas `entrada`
   é a POSIÇÃO NA FILA: conferir um exemplar o mandava para o fim dela, e era isso que quebrava a
   regra que ele mesmo pediu — número menor tem de ser o mais antigo. Conferir o exemplar nº 1
   primeiro fazia dele o mais recente.
   São dois fatos diferentes: `entrada` é QUANDO O EXEMPLAR CHEGOU (vem da data da remessa e manda na
   fila), `conferido` é QUANDO ALGUÉM O CONFERIU contra a caixa. Conferir não reescreve história.
   Guarda o instante em vez de um 0/1: responde "quando isto foi conferido" pelo mesmo preço, e
   nulo já é o "ainda não". */
addColuna("estoque_unidade", "conferido", "TEXT");
/* ===== A EDIÇÃO É DO EXEMPLAR (2026-08-17) =====
   Problema real dele: *"a gente pede cinco unidades do Kids 4: duas Old Edition e três Third
   Edition. Ambos são K4, mesmo nível de inglês, só que edições diferentes."* Isso não cabia:
   `ux_estoque_item_livro` admite UM material por livro e a edição morava no MATERIAL, então um
   material tinha uma edição só. Tanto que o estágio "Kids 4 · Old" estava sem material nenhum.
   Escolha dele entre três desenhos: a edição passou a ser do EXEMPLAR. Materiais continua com uma
   linha "KIDS 4" — o índice único, a lista de entregas e o vínculo do estágio ficam de pé — e cada
   unidade diz de qual edição ela é.
   Tabela própria (e não texto solto na unidade) para ele poder RENOMEAR uma edição e todos os
   exemplares acompanharem, que é o "alterar edição" que ele pediu. */
db.exec(`CREATE TABLE IF NOT EXISTS estoque_edicao (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES estoque_item(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  ano INTEGER,
  momento TEXT NOT NULL
)`);
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_edicao_item_nome ON estoque_edicao(item_id, nome)");
/* ARQUIVAR no lugar de APAGAR (regra dele, 2026-08-17): a edição fica vinculada a exemplares que já
   saíram, então apagá-la deixaria o rastro sem nome. Arquivada vai para o fim da lista, esmaecida.
   `padrao` é a edição que os exemplares novos herdam. Sem ninguém marcado, vence a ATIVA de ano mais
   recente — "geralmente é a do ano mais atual", nas palavras dele, e `geralmente` é o que faz a
   marca explícita existir: dá para contrariar o padrão quando a compra é de uma tiragem antiga. */
addColuna("estoque_edicao", "arquivada", "TEXT");
addColuna("estoque_edicao", "padrao", "INTEGER NOT NULL DEFAULT 0");
/* A edição PADRÃO é o que o material mostra como "a edição dele" — é ela que o estágio espelha em
   "EDIÇÃO (vem do material)". Mantém `estoque_item.edicao_nome/ano` em dia para nada rio abaixo
   precisar saber que a edição virou uma tabela. */
function edicaoPadrao(itemId: number) {
  return G(`SELECT * FROM estoque_edicao WHERE item_id=? AND arquivada IS NULL
            ORDER BY padrao DESC, COALESCE(ano,0) DESC, id DESC LIMIT 1`, itemId);
}
function sincronizarEdicaoDoItem(itemId: number) {
  const ed = edicaoPadrao(itemId);
  R("UPDATE estoque_item SET edicao_nome=?, edicao_ano=? WHERE id=?",
    ed?.nome ?? null, ed?.ano ?? null, itemId);
  return ed;
}
addColuna("estoque_unidade", "edicao_id", "INTEGER REFERENCES estoque_edicao(id) ON DELETE SET NULL");
/* A edição que hoje está no MATERIAL vira a primeira edição dele, e os exemplares existentes
   passam a apontar para ela — ninguém fica sem edição por causa da mudança de desenho.
   Self-limiting: só cria o que ainda não existe e só liga unidade que está sem edição. */
function migrarEdicoesParaUnidade() {
  let criadas = 0, ligadas = 0;
  for (const it of A("SELECT id, edicao_nome, edicao_ano FROM estoque_item WHERE edicao_nome IS NOT NULL AND TRIM(edicao_nome)<>''")) {
    let ed = G("SELECT id FROM estoque_edicao WHERE item_id=? AND nome=?", it.id, it.edicao_nome);
    if (!ed) {
      ed = { id: Number(R("INSERT INTO estoque_edicao (item_id,nome,ano,momento) VALUES (?,?,?,?)",
        it.id, it.edicao_nome, it.edicao_ano ?? null, agora()).lastInsertRowid) };
      criadas++;
    }
    ligadas += R("UPDATE estoque_unidade SET edicao_id=? WHERE item_id=? AND edicao_id IS NULL", ed.id, it.id).changes as number;
  }
  if (criadas || ligadas) console.log("estoque: " + criadas + " edição(ões) criadas, " + ligadas + " exemplar(es) ligados");
  return { criadas, ligadas };
}
/* o índice que serve à fila: por item, do mais antigo para o mais novo, só o que não saiu */
db.exec(`CREATE INDEX IF NOT EXISTS ix_unidade_fila ON estoque_unidade(item_id, entrada)
  WHERE entrega_id IS NULL`);
db.exec("CREATE INDEX IF NOT EXISTS ix_unidade_entrega ON estoque_unidade(entrega_id)");
db.exec("CREATE INDEX IF NOT EXISTS ix_entrega_item ON entrega_material(item_id, data)");
db.exec("CREATE INDEX IF NOT EXISTS ix_ev_item ON estoque_evento_item(item_id)");
/* COMPONENTE: peça que só existe DENTRO de um kit e não se conta sozinha na prateleira.
   O Student's Book e o Workbook do W2 não são duas linhas de estoque — a escola conta a mochila
   fechada, com os dois dentro. Sem esta marca, documentar a composição encheria a grade de linhas
   que ninguém conta. */
addColuna("estoque_item", "componente", "INTEGER NOT NULL DEFAULT 0");
/* natureza do item: kit (conjunto montado, é o que se conta e etiqueta) · peca (parte de um kit) ·
   unidade (existe por si, como a Wiz.pen). Substitui o par `unidade`+`componente`, que dizia a
   mesma coisa em dois lugares e com a palavra errada. */
addColuna("estoque_item", "tipo", "TEXT NOT NULL DEFAULT 'unidade'");
/* A EDIÇÃO é do MATERIAL, não da estrutura (2026-08-10, dele): *"faz mais sentido vincular o ano e
   o nome da edição no item do estoque, não no estágio. Quando eu vinculo um estágio a um item, ele
   já traz consigo a edição."* É o que a realidade diz: o que ganha edição nova é a caixa — o
   Student's Book e o Workbook mudam, a estrutura pedagógica nem sempre.
   Vale para kit e material tipo livro; para a Wiz.pen não faz sentido, e o campo simplesmente fica
   vazio nela ("ela é autocontida", nas palavras dele). */
addColuna("estoque_item", "edicao_nome", "TEXT");
/* ===== MATERIAL FINAL (2026-08-17) =====
   Ordem dele: *"tem um estágio que é final, o W12; ele não tem nada depois dele porque é o último
   livro da Wizard. Então coloca um atributo lá nos materiais"*.
   Mora no MATERIAL e não no estágio, também por decisão dele — é o material que é o último da
   coleção, e o estágio apenas herda. Na tela do estágio o campo aparece TRAVADO, apontando para
   onde se decide; duas telas editando o mesmo fato é como elas divergem.
   Consequência imediata: a checagem "estágio sem próximo na trilha" para de acusar o último — ele
   não tem próximo por definição, e um alerta permanente que não se resolve é ruído. */
addColuna("estoque_item", "final", "INTEGER NOT NULL DEFAULT 0");
addColuna("estoque_item", "edicao_ano", "INTEGER");
/* "unidade" SAIU do vocabulário (2026-08-10, dele): *"unidade é a mesma coisa que item — quantos
   itens de W2 temos, quantas unidades de W2 temos, é o mesmo termo"*. Sobram duas naturezas:
   **kit** (conglomerado de peças) e **peça** (o que vai dentro). A Wiz.pen é peça e mesmo assim se
   conta sozinha — é `componente=0` que diz isso, não o tipo. */
/* PREENCHIMENTO ÚNICO, e não regra permanente: o `WHERE tipo NOT IN ('kit','peca')` é o que faz
   esta linha tocar só quem ainda está com o valor padrão da coluna.
   A versão anterior rodava SEM o WHERE e reclassificava tudo a cada boot pelo par antigo
   (`unidade` + `componente`) — o que desfazia, toda subida, a Wiz.pen recém-marcada como peça.
   Ela voltava a "unidade" e sumia das colunas da matriz; levou uma rodada para eu ver. */
R(`UPDATE estoque_item SET tipo = CASE WHEN componente=1 THEN 'peca' ELSE 'kit' END
   WHERE tipo NOT IN ('kit','peca')`);
/* a Wiz.pen é peça E se conta sozinha — as duas coisas, e é o único material assim */
R("UPDATE estoque_item SET tipo='peca', componente=0 WHERE descricao='Wiz.pen'");
/* A remessa é o RECEBIMENTO de um pedido, não um evento solto: aponta para o pedido que ela veio
   atender. `ON DELETE SET NULL` porque apagar o pedido não pode apagar a caixa que já chegou —
   o material entrou no estoque de qualquer jeito. */
addColuna("estoque_evento", "pedido_id", "INTEGER REFERENCES estoque_evento(id) ON DELETE SET NULL");
/* RASCUNHO × CONFIRMADO (2026-08-10): o pedido nasce aberto, com a lista inteira de materiais para
   se escolher o que pedir. Confirmado, ele se enxuga — some tudo o que ficou em zero e fica só o
   que foi pedido de fato. Era poluição visual carregar 28 linhas para ver 5.
   Pedido antigo (anterior a esta coluna) nasce confirmado: a lista dele já está enxuta. */
addColuna("estoque_evento", "confirmado", "INTEGER NOT NULL DEFAULT 1");

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
/* ===== ESTRUTURA DIGITADA, lição por lição =====
   A geração por fórmula cobre o caso comum e continua valendo. Mas ela não alcança o que ele
   descreveu em 2026-08-10: *"o TOTS 2 pode usar sim o modelo de capítulo de 11, mas eu vou lá no
   TOTS 2 e reestruturo ele, porque ele tem duas lições especiais no começo... e as Recall são
   feitas de forma estratégica, não têm cronograma pré-definido. Todos os livros da Wizard devem
   ter permissão de fazer isso."*
   Daí duas listas com a MESMA forma e papéis diferentes:
   - `estagio_modelo_licao`: o modelo deixa de ser só fórmula e pode ser uma lista pronta;
   - `estagio_licao`: a estrutura DAQUELE livro, que vence tudo.
   Ordem de resolução na tela: lista do estágio → lista do modelo → fórmula. Quem não digita nada
   continua com as lições geradas, como sempre foi.
   `numero` é o rótulo pedagógico e é NULO em lição que não tem número (Useful Language, Review):
   o índice — a posição na fila, que conta hora-aula — é `ordem`, e são coisas diferentes. */
const CORPO_LICAO = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dono_id INTEGER NOT NULL,
  ordem INTEGER NOT NULL,
  numero INTEGER,
  descricao TEXT NOT NULL,
  bloco INTEGER,
  tipo TEXT NOT NULL DEFAULT 'input' CHECK (tipo IN ('especial','input','output','review','remind'))`;
db.exec(`CREATE TABLE IF NOT EXISTS estagio_modelo_licao (${CORPO_LICAO},
  FOREIGN KEY (dono_id) REFERENCES estagio_modelo(id) ON DELETE CASCADE)`);
db.exec(`CREATE TABLE IF NOT EXISTS estagio_licao (${CORPO_LICAO},
  FOREIGN KEY (dono_id) REFERENCES estagio(id) ON DELETE CASCADE)`);
db.exec("CREATE INDEX IF NOT EXISTS ix_modelo_licao ON estagio_modelo_licao(dono_id, ordem)");
db.exec("CREATE INDEX IF NOT EXISTS ix_estagio_licao ON estagio_licao(dono_id, ordem)");
/* ===== SIGLA DA LIÇÃO (2026-08-16) =====
   Pedido dele: cada lição ganha um nome curto — *"a lição 1 vai ser L maiúsculo e o número 1 junto"*
   — customizável, vindo do modelo e viajando para o estágio junto com o resto.
   Ela também é o que RESOLVE a fusão das duas colunas de número que ele pediu. `ordem` (a posição)
   e `numero` (o rótulo pedagógico) parecem iguais nas dez primeiras linhas e é por isso que ele as
   viu como redundantes — mas divergem na primeira Review, que ocupa posição e NÃO tem número:
     ordem 10 → numero 10 · ordem 11 → Review, sem número · ordem 12 → numero 11
   Some com a coluna Número e essa distinção se perde. Ela passa a viver na SIGLA: "L10", "R1",
   "L11". A tela mostra uma coluna de número só (a posição), e a identidade pedagógica fica legível
   ao lado, em texto — que é mais honesto que um campo numérico vazio. */
addColuna("estagio_modelo_licao", "sigla", "TEXT");
addColuna("estagio_licao", "sigla", "TEXT");
/* Preenche a sigla de quem ainda não tem, a partir do que já existe. Sem marca em `config`: o
   `WHERE sigla IS NULL` já a torna inerte, e assim ela alcança linha nova que apareça sem sigla. */
function siglarLicoes() {
  let n = 0;
  for (const t of ["estagio_modelo_licao", "estagio_licao"]) {
    const donos = A(`SELECT DISTINCT dono_id FROM ${t} WHERE sigla IS NULL`).map(r => r.dono_id);
    for (const dono of donos) {
      /* contadores por TIPO, para as sem número: Review 1, 2, 3... na ordem em que aparecem */
      const seq: Record<string, number> = {};
      for (const l of A(`SELECT id, numero, tipo, descricao, sigla FROM ${t} WHERE dono_id=? ORDER BY ordem, id`, dono)) {
        if (l.sigla) continue;
        let s: string;
        if (l.numero != null) s = "L" + l.numero;
        else {
          const pref = l.tipo === "review" ? "R" : l.tipo === "remind" ? "RM"
            : l.tipo === "especial" ? "E" : "L";
          seq[pref] = (seq[pref] || 0) + 1;
          s = pref + seq[pref];
        }
        R(`UPDATE ${t} SET sigla=? WHERE id=?`, s, l.id);
        n++;
      }
    }
  }
  if (n) console.log("estágios: " + n + " lição(ões) ganharam sigla");
  return { siglas: n };
}
/* NOME LONGO × NOME CURTO (dele, 2026-08-10): *"Little Kids 4 é o nome por extenso. Só que eu quero
   L. Kids 4, que vai ser representado em outros lugares, porque é um nome curto. O nome longo é o
   completo; o curto é mais representativo, na frequência do aluno."*
   O curto já existia de fato — é `livros.nome`, que é o que a ficha impressa usa — só não tinha
   nome próprio no estágio. Aqui ele passa a ser campo, e nasce igual ao livro vinculado. */
addColuna("estagio", "nome_curto", "TEXT");
R("UPDATE estagio SET nome_curto=livro WHERE nome_curto IS NULL AND livro IS NOT NULL");
/* 'W' → 'Ws' (pedido dele, 2026-08-16). O Estoque (`ES_FAIXAS`) e o dashboard (`CORES_CAT`) já
   escreviam 'Ws'; só o catálogo de estágios dizia 'W', e o mesmo grupo aparecia com dois nomes.
   Sem marca em `config`: o próprio WHERE a torna inerte depois da primeira passada, e o select da
   tela não oferece mais 'W' para alguém recriar. */
{
  const n = R("UPDATE estagio SET categoria='Ws' WHERE categoria='W'").changes as number;
  if (n) console.log("estágios: " + n + " passaram da categoria 'W' para 'Ws'");
}
/* Reata o vínculo de estoque de quem o perdeu. O formulário do estágio não tinha o campo e mandava
   `undefined` a cada gravação, então salvar um estágio apagava o `item_estoque_id` em silêncio —
   10 dos 27 já estavam sem. Só preenche o que está NULO, pelo livro, que é o vínculo evidente:
   escolha que ele tenha feito à mão fica de pé. */
/* ...MAS só quando o material ainda não tem dono. Duas edições do mesmo livro (Kids 4 Old e 3rd
   Edition) apontam para o mesmo `livro`, e sem esta guarda o reconciliador religava a edição
   aposentada ao material da atual A CADA BOOT — desfazendo em silêncio o desligamento que
   `edicaoParaOItem` faz de propósito, e deixando as duas com o mesmo nome na lista. */
R(`UPDATE estagio SET item_estoque_id=(SELECT id FROM estoque_item WHERE livro=estagio.livro)
   WHERE item_estoque_id IS NULL AND livro IS NOT NULL
     AND EXISTS (SELECT 1 FROM estoque_item WHERE livro=estagio.livro)
     AND NOT EXISTS (SELECT 1 FROM estagio o WHERE o.id<>estagio.id
                       AND o.item_estoque_id=(SELECT id FROM estoque_item WHERE livro=estagio.livro))`);

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

/* ===== ARQUIVAMENTO (2026-08-17) =====
   Regra dele: *"onde tem para deletar, em vez de deletar ou excluir, coloca arquivar"* — e a
   EXCLUSÃO passa a existir só na página de Arquivados, com o nome digitado à mão.
   O motivo já estava no código: quase tudo aqui tem vínculo. Material tem exemplares e entregas;
   pedido tem unidades; estágio tem matrículas e percurso; modelo tem estágios. Apagar qualquer um
   arrasta rastro de coisa que ACONTECEU.
   `arquivado` guarda o INSTANTE, não um 0/1: responde "quando isso saiu de circulação" pelo mesmo
   preço, e nulo já é o "está em uso".
   ALUNO ficou de fora, decisão dele: `situacao` inativa já é o arquivamento dele, e duas formas de
   sumir da tela viraria confusão. */
for (const t of ["estoque_item", "estoque_unidade", "estoque_evento", "estagio", "estagio_modelo"])
  addColuna(t, "arquivado", "TEXT");
/* ===== CENTRAL DE CONTROLE (2026-08-17) =====
   Pedido dele: *"um sistema de notificação e dependências, tipo central de controle... alunos com
   livro vinculado mas sem livro entregue, alunos cadastrados sem livro vinculado, recurso sem suas
   informações completas... é tipo um backlog"*.

   NÃO existe biblioteca para isto, e é por uma razão de fundo: o que conta como "incompleto" aqui
   não é uma propriedade do esquema, é uma REGRA DA ESCOLA. Nenhum validador genérico sabe que
   estágio sem próximo pode ser o último da trilha, nem que o Kids 4 da edição antiga está sem
   material DE PROPÓSITO. Então a central é uma lista de perguntas escritas à mão, cada uma com o
   seu porquê e a sua saída — e o app segue sem dependência externa nenhuma.

   SILENCIAR é a peça que a torna usável. Ele foi explícito: *"às vezes é uma pendência, às vezes
   ela pode ser até proposital, por questão de regra de negócio"*. Sem isso, toda pendência
   deliberada vira ruído permanente e em duas semanas ninguém olha mais a tela.
   `chave='*'` silencia a REGRA inteira (ex.: "entrega sem data" — são 120 herdadas da semeadura, e
   ele sabe disso); qualquer outra chave silencia UM caso.
   As chaves são estáveis: todo alvo é `INTEGER PRIMARY KEY AUTOINCREMENT` (id nunca reaproveitado)
   ou um id de texto do mundo real (matrícula, turma). Sem isso, apagar um registro faria o silêncio
   dele cair sobre outro. */
db.exec(`CREATE TABLE IF NOT EXISTS aviso_silenciado (
  regra TEXT NOT NULL,
  chave TEXT NOT NULL,                 -- '*' = a regra inteira
  motivo TEXT,
  momento TEXT NOT NULL,
  PRIMARY KEY (regra, chave)
)`);
/* ===== CALENDÁRIO LETIVO (2026-08-17) =====
   Do protótipo em PowerPoint dele (`resources/Wizard Tools.pdf`, páginas 4-19), de anos atrás.

   POR QUE NÃO USEI BIBLIOTECA — ele pediu para eu procurar, e procurei. FullCalendar, Tui.calendar
   e afins são feitos para AGENDA: arrastar evento, visão de semana/dia, colisão de horário. O que
   ele quer é um PANORAMA ANUAL estático — 12 cartões de mês, grade fixa 7×7, segunda a domingo, dia
   de fora do mês esmaecido. Isso é aritmética de data, não interação: as ~40 linhas abaixo fazem o
   que a biblioteca faria, sem 200KB, sem CDN (o app é offline por princípio) e sem brigar com um
   layout que já vem desenhado.

   AS DATAS MÓVEIS SÃO CALCULADAS, NÃO BAIXADAS. Carnaval, Sexta-feira Santa e Corpus Christi
   andam todo ano porque dependem da Páscoa, e a Páscoa se calcula (algoritmo de Meeus/Butcher).
   Calculando, o calendário de 2031 sai certo sem internet e sem ninguém cadastrar nada — que é a
   parte "o sistema tem que ser inteligente pra se adaptar" do pedido dele.
   A BrasilAPI entra só como CONFERÊNCIA, num botão, e nunca no caminho crítico: servidor que
   depende de rede para abrir uma tela é servidor que trava quando a rede cai. */
function pascoa(ano: number): string {
  /* Meeus/Butcher — vale para todo o calendário gregoriano */
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return `${ano}-${("0" + mes).slice(-2)}-${("0" + dia).slice(-2)}`;
}
/* soma dias a uma data ISO sem passar por fuso: UTC puro, senão o horário de verão de algum ano
   antigo desloca a conta em um dia */
function maisDias(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
db.exec(`CREATE TABLE IF NOT EXISTS calendario_marcacao (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('feriado','facultativo','ferias','recesso','ponte','evento')),
  ambito TEXT NOT NULL DEFAULT 'escola' CHECK (ambito IN ('nacional','estadual','municipal','escola')),
  -- COMO a data se repete. Foi assim que o "É anual? Sim/Não" do protótipo virou três casos:
  --   'nenhuma' = data única, num ano só (usa data_ini/data_fim)
  --   'anual'   = todo ano no mesmo dia/mês (usa mes/dia)
  --   'pascoa'  = todo ano a N dias da Páscoa (usa offset_pascoa) — Carnaval, Corpus Christi...
  repeticao TEXT NOT NULL DEFAULT 'nenhuma' CHECK (repeticao IN ('nenhuma','anual','pascoa')),
  data_ini TEXT, data_fim TEXT,        -- repeticao='nenhuma'
  mes INTEGER, dia INTEGER,            -- repeticao='anual'
  offset_pascoa INTEGER,               -- repeticao='pascoa'
  duracao INTEGER NOT NULL DEFAULT 1,  -- dias corridos, para férias e recessos
  fecha INTEGER NOT NULL DEFAULT 1 CHECK (fecha IN (0,1)),  -- 1 = a escola não abre
  cor TEXT,
  observacao TEXT,
  arquivado TEXT,
  momento TEXT NOT NULL
)`);
db.exec("CREATE INDEX IF NOT EXISTS ix_cal_rep ON calendario_marcacao(repeticao)");
/* ===== A MARCAÇÃO VIROU UM CONJUNTO DE TRECHOS (2026-08-17) =====
   Ele descreveu o caso que o modelo antigo não sabia representar: *"um evento dura do dia 1 até o
   dia 4, aí se repete dia 7, aí de novo dia 9, aí dura do 11 até o 17, aí no 21 e no 25"*. E
   apontou o incômodo certo: *"esse 'quando se repete' com Páscoa é coisa antiga, não estou
   entendendo a lógica"*.

   O modelo velho amarrava UMA data a UMA regra de repetição, e ainda pedia "duração em dias" — que
   ele também recusou: *"é melhor data início e fim"*. Com isso, férias eram difíceis e o exemplo
   acima era impossível.

   Agora: **uma marcação tem N TRECHOS, e cada trecho é um ponto ou um intervalo.** Isso engole tudo
   o que existia, sem caso especial:
     · feriado fixo  → 1 trecho anual de um dia
     · férias        → 1 trecho de intervalo
     · Carnaval      → 1 trecho ancorado na Páscoa
     · o exemplo dele → 5 trechos na mesma marcação
   O `modo` continua respondendo "como este trecho acha a data no ano", que é a única coisa que a
   repetição realmente significava — só que agora por trecho, e sempre com início E fim. */
db.exec(`CREATE TABLE IF NOT EXISTS calendario_trecho (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  marcacao_id INTEGER NOT NULL REFERENCES calendario_marcacao(id) ON DELETE CASCADE,
  ordem INTEGER NOT NULL DEFAULT 1,
  modo TEXT NOT NULL CHECK (modo IN ('data','anual','pascoa','semana')),
  data_ini TEXT, data_fim TEXT,        -- modo 'data'   (fim nulo = um dia só)
  dia INTEGER, mes INTEGER,            -- modo 'anual'
  dia_fim INTEGER, mes_fim INTEGER,    -- modo 'anual', quando é intervalo
  off_ini INTEGER, off_fim INTEGER     -- modo 'pascoa' (dias a contar da Páscoa)
)`);
db.exec("CREATE INDEX IF NOT EXISTS ix_trecho_marc ON calendario_trecho(marcacao_id)");
/* ===== MODO 'semana': o N-ésimo DIA DA SEMANA de um mês (2026-08-17) =====
   As férias da Wizard não são uma data, são uma REGRA: *"começamos na segunda sexta-feira de
   dezembro e voltamos na segunda segunda-feira de janeiro"*. Guardar 11/12 fixo estaria certo em
   2026 e errado em todos os outros anos — a segunda sexta cai em 10/12 em 2027, 08/12 em 2028 e
   14/12 em 2029. Com a regra, o calendário acerta sozinho para sempre, que é o ponto do módulo.
   `n` = 1..5, ou -1 para "o último do mês" (o caso do "última sexta"). */
for (const c of ["sem_n", "sem_dow", "sem_n_fim", "sem_dow_fim"])
  addColuna("calendario_trecho", c, "INTEGER");
/* o n-ésimo `dow` (0=domingo … 6=sábado) do mês; n=-1 devolve o último */
function nEsimoDow(ano: number, mes: number, dow: number, n: number): string | null {
  const dias: string[] = [];
  const d = new Date(Date.UTC(ano, mes - 1, 1));
  while (d.getUTCMonth() === mes - 1) {
    if (d.getUTCDay() === dow) dias.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  if (!dias.length) return null;
  return n === -1 ? dias[dias.length - 1] : (dias[n - 1] || null);
}

/* UMA ocorrência do trecho, ancorada num ano (sem recorte) */
function ocorrenciaDoTrecho(t: any, ancora: number): string[] {
  let ini: string | null = null, fim: string | null = null;
  if (t.modo === "anual") {
    if (!t.mes || !t.dia) return [];
    ini = `${ancora}-${("0" + t.mes).slice(-2)}-${("0" + t.dia).slice(-2)}`;
    if (t.dia_fim && t.mes_fim) {
      fim = `${ancora}-${("0" + t.mes_fim).slice(-2)}-${("0" + t.dia_fim).slice(-2)}`;
      /* intervalo anual que vira o ano (15/dez a 20/jan): o fim é no ano SEGUINTE */
      if (fim < ini) fim = `${ancora + 1}-${("0" + t.mes_fim).slice(-2)}-${("0" + t.dia_fim).slice(-2)}`;
    }
  } else if (t.modo === "semana") {
    if (!t.mes || !t.sem_dow == null) return [];
    ini = nEsimoDow(ancora, Number(t.mes), Number(t.sem_dow), Number(t.sem_n) || 1);
    if (!ini) return [];
    if (t.mes_fim && t.sem_dow_fim != null) {
      fim = nEsimoDow(ancora, Number(t.mes_fim), Number(t.sem_dow_fim), Number(t.sem_n_fim) || 1);
      /* fim antes do início = a regra vira o ano (2ª sexta de dez → 2º domingo de jan) */
      if (fim && fim < ini)
        fim = nEsimoDow(ancora + 1, Number(t.mes_fim), Number(t.sem_dow_fim), Number(t.sem_n_fim) || 1);
    }
  } else if (t.modo === "pascoa") {
    const p = pascoa(ancora);
    ini = maisDias(p, Number(t.off_ini) || 0);
    if (t.off_fim != null && t.off_fim !== "") fim = maisDias(p, Number(t.off_fim));
  } else {
    if (!t.data_ini) return [];
    ini = t.data_ini; fim = t.data_fim || null;
  }
  const out: string[] = [];
  if (!fim || fim <= ini!) out.push(ini!);
  else {
    const a = new Date(ini! + "T12:00:00Z").getTime();
    const b = new Date(fim + "T12:00:00Z").getTime();
    let n = Math.round((b - a) / 86400000) + 1;
    if (n > 800) n = 800;                       // intervalo digitado errado não gera milhares
    for (let i = 0; i < n; i++) out.push(maisDias(ini!, i));
  }
  return out;
}
/* as datas de UM trecho dentro de um ano.
   ===== A OCORRÊNCIA DO ANO ANTERIOR TAMBÉM CONTA (achado testando, 2026-08-17) =====
   As férias anuais da Wizard vão de 15/dez a 20/jan. Olhando só a ocorrência ancorada em 2027,
   janeiro de 2027 sumia — ele pertence às férias que COMEÇARAM em dezembro de 2026. Medido: 17 dias
   por ano em vez de 37. Por isso a conta considera a âncora do ano pedido E a do ano anterior, e só
   então recorta. Vale para 'anual' e para 'pascoa' (a Páscoa de janeiro não existe, mas um offset
   grande o bastante criaria o mesmo caso). */
function datasDoTrecho(t: any, ano: number): string[] {
  const vistas = new Set<string>();
  for (const ancora of [ano - 1, ano])
    for (const d of ocorrenciaDoTrecho(t, ancora))
      if (d.startsWith(String(ano))) vistas.add(d);
  return [...vistas].sort();
}
/* MIGRAÇÃO: cada marcação antiga vira UM trecho equivalente. Roda uma vez; marcação que já tem
   trecho é ignorada, então subir o app de novo é inerte. */
function migrarTrechos() {
  const semTrecho = A(`SELECT m.* FROM calendario_marcacao m
     WHERE NOT EXISTS (SELECT 1 FROM calendario_trecho t WHERE t.marcacao_id=m.id)`);
  for (const m of semTrecho) {
    if (m.repeticao === "anual") {
      R("INSERT INTO calendario_trecho (marcacao_id,ordem,modo,dia,mes) VALUES (?,1,'anual',?,?)",
        m.id, m.dia, m.mes);
    } else if (m.repeticao === "pascoa") {
      const d = Math.max(1, m.duracao || 1);
      R("INSERT INTO calendario_trecho (marcacao_id,ordem,modo,off_ini,off_fim) VALUES (?,1,'pascoa',?,?)",
        m.id, m.offset_pascoa, d > 1 ? (Number(m.offset_pascoa) + d - 1) : null);
    } else {
      /* 'nenhuma': o fim vinha de `data_fim` OU de `duracao` — os dois viram um fim explícito */
      let fim = m.data_fim || null;
      if (!fim && (m.duracao || 1) > 1 && m.data_ini) fim = maisDias(m.data_ini, m.duracao - 1);
      R("INSERT INTO calendario_trecho (marcacao_id,ordem,modo,data_ini,data_fim) VALUES (?,1,'data',?,?)",
        m.id, m.data_ini, fim);
    }
  }
  if (semTrecho.length) console.log(`   calendário: ${semTrecho.length} marcação(ões) migradas para trechos`);
}
/* de onde a marcação veio: 'manual' (ele digitou), 'semente' (nasceu com o módulo) ou o id de uma
   fonte externa. É o que permite atualizar o que veio de fora sem encostar no que é dele. */
addColuna("calendario_marcacao", "origem", "TEXT NOT NULL DEFAULT 'manual'");
addColuna("calendario_marcacao", "chave_externa", "TEXT");
/* ===== ORQUESTRAÇÃO DE FONTES (2026-08-17) =====
   Pedido dele: *"não depender só de uma API... pode pegar mais outras, do Brasil, fora do Brasil"*.

   O QUE A PESQUISA ACHOU, e por que só duas entraram:
   - **BrasilAPI** (`brasilapi.com.br`) — nacionais, grátis, sem chave. Simples e estável.
   - **Nager.Date** (`date.nager.at`) — internacional, grátis, sem chave. Traz duas coisas que a
     BrasilAPI não tem: `counties` (recorte por estado, ex. `BR-SP`) e `types`, que separa
     `Public` de `Bank`/`Optional` — ou seja, **feriado de ponto facultativo**, que é justamente a
     nuance que ele pediu.
   - `dadosbr.github.io/feriados` — tem só 9 nacionais e **cinco** estados (ES, MG, RJ, SP, TO):
     conferido, NÃO tem MS. Ficou de fora por ser redundante e ter formato próprio.
   - feriados.dev, feriadosapi.com, Invertexto — cobrem município, mas TODAS exigem chave/plano.

   **Estadual de MS e municipais de Naviraí não têm API gratuita confiável** — vêm de lei local.
   Já estão semeados como `anual`, e por serem de data fixa nunca precisam de atualização. Raspar o
   site da prefeitura seria fragilidade em troca de nada: o dado não se move.

   A tabela existe para a fonte ser DADO, não código — acrescentar uma quarta é uma linha aqui. */
db.exec(`CREATE TABLE IF NOT EXISTS calendario_fonte (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  url TEXT NOT NULL,              -- com {ano} no lugar do ano
  ativa INTEGER NOT NULL DEFAULT 1 CHECK (ativa IN (0,1)),
  ultima_sync TEXT,
  ultimo_status TEXT,             -- 'ok' | 'erro'
  ultimo_erro TEXT,
  achados INTEGER NOT NULL DEFAULT 0,   -- quantos itens a fonte devolveu na última vez
  novos INTEGER NOT NULL DEFAULT 0      -- quantos viraram marcação
)`);
/* LIVRO-CAIXA do que já veio de fora, uma linha por chave externa vista.
   É ele que faz a sincronização RESPEITAR EXCLUSÃO: se ele apagou um feriado importado, a chave
   continua aqui e a próxima rodada não o traz de volta. Sem isto, o que ele apaga hoje reaparece
   amanhã às 15:30 — e ele nunca mais confiaria na tela. */
db.exec(`CREATE TABLE IF NOT EXISTS calendario_importado (
  fonte TEXT NOT NULL,
  chave TEXT NOT NULL,            -- 'YYYY-MM-DD|nome normalizado'
  visto_em TEXT NOT NULL,
  virou_marcacao INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (fonte, chave)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS calendario_sync (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  momento TEXT NOT NULL,
  gatilho TEXT NOT NULL,          -- 'automatico' | 'manual'
  anos TEXT, fontes_ok INTEGER, fontes_erro INTEGER, novos INTEGER, resumo TEXT
)`);
function semearFontes() {
  const f = (id: string, nome: string, url: string) =>
    R("INSERT OR IGNORE INTO calendario_fonte (id,nome,url) VALUES (?,?,?)", id, nome, url);
  f("brasilapi", "BrasilAPI — feriados nacionais", "https://brasilapi.com.br/api/feriados/v1/{ano}");
  f("nager", "Nager.Date — feriados do Brasil (com ponto facultativo)", "https://date.nager.at/api/v3/PublicHolidays/{ano}/BR");
  /* ===== INVERTEXTO (2026-08-17) — a melhor das três, e a única com ESTADUAL =====
     Ele criou a conta e o token. É a que responde mais perto do que a escola precisa:
       · `type` separa **feriado** de **facultativo** de forma explícita (as outras não, ou só por
         inferência de `types`);
       · `level` separa **nacional** de **estadual**, e com `state=MS` traz a Criação do Estado
         (11/10) com a lei — o buraco que nenhuma fonte gratuita cobria;
       · traz o que as outras duas ignoram: Quarta-feira de Cinzas, Dia do Servidor Público (28/10)
         e as vésperas de 24/12 e 31/12, que são justamente os dias em que a escola fecha mais cedo.
     PRECISA DE TOKEN, e o token é SEGREDO: mora em `config`, nunca no código. Ver `urlDaFonte`. */
  f("invertexto", "Invertexto — nacionais + estaduais de {uf}",
    "https://api.invertexto.com/v1/holidays/{ano}?token={token}&state={uf}");
}
/* ===== O TOKEN NÃO ENTRA NO REPOSITÓRIO =====
   `github.com/Vitor-rs/wiztools` é PÚBLICO. Uma chave de API no código-fonte vira chave de API na
   internet no primeiro `git push`. Ela mora na tabela `config`, dentro do `wizard.db` — que o
   `.gitignore` barra (`*.db`) e que portanto nunca sai daqui.
   Consequência prática, e é o certo: o token é POR INSTALAÇÃO. A recepção e o notebook têm bancos
   diferentes, então cada máquina recebe o dela pela tela. */
const cfg = (chave: string) => G("SELECT valor FROM config WHERE chave=?", chave)?.valor || "";
function urlDaFonte(f: any, ano: number): string | null {
  let u = f.url.replace("{ano}", String(ano));
  if (u.includes("{token}")) {
    const t = cfg("cal_token_invertexto");
    if (!t) return null;                      // sem token a fonte simplesmente não roda
    u = u.replace("{token}", encodeURIComponent(t));
  }
  return u.replace(/\{uf\}/g, cfg("cal_uf") || "MS");
}
/* normaliza o nome para comparar: acento, caixa e pontuação variam entre as fontes e fariam a mesma
   data entrar duas vezes com nomes quase iguais */
const chaveFeriado = (data: string, nome: string) =>
  data + "|" + String(nome || "").toLowerCase().normalize("NFD")
    .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
/* ADAPTADOR por fonte: cada uma fala um dialeto, e o resto do módulo não precisa saber disso. */
function normalizarFonte(id: string, bruto: any[]): any[] {
  if (id === "brasilapi")
    return (bruto || []).map(x => ({ data: x.date, nome: x.name, tipo: "feriado", ambito: "nacional" }));
  if (id === "invertexto")
    return (bruto || []).map(x => ({
      data: x.date, nome: x.name,
      /* `type` já vem no vocabulário certo: feriado | facultativo */
      tipo: x.type === "facultativo" ? "facultativo" : "feriado",
      ambito: x.level === "estadual" ? "estadual" : "nacional",
      /* a lei vira observação — é o "por que este dia é feriado" que nenhuma outra fonte dá */
      observacao: x.law || null,
    }));
  if (id === "nager")
    return (bruto || []).map(x => ({
      data: x.date, nome: x.localName || x.name,
      /* AQUI está o ganho da segunda fonte: 'Bank'/'Optional' viram ponto facultativo, e só
         'Public' é feriado de verdade. A BrasilAPI chama tudo de feriado. */
      tipo: (x.types || []).includes("Public") ? "feriado" : "facultativo",
      /* `counties` restringe a um estado (ex.: BR-SP). Só interessa o que vale em MS ou no país. */
      ambito: x.global === false ? "estadual" : "nacional",
      counties: x.counties || null,
    })).filter(x => !x.counties || x.counties.includes("BR-MS"));
  return [];
}
/* AS DATAS QUE UMA MARCAÇÃO OCUPA NAQUELE ANO. Um lugar só resolve os três modos de repetição —
   a tela, a contagem de dias letivos e o que vier depois pedem sempre a mesma resposta. */
/* AS DATAS DE UMA MARCAÇÃO = a união das datas dos seus trechos.
   O caminho antigo continua abaixo como rede de segurança: marcação sem trecho (só existiria se a
   migração falhasse no meio) ainda responde pelo modelo velho, em vez de sumir da tela. */
function datasDaMarcacao(m: any, ano: number): string[] {
  const trechos = A("SELECT * FROM calendario_trecho WHERE marcacao_id=? ORDER BY ordem, id", m.id);
  if (trechos.length) {
    const vistas = new Set<string>();
    for (const t of trechos) for (const d of datasDoTrecho(t, ano)) vistas.add(d);
    return [...vistas].sort();
  }
  return datasPeloModeloAntigo(m, ano);
}
function datasPeloModeloAntigo(m: any, ano: number): string[] {
  let inicio: string | null = null, dur = Math.max(1, m.duracao || 1);
  if (m.repeticao === "anual") {
    if (!m.mes || !m.dia) return [];
    inicio = `${ano}-${("0" + m.mes).slice(-2)}-${("0" + m.dia).slice(-2)}`;
  } else if (m.repeticao === "pascoa") {
    inicio = maisDias(pascoa(ano), Number(m.offset_pascoa) || 0);
  } else {
    if (!m.data_ini) return [];
    /* ===== FÉRIAS QUE ATRAVESSAM O ANO NOVO (corrigido 2026-08-17) =====
       Aqui havia um `return []` quando `data_ini` não era do ano pedido — e isso apagava JANEIRO
       das férias da escola, que é justamente como a Wizard tira férias: *"entramos na metade de
       dezembro e voltamos na metade de janeiro"*. Medido antes do conserto: 15/12/2026 a
       20/01/2027 são 37 dias, e a tela mostrava 17 em 2026 e **ZERO em 2027**.
       Agora o intervalo INTEIRO é gerado e só depois se recorta o ano — o mesmo registro pinta o
       fim de dezembro numa folha e o começo de janeiro na outra. */
    inicio = m.data_ini;
    if (m.data_fim) {
      const a = new Date(m.data_ini + "T12:00:00Z").getTime();
      const b = new Date(m.data_fim + "T12:00:00Z").getTime();
      dur = Math.max(1, Math.round((b - a) / 86400000) + 1);
    }
    /* guarda de sanidade: intervalo digitado errado (2026→2035) não pode gerar milhares de dias */
    if (dur > 800) dur = 800;
  }
  const out: string[] = [];
  for (let i = 0; i < dur; i++) out.push(maisDias(inicio!, i));
  return out.filter(d => d.startsWith(String(ano)));
}
/* ===== UMA DATA PODE SER VÁRIAS COISAS (2026-08-17) =====
   Ordem dele: *"às vezes uma data pode ser tudo isso — férias, recesso, feriado"*. As férias de fim
   de ano da Wizard são férias E recesso ao mesmo tempo, e podem engolir o Natal por dentro.
   `tipo` continua sendo o tipo PRINCIPAL (é ele que dá a cor, a pílula e a legenda, e é ele que o
   CHECK da tabela conhece); `tipos` guarda o conjunto. Assim nada rio abaixo precisou mudar, e não
   foi preciso reconstruir a tabela só para afrouxar um CHECK. */
addColuna("calendario_marcacao", "tipos", "TEXT");
db.exec("UPDATE calendario_marcacao SET tipos=tipo WHERE tipos IS NULL OR tipos=''");
const TIPOS_CAL = ["feriado", "facultativo", "ferias", "recesso", "ponte", "evento"];
/* FÉRIAS E RECESSO NÃO TÊM AULA, ponto. Ele foi categórico: *"não tem como férias ser aula"*.
   A regra vive no servidor e não no formulário, senão a próxima tela que gravar uma marcação
   poderia contradizê-la. */
const FECHA_SEMPRE = ["ferias", "recesso"];
function normalizarTipos(tipos: any, tipoUnico: any): { tipo: string; tipos: string; fecha: boolean | null } {
  let lista: string[] = Array.isArray(tipos) ? tipos.map(String)
    : String(tipos || tipoUnico || "evento").split(",");
  lista = lista.map(t => t.trim()).filter(t => TIPOS_CAL.includes(t));
  if (!lista.length) lista = [String(tipoUnico || "evento")];
  /* o principal é o que aparece: a ordem de TIPOS_CAL é a de peso (feriado manda sobre evento) */
  lista.sort((a, b) => TIPOS_CAL.indexOf(a) - TIPOS_CAL.indexOf(b));
  const fechaForcado = lista.some(t => FECHA_SEMPRE.includes(t)) ? true : null;
  return { tipo: lista[0], tipos: lista.join(","), fecha: fechaForcado };
}
/* O QUE JÁ NASCE SABIDO. Feriado nacional é lei federal e não muda; estadual e municipal vêm de lei
   local, e é por isso que NÃO existe API confiável para eles — precisam ser ditos uma vez.
   Fontes conferidas para Naviraí-MS: criação do estado 11/10; padroeira 13/05; aniversário do
   município 11/11 (Lei Estadual 1944/1963). */
const CAL_SEMENTE: any[] = [
  // nacionais de data fixa
  ["Confraternização Universal", "feriado", "nacional", "anual", 1, 1],
  ["Tiradentes", "feriado", "nacional", "anual", 4, 21],
  ["Dia do Trabalho", "feriado", "nacional", "anual", 5, 1],
  ["Independência do Brasil", "feriado", "nacional", "anual", 9, 7],
  ["Nossa Senhora Aparecida", "feriado", "nacional", "anual", 10, 12],
  ["Finados", "feriado", "nacional", "anual", 11, 2],
  ["Proclamação da República", "feriado", "nacional", "anual", 11, 15],
  ["Consciência Negra", "feriado", "nacional", "anual", 11, 20],
  ["Natal", "feriado", "nacional", "anual", 12, 25],
  // estadual e municipais
  ["Criação de Mato Grosso do Sul", "feriado", "estadual", "anual", 10, 11],
  ["Nossa Senhora de Fátima (padroeira)", "feriado", "municipal", "anual", 5, 13],
  ["Aniversário de Naviraí", "feriado", "municipal", "anual", 11, 11],
];
/* as móveis, por deslocamento a partir da Páscoa */
const CAL_SEMENTE_PASCOA: any[] = [
  ["Carnaval (segunda)", "facultativo", "nacional", -48],
  ["Carnaval (terça)", "facultativo", "nacional", -47],
  ["Quarta-feira de Cinzas", "facultativo", "nacional", -46],
  ["Sexta-feira Santa", "feriado", "nacional", -2],
  ["Páscoa", "feriado", "nacional", 0],
  ["Corpus Christi", "facultativo", "nacional", 60],
];
function semearCalendario() {
  if (G("SELECT 1 FROM config WHERE chave='calendario_semeado'")) return;
  const ins = (nome: string, tipo: string, amb: string, rep: string,
               mes: any, dia: any, off: any, cor: string) =>
    R(`INSERT INTO calendario_marcacao (nome,tipo,ambito,repeticao,mes,dia,offset_pascoa,duracao,fecha,cor,origem,momento)
       VALUES (?,?,?,?,?,?,?,1,1,?,'semente',?)`, nome, tipo, amb, rep, mes, dia, off, cor, agora());
  for (const [nome, tipo, amb, rep, mes, dia] of CAL_SEMENTE)
    ins(nome, tipo, amb, rep, mes, dia, null, amb === "nacional" ? "#B3261E" : amb === "estadual" ? "#7A4FBF" : "#0F7B6C");
  for (const [nome, tipo, amb, off] of CAL_SEMENTE_PASCOA)
    ins(nome, tipo, amb, "pascoa", null, null, off, tipo === "feriado" ? "#B3261E" : "#B26A00");
  R("INSERT INTO config (chave,valor) VALUES ('calendario_semeado',?)", agora());
  console.log(`   calendário letivo semeado: ${CAL_SEMENTE.length + CAL_SEMENTE_PASCOA.length} marcações`);
}
/* a CHAMADA de `semearCalendario` mora lá embaixo, junto das outras semeaduras: `agora` é um
   `const` declarado adiante, e chamar daqui morre na zona morta temporal — foi o que aconteceu
   na primeira subida. Regra da casa: semeadura roda no bloco de boot, nunca no meio do arquivo. */

/* Cada checagem devolve `k` (chave estável), `r` (rótulo) e, quando ajuda, `d` (detalhe).
   `gravidade`: alta = atrapalha a operação hoje · media = vai atrapalhar · baixa = cadastro
   incompleto, que é backlog de verdade e não urgência.
   `aba` é para onde o botão "resolver" leva. */
/* `destino` diz O QUE o caso é (aluno, material, estágio…) e `campo` qual caixa deve piscar ao
   chegar. Quem resolve o ALVO é o SQL, na coluna `a`: só o banco sabe virar um `aula.id` no aluno
   dono dela, e fazer o cliente adivinhar isso a partir da chave seria decorar o formato de cada
   regra em dois lugares. */
type Checagem = { id: string; area: string; titulo: string; porque: string; acao: string;
                  gravidade: "alta" | "media" | "baixa"; aba: string; sql: string;
                  destino?: string; campo?: string };
const CHECAGENS: Checagem[] = [
  /* ---------- ALUNOS ---------- */
  { id: "aluno_sem_matricula", destino: "aluno", area: "Alunos", gravidade: "alta", aba: "alunos",
    titulo: "Aluno ativo sem nenhuma matrícula",
    porque: "O aluno está com situação ativa mas não está vinculado a estágio nenhum — ele não aparece em ficha, agenda nem entrega.",
    acao: "Abra o aluno e use \"+ Nova matrícula em estágio\".",
    sql: `SELECT a.id_matricula k, a.nome r, a.situacao d, a.id_matricula a FROM alunos a
          JOIN situacoes s ON s.situacao=a.situacao AND s.ativa=1
          WHERE NOT EXISTS (SELECT 1 FROM aluno_livro al WHERE al.id_matricula=a.id_matricula)
          ORDER BY a.nome` },
  { id: "matricula_sem_entrega", destino: "entrega", area: "Alunos", gravidade: "alta", aba: "estoque",
    titulo: "Matrícula ativa sem material entregue",
    porque: "O aluno está matriculado no estágio e não recebeu o material dele (ou devolveu e não recebeu outro).",
    acao: "Aba Estoque · Entregas: escolha o aluno e entregue um exemplar.",
    sql: `SELECT al.id_matricula||'|'||al.livro k, a.nome r, al.livro d, al.id_matricula a
          FROM aluno_livro al JOIN alunos a ON a.id_matricula=al.id_matricula
          JOIN situacoes s ON s.situacao=a.situacao AND s.ativa=1
          LEFT JOIN entrega_material e ON e.id_matricula=al.id_matricula AND e.livro=al.livro
          WHERE e.id IS NULL OR e.devolvida IS NOT NULL ORDER BY a.nome` },
  { id: "matricula_sem_agenda", destino: "aluno", area: "Alunos", gravidade: "alta", aba: "alunos",
    titulo: "Matrícula ativa sem horário na agenda",
    porque: "Sem dia e hora o aluno não entra em bloco nenhum: some da ficha impressa e das duas telas de frequência.",
    acao: "Abra o aluno, escolha a aba do estágio e marque os dias na grade.",
    sql: `SELECT al.id_matricula||'|'||al.livro k, a.nome r, al.livro d, al.id_matricula a
          FROM aluno_livro al JOIN alunos a ON a.id_matricula=al.id_matricula
          JOIN situacoes s ON s.situacao=a.situacao AND s.ativa=1
          WHERE NOT EXISTS (SELECT 1 FROM aulas au WHERE au.id_matricula=al.id_matricula AND au.livro=al.livro)
          ORDER BY a.nome` },
  { id: "aula_sem_professor", destino: "aluno", area: "Alunos", gravidade: "media", aba: "alunos",
    titulo: "Aula sem professor vinculado",
    porque: "A ficha impressa sai sem o nome da professora naquele bloco.",
    acao: "Abra o aluno, na aba do estágio, e preencha Professores.",
    sql: `SELECT au.id k, a.nome r, au.livro||' · '||au.dia||' '||au.hora d, au.id_matricula a FROM aulas au
          JOIN alunos a ON a.id_matricula=au.id_matricula
          JOIN situacoes s ON s.situacao=a.situacao AND s.ativa=1
          WHERE NOT EXISTS (SELECT 1 FROM aula_professor ap WHERE ap.aula_id=au.id)
          ORDER BY a.nome, au.dia` },
  { id: "aluno_sem_historico", destino: "aluno-historico", area: "Alunos", gravidade: "baixa", aba: "alunos",
    titulo: "Aluno ativo sem nenhum registro de situação",
    porque: "Não há quando ele entrou nem em qual estágio — o percurso dele começa em branco.",
    acao: "Abra o aluno em Informações · Histórico de situação e lance a entrada dele.",
    sql: `SELECT a.id_matricula k, a.nome r, a.situacao d, a.id_matricula a FROM alunos a
          JOIN situacoes s ON s.situacao=a.situacao AND s.ativa=1
          WHERE NOT EXISTS (SELECT 1 FROM aluno_situacao_historico h WHERE h.id_matricula=a.id_matricula)
          ORDER BY a.nome` },
  { id: "entrega_sem_data", destino: "entrega", area: "Alunos", gravidade: "baixa", aba: "estoque",
    titulo: "Entrega registrada sem data",
    porque: "Sabe-se que o aluno recebeu, não quando. É o caso das entregas deduzidas das matrículas antigas.",
    acao: "Aba Estoque · Entregas: preencha a data na linha, quando souber.",
    sql: `SELECT e.id_matricula||'|'||e.livro k, a.nome r, e.livro d, e.id_matricula a FROM entrega_material e
          JOIN alunos a ON a.id_matricula=e.id_matricula WHERE e.data IS NULL ORDER BY a.nome` },

  /* ---------- BIBLIOTECA · ESTÁGIOS ---------- */
  { id: "estagio_sem_estrutura", destino: "estagio", campo: "estrutura", area: "Estágios", gravidade: "alta", aba: "estagios",
    titulo: "Estágio sem estrutura definida",
    porque: "Sem modelo e sem lista própria não há como saber quantas lições o estágio tem.",
    acao: "Abra o estágio em Estrutura e escolha um modelo (ou monte a lista própria).",
    sql: `SELECT e.id k, e.nome r, e.categoria d, e.id a FROM estagio e
          WHERE e.arquivado IS NULL AND e.modelo_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM estagio_licao l WHERE l.dono_id=e.id) ORDER BY e.ordem` },
  { id: "estagio_sem_material", destino: "estagio", campo: "eg-item", area: "Estágios", gravidade: "media", aba: "estagios",
    titulo: "Estágio sem material de estoque vinculado",
    porque: "A matrícula nesse estágio não consegue dizer se há exemplar na prateleira, e a entrega fica sem unidade.",
    acao: "Abra o estágio em Dados e escolha o material. (Edição aposentada sem estoque é caso legítimo — silencie.)",
    sql: `SELECT e.id k, e.nome r, COALESCE(e.livro,'sem estágio-ponte') d, e.id a FROM estagio e
          WHERE e.arquivado IS NULL AND e.item_estoque_id IS NULL ORDER BY e.ordem` },
  { id: "estagio_sem_livro", destino: "estagio", campo: "eg-item", area: "Estágios", gravidade: "media", aba: "estagios",
    titulo: "Estágio sem estágio-ponte",
    porque: "Sem o vínculo com `livros` ninguém consegue se matricular nele: matrícula, agenda e ficha passam por aí.",
    acao: "Abra o estágio em Dados e vincule o material — o estágio-ponte vem dele.",
    sql: `SELECT e.id k, e.nome r, e.categoria d, e.id a FROM estagio e
          WHERE e.arquivado IS NULL AND (e.livro IS NULL OR e.livro='') ORDER BY e.ordem` },
  { id: "estagio_sem_nome_curto", destino: "estagio", campo: "eg-nomecurto", area: "Estágios", gravidade: "baixa", aba: "estagios",
    titulo: "Estágio sem nome curto",
    porque: "O nome curto é o que cabe nas pílulas e nas fichas impressas.",
    acao: "Abra o estágio em Dados e preencha Nome curto.",
    sql: `SELECT e.id k, e.nome r, e.categoria d, e.id a FROM estagio e
          WHERE e.arquivado IS NULL AND (e.nome_curto IS NULL OR e.nome_curto='') ORDER BY e.ordem` },
  { id: "estagio_sem_proximo", destino: "estagio-trilha", area: "Estágios", gravidade: "baixa", aba: "estagios",
    titulo: "Estágio sem próximo na trilha",
    porque: "A rematrícula não sabe sugerir para onde o aluno vai depois de terminar.",
    acao: "Aba Estágios · Trilha. (Se ele é o último da coleção, marque o material como FINAL na aba Estoque · Materiais — aí ele sai daqui sozinho.)",
    /* O ÚLTIMO DA COLEÇÃO NÃO ENTRA (2026-08-17): o W12 não tem próximo por definição, e um alerta
       que não se resolve nunca é ruído permanente. Quem diz que é o último é o MATERIAL. */
    sql: `SELECT e.id k, e.nome r, e.categoria d, e.id a FROM estagio e
          LEFT JOIN estoque_item i ON i.id=e.item_estoque_id
          WHERE e.arquivado IS NULL AND (e.livro IS NOT NULL AND e.livro<>'')
          AND COALESCE(i.final,0)=0
          AND NOT EXISTS (SELECT 1 FROM estagio_proximo p WHERE p.de_id=e.id) ORDER BY e.ordem` },

  /* ---------- BIBLIOTECA · ESTOQUE ---------- */
  { id: "material_abaixo_minimo", destino: "material", campo: "minimo", area: "Estoque", gravidade: "alta", aba: "estoque",
    titulo: "Material abaixo do mínimo, sem pedido a caminho",
    porque: "O saldo já está abaixo do que você definiu como mínimo e não há pedido pendente para repor.",
    acao: "Aba Estoque · Materiais: \"+ Fazer pedido\".",
    sql: `SELECT i.id k, i.descricao r,
            'saldo '||(SELECT COUNT(*) FROM estoque_unidade u WHERE u.item_id=i.id AND u.entrega_id IS NULL AND u.arquivado IS NULL)
            ||' · mínimo '||i.minimo d, i.id a
          FROM estoque_item i WHERE i.arquivado IS NULL AND i.componente=0 AND i.minimo>0
          AND (SELECT COUNT(*) FROM estoque_unidade u WHERE u.item_id=i.id AND u.entrega_id IS NULL AND u.arquivado IS NULL) < i.minimo
          ORDER BY i.ordem` },
  { id: "material_sem_minimo", destino: "material", campo: "minimo", area: "Estoque", gravidade: "media", aba: "estoque",
    titulo: "Material sem estoque mínimo definido",
    porque: "Com mínimo zero o sistema nunca vai avisar que está na hora de pedir esse material.",
    acao: "Aba Estoque · Materiais: escolha o material e preencha Mínimo.",
    sql: `SELECT i.id k, i.descricao r, COALESCE(i.livro,'avulso') d, i.id a FROM estoque_item i
          WHERE i.arquivado IS NULL AND i.componente=0 AND i.minimo=0 ORDER BY i.ordem` },
  { id: "material_sem_edicao", destino: "material", campo: "edicoes", area: "Estoque", gravidade: "baixa", aba: "estoque",
    titulo: "Material de livro sem edição definida",
    porque: "Sem edição, dois exemplares de anos diferentes ficam indistinguíveis na fila.",
    acao: "Aba Estoque · Materiais: escolha o material e crie a edição no campo Edições.",
    sql: `SELECT i.id k, i.descricao r, i.livro d, i.id a FROM estoque_item i
          WHERE i.arquivado IS NULL AND i.componente=0 AND i.livro IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM estoque_edicao ed WHERE ed.item_id=i.id AND ed.arquivada IS NULL)
          ORDER BY i.ordem` },
  { id: "unidade_sem_numero", destino: "material", area: "Estoque", gravidade: "media", aba: "estoque",
    titulo: "Exemplar sem número de etiqueta",
    porque: "O número escrito à caneta é o identificador que a mão alcança na prateleira.",
    acao: "Aba Estoque · Materiais: abra a fila do material e edite o exemplar no lápis.",
    sql: `SELECT u.id k, i.descricao r, 'entrou '||substr(u.entrada,1,16) d, u.item_id a
          FROM estoque_unidade u JOIN estoque_item i ON i.id=u.item_id
          WHERE u.arquivado IS NULL AND u.numero IS NULL ORDER BY u.entrada` },
  { id: "unidade_sem_codigo", destino: "material", area: "Estoque", gravidade: "baixa", aba: "estoque",
    titulo: "Exemplar sem código de barras",
    porque: "O código é o que amarra a entrega ao objeto físico quando o exemplar sai.",
    acao: "Aba Estoque · Materiais: abra a fila e digite o código no lápis do exemplar.",
    sql: `SELECT u.id k, i.descricao||' nº '||COALESCE(u.numero,'?') r, 'entrou '||substr(u.entrada,1,16) d, u.item_id a
          FROM estoque_unidade u JOIN estoque_item i ON i.id=u.item_id
          WHERE u.arquivado IS NULL AND (u.codigo IS NULL OR u.codigo='') ORDER BY u.entrada` },
  { id: "unidade_nao_conferida", destino: "material", area: "Estoque", gravidade: "baixa", aba: "estoque",
    titulo: "Exemplar na prateleira nunca conferido",
    porque: "Ninguém confirmou que esse exemplar está fisicamente na caixa que chegou.",
    acao: "Aba Estoque · Entradas: abra o pedido e use o botão de conferir de cada exemplar.",
    sql: `SELECT u.id k, i.descricao||' nº '||COALESCE(u.numero,'?') r, 'entrou '||substr(u.entrada,1,16) d, u.item_id a
          FROM estoque_unidade u JOIN estoque_item i ON i.id=u.item_id
          WHERE u.arquivado IS NULL AND u.entrega_id IS NULL AND u.conferido IS NULL ORDER BY u.entrada` },
  { id: "pedido_nao_chegou", destino: "pedido", area: "Estoque", gravidade: "media", aba: "estoque",
    titulo: "Pedido confirmado que ainda não chegou",
    porque: "O pedido foi fechado e nenhuma remessa dele entrou — pode ser hora de cobrar.",
    acao: "Aba Estoque · Entradas: confirme a chegada quando a caixa vier.",
    sql: `SELECT ev.id k, 'Pedido de '||ev.data r,
            (SELECT COALESCE(SUM(quantidade),0) FROM estoque_evento_item ei WHERE ei.evento_id=ev.id)||' exemplar(es)' d, ev.id a
          FROM estoque_evento ev WHERE ev.tipo='pedido' AND ev.arquivado IS NULL AND ev.confirmado=1
          AND NOT EXISTS (SELECT 1 FROM estoque_evento r2 WHERE r2.tipo='remessa' AND r2.pedido_id=ev.id)
          ORDER BY ev.data` },

  /* ---------- TURMAS E PROFESSORES ---------- */
  { id: "turma_sem_professor", destino: "turma", area: "Turmas", gravidade: "alta", aba: "turmas",
    titulo: "Turma ativa sem professor",
    porque: "A professora faz parte da identidade da turma — é ela que desempata salas gêmeas no mesmo horário.",
    acao: "Abra a turma e preencha Professores.",
    sql: `SELECT t.id k, t.id r, COALESCE(t.livro,'multi-estágio')||' · '||t.hora_inicio d, t.id a FROM turmas t
          WHERE t.status='Ativa' AND NOT EXISTS (SELECT 1 FROM turma_professor tp WHERE tp.turma_id=t.id)` },
  { id: "turma_sem_dias", destino: "turma", area: "Turmas", gravidade: "alta", aba: "turmas",
    titulo: "Turma ativa sem dias definidos",
    porque: "Turma sem dia não casa com aluno nenhum: ela não existe em nenhuma ficha.",
    acao: "Abra a turma e marque os dias.",
    sql: `SELECT t.id k, t.id r, COALESCE(t.livro,'multi-estágio')||' · '||t.hora_inicio d, t.id a FROM turmas t
          WHERE t.status='Ativa' AND NOT EXISTS (SELECT 1 FROM turma_dia td WHERE td.turma_id=t.id)` },
  { id: "turma_vazia", destino: "turma", area: "Turmas", gravidade: "media", aba: "turmas",
    titulo: "Turma ativa sem nenhum aluno no horário dela",
    porque: "A sala está aberta na matriz e ninguém está agendado nela.",
    acao: "Abra a turma: ou entra aluno, ou ela passa a Inativa.",
    sql: `SELECT t.id k, t.id r, COALESCE(t.livro,'multi-estágio')||' · '||t.hora_inicio d, t.id a FROM turmas t
          WHERE t.status='Ativa' AND NOT EXISTS (
            SELECT 1 FROM aulas au JOIN turma_dia td ON td.dia=au.dia AND td.turma_id=t.id
            WHERE au.hora=t.hora_inicio AND (t.livro IS NULL OR au.livro=t.livro))` },
  { id: "professor_sem_aula", destino: "professor", area: "Turmas", gravidade: "baixa", aba: "professores",
    titulo: "Professor sem nenhuma aula ou turma",
    porque: "Está cadastrado e não aparece em lugar nenhum — pode ser cadastro antigo.",
    acao: "Aba Professores: vincule ou remova.",
    sql: `SELECT f.id k, f.nome r, f.nome_completo d, f.id a FROM funcionarios f
          WHERE NOT EXISTS (SELECT 1 FROM aula_professor ap WHERE ap.funcionario_id=f.id)
            AND NOT EXISTS (SELECT 1 FROM turma_professor tp WHERE tp.funcionario_id=f.id)
          ORDER BY f.nome` },
];

/* de qual tabela cada tipo vem, e qual coluna é o NOME que a exclusão vai exigir digitado */
const ARQUIVAVEIS: Record<string, { tabela: string; rotulo: string }> = {
  material: { tabela: "estoque_item", rotulo: "descricao" },
  exemplar: { tabela: "estoque_unidade", rotulo: "codigo" },
  pedido: { tabela: "estoque_evento", rotulo: "data" },
  estagio: { tabela: "estagio", rotulo: "nome" },
  modelo: { tabela: "estagio_modelo", rotulo: "nome" },
};

/* ===== PERCURSO DO ALUNO =====
   `aluno_livro` responde "o que ele faz HOJE" e por isso é apagada quando o livro troca — a agenda,
   a modalidade e o VIP são do livro corrente, e `aulas.livro` tem FK para lá. O efeito colateral é
   que o aluno perdia a própria história: quem terminou o W2 e foi para o W4 não deixava rastro de
   ter feito o W2.
   Esta tabela é a HISTÓRIA. Nasce junto com a matrícula e é FECHADA (data_fim + estado), nunca
   apagada, quando o livro troca ou a matrícula sai. As duas convivem de propósito: a de cima é
   operacional, esta é biográfica.

   `livro` é TEXT solto e `estagio_id` pode ficar NULL — mesma razão de `presenca.livro`: apagar um
   livro do catálogo ou um estágio da Biblioteca não pode apagar o passado de ninguém. O nome do
   livro fica gravado aqui mesmo, então a linha continua legível sem o catálogo. */
db.exec(`CREATE TABLE IF NOT EXISTS aluno_estagio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  id_matricula TEXT NOT NULL REFERENCES alunos(id_matricula) ON DELETE CASCADE,
  estagio_id INTEGER REFERENCES estagio(id) ON DELETE SET NULL,
  livro TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'cursando'
    CHECK (estado IN ('cursando','encerrado','trancado','evadido','cancelado')),
  data_inicio TEXT, data_fim TEXT,
  licao_atual INTEGER,
  contrato_seq INTEGER,
  observacao TEXT,
  momento TEXT NOT NULL,
  /* fechado é fechado: estado que não seja 'cursando' tem de dizer QUANDO acabou */
  CHECK (estado='cursando' OR data_fim IS NOT NULL),
  CHECK (data_fim IS NULL OR data_inicio IS NULL OR data_fim >= data_inicio)
)`);
/* um 'cursando' por aluno+livro, e quantos fechados quiser: aluno que repete o mesmo livro tem
   duas linhas, e é isso mesmo que se quer ver. Índice PARCIAL — o único jeito de exigir unicidade
   só de uma fatia da tabela. */
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ix_aluno_estagio_atual
  ON aluno_estagio(id_matricula, livro) WHERE estado='cursando'`);
db.exec("CREATE INDEX IF NOT EXISTS ix_aluno_estagio ON aluno_estagio(id_matricula, data_inicio)");

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

/* ===== O MATERIAL É O KIT (2026-08-10) =====
   Correção de modelo, ditada por ele: "quando a gente pede, não é um livro sozinho, avulso — a
   gente pede sempre um kit. A contagem que eu fiz não é do livro em si, é do kit. É a mochila que
   vem com o workbook e o student's book."
   Logo, a linha de cada livro JÁ É o kit. As quantidades que ele contou em 06/08 continuam valendo
   sem tocar em nada — elas sempre foram contagem de kit; o que estava errado era o rótulo.
   Antes disto ele tinha criado à mão um item "W2 NEW" com unidade kit contendo o W2, justamente
   porque o modelo o obrigava a inventar uma linha paralela para dizer "isto é um kit".

   Os componentes são TIPOS de peça (Student's Book, Workbook, Mochila, Pasta), não um item por
   livro: cinco linhas em vez de oitenta, e a composição de cada kit diz quais tipos ele leva. */
function migrarMaterialParaKit() {
  if (G("SELECT valor FROM config WHERE chave='material_kit'")) return { kits: 0 };
  /* a COMPOSIÇÃO em si é assunto de `comporKits()`, que roda logo depois e a deriva da regra —
     aqui só se marca o que é kit */
  let kits = 0;
  for (const it of A("SELECT * FROM estoque_item WHERE livro IS NOT NULL AND componente=0")) {
    /* o "Kids Esp 1" fica fora: é adaptação que o próprio Vitor montou a partir de outra editora,
       não vem em caixa da Wizard. Ele que diga se um dia virar kit. */
    if (it.livro === "Kids Esp 1") continue;
    R("UPDATE estoque_item SET unidade='kit', tipo='kit' WHERE id=?", it.id);
    kits++;
  }
  R("INSERT OR REPLACE INTO config (chave,valor) VALUES ('material_kit',?)", agora());
  console.log("estoque: " + kits + " material(is) passaram a ser kit, com a composição padrão");
  return { kits };
}
/* ===== TUDO É ITEM, e o item tem TRÊS naturezas (2026-08-10, especificação dele) =====
     kit     — o conjunto montado que a escola conta, pede e etiqueta com código de barras.
               "O kit W2 é o estágio W2 com o W2 Student's Book, o W2 Workbook e a pasta que
               segura eles."
     peca    — parte de um kit: Student's Book, Workbook, pasta, mochila. Não se conta sozinha.
               Student's Book e Workbook são peças do TIPO LIVRO — "ao final das contas, são livros".
     unidade — material que existe por si: a Wiz.pen. Ela vem dentro de três kits E pode ser pedida
               avulsa, então é unidade que também aparece como peça de kit.
   `unidade` era o nome do campo e virou `tipo`, com as três naturezas. A palavra "unidade" passou a
   ser um dos valores, e não mais o nome da coluna — era exatamente a confusão que ele apontou.

   ATENÇÃO à correção de rumo: horas antes ele dissera que a pasta "não faz parte do conteúdo", e eu
   tirei pasta e mochila das composições. Ele então descreveu o kit e a pasta está lá dentro. As
   duas frases convivem: o CONTEÚDO pedagógico é o livro; o KIT é o que chega na caixa, com a pasta.
   A composição modela o KIT. */
const PECAS_LIVRO = ["Student's Book", "Workbook"];
const PECAS_CONTINENTE = ["Pasta", "Mochila"];
/* os únicos três kits que trazem Wiz.pen por padrão. Aluno que já tem a caneta de um livro anterior
   não precisa de outra, e a que vem no kit costuma ir para o estoque — mas ela VEM no kit, e é isso
   que a composição registra. */
const KITS_COM_WIZPEN = ["TOTS 2", "L. Kids 2", "KIDS 2"];
/* Business Empire: curso avulso de inglês de negócios, complementa o W (BE 2 ↔ W2, BE 4 ↔ W4).
   Sem workbook, com pasta. */
const SEM_WORKBOOK = /^(TOTS|BE )/i;

function comporKits() {
  if (G("SELECT valor FROM config WHERE chave='kit_composicao_v3'")) return { kits: 0 };
  const idDe: Record<string, number> = {};
  /* `componente` é explícito e NÃO sai do tipo: a Wiz.pen é peça (entra em três kits) e mesmo assim
     se conta e se pede sozinha, então entra na grade. Derivar um do outro a fazia sumir da
     contagem — ou virar "unidade" de novo e não aparecer como coluna da matriz. */
  const garantir = (nome: string, tipo: string, ordem: number, componente: number) => {
    let c = G("SELECT id FROM estoque_item WHERE descricao=?", nome);
    if (!c) c = { id: Number(R(`INSERT INTO estoque_item (descricao,codigo,livro,unidade,tipo,finalidade,minimo,ordem,componente)
        VALUES (?,?,NULL,'unidade',?,'venda',0,?,?)`, nome, siglaLivro(nome), tipo, ordem, componente).lastInsertRowid) };
    R("UPDATE estoque_item SET tipo=?, componente=? WHERE id=?", tipo, componente, c.id);
    idDe[nome] = c.id;
    return c.id;
  };
  PECAS_LIVRO.forEach((n, i) => garantir(n, "peca", 950 + i, 1));
  PECAS_CONTINENTE.forEach((n, i) => garantir(n, "peca", 960 + i, 1));
  garantir("Wiz.pen", "peca", 901, 0);

  let kits = 0;
  for (const it of A("SELECT * FROM estoque_item WHERE livro IS NOT NULL AND componente=0")) {
    if (it.livro === "Kids Esp 1") continue; // adaptação própria dele, não vem em caixa da Wizard
    R("UPDATE estoque_item SET tipo='kit', unidade='kit' WHERE id=?", it.id);
    /* recompõe do zero: a composição inteira é derivada de regra, e reconstruir é o que a mantém
       igual à regra depois de eu ter errado duas vezes o que entra nela */
    R("DELETE FROM estoque_kit_item WHERE kit_id=?", it.id);
    const peças = [idDe["Student's Book"]];
    if (!SEM_WORKBOOK.test(it.livro)) peças.push(idDe["Workbook"]);
    peças.push(categoriaLivro(it.livro) === "Kids" ? idDe["Mochila"] : idDe["Pasta"]);
    if (KITS_COM_WIZPEN.includes(it.livro)) peças.push(idDe["Wiz.pen"]);
    for (const p of peças)
      R("INSERT OR IGNORE INTO estoque_kit_item (kit_id,item_id,quantidade) VALUES (?,?,1)", it.id, p);
    kits++;
  }
  R("INSERT OR REPLACE INTO config (chave,valor) VALUES ('kit_composicao_v3',?)", agora());
  console.log("estoque: composição refeita em " + kits + " kit(s) — pasta/mochila dentro, Wiz.pen nos três de entrada");
  return { kits };
}

/* A EDIÇÃO deixa de ser escrita DENTRO do nome (2026-08-10, dele): *"o nome pode ser uma
   concatenação da edição com o nome. Não preciso colocar Kids 4 Third Edition — só coloco Kids 4,
   aí o nome da edição vincula ele. Não é o ano da edição, só o nome já é suficiente."*
   Então o nome guarda só o livro e a tela concatena. Esta função arruma os dois Kids 4 que ele já
   tinha editado à mão, e roda uma vez só: depois disso os nomes são dele. */
function arrumarNomesDeEdicao() {
  /* marca v2: a primeira versão procurava por SIGLA e não achou nada — ele já tinha renomeado as
     siglas para K4 e K4_O, e a marca foi gravada com zero ajustes. Mesmo erro que o catálogo de
     estágios cometeu horas antes: **sigla e nome são dele; o que é estável é o LIVRO.** */
  if (G("SELECT valor FROM config WHERE chave='edicao_no_nome3'")) return { ajustados: 0 };
  let n = 0;
  for (const e of A("SELECT id, nome, edicao_nome FROM estagio WHERE livro='KIDS 4'")) {
    /* "Antiga" é rótulo meu, da semeadura; ele escreve "Old" */
    const velha = /antig|old/i.test(e.edicao_nome || "");
    R("UPDATE estagio SET nome='Kids 4', edicao_nome=?, edicao_ano=? WHERE id=?",
      velha ? "Old" : "3rd Edition", velha ? 2014 : 2020, e.id);
    n++;
  }
  /* datas e rótulos ditados por ele em 2026-08-10: Kids 4 Old lançado em 2014 e aposentado em 2019;
     3rd Edition em 2020; Kids 2 também 3rd Ed. de 2020; e o W2 corrente é a edição NEW.
     O ano NÃO entra no nome — o nome é só o estágio, e a tela concatena a edição. */
  for (const [livro, nome, edicao, ano] of [
    ["KIDS 2", "Kids 2", "3rd Ed.", 2020],
    ["W2", "W2", "NEW", null],
  ] as any[][]) {
    const e = G("SELECT id FROM estagio WHERE livro=?", livro);
    if (!e) continue;
    R("UPDATE estagio SET nome=?, edicao_nome=?, edicao_ano=? WHERE id=?", nome, edicao, ano, e.id);
    n++;
  }
  R("INSERT OR REPLACE INTO config (chave,valor) VALUES ('edicao_no_nome3',?)", agora());
  if (n) console.log("estágios: " + n + " nome(s) separados da edição (a tela concatena)");
  return { ajustados: n };
}

/* A VIRADA: transforma o que a tela mostrava como saldo em UNIDADES de verdade.
   Roda uma vez. Sem ela, o dia da mudança começaria com estoque zerado — os 43 kits que ele contou
   no caderno em 06/08 sumiriam, porque unidade só nasce de remessa. Cada exemplar recebe o instante
   da contagem que o viu, mais um milissegundo por ordem, para a fila nascer determinística. */
function converterContagemEmUnidades() {
  if (G("SELECT valor FROM config WHERE chave='estoque_por_unidade'")) return { unidades: 0 };
  const ultima = G("SELECT data FROM estoque_evento WHERE tipo='contagem' ORDER BY data DESC, id DESC LIMIT 1");
  const base = (ultima?.data || dataISO(new Date())) + " 08:00:00";
  let unidades = 0;
  for (const it of A("SELECT id, descricao FROM estoque_item WHERE componente=0")) {
    const s = saldoPelaContagem(it.id);
    if (!s || s <= 0) continue;
    for (let i = 0; i < s; i++) {
      const ms = ("00" + (i % 1000)).slice(-3);
      R(`INSERT INTO estoque_unidade (item_id,remessa_id,entrada,origem,momento)
         VALUES (?,NULL,?,'contagem',?)`, it.id, base + "." + ms, agora());
      unidades++;
    }
  }
  R("INSERT OR REPLACE INTO config (chave,valor) VALUES ('estoque_por_unidade',?)", agora());
  console.log("estoque: " + unidades + " unidade(s) criadas a partir da última contagem — o saldo passa a ser contagem de exemplares");
  return { unidades };
}

/* Nome trocado que a auditoria dele pediu para eu procurar: o item do "L. Kids 2" estava batizado
   "LITTLE KIDS 4" — havia DOIS itens com esse nome, e o do Little Kids 2 era o errado. Corrigido
   por CHAVE (o livro vinculado), nunca pelo nome, que é justamente o campo defeituoso. */
function arrumarNomeTrocado() {
  if (G("SELECT valor FROM config WHERE chave='nome_item_lk2'")) return { ok: false };
  const n = R(`UPDATE estoque_item SET descricao='LITTLE KIDS 2'
               WHERE livro='L. Kids 2' AND descricao='LITTLE KIDS 4'`).changes as number;
  R("INSERT OR REPLACE INTO config (chave,valor) VALUES ('nome_item_lk2',?)", agora());
  if (n) console.log("estoque: item do L. Kids 2 estava nomeado LITTLE KIDS 4 — corrigido");
  return { ok: n > 0 };
}

/* Leva a edição que hoje está no estágio para o ITEM ao qual ele se liga. Roda uma vez.
   O Kids 4 é o caso que não fecha sozinho: são DOIS estágios (Old de 2014 e 3rd Edition de 2020)
   apontando para UM item de estoque, porque `ux_estoque_item_livro` só admite um item por livro.
   Aqui vence a edição do estágio ATIVO — e o caso fica registrado no log, porque a saída de
   verdade (dois itens de estoque, um por edição) mexe em índice e em consulta de entrega, e é
   decisão dele, não minha. */
function edicaoParaOItem() {
  if (G("SELECT valor FROM config WHERE chave='edicao_no_item'")) return { itens: 0 };
  let itens = 0, conflitos: string[] = [];
  for (const it of A("SELECT id, descricao FROM estoque_item WHERE edicao_nome IS NULL")) {
    const ligados = A(`SELECT nome, edicao_nome, edicao_ano, status FROM estagio
       WHERE item_estoque_id=? OR livro=(SELECT livro FROM estoque_item WHERE id=?)
       ORDER BY (status='ativo') DESC, id`, it.id, it.id);
    /* "Oficial" foi rótulo MEU na semeadura, para livro que só tem uma edição — não é nome de
       edição de verdade e, concatenado, viraria "TOTS 2 · Oficial" em 22 lugares. Some. */
    const comEdicao = ligados.filter(e => e.edicao_nome && !/^oficial$/i.test(e.edicao_nome));
    if (!comEdicao.length) continue;
    R("UPDATE estoque_item SET edicao_nome=?, edicao_ano=? WHERE id=?",
      comEdicao[0].edicao_nome, comEdicao[0].edicao_ano ?? null, it.id);
    itens++;
    if (comEdicao.length > 1) {
      conflitos.push(it.descricao + " (" + comEdicao.map(e => e.edicao_nome).join(" e ") + ")");
      /* DOIS estágios disputando UM material: é o Kids 4, com a edição Old aposentada em 2019 e a
         3rd Edition em uso. O material fica com a edição do ativo, e o LEGADO se desliga dele —
         edição aposentada não tem estoque, e sem isto os dois apareceriam com o mesmo nome na
         lista, indistinguíveis. A edição do legado continua no próprio estágio. */
      R(`UPDATE estagio SET item_estoque_id=NULL
         WHERE item_estoque_id=? AND status<>'ativo' AND edicao_nome IS NOT NULL`, it.id);
    }
  }
  R("INSERT OR REPLACE INTO config (chave,valor) VALUES ('edicao_no_item',?)", agora());
  console.log("estoque: edição levada para " + itens + " item(ns)");
  if (conflitos.length)
    console.warn("estoque: mais de uma edição para o mesmo material — ficou a do estágio ativo: "
      + conflitos.join(" · ") + ". Para estocar as duas, cada edição precisa do próprio item.");
  return { itens, conflitos };
}

/* Pedido e remessa não têm "vazio diferente de zero": não pedir é pedir zero. As linhas zeradas
   que já existem vieram de ele digitar 0 em tudo que não pediu — trabalho que a tela o obrigava a
   fazer. Apagá-las não muda conta nenhuma (somam zero em qualquer soma) e devolve à grade a
   leitura certa: só aparece o que foi de fato pedido. A contagem NÃO entra aqui — lá zero é
   "conferi e não tem", que é diferente de "não contei". */
function limparZerosDePedido() {
  if (G("SELECT valor FROM config WHERE chave='pedido_zero_limpo'")) return { linhas: 0 };
  const n = R(`DELETE FROM estoque_evento_item WHERE quantidade=0 AND evento_id IN
               (SELECT id FROM estoque_evento WHERE tipo IN ('pedido','remessa'))`).changes as number;
  R("INSERT OR REPLACE INTO config (chave,valor) VALUES ('pedido_zero_limpo',?)", agora());
  if (n) console.log("estoque: " + n + " zero(s) de pedido/remessa limpos — vazio agora já significa zero");
  return { linhas: n };
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
  /* Português 2 (2026-08-10, dele): "é um livro normal da Wizard, tem estágio sim. Começa na lição
     1, vai até a 6 e tem a revisão 1 — literalmente 70 lições no total." 6+1 por capítulo × 10 é
     exatamente o cap7i, e 70 (e não 71) confirma que não tem lição de abertura. */
  ["PORT2","Português 2","Português","Outros Idiomas","Portuguese","cap7i",1,1,1,"ativo","Oficial",null,"Port 2",[],0],
  /* Business Empire (2026-08-10, dele): curso AVULSO de inglês de negócios, que complementa o W —
     BE 2 anda com o W2, BE 4 com o W4. Sem workbook; vem com pasta, como o W2.
     Entram sem livro vinculado: não existem em `livros` ainda, e o vínculo é campo de tela. */
  ["BE2","Business Empire 2","Inglês","Avulsos","Business Empire","cap7",1,1,1,"ativo","Oficial",null,null,[],0],
  ["BE4","Business Empire 4","Inglês","Avulsos","Business Empire","cap7",61,0,2,"ativo","Oficial",null,null,[],0],
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
  /* MODELOS reconciliados pela FORMA (lições por bloco × blocos), NUNCA pelo nome — o nome é dele
     para editar. Casando por nome, renomear "Capítulo de 7" para "Bloco de 7" fazia o boot seguinte
     não achar o modelo e CRIAR OUTRO igual: foi exatamente o que aconteceu em 2026-08-17, e é a
     mesma lição que já custou uma rodada no catálogo de estágios e nos nomes de edição.
     `cap7` e `cap7i` tinham a mesma forma (6×10) e por isso viraram um só, a pedido dele — as duas
     chaves apontam para o mesmo modelo. */
  const mods: Record<string, number> = {};
  const modelo = (nome: string, lpc: number, caps: number) => {
    const m = G("SELECT id FROM estagio_modelo WHERE licoes_por_capitulo=? AND capitulos=? ORDER BY id", lpc, caps);
    return m ? m.id
      : Number(R("INSERT INTO estagio_modelo (nome,licoes_por_capitulo,capitulos) VALUES (?,?,?)", nome, lpc, caps).lastInsertRowid);
  };
  mods["cap11"] = modelo("Bloco de 11", 10, 6);
  mods["cap7"] = mods["cap7i"] = modelo("Bloco de 7", 6, 10);
  /* O catálogo CRESCE depois da primeira semeadura (o Português 2 chegou em 2026-08-10, com o banco
     dele já semeado na véspera), e o critério para saber o que ainda falta oferecer é a VERSÃO do
     catálogo — nunca a sigla.
     Comparar por sigla parecia esperto e estava errado: ele RENOMEIA siglas na tela ("KIDS 4" virou
     "KIDS 4 3rd"), e aí o catálogo não reconhecia mais o próprio estágio e o recriava duplicado.
     Medido no ensaio: 3 inserções onde só o Português 2 devia entrar. Com versão, o que ele
     renomeou, editou ou apagou fica como ele deixou. */
  const CAT_VERSAO = 3;
  const CAT_DESDE: Record<string, number> = { PORT2: 2, BE2: 3, BE4: 3 }; // sem entrada = versão 1
  const jaSemeado = !!G("SELECT valor FROM config WHERE chave='estagios_semeados'");
  const versaoSalva = Number(G("SELECT valor FROM config WHERE chave='estagios_catalogo_versao'")?.valor
    ?? (jaSemeado ? 1 : 0));
  let novos = 0;
  for (const e of CAT_ESTAGIOS) {
    const [sigla, nome, idioma, cat, grupo, mod, licIni, entrada, ordem, status, edNome, edAno, livro, especiais, remind] = e;
    if ((CAT_DESDE[sigla] || 1) <= versaoSalva) continue;
    if (G("SELECT 1 FROM estagio WHERE sigla=?", sigla)) continue;
    /* escala CEFR/GSE nasce ATIVA só em Teens e W: a Wizard não define subnível de criança, e
       outros idiomas não usam a escala. Os valores em si o Vitor preenche à mão. */
    const escala = (cat === "Teens" || cat === "W") ? 1 : 0;
    /* `estagio.livro` tem FK para `livros`: livro que não esteja no catálogo derruba o INSERT, e
       como esta função não corre em transação, ela abortava no meio — metade dos estágios entrava,
       a marca `estagios_semeados` nunca era gravada e todo boot seguinte repetia o erro. Foi o que
       aconteceu com o Pre-Teens em instalação nova. Agora o estágio nasce SEM livro e avisa: um
       vínculo faltando é um campo para preencher na tela, não motivo para o catálogo inteiro
       deixar de existir. */
    let livroOk = livro;
    if (livro && !G("SELECT 1 FROM livros WHERE nome=?", livro)) {
      console.warn("estágios: " + sigla + " ficou sem livro — '" + livro + "' não está no catálogo de livros");
      livroOk = null;
    }
    const item = livroOk ? G("SELECT id FROM estoque_item WHERE livro=?", livroOk) : null;
    /* a semeadura continua trazendo `grupo` na tupla (são 29 linhas de dados, não vale reescrevê-las)
       — ele simplesmente não é mais gravado */
    const r = R(`INSERT INTO estagio (sigla,nome,idioma,categoria,modelo_id,licao_inicial,entrada,
        ordem,escala_ativa,edicao_nome,edicao_ano,status,livro,item_estoque_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      sigla, nome, idioma, cat, mods[mod], licIni, entrada, ordem, escala,
      edNome, edAno, status, livroOk, item?.id ?? null);
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
  R("INSERT OR REPLACE INTO config (chave,valor) VALUES ('estagios_catalogo_versao',?)", String(CAT_VERSAO));
  if (novos) console.log("estágios: catálogo semeado — " + novos + " estágio(s)");
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

/* ===== percurso: abrir e fechar =====
   Toda escrita em `aluno_livro` passa por aqui. São duas funções e nenhuma delas lança: um erro no
   percurso não pode impedir uma matrícula de ser salva nem um livro de ser trocado — a história é
   importante, a operação do balcão é mais. */
/* o mesmo livro pode ter dois estágios (Kids 4 de 2014 e a 3rd Edition): na dúvida, o que está ativo */
/* as duas tabelas de estrutura têm a mesma forma; esta função é a única que escolhe entre elas, e
   por ser lista fechada não há como um nome de tabela vindo de fora entrar numa query */
function tabelaLicao(alvo: string) {
  if (alvo === "modelo") return "estagio_modelo_licao";
  if (alvo === "estagio") return "estagio_licao";
  throw new Error("Alvo inválido: " + alvo);
}
const estagioDoLivro = (livro: string) =>
  G("SELECT id FROM estagio WHERE livro=? ORDER BY (status='ativo') DESC, id", livro)?.id ?? null;

/* `dataInicio` tem TRÊS valores possíveis e os três são diferentes: não passar nada é "abrindo
   agora" (matrícula nova → hoje); passar uma data é essa data; passar `null` é "não se sabe" e fica
   em branco de propósito. Por isso o teste é `=== undefined` e não `??` — com `??` o null viraria
   hoje, e a retomada do histórico gravaria uma data de início inventada em 134 alunos, com o
   vencimento do contrato um ano depois dela. */
/* ===== SITUAÇÃO: uma entrada só, e o percurso se mantém sozinho a partir dela (2026-08-10) =====
   Percurso e histórico de situação diziam a mesma coisa em dois lugares — ele apontou a redundância
   e pediu para juntar. Ficou o HISTÓRICO como único ponto de entrada; `aluno_estagio` continua
   existindo (é ele que sobrevive à troca de estágio e dá o vencimento do contrato), mas agora é
   consequência, não digitação. */
const SIT_ENTRADA = ["Matriculado", "Rematriculado", "Retornado"];
/* situação de saída → estado em que o percurso daquele estágio fica */
const SIT_FECHA: Record<string, string> = {
  Encerrado: "encerrado", Trancado: "trancado", Evadido: "evadido", Cancelado: "cancelado",
};
/* A situação CORRENTE do aluno é a do registro mais recente, com uma exceção que é regra dele:
   *"o retornado é quando o aluno sai do trancamento e volta. Aí o sistema vai colocar rematriculado
   de novo."* Retornado é o FATO (fica no histórico), não o estado — o estado que volta é o que ele
   tinha antes de trancar. Sem isto, quem voltava ficava numa situação que não diz em que curso está. */
function situacaoCorrente(idMatricula: string): string | null {
  const linhas = A(`SELECT situacao, data, id FROM aluno_situacao_historico WHERE id_matricula=?
                    ORDER BY data DESC, id DESC`, idMatricula);
  if (!linhas.length) return null;
  if (linhas[0].situacao !== "Retornado") return linhas[0].situacao;
  const antes = linhas.slice(1).find(l => l.situacao === "Matriculado" || l.situacao === "Rematriculado");
  return antes?.situacao || "Rematriculado";
}
function sincronizarSituacao(idMatricula: string) {
  const s = situacaoCorrente(idMatricula);
  if (s && G("SELECT 1 FROM situacoes WHERE situacao=?", s))
    R("UPDATE alunos SET situacao=? WHERE id_matricula=?", s, idMatricula);
  return s;
}
/* Deriva o percurso de um estágio percorrendo a LINHA DO TEMPO INTEIRA daquele estágio.
   A primeira versão espelhava só o registro que acabara de ser gravado, e isso quebrava ao EDITAR
   um registro antigo: reaplicar "Trancado 15/09" por cima carregava o estágio para trancado, mesmo
   havendo um "Retornado 01/10" depois dele. Medido na tela — o estágio sumia de "em curso".
   Percorrendo tudo em ordem, o estado final é sempre o do último registro, venha ele de onde vier.
   Entrada carimba a data de início (regra dele: "a data de matrícula vai ser a data de início
   daquele curso, automaticamente"); saída fecha com o estado correspondente. */
function sincronizarPercurso(idMatricula: string, livro?: string | null) {
  if (!livro) return;
  const linhas = A(`SELECT situacao, data FROM aluno_situacao_historico
                    WHERE id_matricula=? AND livro=? ORDER BY data, id`, idMatricula, livro);
  if (!linhas.length) return;
  let inicio: string | null = null, fim: string | null = null, estado = "cursando";
  for (const l of linhas) {
    if (SIT_ENTRADA.includes(l.situacao)) { inicio = l.data; fim = null; estado = "cursando"; continue; }
    const e = SIT_FECHA[l.situacao];
    if (e) { estado = e; fim = l.data; }
  }
  /* fechado sem data de entrada conhecida é possível (registro antigo, sem o par de matrícula) —
     o CHECK do banco só exige data_fim, então isto passa */
  if (estado !== "cursando" && !fim) return;
  const alvo = G(`SELECT id FROM aluno_estagio WHERE id_matricula=? AND livro=?
                  ORDER BY (estado='cursando') DESC, data_inicio DESC, id DESC LIMIT 1`, idMatricula, livro);
  if (!alvo) { abrirPercurso(idMatricula, livro, inicio); }
  if (estado === "cursando") {
    R(`UPDATE aluno_estagio SET estado='cursando', data_inicio=?, data_fim=NULL WHERE id=?`,
      inicio, (alvo || G("SELECT id FROM aluno_estagio WHERE id_matricula=? AND livro=? ORDER BY id DESC LIMIT 1", idMatricula, livro))?.id);
    return;
  }
  /* clamp: data_fim nunca antes de data_inicio (CHECK do banco) */
  let f = fim as string;
  if (inicio && f < inicio) f = inicio;
  R(`UPDATE aluno_estagio SET estado=?, data_inicio=?, data_fim=? WHERE id=?`, estado, inicio, f,
    (alvo || G("SELECT id FROM aluno_estagio WHERE id_matricula=? AND livro=? ORDER BY id DESC LIMIT 1", idMatricula, livro))?.id);
}

function abrirPercurso(idMatricula: string, livro: string, dataInicio?: string | null, contratoSeq?: number | null) {
  /* já cursando este livro: não abre outra. O índice único garantiria, mas falhar em silêncio aqui
     é melhor que estourar no meio de um salvamento de matrícula. */
  if (G("SELECT 1 FROM aluno_estagio WHERE id_matricula=? AND livro=? AND estado='cursando'", idMatricula, livro)) return;
  const seq = contratoSeq ?? G("SELECT contrato_seq c FROM aluno_livro WHERE id_matricula=? AND livro=?", idMatricula, livro)?.c ?? null;
  R(`INSERT INTO aluno_estagio (id_matricula,estagio_id,livro,estado,data_inicio,contrato_seq,momento)
     VALUES (?,?,?,'cursando',?,?,?)`,
    idMatricula, estagioDoLivro(livro), livro, dataInicio === undefined ? dataISO(new Date()) : dataInicio, seq, agora());
}
/* Fecha o que está aberto. `data_fim` nunca pode ficar antes de `data_inicio` (CHECK do banco), e
   início no futuro é digitável na tela — daí o clamp, senão uma troca de livro estouraria. */
function fecharPercurso(idMatricula: string, livro: string, estado = "encerrado", data?: string) {
  const linha = G("SELECT id, data_inicio FROM aluno_estagio WHERE id_matricula=? AND livro=? AND estado='cursando'", idMatricula, livro);
  if (!linha) return false;
  let fim = data || dataISO(new Date());
  if (linha.data_inicio && fim < linha.data_inicio) fim = linha.data_inicio;
  R("UPDATE aluno_estagio SET estado=?, data_fim=? WHERE id=?", estado, fim, linha.id);
  return true;
}

/* Retomada do percurso a partir do que o banco já sabe. Roda uma vez só: depois disso o Vitor
   corrige datas e lições à mão, e uma segunda passada desfaria o trabalho dele.
   Duas fontes, nesta ordem:
   1. `aluno_livro` — o que ele cursa hoje, tudo 'cursando';
   2. `aluno_situacao_historico` — livro que ele já não tem mais e cuja situação diz que acabou.
      É a única memória que sobrou dos livros perdidos na troca, e são poucos registros (a coluna
      `livro` só passou a existir em 2026-08-09) — mas o que dá para recuperar, recupera-se.
   A data de início só é preenchida quando ela é DEDUZÍVEL SEM CHUTE. Inventar data aqui seria pior
   que deixar em branco: o contrato vence um ano depois dela, e um vencimento errado é pior que
   vencimento nenhum. */
function semearPercurso() {
  if (G("SELECT valor FROM config WHERE chave='percurso_semeado'")) return { abertos: 0, fechados: 0 };
  const ENTRADA = ["Matriculado", "Rematriculado", "Retornado"];
  const FECHA: Record<string, string> = { Encerrado: "encerrado", Trancado: "trancado", Evadido: "evadido", Cancelado: "cancelado" };
  const hist = A("SELECT * FROM aluno_situacao_historico ORDER BY data");
  const porAluno: Record<string, any[]> = {};
  hist.forEach(h => (porAluno[h.id_matricula] ||= []).push(h));

  function inicioDe(idMatricula: string, livro: string, quantasMatriculas: number): string | null {
    const meus = porAluno[idMatricula] || [];
    /* registro do próprio livro: é o que responde direto, sem ambiguidade */
    const doLivro = meus.filter(h => h.livro === livro && ENTRADA.includes(h.situacao));
    if (doLivro.length) return doLivro[0].data;
    /* aluno de um livro só, com uma entrada só: não há a que outra coisa a data poderia se referir.
       Com dois livros seria adivinhação — e aí fica em branco. */
    if (quantasMatriculas === 1) {
      const entradas = meus.filter(h => ENTRADA.includes(h.situacao));
      if (entradas.length === 1) return entradas[0].data;
    }
    return null;
  }

  let abertos = 0, fechados = 0;
  for (const a of A("SELECT DISTINCT id_matricula FROM aluno_livro")) {
    const mats = A("SELECT * FROM aluno_livro WHERE id_matricula=? ORDER BY contrato_seq, rowid", a.id_matricula);
    for (const m of mats) {
      if (G("SELECT 1 FROM aluno_estagio WHERE id_matricula=? AND livro=? AND estado='cursando'", m.id_matricula, m.livro)) continue;
      abrirPercurso(m.id_matricula, m.livro, inicioDe(m.id_matricula, m.livro, mats.length), m.contrato_seq);
      abertos++;
    }
  }
  /* livros que sumiram: só entram os que a situação declara encerrados E que o aluno realmente não
     cursa mais — se ele ainda tem a matrícula, a linha 'cursando' acima já contou a história. */
  for (const h of hist) {
    if (!h.livro || !FECHA[h.situacao]) continue;
    if (G("SELECT 1 FROM aluno_livro WHERE id_matricula=? AND livro=?", h.id_matricula, h.livro)) continue;
    if (G("SELECT 1 FROM aluno_estagio WHERE id_matricula=? AND livro=? AND data_fim=?", h.id_matricula, h.livro, h.data)) continue;
    const entrada = (porAluno[h.id_matricula] || [])
      .filter(x => x.livro === h.livro && ENTRADA.includes(x.situacao) && x.data <= h.data)[0];
    R(`INSERT INTO aluno_estagio (id_matricula,estagio_id,livro,estado,data_inicio,data_fim,momento)
       VALUES (?,?,?,?,?,?,?)`,
      h.id_matricula, estagioDoLivro(h.livro), h.livro, FECHA[h.situacao], entrada?.data ?? null, h.data, agora());
    fechados++;
  }
  R("INSERT OR REPLACE INTO config (chave,valor) VALUES ('percurso_semeado',?)", agora());
  console.log("percurso: retomado — " + abertos + " em curso, " + fechados + " já encerrado(s)");
  return { abertos, fechados };
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
} catch { console.warn("aviso: há registros de situação duplicados (mesmo aluno/situação/data/estágio) — índice único não aplicado"); }

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
/* instância de ENSAIO não faz backup: `executarBackup` copia o `wizard.db` REAL (o caminho é fixo,
   não segue o WIZ_DB), então o conteúdo sairia certo — mas quem escreve na pasta de backup da escola
   tem de ser o servidor dela, não um teste meu que vai ser derrubado em dez minutos. */
try { // backup diário na subida do servidor (a leitura da config acima já recuperou journal pendente)
  if (ENSAIO) throw new Error("instância de ensaio (WIZ_DB) não escreve na pasta de backup");
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
  abrirPercurso(idMatricula, livro);
}
/* remove a matrícula antiga se não sobrou nenhuma aula nela — sem isso, uma troca de livro (cascata de
   turma ou trocarLivroAluno) deixava um livro "fantasma" vazio na ficha do aluno (aluno só guarda o
   ESTADO ATUAL, não todo livro que já fez). */
function limparMatriculaSeVazia(idMatricula: string, livro: string) {
  if (!G("SELECT 1 FROM aulas WHERE id_matricula=? AND livro=?", idMatricula, livro)) {
    R("DELETE FROM aluno_livro WHERE id_matricula=? AND livro=?", idMatricula, livro);
    /* as aulas mudaram de livro logo acima (cascata de turma): isto é troca, não engano — o livro
       antigo fica no percurso como encerrado em vez de desaparecer sem deixar rastro */
    fecharPercurso(idMatricula, livro, "encerrado");
  }
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
const COLUNAS_FICHA = 22; // colunas estreitas do template impresso — número FIXO, por regra da casa (12 → 22 em 2026-08-18: estavam acabando)

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
/* SALDO, regra nova (2026-08-10): quantas unidades daquele material ainda não saíram.
   Deixou de ser "última contagem + remessas − entregas posteriores" porque a contagem deixou de
   existir: tudo o que entra é registrado exemplar por exemplar, então o saldo é uma contagem de
   linhas, não uma conta com data de corte. E deixa de existir o "null = não sei": agora se sabe. */
function saldoItem(itemId: number): number {
  return G(`SELECT COUNT(*) n FROM estoque_unidade
            WHERE item_id=? AND entrega_id IS NULL AND arquivado IS NULL`, itemId)?.n || 0;
}
/* a fila: o exemplar mais antigo que ainda está na prateleira. "Quem chegou primeiro sai primeiro",
   e o desempate é o `entrada` com milissegundos. */
const proximaUnidade = (itemId: number) =>
  G(`SELECT * FROM estoque_unidade WHERE item_id=? AND entrega_id IS NULL AND arquivado IS NULL
     ORDER BY entrada, id LIMIT 1`, itemId);
/* o próximo número de etiqueta daquele material. Conta os entregues também: o número sai de
   circulação com o livro, e reaproveitá-lo poria duas etiquetas iguais no mundo. */
const proximoNumero = (itemId: number): number =>
  (G("SELECT MAX(numero) m FROM estoque_unidade WHERE item_id=?", itemId)?.m || 0) + 1;
/* A ORDEM DA ETIQUETA TEM DE BATER COM A DA CHEGADA (regra dele): *"um timestamp mais antigo tem
   que ter o número menor... como é que eu vou colocar um timestamp antigo com o número dois e um
   timestamp mais recente com o número um? Isso é inválido."*
   Devolve os pares que se contradizem, do material inteiro — quem lê a fila em ordem de chegada
   deve ver 1, 2, 3. Por ora a tela AVISA e não impede: bloquear a gravação deixaria o campo
   inutilizável enquanto ele estivesse arrumando dois exemplares trocados, porque toda troca passa
   por um estado intermediário inválido. */
function conflitosDeNumero(itemId: number) {
  const us = A(`SELECT id, numero, entrada, codigo FROM estoque_unidade
                WHERE item_id=? AND numero IS NOT NULL ORDER BY entrada, id`, itemId);
  const fora: { numero: number; entrada: string }[] = [];
  for (let i = 1; i < us.length; i++)
    if (us[i].numero < us[i - 1].numero) fora.push({ numero: us[i].numero, entrada: us[i].entrada });
  return fora;
}
/* Numera quem ainda não tem número, na ORDEM DA FILA (que é a ordem de chegada) — o exemplar mais
   antigo do W2 vira o 1, e é o que ele vai escrever na etiqueta.
   Sem marca em `config` de propósito: o `WHERE numero IS NULL` já a torna inerte depois da primeira
   passada, e assim ela também alcança qualquer exemplar que apareça sem número depois. Marca em
   `config` já me travou duas vezes neste módulo — a versão consertada não rodava mais. */
function numerarUnidades() {
  const semNumero = A(`SELECT id, item_id FROM estoque_unidade WHERE numero IS NULL
                       ORDER BY item_id, entrada, id`);
  if (!semNumero.length) return { numeradas: 0 };
  const prox: Record<number, number> = {};
  for (const u of semNumero) {
    if (prox[u.item_id] === undefined) prox[u.item_id] = proximoNumero(u.item_id);
    R("UPDATE estoque_unidade SET numero=? WHERE id=?", prox[u.item_id]++, u.id);
  }
  console.log("estoque: " + semNumero.length + " exemplar(es) numerados (número da etiqueta)");
  return { numeradas: semNumero.length };
}

/* regra ANTIGA, preservada só para a virada: é ela que diz quantas unidades criar a partir do que a
   tela mostrava até aqui. Depois da conversão ninguém mais a chama. */
function saldoPelaContagem(itemId: number): number | null {
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
/* 'HH:MM' ou nada. Vazio não é erro: é a entrega cuja hora ninguém sabe — o CHECK da coluna aceita
   a nula, e é a tela que oferece o campo em branco. Formato conferido com o mesmo rigor de
   `registrarPonto` (o GLOB da coluna deixaria passar 29:59). */
function horaEntrega(hora: any): string | null {
  if (hora == null || hora === "") return null;
  const h = String(hora).trim().slice(0, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(h)) throw new Error("Hora inválida: use HH:MM.");
  return h;
}
/* o instante do exemplar que saiu, no formato de `estoque_unidade.saida`. Data e hora vêm da
   entrega, nunca de um relógio próprio: eram dois carimbos para um fato só. */
const instanteSaida = (data: string | null, hora: string | null) =>
  data ? (hora ? data + " " + hora : data) : null;

/* Entregas pelo ponto de vista da MATRÍCULA: toda matrícula ativa precisa do livro dela, e a
   ausência de linha em entrega_material é o que significa "ainda não recebeu". É a lista que
   responde "quem está sem o livro na mão" — o caderno de papel nunca deu isso.
   LEFT JOIN em estoque_item pelo livro: matrícula em livro que não tem item de estoque (Kids Esp 1,
   Port 2) aparece assim mesmo, com item nulo, em vez de sumir da lista. */
function listaEntregas() {
  return A(`SELECT al.id_matricula, al.livro, a.nome, a.situacao,
                   e.id AS entrega_id, e.data, e.hora, e.deduzida, e.item_id, e.devolvida,
                   i.id AS item_livro_id, i.descricao AS item_desc
            FROM aluno_livro al
            JOIN alunos a ON a.id_matricula=al.id_matricula
            JOIN situacoes s ON s.situacao=a.situacao AND s.ativa=1
            LEFT JOIN entrega_material e ON e.id_matricula=al.id_matricula AND e.livro=al.livro
            LEFT JOIN estoque_item i ON i.livro=al.livro
            ORDER BY a.nome`).map(r => ({
    idMatricula: r.id_matricula, livro: r.livro, nome: r.nome, situacao: r.situacao,
    entregaId: r.entrega_id ?? null, data: r.data ?? null, hora: r.hora ?? null,
    deduzida: r.deduzida === 1,
    /* DEVOLVIDA (2026-08-17): a entrega continua na lista — ela aconteceu —, só que marcada. A tela
       mostra a pílula riscada e o aluno volta a contar como quem está sem o material. */
    devolvida: r.devolvida ?? null,
    /* o histórico vem SEMPRE, não só quando o material está devolvido agora: "este aluno já
       devolveu uma vez e recebeu outro" é informação do balcão, e ela desapareceria da tela no
       instante em que ele recebe o exemplar novo. Uma busca indexada por entrega, ao lado da que
       já existe para a unidade. */
    devolucoes: A(`SELECT data, hora, motivo, unidade_id FROM devolucao_material
                   WHERE id_matricula=? AND livro=? ORDER BY data DESC, id DESC`,
                  r.id_matricula, r.livro)
      .map(d => ({ data: d.data, hora: d.hora || null, motivo: d.motivo || "",
                   unidadeId: d.unidade_id ?? null })),
    itemId: r.item_id ?? r.item_livro_id ?? null, itemDesc: r.item_desc ?? null,
    /* QUAL exemplar saiu: é o que liga a entrega à etiqueta física. Entrega deduzida das matrículas
       antigas não tem unidade — ninguém registrou qual livro daquela pilha foi para a mão de quem. */
    unidade: r.entrega_id
      ? (() => {
          const u = G("SELECT id, codigo, entrada, numero FROM estoque_unidade WHERE entrega_id=?", r.entrega_id);
          return u ? { id: u.id, codigo: u.codigo || "", entrada: u.entrada, numero: u.numero ?? null } : null;
        })()
      : null,
  }));
}
/* ===== QUEM ESTÁ ESPERANDO MATERIAL (2026-08-17) =====
   Pedido dele: *"notificação quando a remessa chega para o aluno pendente"*.
   ESPERANDO é o aluno ATIVO cuja matrícula não tem o livro na mão. São dois casos, e os dois
   contam:
   - matrícula SEM linha em `entrega_material` — nunca recebeu (é a matrícula feita depois da
     semeadura, quando a caixa ainda não tinha chegado);
   - entrega com `devolvida` preenchida — recebeu, devolveu, e está sem de novo.
   Aluno inativo não entra: `situacoes.ativa=1` é o mesmo filtro de `listaEntregas`, e quem cancelou
   não está esperando nada. Estágio sem material cadastrado também não — não há o que chegar. */
function aguardandoDoItem(itemId: number) {
  return A(`SELECT al.id_matricula, al.livro, a.nome
            FROM aluno_livro al
            JOIN alunos a ON a.id_matricula=al.id_matricula
            JOIN situacoes s ON s.situacao=a.situacao AND s.ativa=1
            JOIN estoque_item i ON i.livro=al.livro AND i.arquivado IS NULL
            LEFT JOIN entrega_material e ON e.id_matricula=al.id_matricula AND e.livro=al.livro
            WHERE i.id=? AND (e.id IS NULL OR e.devolvida IS NOT NULL)
            ORDER BY a.nome`, itemId)
    .map(r => ({ idMatricula: r.id_matricula, livro: r.livro, nome: r.nome }));
}
/* O AVISO é o cruzamento de duas listas: quem espera e o que tem na prateleira. Um aluno esperando
   um material que não chegou não é aviso nenhum — é a situação normal de quem acabou de se
   matricular. O que merece a tela piscando é *"chegou o livro DELE"*: saldo > 0 com gente na fila.
   `podem` é o que de fato dá para entregar hoje — não adianta anunciar 5 esperando com 2 na
   prateleira e mandar a recepção descobrir sozinha que só dois saem. */
function avisosDeChegada() {
  const itens: any[] = [];
  for (const i of A(`SELECT id, descricao, livro FROM estoque_item
                     WHERE arquivado IS NULL AND livro IS NOT NULL`)) {
    const saldo = saldoItem(i.id);
    if (saldo <= 0) continue;
    const esperando = aguardandoDoItem(i.id);
    if (!esperando.length) continue;
    itens.push({ itemId: i.id, descricao: i.descricao, livro: i.livro, saldo,
      esperando, podem: Math.min(saldo, esperando.length) });
  }
  itens.sort((a, b) => b.podem - a.podem || a.descricao.localeCompare(b.descricao, "pt"));
  return { itens,
    /* o número do sino conta ALUNOS ATENDÍVEIS, não matrículas esperando: é o que a recepção pode
       resolver agora, e é a promessa que o aviso faz quando ela clicar nele */
    total: itens.reduce((s, i) => s + i.podem, 0),
    alunos: new Set(itens.flatMap(i => i.esperando.map((e: any) => e.idMatricula))).size };
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
/* O QUE AINDA FALTA CHEGAR DE UM PEDIDO, item a item.
   Regra dele (2026-08-10): "quando a gente faz um pedido, quando ele vem, é uma remessa. Se eu for
   lançar uma remessa, eu tô confirmando que esse pedido chegou." Então a remessa aponta para o
   pedido, e o que falta é o pedido menos o que as remessas dele já trouxeram — nunca negativo:
   caixa que traz a mais não gera pendência ao contrário. */
function faltaDoPedido(pedidoId: number): Record<number, number> {
  const falta: Record<number, number> = {};
  for (const r of A("SELECT item_id, quantidade FROM estoque_evento_item WHERE evento_id=?", pedidoId))
    falta[r.item_id] = r.quantidade;
  for (const r of A(`SELECT ei.item_id, ei.quantidade FROM estoque_evento_item ei
      JOIN estoque_evento ev ON ev.id=ei.evento_id
      WHERE ev.tipo='remessa' AND ev.pedido_id=?`, pedidoId))
    if (falta[r.item_id] != null) falta[r.item_id] = Math.max(0, falta[r.item_id] - r.quantidade);
  return falta;
}
/* DOIS estados, não três: aguardando ou recebido. O "chegou em parte" saiu a pedido dele — a
   chegada é confirmada de uma vez, no botão do pedido, e o que veio a menos se corrige no número.
   `totalFalta` continua existindo porque é ele que diz o que ainda entra em unidade. */
function situacaoPedido(pedidoId: number) {
  const falta = faltaDoPedido(pedidoId);
  const pedido = A("SELECT item_id, quantidade FROM estoque_evento_item WHERE evento_id=?", pedidoId);
  const totalPedido = pedido.reduce((s, r) => s + r.quantidade, 0);
  const totalFalta = Object.values(falta).reduce((s: number, q) => s + (q as number), 0);
  const remessas = A("SELECT id, data FROM estoque_evento WHERE tipo='remessa' AND pedido_id=? ORDER BY data", pedidoId);
  const estado = remessas.length ? "recebido" : "aguardando";
  return { estado, totalPedido, totalFalta, falta, remessas };
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
/* ===== QUARTA TRAVA: SÓ A ESTAÇÃO DA RECEPÇÃO FECHA O DIA (2026-08-18) =====
   Custou 16 faltas erradas para aparecer. Em 17/08 o laptop foi aberto com uma cópia atrasada do
   banco: o dia tinha movimento (trava 3 passou), e o fecho marcou falta em 16 alunos que a recepção
   havia lançado como PRESENTES — porque naquela cópia o lançamento dela não existia.
   As três travas anteriores cuidam de QUANDO fechar; nenhuma cuidava de QUEM fecha.
   O critério é o hostname da máquina que SERVE (o fecho roda no boot, antes de qualquer cliente —
   por isso `estacaoDoIP`, que depende do IP de quem pede, não serve aqui).
   Comparação por PREFIXO porque o Windows trunca o nome em 15 caracteres em vários lugares.
   Valor VAZIO mantém o comportamento antigo (fecha em qualquer máquina): instalação nova não pode
   perder o recurso por falta de configuração — quem tem duas estações é que precisa da trava. */
function estacaoFechaODia(): { pode: boolean; alvo: string; aqui: string } {
  const alvo = String(G("SELECT valor FROM config WHERE chave='fecho_estacao'")?.valor || "").trim();
  let aqui = ""; try { aqui = Deno.hostname(); } catch { /* sem permissão: não trava nada */ }
  if (!alvo) return { pode: true, alvo: "", aqui };
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  return { pode: norm(aqui).startsWith(norm(alvo)) || norm(alvo).startsWith(norm(aqui)), alvo, aqui };
}
function aplicarFaltasAutomaticas() {
  const q = estacaoFechaODia();
  if (!q.pode) {
    console.log(`fecho do dia: pulado — quem fecha é "${q.alvo}" e esta máquina é "${q.aqui}".`);
    return;
  }
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
/* depois da semeadura: converte os materiais em kit e limpa os zeros que a tela antiga obrigava a
   digitar. As duas rodam uma vez só e não tocam em quantidade nenhuma. */
try { migrarMaterialParaKit(); } catch (e) { console.warn("conversão de material em kit falhou (segue o baile):", e); }
try { comporKits(); } catch (e) { console.warn("composição dos kits falhou (segue o baile):", e); }
try { limparZerosDePedido(); } catch (e) { console.warn("limpeza dos zeros de pedido falhou (segue o baile):", e); }
try { arrumarNomesDeEdicao(); } catch (e) { console.warn("ajuste dos nomes de edição falhou (segue o baile):", e); }
/* depois de os nomes estarem separados da edição: é essa edição que vai para o item */
try { edicaoParaOItem(); } catch (e) { console.warn("edição para o item falhou (segue o baile):", e); }
try { arrumarNomeTrocado(); } catch (e) { console.warn("correção do nome trocado falhou (segue o baile):", e); }
/* por último no estoque: precisa dos itens já classificados para saber quem tem saldo a converter */
try { converterContagemEmUnidades(); } catch (e) { console.warn("conversão para unidades falhou (segue o baile):", e); }
/* depois de existirem todas as unidades: numera na ordem da fila quem ainda não tem etiqueta */
try { numerarUnidades(); } catch (e) { console.warn("numeração das unidades falhou (segue o baile):", e); }
/* e leva a edição que estava no material para o exemplar */
try { migrarEdicoesParaUnidade(); } catch (e) { console.warn("migração das edições falhou (segue o baile):", e); }
try { semearEstagios(); } catch (e) { console.warn("semeadura dos estágios falhou (segue o baile):", e); }
try { semearCalendario(); } catch (e) { console.warn("semeadura do calendário falhou (segue o baile):", e); }
try { semearFontes(); } catch (e) { console.warn("semeadura das fontes falhou (segue o baile):", e); }
try { migrarTrechos(); } catch (e) { console.warn("migração dos trechos falhou (segue o baile):", e); }
/* CORREÇÃO com marca própria: a Páscoa faltava na primeira semeadura, e a marca
   `calendario_semeado` já gravada impede `semearCalendario` de rodar de novo — arrumar a lista não
   basta, é a lição que este módulo já cobrou duas vezes. Guarda por `offset_pascoa`, não por nome:
   ele renomeia marcação livremente. */
try {
  if (!G("SELECT 1 FROM config WHERE chave='calendario_pascoa'")) {
    if (G("SELECT 1 FROM config WHERE chave='calendario_semeado'")
      && !G("SELECT 1 FROM calendario_marcacao WHERE repeticao='pascoa' AND offset_pascoa=0"))
      R(`INSERT INTO calendario_marcacao (nome,tipo,ambito,repeticao,offset_pascoa,duracao,fecha,cor,momento)
         VALUES ('Páscoa','feriado','nacional','pascoa',0,1,1,'#B3261E',?)`, agora());
    R("INSERT INTO config (chave,valor) VALUES ('calendario_pascoa',?)", agora());
  }
} catch (e) { console.warn("correção da Páscoa falhou (segue o baile):", e); }
/* depois de existirem as lições: dá sigla a quem ainda não tem */
try { siglarLicoes(); } catch (e) { console.warn("siglas das lições falharam (segue o baile):", e); }
try { numerarContratos(); } catch (e) { console.warn("numeração de contratos falhou (segue o baile):", e); }
/* depois dos contratos: o percurso copia `contrato_seq`, que a linha acima acabou de preencher */
try { semearPercurso(); } catch (e) { console.warn("retomada do percurso falhou (segue o baile):", e); }

/* ===== API (mesmo contrato do painel GAS) ===== */
const api: Record<string, (a: any) => unknown> = {
  getDominios() {
    const horariosPorDia: Record<string, string[]> = {};
    A("SELECT ha.dia,ha.hora FROM horario_ativo ha JOIN dias d ON d.nome=ha.dia WHERE ha.ativo=1 ORDER BY d.ordem,ha.hora")
      .forEach(r => (horariosPorDia[r.dia] = horariosPorDia[r.dia] || []).push(r.hora));
    return { situacoes: A("SELECT situacao, ativa FROM situacoes").map(r => ({ situacao: r.situacao, ativa: r.ativa === 1 })),
      modalidades: [...new Set(A("SELECT tipo FROM prioridade").map(r => String(r.tipo).replace(/^Vip\s+/i, "")))],
      dias: Object.keys(horariosPorDia), horariosPorDia,
      /* `saldo` vem junto para a tela de Alunos poder dizer, na hora de matricular, quantas unidades
         daquele material existem na prateleira — sem obrigar a página a carregar o estoque inteiro
         só por causa de um número. NULO quando o estágio não tem item de estoque (Kids Esp 1,
         Port 2): "não sei" é diferente de "zero". */
      livros: A(`SELECT l.*, i.id AS item_id,
                   (SELECT COUNT(*) FROM estoque_unidade u
                    WHERE u.item_id=i.id AND u.entrega_id IS NULL) AS saldo
                 FROM livros l LEFT JOIN estoque_item i ON i.livro=l.nome
                 ORDER BY l.ordem`)
        .map(r => ({ nome: r.nome, tipoPadrao: r.tipo_padrao, kids: r.kids === 1,
          tipoFixo: r.tipo_fixo === 1, categoria: categoriaLivro(r.nome),
          saldo: r.item_id ? (r.saldo ?? 0) : null })),
      professores: A("SELECT * FROM funcionarios").map(r => ({ id: r.id, nomeCompleto: r.nome_completo, nome: r.nome })),
      turmas: getTurmas() };
  },
  getAlunos: () => A("SELECT * FROM v_alunos").map(r => ({ id: r.id_matricula, nome: r.nome, situacao: r.situacao, status: r.status })),
  /* Existe este ID? Consulta enxuta para a tela dizer "NOVO" enquanto se digita.
     Vai ao banco em vez de olhar a lista que o cliente já tem em memória porque a recepção e a sala
     usam máquinas diferentes: um aluno cadastrado agora na outra ponta não está nessa lista. */
  alunoExiste: ({ id }: any) => {
    const a = id ? G("SELECT nome, situacao FROM alunos WHERE id_matricula=?", String(id).trim()) : null;
    return { existe: !!a, nome: a?.nome || null, situacao: a?.situacao || null };
  },
  salvarAluno(a) {
    if (!a?.id || !a?.nome) throw new Error("Nome e ID são obrigatórios.");
    if (!G("SELECT 1 FROM situacoes WHERE situacao=?", a.situacao)) throw new Error("Situação inválida: " + a.situacao);
    const existe = G("SELECT 1 FROM alunos WHERE id_matricula=?", a.id);
    existe ? R("UPDATE alunos SET nome=?,situacao=? WHERE id_matricula=?", a.nome, a.situacao, a.id)
           : R("INSERT INTO alunos VALUES (?,?,?)", a.id, a.nome, a.situacao);
    return { ok: true, criado: !existe, status: G("SELECT status FROM v_alunos WHERE id_matricula=?", a.id)?.status };
  },
  excluirAluno: (id) => ({ ok: true, aulasRemovidas: R("DELETE FROM aulas WHERE id_matricula=?", id).changes, aluno: R("DELETE FROM alunos WHERE id_matricula=?", id).changes }),

  /* TROCAR O ID DA MATRÍCULA.
     O ID é a chave do aluno e aparece em dez tabelas; as FKs são `ON DELETE CASCADE`, não
     `ON UPDATE CASCADE`, então o SQLite não propaga sozinho. A troca é feita à mão, em transação,
     com as FKs desligadas — desligar é necessário porque, no meio do caminho, os filhos apontam
     para um pai que ainda não existe (ou já não existe).
     Existe porque digitar o ID errado no cadastro acontece, e hoje a única saída era apagar o aluno
     e refazer tudo. A tela põe isto atrás de um botão pequeno e de um popover, de propósito: é
     mudança de chave, não pode estar a um clique de distância. */
  trocarIdMatricula({ de, para }: any) {
    const novo = String(para ?? "").trim();
    if (!de || !novo) throw new Error("Informe o ID atual e o novo.");
    if (de === novo) return { ok: true, trocou: false };
    if (!G("SELECT 1 FROM alunos WHERE id_matricula=?", de)) throw new Error("Aluno não encontrado.");
    if (G("SELECT 1 FROM alunos WHERE id_matricula=?", novo))
      throw new Error("Já existe um aluno com o ID " + novo + ".");
    /* `alunos` por último: as outras apontam para ela, e trocar o pai antes deixaria os filhos
       órfãos por um instante — com FK desligada não estoura, mas a ordem certa mantém o banco
       coerente mesmo se algo falhar no meio e o ROLLBACK não chegar a rodar. */
    const TABELAS = ["aulas", "aluno_situacao_historico", "presenca", "diario", "encontro_avulso",
      "aluno_livro", "aluno_horario_historico", "entrega_material", "aluno_estagio", "alunos"];
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("BEGIN");
    const movidas: Record<string, number> = {};
    try {
      for (const t of TABELAS)
        movidas[t] = R(`UPDATE ${t} SET id_matricula=? WHERE id_matricula=?`, novo, de).changes as number;
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    } finally {
      db.exec("PRAGMA foreign_keys=ON");
    }
    /* confere na saída: FK quebrada aqui seria silenciosa e só apareceria semanas depois */
    const quebradas = A("PRAGMA foreign_key_check").length;
    return { ok: true, trocou: true, novo, movidas, quebradas };
  },

  /* ===== matrículas em livro (fonte da verdade de modalidade/VIP/tipo de encontro) ===== */
  /* ordenado pelo contrato: a lista passa a contar a história do aluno na ordem em que aconteceu */
  getMatriculasAluno: (id) => A("SELECT * FROM aluno_livro WHERE id_matricula=? ORDER BY contrato_seq, rowid", id).map(r => {
    /* resumo do percurso junto da matrícula, e não numa chamada à parte: o cartão é desenhado por
       `recarregarMatriculas`, que roda ANTES dos históricos — buscar em separado faria o cartão
       nascer sem o dado e só preencher depois (ou pior, ficar com o do aluno anterior). */
    /* o em curso primeiro, mas o fechado também serve: matrícula que ainda existe com o percurso
       encerrado é um estado real (encerrou o livro e a matrícula não saiu ainda), e sem esta linha
       o cartão ficava mudo justamente aí — o silêncio não distingue "não sei" de "acabou". */
    const pc = G(`SELECT ae.data_inicio, ae.data_fim, ae.estado, ae.licao_atual,
                         date(ae.data_inicio,'+1 year') vence, ae.estagio_id
                  FROM aluno_estagio ae WHERE ae.id_matricula=? AND ae.livro=?
                  ORDER BY (ae.estado='cursando') DESC, ae.data_inicio DESC LIMIT 1`, id, r.livro);
    const m = pc?.estagio_id
      ? G(`SELECT em.licoes_por_capitulo l, em.capitulos c,
                  (SELECT COUNT(*) FROM estagio_licao_extra WHERE estagio_id=e.id) x
           FROM estagio e JOIN estagio_modelo em ON em.id=e.modelo_id WHERE e.id=?`, pc.estagio_id)
      : null;
    return {
      livro: r.livro, modalidade: r.modalidade, vip: r.vip === 1, tipoEncontro: r.tipo_encontro,
      contratoSeq: r.contrato_seq, contrato: r.contrato_seq ? id + "/" + r.contrato_seq : null,
      percurso: pc ? {
        estado: pc.estado, dataInicio: pc.data_inicio, dataFim: pc.data_fim,
        licaoAtual: pc.licao_atual,
        vence: pc.data_inicio ? pc.vence : null,
        totalLicoes: m ? m.l * m.c + m.c + m.x : null,
      } : null,
    };
  }),
  salvarMatricula({ idMatricula, livro, modalidade, vip, tipoEncontro, confirmado }: any) {
    if (!idMatricula || !livro) throw new Error("Aluno e estágio são obrigatórios.");
    if (!G("SELECT 1 FROM alunos WHERE id_matricula=?", idMatricula)) throw new Error("Aluno não encontrado.");
    const lv = G("SELECT * FROM livros WHERE nome=?", livro); if (!lv) throw new Error("Estágio inválido: " + livro);
    let mod = modalidade || lv.tipo_padrao;
    if (lv.tipo_fixo === 1) mod = lv.tipo_padrao; // TOTS/L. Kids: modalidade travada
    /* UM ESTÁGIO POR IDIOMA (regra dele, 2026-08-10): *"um aluno não pode fazer dois estágios do
       mesmo idioma ao mesmo tempo, não tem sentido. Ele precisa encerrar o mais antigo para fazer
       um posterior."* A Rafaela com inglês + espanhol continua valendo: idiomas diferentes.
       O idioma vem do ESTÁGIO vinculado ao livro; livro sem estágio (o "Kids Esp 1", adaptação
       dele) não trava nada — não dá para afirmar o idioma de algo que não está cadastrado. */
    const idiomaNovo = G("SELECT idioma FROM estagio WHERE livro=? ORDER BY (status='ativo') DESC, id", livro)?.idioma;
    if (idiomaNovo && !confirmado) {
      const conflito = A(`SELECT al.livro, e.idioma FROM aluno_livro al
          JOIN estagio e ON e.livro=al.livro
          WHERE al.id_matricula=? AND al.livro<>? AND e.idioma=?`, idMatricula, livro, idiomaNovo)[0];
      if (conflito) return { precisaConfirmar: true, motivo: "idioma",
        livroEmCurso: conflito.livro, idioma: idiomaNovo,
        texto: "Este aluno já está em " + conflito.livro + ", que também é " + idiomaNovo
          + ". Na Wizard não se faz dois estágios do mesmo idioma ao mesmo tempo — o anterior "
          + "precisa ser encerrado antes." };
    }
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
    abrirPercurso(idMatricula, livro, undefined, seq); // sem data explícita = começa hoje
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
    /* Remover matrícula tem DOIS significados e só os dados dizem qual é: se o aluno já teve
       presença lançada neste livro, ele cursou de verdade e o percurso é fechado — a história não
       se apaga. Se nunca houve lançamento nenhum, a matrícula foi engano e a linha some junto,
       senão a ficha do aluno acumularia livro fantasma (o mesmo defeito que `limparMatriculaSeVazia`
       existe para evitar). A presença sobrevive à remoção porque `presenca.livro` é texto solto. */
    const cursouDeVerdade = !!G("SELECT 1 FROM presenca WHERE id_matricula=? AND livro=?", idMatricula, livro);
    const aulasRemovidas = R("DELETE FROM aulas WHERE id_matricula=? AND livro=?", idMatricula, livro).changes;
    const removida = R("DELETE FROM aluno_livro WHERE id_matricula=? AND livro=?", idMatricula, livro).changes as number > 0;
    if (cursouDeVerdade) fecharPercurso(idMatricula, livro, "encerrado");
    else R("DELETE FROM aluno_estagio WHERE id_matricula=? AND livro=? AND estado='cursando'", idMatricula, livro);
    return { ok: true, aulasRemovidas, removida, percursoMantido: cursouDeVerdade };
  },
  /* troca o livro de UMA matrícula do aluno (ex.: terminou TOTS 6, avançou pra L. Kids 2): a nova
     matrícula herda modalidade/vip/tipo_encontro, a agenda (dias/horas/professores) migra junto, e a
     matrícula antiga é removida — o aluno só guarda o livro ATUAL, não todo livro que já fez. */
  trocarLivroAluno({ idMatricula, livroAntigo, livroNovo }: any) {
    if (!idMatricula || !livroAntigo || !livroNovo) throw new Error("Aluno, estágio atual e estágio novo são obrigatórios.");
    if (livroAntigo === livroNovo) return { ok: true, aulasMovidas: 0 };
    const antiga = getMatricula(idMatricula, livroAntigo); if (!antiga) throw new Error("Matrícula em " + livroAntigo + " não encontrada.");
    if (G("SELECT 1 FROM aluno_livro WHERE id_matricula=? AND livro=?", idMatricula, livroNovo)) throw new Error("Aluno já está matriculado em " + livroNovo + " — remova uma das duas matrículas antes.");
    const lvNovo = G("SELECT * FROM livros WHERE nome=?", livroNovo); if (!lvNovo) throw new Error("Estágio inválido: " + livroNovo);
    let mod = antiga.modalidade;
    if (lvNovo.tipo_fixo === 1) mod = lvNovo.tipo_padrao; // TOTS/L. Kids: modalidade travada
    /* trocar de livro é um vínculo NOVO, logo um contrato novo — sem isto a matrícula nascia com a
       pílula "2068/—" e o percurso dela ficava sem contrato nenhum. O vínculo antigo guarda o
       número dele, que continua valendo para a história. */
    const seqNovo = (G("SELECT MAX(contrato_seq) m FROM aluno_livro WHERE id_matricula=?", idMatricula)?.m || 0) + 1;
    R("INSERT INTO aluno_livro (id_matricula, livro, modalidade, vip, tipo_encontro, contrato_seq) VALUES (?,?,?,?,?,?)", idMatricula, livroNovo, mod, antiga.vip, antiga.tipo_encontro, seqNovo);
    const aulasMovidas = R("UPDATE aulas SET livro=? WHERE id_matricula=? AND livro=?", livroNovo, idMatricula, livroAntigo).changes;
    R("DELETE FROM aluno_livro WHERE id_matricula=? AND livro=?", idMatricula, livroAntigo);
    /* ESTE é o caso que motivou a tabela: até aqui, trocar de livro apagava a linha antiga e o aluno
       perdia a prova de ter feito o livro anterior. Agora ela fecha e o novo abre — a troca vira
       duas linhas do percurso em vez de uma substituição. */
    const fechou = fecharPercurso(idMatricula, livroAntigo, "encerrado");
    abrirPercurso(idMatricula, livroNovo);
    return { ok: true, aulasMovidas, modalidade: mod, percursoFechado: fechou };
  },

  /* ===== histórico de situação (linha do tempo manual: matrícula/rematrícula/etc por data) ===== */
  /* mais recente primeiro: a pergunta que se faz olhando esta lista é "em que pé ele está", e a
     resposta é sempre a última linha. Livro desempata registros do mesmo dia. */
  /* Cada linha carrega o que o cartão de Percurso mostrava — contrato, "em curso", vencimento —
     porque os dois viraram um só. O percurso continua no banco, mas a tela é esta. */
  getHistoricoAluno: (id) => {
    /* "em curso" e o vencimento descrevem o ESTADO DE HOJE daquele estágio, não cada registro da
       linha do tempo. Como a lista vem do mais recente para o mais antigo, só a PRIMEIRA linha de
       cada estágio os recebe — sem isto a linha de "Trancado" também dizia "em curso", que é o
       contrário do que ela conta. O contrato, esse, vale para todas: é do vínculo, não do momento. */
    const jaVisto = new Set<string>();
    return A("SELECT * FROM aluno_situacao_historico WHERE id_matricula=? ORDER BY data DESC, id DESC", id)
      .map(r => {
        const pc = r.livro ? G(`SELECT estado, data_inicio, contrato_seq,
                date(data_inicio,'+1 year') AS vence
              FROM aluno_estagio WHERE id_matricula=? AND livro=?
              ORDER BY (estado='cursando') DESC, data_inicio DESC LIMIT 1`, id, r.livro) : null;
        const primeira = !!r.livro && !jaVisto.has(r.livro);
        if (r.livro) jaVisto.add(r.livro);
        return { id: r.id, situacao: r.situacao, data: r.data, livro: r.livro || null,
          emCurso: primeira && pc?.estado === "cursando",
          contrato: pc?.contrato_seq ? id + "/" + pc.contrato_seq : null,
          /* vencimento só do que está em curso: contrato encerrado não vence, já acabou */
          vence: primeira && pc?.estado === "cursando" && pc?.data_inicio ? pc.vence : null };
      });
  },
  salvarHistoricoAluno({ idMatricula, situacao, data, livro }: any) {
    if (!idMatricula || !situacao || !data) throw new Error("Situação e data são obrigatórias.");
    if (!G("SELECT 1 FROM situacoes WHERE situacao=?", situacao)) throw new Error("Situação inválida: " + situacao);
    /* o livro é opcional (registro geral do aluno), mas se vier tem de ser um livro em que ele
       esteve matriculado — senão a pílula do histórico apontaria para um curso que nunca existiu.
       Aceita também livro de matrícula JÁ ENCERRADA, por isso a checagem é em `livros` e não em
       `aluno_livro`: quem encerrou o W2 e foi para o W4 não tem mais a linha do W2, e ainda assim
       precisa poder registrar "Encerrado · W2". */
    if (livro && !G("SELECT 1 FROM livros WHERE nome=?", livro)) throw new Error("Estágio inválido: " + livro);
    R("INSERT INTO aluno_situacao_historico (id_matricula,situacao,data,livro) VALUES (?,?,?,?)",
      idMatricula, situacao, data, livro || null);
    /* o registro novo manda no resto: a situação corrente do aluno (e daí o status) e o percurso
       daquele estágio se ajustam sozinhos — é o que substituiu a digitação em dois lugares */
    sincronizarPercurso(idMatricula, livro);
    const corrente = sincronizarSituacao(idMatricula);
    return { ok: true, situacaoCorrente: corrente,
      status: G("SELECT status FROM v_alunos WHERE id_matricula=?", idMatricula)?.status,
      /* avisa quando "Retornado" resolveu para outra coisa, senão a tela pareceria ter ignorado */
      resolvido: situacao === "Retornado" && corrente !== "Retornado" ? corrente : null };
  },
  /* editar o registro em vez de apagar e refazer: errar a data ou a situação é comum, e refazer
     perderia a ordem na lista */
  editarHistoricoAluno({ id, situacao, data, livro }: any) {
    const at = G("SELECT * FROM aluno_situacao_historico WHERE id=?", id);
    if (!at) throw new Error("Registro não encontrado.");
    if (situacao && !G("SELECT 1 FROM situacoes WHERE situacao=?", situacao)) throw new Error("Situação inválida: " + situacao);
    if (livro && !G("SELECT 1 FROM livros WHERE nome=?", livro)) throw new Error("Estágio inválido: " + livro);
    const nova = situacao || at.situacao, nd = data || at.data;
    const nl = livro === undefined ? at.livro : (livro || null);
    R("UPDATE aluno_situacao_historico SET situacao=?, data=?, livro=? WHERE id=?", nova, nd, nl, id);
    /* os DOIS estágios: se a edição mudou o estágio do registro, o antigo também precisa ser
       recalculado — senão ele fica com um estado que nenhum registro sustenta mais */
    sincronizarPercurso(at.id_matricula, nl);
    if (at.livro && at.livro !== nl) sincronizarPercurso(at.id_matricula, at.livro);
    const corrente = sincronizarSituacao(at.id_matricula);
    return { ok: true, situacaoCorrente: corrente,
      status: G("SELECT status FROM v_alunos WHERE id_matricula=?", at.id_matricula)?.status };
  },
  excluirHistoricoAluno: (id) => {
    const at = G("SELECT id_matricula, livro FROM aluno_situacao_historico WHERE id=?", id);
    const ok = R("DELETE FROM aluno_situacao_historico WHERE id=?", id).changes > 0;
    /* apagar também muda o percurso: o estado passa a ser o do último registro que sobrou */
    if (at) sincronizarPercurso(at.id_matricula, at.livro);
    /* apagar um registro pode mudar qual é o mais recente — a situação corrente tem de acompanhar */
    const corrente = at ? sincronizarSituacao(at.id_matricula) : null;
    return { ok, situacaoCorrente: corrente,
      status: at ? G("SELECT status FROM v_alunos WHERE id_matricula=?", at.id_matricula)?.status : null };
  },

  getAulasAluno: (id) => A("SELECT * FROM aulas WHERE id_matricula=?", id).map(r => ({ linha: r.id, dia: r.dia, horario: r.hora, livro: r.livro,
    professores: A("SELECT f.nome FROM aula_professor ap JOIN funcionarios f ON f.id=ap.funcionario_id WHERE ap.aula_id=?", r.id).map(x => x.nome) })),
  /* ===== ESTOQUE =====
     Uma rota só monta a tela inteira: itens, eventos e a matriz de quantidades. São ~30 itens e
     poucas dezenas de eventos — buscar tudo de uma vez é mais barato que N chamadas, e a grade
     precisa do conjunto completo para calcular saldo de qualquer jeito. */
  getEstoque() {
    const linha = (i: any) => ({
      id: i.id, descricao: i.descricao, codigo: i.codigo || "", livro: i.livro || null,
      edicaoNome: i.edicao_nome || "", edicaoAno: i.edicao_ano ?? null,
      unidade: i.unidade, tipo: i.tipo || (i.componente === 1 ? "peca" : (i.unidade === "kit" ? "kit" : "unidade")),
      finalidade: i.finalidade, minimo: i.minimo, ativo: i.ativo === 1, final: i.final === 1,
      ordem: i.ordem, componente: i.componente === 1,
      categoria: i.livro ? categoriaLivro(i.livro) : "Materiais",
    });
    /* COMPONENTES ficam FORA da grade: Student's Book e Workbook não são linha de prateleira, são
       o que vem dentro da mochila. Contá-los em separado seria contar o mesmo material duas vezes.
       Vão à parte, para a aba Kits montar a composição. */
    const itens = A("SELECT * FROM estoque_item WHERE componente=0 AND arquivado IS NULL ORDER BY ordem, descricao").map(linha);
    /* COLUNAS da matriz Kits × Peças: peça que de fato ENTRA em kit — declarada como componente ou
       já usada em algum. A Wiz.pen entra pelo segundo critério, e por isso aparece nos dois eixos
       (é o caso que ele levantou: "a única coisa que pode ser tanto coluna quanto linha").
       O critério não é só `tipo='peca'`: o "Kids Esp 1" é material que ele estoca e não compõe
       nada — como coluna, seria uma pergunta sem sentido em toda linha da matriz. */
    const componentes = A(`SELECT * FROM estoque_item WHERE tipo='peca'
        AND (componente=1 OR EXISTS (SELECT 1 FROM estoque_kit_item k WHERE k.item_id=estoque_item.id))
        ORDER BY componente, ordem, descricao`).map(linha);
    const eventos = A("SELECT * FROM estoque_evento WHERE arquivado IS NULL ORDER BY data, id").map(e => ({
      id: e.id, tipo: e.tipo, data: e.data, observacao: e.observacao || "",
      pedidoId: e.pedido_id || null, confirmado: e.confirmado !== 0,
      /* exemplares que já entraram por conta deste pedido, agrupados por material: é o que a tela
         abre quando ele confirma a chegada de um item, para digitar o código de barras de cada um */
      ...(e.tipo === "pedido" ? { recebidos: (() => {
        const por: Record<number, any[]> = {};
        A(`SELECT u.* FROM estoque_unidade u
           JOIN estoque_evento r ON r.id=u.remessa_id
           WHERE r.pedido_id=? ORDER BY u.item_id, u.entrada, u.id`, e.id)
          .forEach(u => (por[u.item_id] ||= []).push(
            { id: u.id, entrada: u.entrada, codigo: u.codigo || "", numero: u.numero ?? null,
              conferido: u.conferido || null, entregue: !!u.entrega_id }));
        return por;
      })() } : {}),
      /* o pedido carrega a própria situação na fila: aguardando, parcial ou recebido */
      ...(e.tipo === "pedido" ? { situacao: situacaoPedido(e.id) } : {}),
      itens: Object.fromEntries(A("SELECT item_id, quantidade, nota FROM estoque_evento_item WHERE evento_id=?", e.id)
        .map(r => [r.item_id, { q: r.quantidade, nota: r.nota || null }])),
    }));
    /* entregas viram colunas de SAÍDA agregadas por período entre contagens — uma coluna por dia de
       entrega encheria a grade (são 127 matrículas). O dia exato fica na entrega e aparece no
       detalhe. Entrega sem data não entra em período nenhum: não dá para saber quando saiu, então
       ela conta como já absorvida por qualquer contagem (o livro não está na prateleira hoje). */
    /* composição de QUALQUER item que tenha uma, não só dos marcados como kit: agora todo material
       de livro é um kit (mochila + Student's Book + Workbook), e é a composição que diz o que vem
       dentro. Item sem composição simplesmente não aparece com peças. */
    const kits = Object.fromEntries(A(`SELECT DISTINCT i.id FROM estoque_item i
        WHERE i.unidade='kit' OR EXISTS (SELECT 1 FROM estoque_kit_item k WHERE k.kit_id=i.id)`).map(k =>
      [k.id, A(`SELECT ki.item_id, ki.quantidade, it.descricao FROM estoque_kit_item ki
                JOIN estoque_item it ON it.id=ki.item_id WHERE ki.kit_id=?`, k.id)
        .map(r => ({ itemId: r.item_id, quantidade: r.quantidade, descricao: r.descricao }))]));
    /* saldo e pendência vêm calculados do servidor: são as duas contas que a tela não pode errar,
       e deixá-las no cliente as duplicaria (a grade e a lista de entregas precisam das duas). */
    itens.forEach((i: any) => {
      i.saldo = saldoItem(i.id);
      i.pedidoPendente = pedidoPendenteItem(i.id);
      i.sugestao = Math.max(0, i.minimo - i.saldo - i.pedidoPendente);
      /* as unidades na prateleira, da mais antiga para a mais nova: é a fila de saída, e é o que o
         acordeão da linha abre. Só as que não saíram — o que foi entregue vive na aba Entregas. */
      /* EDIÇÕES do material, com quantos exemplares cada uma tem na prateleira — é o que alimenta
         as pílulas de filtro da fila. Vem sempre, mesmo com zero, para a edição existir na tela
         antes de chegar o primeiro exemplar dela. */
      /* ATIVAS primeiro (mais recente na frente, que é a que se usa), arquivadas no fim — é a ordem
         que ele pediu: "quando arquiva, vai pro fundo com aparência de desativado". */
      i.edicoes = A(`SELECT e.id, e.nome, e.ano, e.padrao, e.arquivada,
                       (SELECT COUNT(*) FROM estoque_unidade u
                        WHERE u.edicao_id=e.id AND u.entrega_id IS NULL AND u.arquivado IS NULL) saldo,
                       (SELECT COUNT(*) FROM estoque_unidade u WHERE u.edicao_id=e.id) total
                     FROM estoque_edicao e WHERE e.item_id=?
                     ORDER BY (e.arquivada IS NOT NULL), e.padrao DESC, COALESCE(e.ano,0) DESC, e.id DESC`, i.id)
        .map(e => ({ id: e.id, nome: e.nome, ano: e.ano ?? null, saldo: e.saldo, total: e.total,
                     padrao: e.padrao === 1, arquivada: e.arquivada || null }));
      i.unidades = A(`SELECT u.id, u.entrada, u.origem, u.codigo, u.numero, u.conferido,
                             u.edicao_id, ed.nome AS edicao_nome, ev.data AS remessa
                      FROM estoque_unidade u
                      LEFT JOIN estoque_evento ev ON ev.id=u.remessa_id
                      LEFT JOIN estoque_edicao ed ON ed.id=u.edicao_id
                      WHERE u.item_id=? AND u.entrega_id IS NULL AND u.arquivado IS NULL ORDER BY u.entrada, u.id`, i.id)
        .map(u => ({ id: u.id, entrada: u.entrada, origem: u.origem, codigo: u.codigo || "",
                     numero: u.numero ?? null, conferido: u.conferido || null,
                     edicaoId: u.edicao_id ?? null, edicao: u.edicao_nome || "",
                     remessa: u.remessa || null }));
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
      (quem[lim] ||= []).push({ itemId: e.item_id, nome: e.nome, data: e.data, hora: e.hora || null,
        livro: e.livro });
    }
    const saidas = Object.keys(baldes).map(lim => {
      const aberta = lim === ABERTO;
      /* a coluna aberta é rotulada pela data mais recente que ela contém (ou hoje, o que for maior):
         '9999' é sentinela de cálculo e não pode vazar para a tela */
      const maxData = (quem[lim] || []).reduce((m, q) => q.data > m ? q.data : m, hoje);
      return { id: "s|" + lim, tipo: "saida", data: aberta ? maxData : lim, aberta,
        itens: baldes[lim], quem: quem[lim] || [] };
    });
    return { itens, componentes, eventos, saidas, kits, entregas: listaEntregas() };
  },
  getEntregas: () => listaEntregas(),
  salvarItemEstoque(p: any) {
    if (!p?.descricao) throw new Error("A descrição do item é obrigatória.");
    if (p.livro && !G("SELECT 1 FROM livros WHERE nome=?", p.livro)) throw new Error("Estágio inválido: " + p.livro);
    /* `tipo` é a natureza (kit · peca · unidade) e manda nas outras duas colunas: peça é o que não
       se conta sozinho, kit é o que se conta. Guardar as três em sincronia aqui evita que a tela
       precise saber da história antiga do campo `unidade`. */
    const tipo = ["kit", "peca"].includes(p.tipo) ? p.tipo : (p.componente ? "peca" : "kit");
    /* `componente` ("não se conta sozinho") é INDEPENDENTE do tipo, e a Wiz.pen é a razão: ela é
       peça — vai dentro de três kits — e mesmo assim se conta e se pede sozinha. Por isso não dá
       para derivar um do outro; quem manda aqui é o que veio da tela, com o kit sempre contável. */
    const comp = tipo === "kit" ? 0 : (p.componente === undefined ? 1 : (p.componente ? 1 : 0));
    const num = (v: any) => (v === "" || v == null ? null : Number(v));
    /* EDIÇÃO E ANO PRESERVAM o valor atual quando não vêm no payload. Quem manda neles é a tabela
       `estoque_edicao` (via `sincronizarEdicaoDoItem`), e o formulário do material deixou de
       enviá-los — sem esta guarda, salvar a descrição apagava a edição em silêncio. É o mesmo
       defeito que já custou o `item_estoque_id` de 10 estágios. */
    const at = p.id ? G("SELECT edicao_nome, edicao_ano FROM estoque_item WHERE id=?", p.id) : null;
    const atF = p.id ? G("SELECT final FROM estoque_item WHERE id=?", p.id) : null;
    const campos = [p.descricao, p.codigo || null, p.livro || null,
      tipo === "kit" ? "kit" : "unidade", tipo,
      p.finalidade || "venda", Number(p.minimo) || 0, p.ativo === false ? 0 : 1, Number(p.ordem) || 900,
      comp,
      p.edicaoNome === undefined ? (at?.edicao_nome ?? null) : (p.edicaoNome || null),
      p.edicaoAno === undefined ? (at?.edicao_ano ?? null) : num(p.edicaoAno),
      /* `final` também PRESERVA quando não vem no payload: a linha da tabela salva sem ele */
      p.final === undefined ? (atF?.final ?? 0) : (p.final ? 1 : 0)];
    if (p.id) { R(`UPDATE estoque_item SET descricao=?,codigo=?,livro=?,unidade=?,tipo=?,finalidade=?,minimo=?,ativo=?,ordem=?,componente=?,edicao_nome=?,edicao_ano=?,final=? WHERE id=?`, ...campos, p.id); return { ok: true, id: p.id }; }
    const r = R(`INSERT INTO estoque_item (descricao,codigo,livro,unidade,tipo,finalidade,minimo,ativo,ordem,componente,edicao_nome,edicao_ano,final) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...campos);
    return { ok: true, id: Number(r.lastInsertRowid) };
  },
  /* Apagar é permitido — a regra dele é PERGUNTAR, não proibir: "ele permite eu apagar, só que ele
     me pergunta se eu realmente quero, se esse elemento tem vínculo com outra coisa no sistema."
     Então o servidor devolve os vínculos e não apaga; o cliente mostra e volta com `confirmado`.
     Mesmo padrão de `registrarPonto`/`salvarAgendaLivro`: quem conhece os vínculos é o banco. */
  excluirItemEstoque({ id, confirmado }: any) {
    const it = G("SELECT * FROM estoque_item WHERE id=?", id);
    if (!it) return { ok: false };
    const vinculos: string[] = [];
    const emKits = A(`SELECT i.descricao FROM estoque_kit_item k JOIN estoque_item i ON i.id=k.kit_id
                      WHERE k.item_id=?`, id).map(r => r.descricao);
    if (emKits.length) vinculos.push("faz parte de " + emKits.length + " kit(s): " + emKits.join(", "));
    const peças = G("SELECT COUNT(*) n FROM estoque_kit_item WHERE kit_id=?", id)?.n || 0;
    if (peças) vinculos.push("tem " + peças + " peça(s) na composição dele");
    const evs = G(`SELECT COUNT(DISTINCT ev.id) n FROM estoque_evento_item ei
                   JOIN estoque_evento ev ON ev.id=ei.evento_id WHERE ei.item_id=?`, id)?.n || 0;
    if (evs) vinculos.push("aparece em " + evs + " contagem/pedido/remessa — essas quantidades somem junto");
    const ents = G("SELECT COUNT(*) n FROM entrega_material WHERE item_id=?", id)?.n || 0;
    if (ents) vinculos.push(ents + " aluno(s) já receberam este material");
    if (vinculos.length && !confirmado) return { precisaConfirmar: true, descricao: it.descricao, vinculos };
    return { ok: R("DELETE FROM estoque_item WHERE id=?", id).changes > 0, vinculos };
  },
  salvarEventoEstoque(p: any) {
    if (!p?.tipo || !p?.data) throw new Error("Tipo e data são obrigatórios.");
    if (p.id) { R("UPDATE estoque_evento SET data=?, observacao=? WHERE id=?", p.data, p.observacao || null, p.id); return { ok: true, id: p.id }; }
    /* pedido criado pela tela nasce RASCUNHO: a lista inteira de materiais fica visível até ele
       confirmar o que vai pedir de fato */
    const rascunho = p.tipo === "pedido" && p.rascunho ? 0 : 1;
    const pedidoId = p.tipo === "remessa" && p.pedidoId ? Number(p.pedidoId) : null;
    if (pedidoId && !G("SELECT 1 FROM estoque_evento WHERE id=? AND tipo='pedido'", pedidoId))
      throw new Error("Pedido não encontrado.");
    const r = R("INSERT INTO estoque_evento (tipo,data,observacao,momento,pedido_id,confirmado) VALUES (?,?,?,?,?,?)",
      p.tipo, p.data, p.observacao || null, agora(), pedidoId, rascunho);
    const id = Number(r.lastInsertRowid);
    /* REMESSA DE UM PEDIDO nasce preenchida com o que FALTA chegar dele. Lançar remessa é conferir
       a caixa contra o pedido — o gesto é "chegou tudo?" e não "digite de novo o que você já
       pediu". Quem recebeu menos corrige para baixo, e o pedido continua parcial. */
    if (pedidoId)
      for (const [itemId, q] of Object.entries(faltaDoPedido(pedidoId)))
        if (q > 0) R("INSERT INTO estoque_evento_item (evento_id,item_id,quantidade) VALUES (?,?,?)", id, Number(itemId), q);
    /* CONTAGEM não é mais criada pela tela (decisão dele, 2026-08-10: era herança do caderno, e com
       cada exemplar registrado não há o que recontar). As contagens antigas continuam no banco como
       história — é delas que saíram as unidades da virada. */
    return { ok: true, id };
  },
  excluirEventoEstoque: ({ id }: any) => ({ ok: R("DELETE FROM estoque_evento WHERE id=?", id).changes > 0 }),
  /* célula da grade: quantidade nula APAGA a linha. Vazio e zero são coisas diferentes — zero é
     "conferi e não tem", vazio é "não contei". */
  /* CONFIRMAR A CHEGADA: transforma as quantidades lançadas na remessa em unidades de verdade.
     É o gesto que ele descreveu — *"a gente só confirma: material está certo? Sim. Aí vai gerar um
     timestamp para cada material que veio"*. Cada exemplar ganha um instante próprio (milissegundo
     por posição), que é o que ordena a fila de entrega depois.
     Idempotente: uma remessa já confirmada não gera unidade de novo. */
  /* Fecha o RASCUNHO: o pedido deixa de listar o catálogo inteiro e passa a ser só o que foi
     pedido. Limpa por garantia o que ficou em zero — `gravarCelulaEstoque` já apaga, mas um
     rascunho antigo pode ter sobra. */
  confirmarPedido({ eventoId }: any) {
    const ev = G("SELECT * FROM estoque_evento WHERE id=? AND tipo='pedido'", eventoId);
    if (!ev) throw new Error("Pedido não encontrado.");
    R("DELETE FROM estoque_evento_item WHERE evento_id=? AND quantidade<=0", eventoId);
    const itens = A("SELECT item_id, quantidade FROM estoque_evento_item WHERE evento_id=?", eventoId);
    if (!itens.length) throw new Error("Nenhum material foi pedido — preencha ao menos um.");
    R("UPDATE estoque_evento SET confirmado=1 WHERE id=?", eventoId);
    return { ok: true, materiais: itens.length,
      total: itens.reduce((s, i) => s + i.quantidade, 0) };
  },
  /* CHEGADA DE UM MATERIAL do pedido. A remessa deixou de ser criada à mão: ela é "o pedido
     chegado", então nasce sozinha na primeira confirmação e as demais se penduram nela.
     Cada exemplar vira uma unidade com instante próprio — é o que alimenta a fila FIFO. */
  receberItemPedido({ pedidoId, itemId, quantidade }: any) {
    const ped = G("SELECT * FROM estoque_evento WHERE id=? AND tipo='pedido'", pedidoId);
    if (!ped) throw new Error("Pedido não encontrado.");
    const falta = faltaDoPedido(pedidoId)[itemId] || 0;
    const q = Math.max(0, Math.min(falta, parseInt(quantidade, 10) || falta));
    if (!q) return { ok: true, unidades: [], jaChegou: true };
    /* uma remessa por pedido, criada na hora em que a primeira caixa é confirmada */
    let rem = G("SELECT * FROM estoque_evento WHERE tipo='remessa' AND pedido_id=? ORDER BY id LIMIT 1", pedidoId);
    if (!rem) {
      const id = Number(R("INSERT INTO estoque_evento (tipo,data,observacao,momento,pedido_id,confirmado) VALUES ('remessa',?,NULL,?,?,1)",
        dataISO(new Date()), agora(), pedidoId).lastInsertRowid);
      rem = G("SELECT * FROM estoque_evento WHERE id=?", id);
    }
    R(`INSERT INTO estoque_evento_item (evento_id,item_id,quantidade) VALUES (?,?,?)
       ON CONFLICT(evento_id,item_id) DO UPDATE SET quantidade=quantidade+excluded.quantidade`,
      rem.id, itemId, q);
    const base = agora();                       // 'YYYY-MM-DD HH:MM:SS'
    const jaTem = G("SELECT COUNT(*) n FROM estoque_unidade WHERE item_id=?", itemId)?.n || 0;
    let numero = proximoNumero(itemId);         // o que ele vai escrever de caneta na etiqueta
    const novas: any[] = [];
    for (let i = 0; i < q; i++) {
      const ms = ("00" + ((jaTem + i) % 1000)).slice(-3);
      const n = numero++;
      const id = Number(R(`INSERT INTO estoque_unidade (item_id,remessa_id,entrada,origem,momento,numero)
         VALUES (?,?,?,'remessa',?,?)`, itemId, rem.id, base + "." + ms, base, n).lastInsertRowid);
      novas.push({ id, entrada: base + "." + ms, numero: n });
    }
    /* QUEM ESTAVA ESPERANDO ESTE MATERIAL. Vai junto na resposta, e não numa segunda chamada, porque
       é exatamente neste instante que a informação vale: a caixa acabou de ser aberta e a recepção
       está com os livros na mão. Descobrir dois dias depois que a Rafaela esperava é tarde. */
    return { ok: true, unidades: novas, remessaId: rem.id, saldo: saldoItem(itemId),
      descricao: G("SELECT descricao FROM estoque_item WHERE id=?", itemId)?.descricao || "",
      esperando: aguardandoDoItem(itemId) };
  },
  /* DESFAZER a chegada de um pedido: some com as unidades que ela criou e com a remessa, e o pedido
     volta ao que era — só os números pedidos, sem nada recebido.
     Só desfaz o que ainda está na prateleira: unidade JÁ ENTREGUE a um aluno não volta atrás, senão
     o sistema apagaria um exemplar que está fisicamente com alguém. Nesse caso a rota recusa e diz
     quantos são, porque a saída certa é desfazer a entrega primeiro. */
  /* observação do pedido: o "chegou em parte" saiu e este campo entrou no lugar — o que aconteceu
     de diferente numa remessa é texto, não um estado a mais */
  observacaoEvento({ eventoId, texto }: any) {
    R("UPDATE estoque_evento SET observacao=? WHERE id=?", String(texto || "").trim() || null, eventoId);
    return { ok: true };
  },
  desfazerChegada({ pedidoId }: any) {
    const ped = G("SELECT * FROM estoque_evento WHERE id=? AND tipo='pedido'", pedidoId);
    if (!ped) throw new Error("Pedido não encontrado.");
    const remessas = A("SELECT id FROM estoque_evento WHERE tipo='remessa' AND pedido_id=?", pedidoId);
    if (!remessas.length) return { ok: true, desfeitas: 0 };
    const entregues = G(`SELECT COUNT(*) n FROM estoque_unidade u
        JOIN estoque_evento r ON r.id=u.remessa_id
        WHERE r.pedido_id=? AND u.entrega_id IS NOT NULL`, pedidoId)?.n || 0;
    if (entregues) throw new Error(entregues + " unidade(s) deste pedido já foram entregues a alunos. "
      + "Desfaça essas entregas antes de desfazer a chegada.");
    let n = 0;
    for (const r of remessas) {
      n += R("DELETE FROM estoque_unidade WHERE remessa_id=?", r.id).changes as number;
      R("DELETE FROM estoque_evento_item WHERE evento_id=?", r.id);
      R("DELETE FROM estoque_evento WHERE id=?", r.id);
    }
    return { ok: true, desfeitas: n };
  },
  confirmarRemessa({ eventoId }: any) {
    const ev = G("SELECT * FROM estoque_evento WHERE id=? AND tipo='remessa'", eventoId);
    if (!ev) throw new Error("Remessa não encontrada.");
    if (G("SELECT 1 FROM estoque_unidade WHERE remessa_id=?", eventoId))
      return { ok: true, jaConfirmada: true, unidades: 0 };
    /* o carimbo nasce da DATA DA REMESSA, não do instante em que se clicou em confirmar: quem
       lança hoje uma caixa que chegou semana passada tem de entrar na fila na semana passada,
       senão ela fura a ordem e o exemplar mais novo sai antes do mais velho.
       A hora vem do relógio só para desempatar duas remessas do mesmo dia. */
    const rel = agora().slice(11);      // 'HH:MM:SS'
    const base = ev.data + " " + rel;
    let n = 0, seq = 0;
    const tocados: number[] = [];
    for (const l of A("SELECT item_id, quantidade FROM estoque_evento_item WHERE evento_id=? ORDER BY item_id", eventoId)) {
      let numero = proximoNumero(l.item_id);   // a numeração da etiqueta continua de onde parou
      for (let i = 0; i < l.quantidade; i++) {
        const ms = ("00" + (seq++ % 1000)).slice(-3);
        R(`INSERT INTO estoque_unidade (item_id,remessa_id,entrada,origem,momento,numero)
           VALUES (?,?,?,'remessa',?,?)`, l.item_id, eventoId, base + "." + ms, agora(), numero++);
        n++;
      }
      tocados.push(l.item_id);
    }
    /* a remessa inteira pode atender vários materiais de uma vez — o aviso vem agrupado por
       material, que é como a recepção separa as pilhas na mesa */
    const esperando = tocados.map(id => ({
      itemId: id, descricao: G("SELECT descricao FROM estoque_item WHERE id=?", id)?.descricao || "",
      alunos: aguardandoDoItem(id), saldo: saldoItem(id),
    })).filter(x => x.alunos.length);
    return { ok: true, unidades: n, data: ev.data, esperando };
  },
  /* Ajusta um exemplar: o instante de entrada (que é o lugar dele na FILA) e o código de barras da
     etiqueta. O instante é editável a pedido dele — caixa lançada com a data errada tira a ordem do
     lugar, e sem isto a única saída seria apagar e relançar.
     Os milissegundos originais são preservados: o input só dá minutos, e zerá-los empataria
     exemplares que estavam desempatados. */
  ajustarUnidade({ id, entrada, codigo, numero, conferir }: any) {
    const u = G("SELECT * FROM estoque_unidade WHERE id=?", id);
    if (!u) throw new Error("Exemplar não encontrado.");
    if (codigo !== undefined) R("UPDATE estoque_unidade SET codigo=? WHERE id=?", String(codigo || "").trim() || null, id);
    /* NÚMERO DA ETIQUETA, editável: os exemplares que já estão na prateleira podem ter sido
       numerados à mão antes do sistema, e é preciso dizer qual número está escrito em qual.
       Teto = quantos exemplares o material tem (não existe "nº 7" num material com 5), exceto se
       algum número maior já estiver em uso — o que acontece quando um exemplar foi apagado.
       Número já usado por outro exemplar TROCA com ele, em vez de recusar: sem a troca não haveria
       como rearranjar dois exemplares, só apagar e recriar. */
    if (numero !== undefined && numero !== null && numero !== "") {
      const n = parseInt(String(numero), 10);
      if (!Number.isFinite(n) || n < 1) throw new Error("O número da etiqueta começa em 1.");
      const total = G("SELECT COUNT(*) n FROM estoque_unidade WHERE item_id=?", u.item_id)?.n || 0;
      const maior = G("SELECT MAX(numero) m FROM estoque_unidade WHERE item_id=?", u.item_id)?.m || 0;
      const teto = Math.max(total, maior);
      if (n > teto) throw new Error("Este material tem " + teto + " exemplar(es) — o número " + n + " não existe.");
      const dono = G("SELECT id FROM estoque_unidade WHERE item_id=? AND numero=? AND id<>?", u.item_id, n, id);
      if (dono) R("UPDATE estoque_unidade SET numero=? WHERE id=?", u.numero ?? null, dono.id);
      R("UPDATE estoque_unidade SET numero=? WHERE id=?", n, id);
    }
    /* CONFERIR o exemplar: marca que ele foi conferido contra a caixa, e SÓ ISSO. Antes este era o
       botão "carimbar", que reescrevia `entrada` — ou seja, mudava o lugar do exemplar na fila a
       cada conferência, e era a origem da inconsistência entre número e instante.
       Desmarcar é permitido: quem clicou no exemplar errado precisa poder voltar. */
    if (conferir !== undefined) {
      R("UPDATE estoque_unidade SET conferido=? WHERE id=?", conferir ? agora() : null, id);
      return { ok: true, conferido: conferir ? agora() : null, saldo: saldoItem(u.item_id),
        conflitos: conflitosDeNumero(u.item_id) };
    }
    if (entrada) {
      const ms = (String(u.entrada).split(".")[1] || "000").slice(0, 3);
      const base = String(entrada).trim().slice(0, 16).replace("T", " "); // 'YYYY-MM-DD HH:MM'
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(base)) throw new Error("Data e hora inválidas.");
      R("UPDATE estoque_unidade SET entrada=? WHERE id=?", base + ":00." + ms, id);
    }
    return { ok: true, saldo: saldoItem(u.item_id), conflitos: conflitosDeNumero(u.item_id) };
  },
  /* ===== EDIÇÕES DE UM MATERIAL =====
     Criar e renomear; NÃO apagar (regra dele: *"apagar não dá para apagar, mas talvez alterar ou
     adicionar edição nova"*) — e é o certo, porque exemplar entregue a aluno aponta para a edição
     e apagá-la deixaria o rastro sem nome. */
  salvarEdicao({ id, itemId, nome, ano }: any) {
    const n = String(nome ?? "").trim();
    if (!n) throw new Error("A edição precisa de um nome.");
    const a = (ano === "" || ano == null || ano === 0) ? null : Number(ano);
    if (id) {
      const at = G("SELECT * FROM estoque_edicao WHERE id=?", id);
      if (!at) throw new Error("Edição não encontrada.");
      if (G("SELECT 1 FROM estoque_edicao WHERE item_id=? AND nome=? AND id<>?", at.item_id, n, id))
        throw new Error("Este material já tem uma edição chamada \"" + n + "\".");
      R("UPDATE estoque_edicao SET nome=?, ano=? WHERE id=?", n, a, id);
      sincronizarEdicaoDoItem(at.item_id);
      return { ok: true, id, itemId: at.item_id };
    }
    if (!itemId) throw new Error("Informe o material.");
    if (G("SELECT 1 FROM estoque_edicao WHERE item_id=? AND nome=?", itemId, n))
      throw new Error("Este material já tem uma edição chamada \"" + n + "\".");
    const r = R("INSERT INTO estoque_edicao (item_id,nome,ano,momento) VALUES (?,?,?,?)", itemId, n, a, agora());
    sincronizarEdicaoDoItem(itemId);
    return { ok: true, id: Number(r.lastInsertRowid), itemId };
  },
  /* ARQUIVAR / DESARQUIVAR uma edição. Nunca apagar: exemplar entregue aponta para ela.
     Arquivar a que era PADRÃO passa o posto para a próxima ativa — o material não pode ficar sem
     edição corrente enquanto tiver alguma viva. */
  arquivarEdicao({ id, desarquivar }: any) {
    const ed = G("SELECT * FROM estoque_edicao WHERE id=?", id);
    if (!ed) throw new Error("Edição não encontrada.");
    R("UPDATE estoque_edicao SET arquivada=?, padrao=? WHERE id=?",
      desarquivar ? null : agora(), desarquivar ? ed.padrao : 0, id);
    const nova = sincronizarEdicaoDoItem(ed.item_id);
    return { ok: true, padraoAgora: nova?.nome ?? null,
      exemplares: G("SELECT COUNT(*) n FROM estoque_unidade WHERE edicao_id=?", id)?.n || 0 };
  },
  /* a edição que os exemplares novos herdam. Uma por material — marcar outra desmarca a anterior. */
  edicaoPadraoDoItem({ id }: any) {
    const ed = G("SELECT * FROM estoque_edicao WHERE id=?", id);
    if (!ed) throw new Error("Edição não encontrada.");
    if (ed.arquivada) throw new Error("Edição arquivada não pode ser a padrão — desarquive antes.");
    R("UPDATE estoque_edicao SET padrao=0 WHERE item_id=?", ed.item_id);
    R("UPDATE estoque_edicao SET padrao=1 WHERE id=?", id);
    sincronizarEdicaoDoItem(ed.item_id);
    return { ok: true };
  },
  /* a edição de UM exemplar. Nula é legítima: exemplar antigo cuja edição ninguém anotou. */
  definirEdicaoUnidade({ id, edicaoId }: any) {
    const u = G("SELECT item_id FROM estoque_unidade WHERE id=?", id);
    if (!u) throw new Error("Exemplar não encontrado.");
    if (edicaoId) {
      const ed = G("SELECT item_id FROM estoque_edicao WHERE id=?", edicaoId);
      if (!ed || ed.item_id !== u.item_id) throw new Error("Essa edição não é deste material.");
    }
    R("UPDATE estoque_unidade SET edicao_id=? WHERE id=?", edicaoId || null, id);
    return { ok: true };
  },
  /* ENTRADA DIRETA, sem pedido (2026-08-16). Regra dele: *"a entrada vai servir mais para quando a
     gente faz pedido; só que a edição, manipulação vai ser a mesma"*. O caso que a pediu é o de
     agora — os exemplares que JÁ estão na prateleira e nunca passaram por um pedido no sistema
     precisam entrar para receber número, código e carimbo.
     `origem='manual'` já existia no CHECK desde o primeiro dia da unidade física; era o buraco que
     faltava preencher. Sem remessa ligada: não houve caixa, e inventar uma criaria um pedido que
     ninguém fez.
     O instante é o de AGORA, com milissegundo por posição. Parece errado para livro que está na
     estante há meses, e não é: o que a fila precisa é da ORDEM, e o que entra hoje sai antes de
     tudo que chegar depois. Quem souber a data de verdade corrige no lápis da unidade. */
  adicionarUnidades({ itemId, quantidade }: any) {
    const it = G("SELECT id, descricao FROM estoque_item WHERE id=?", itemId);
    if (!it) throw new Error("Material não encontrado.");
    const q = Math.max(0, Math.min(200, parseInt(quantidade, 10) || 0));
    if (!q) throw new Error("Informe quantos exemplares estão entrando.");
    const base = agora();
    const jaTem = G("SELECT COUNT(*) n FROM estoque_unidade WHERE item_id=?", itemId)?.n || 0;
    let numero = proximoNumero(itemId);
    const novas: any[] = [];
    for (let i = 0; i < q; i++) {
      const entrada = base + "." + ("00" + ((jaTem + i) % 1000)).slice(-3);
      const n = numero++;
      const id = Number(R(`INSERT INTO estoque_unidade (item_id,remessa_id,entrada,origem,momento,numero)
         VALUES (?,NULL,?,'manual',?,?)`, itemId, entrada, base, n).lastInsertRowid);
      novas.push({ id, entrada, numero: n });
    }
    /* entrada manual também avisa: o exemplar que estava na estante e acabou de ganhar número é
       tão entregável quanto o que veio na caixa */
    return { ok: true, unidades: novas, saldo: saldoItem(itemId), descricao: it.descricao,
      esperando: aguardandoDoItem(itemId) };
  },
  /* Apaga UM exemplar. A entrega, se houver, continua registrada: o aluno recebeu de verdade, e
     apagar o rastro do objeto não desfaz o fato. */
  excluirUnidade({ id }: any) {
    const u = G("SELECT item_id FROM estoque_unidade WHERE id=?", id);
    if (!u) return { ok: false };
    const ok = R("DELETE FROM estoque_unidade WHERE id=?", id).changes > 0;
    return { ok, saldo: saldoItem(u.item_id) };
  },
  gravarCelulaEstoque({ eventoId, itemId, quantidade, nota }: any) {
    if (!eventoId || !itemId) throw new Error("Evento e item são obrigatórios.");
    const ev = G("SELECT tipo FROM estoque_evento WHERE id=?", eventoId);
    const q = quantidade == null || quantidade === "" ? null : Math.max(0, parseInt(quantidade, 10) || 0);
    /* Em PEDIDO e REMESSA, zero e vazio são a mesma coisa: não pedir é pedir zero. Gravar o zero
       obrigava a recepção a digitar 0 em todos os materiais que ela NÃO pediu — foi a reclamação
       dele, e com razão. Na CONTAGEM o zero continua valendo por si: ali "conferi e não tem" é
       informação, diferente de "ainda não contei". */
    const zeroEhVazio = ev?.tipo === "pedido" || ev?.tipo === "remessa";
    if (q == null || (zeroEhVazio && q === 0))
      R("DELETE FROM estoque_evento_item WHERE evento_id=? AND item_id=?", eventoId, itemId);
    else
      R(`INSERT INTO estoque_evento_item (evento_id,item_id,quantidade,nota) VALUES (?,?,?,?)
         ON CONFLICT(evento_id,item_id) DO UPDATE SET quantidade=excluded.quantidade, nota=excluded.nota`,
        eventoId, itemId, Math.max(0, parseInt(quantidade, 10) || 0), nota || null);
    return { ok: true, saldo: saldoItem(itemId) };
  },
  /* entregar = registrar que o livro daquela matrícula foi para a mão do aluno. Sem quantidade:
     é um livro, o dele. A data pode vir vazia e ser preenchida depois. */
  /* QUAIS exemplares estão disponíveis para entregar naquele estágio. A tela abre esta lista antes
     de entregar: a escolha do exemplar é dele, não do sistema — *"tem que aparecer uma janelinha e
     escolher qual que é a unidade que eu quero entregar para esse aluno"*.
     A ordem continua a da fila (o mais antigo primeiro) e o primeiro vem marcado como sugestão, mas
     agora é sugestão mesmo, não decisão silenciosa. */
  unidadesParaEntrega({ livro }: any) {
    const it = G("SELECT id, descricao FROM estoque_item WHERE livro=?", livro);
    if (!it) return { itemId: null, descricao: null, unidades: [] };
    return { itemId: it.id, descricao: it.descricao,
      unidades: A(`SELECT id, numero, codigo, entrada, origem FROM estoque_unidade
                   WHERE item_id=? AND entrega_id IS NULL AND arquivado IS NULL ORDER BY entrada, id`, it.id)
        .map(u => ({ id: u.id, numero: u.numero ?? null, codigo: u.codigo || "",
                     entrada: u.entrada, origem: u.origem })) };
  },
  entregarMaterial({ idMatricula, livro, data, hora, unidadeId }: any) {
    if (!idMatricula || !livro) throw new Error("Matrícula e estágio são obrigatórios.");
    const it = G("SELECT id FROM estoque_item WHERE livro=?", livro);
    /* A HORA carimbada pelo RELÓGIO DO SERVIDOR, e só quando a entrega é de HOJE. Quem clica em
       "entregar" está entregando agora: pedir a hora de um gesto que acabou de acontecer seria
       trabalho sem informação nova, e é o mesmo carimbo automático de `registrarPonto`.
       Data passada é memória — a hora dela ninguém sabe, então fica nula e a linha deixa editar.
       Servidor e não navegador porque são duas estações no balcão, e o relógio que vale é um só. */
    const hhmm = data
      ? (horaEntrega(hora) ?? (data === dataISO(new Date()) ? agora().slice(11, 16) : null))
      : null;
    /* `devolvida=NULL` no UPDATE: entregar de novo é o fim do ciclo anterior. Sem isto, o aluno que
       devolveu e recebeu outro exemplar ficaria com a entrega nova marcada como devolvida — e
       continuaria na lista de quem está esperando, para sempre. O histórico do que ele devolveu
       não se perde: vive em `devolucao_material`. */
    R(`INSERT INTO entrega_material (id_matricula,livro,item_id,data,hora,deduzida,momento) VALUES (?,?,?,?,?,0,?)
       ON CONFLICT(id_matricula,livro) DO UPDATE SET data=excluded.data, hora=excluded.hora,
         deduzida=0, devolvida=NULL`,
      idMatricula, livro, it?.id ?? null, data || null, hhmm, agora());
    /* FILA: sai o exemplar MAIS ANTIGO — "quem chegou primeiro sai primeiro". Se não houver unidade
       na prateleira, a entrega é registrada assim mesmo e o saldo fica devendo: a recepção entregou
       de fato, e negar o registro só faria o sistema divergir da realidade. */
    const ent = G("SELECT id FROM entrega_material WHERE id_matricula=? AND livro=?", idMatricula, livro);
    let unidade = null;
    if (it && ent && !G("SELECT 1 FROM estoque_unidade WHERE entrega_id=?", ent.id)) {
      /* EXEMPLAR ESCOLHIDO pela tela; sem escolha, cai na fila (o mais antigo). A escolha é conferida
         contra o material e contra "ainda está na prateleira" — o id vem do cliente, e um exemplar já
         entregue a outro aluno não pode ser entregue de novo. */
      let u = null;
      if (unidadeId) {
        u = G(`SELECT * FROM estoque_unidade WHERE id=? AND item_id=? AND entrega_id IS NULL AND arquivado IS NULL`,
          Number(unidadeId), it.id);
        if (!u) throw new Error("Esse exemplar não está mais disponível — recarregue a lista.");
      } else u = proximaUnidade(it.id);
      if (u) {
        /* o exemplar sai com o instante DA ENTREGA, não com um carimbo próprio. Entrega sem data
           conhecida ainda assim tira o livro da prateleira agora, e é este clique que a `saida`
           registra — o que não se sabe é quando ele chegou à mão do aluno, e isso quem diz é a
           linha, com o campo em branco. */
        R("UPDATE estoque_unidade SET entrega_id=?, saida=? WHERE id=?",
          ent.id, instanteSaida(data || null, hhmm) ?? agora().slice(0, 16), u.id);
        unidade = { id: u.id, entrada: u.entrada, codigo: u.codigo, numero: u.numero ?? null };
      }
    }
    return { ok: true, saldo: it ? saldoItem(it.id) : null, unidade, hora: hhmm,
      semEstoque: !!it && !unidade };
  },
  /* a data da entrega é editável justamente porque as deduzidas nascem sem data — ninguém sabe
     quando aqueles livros saíram, e chutar seria pior que deixar em branco.
     A HORA anda junto e vem sempre da tela, nunca do relógio: os dois campos estão lado a lado na
     linha, então o que fica gravado é exatamente o que a recepção está vendo. O servidor não tenta
     adivinhar se a hora antiga ainda vale para o dia novo — ele não tem como saber, e ela está à
     vista de quem edita. Apagar a data apaga a hora: hora sem dia não é informação (e o CHECK
     recusaria de qualquer jeito). */
  ajustarEntrega({ idMatricula, livro, data, hora }: any) {
    const d = data || null;
    const h = d ? horaEntrega(hora) : null;
    const r = R("UPDATE entrega_material SET data=?, hora=?, deduzida=0 WHERE id_matricula=? AND livro=?",
      d, h, idMatricula, livro);
    if (!r.changes) throw new Error("Entrega não encontrada.");
    /* o exemplar passa a contar a mesma história: sem isto, corrigir a data na linha deixava
       `estoque_unidade.saida` presa no dia antigo, e o objeto contradizia a entrega para sempre. */
    const ent = G("SELECT id FROM entrega_material WHERE id_matricula=? AND livro=?", idMatricula, livro);
    if (ent) R("UPDATE estoque_unidade SET saida=? WHERE entrega_id=?", instanteSaida(d, h), ent.id);
    return { ok: true, data: d, hora: h };
  },
  removerEntrega({ idMatricula, livro }: any) {
    const it = G("SELECT id FROM estoque_item WHERE livro=?", livro);
    const ent = G("SELECT id FROM entrega_material WHERE id_matricula=? AND livro=?", idMatricula, livro);
    /* o exemplar VOLTA para a prateleira, e volta para o lugar dele na fila: `entrada` nunca é
       reescrito, então quem tinha chegado antes continua sendo o primeiro a sair */
    if (ent) R("UPDATE estoque_unidade SET entrega_id=NULL, saida=NULL WHERE entrega_id=?", ent.id);
    R("DELETE FROM entrega_material WHERE id_matricula=? AND livro=?", idMatricula, livro);
    return { ok: true, saldo: it ? saldoItem(it.id) : null };
  },
  /* ===== DEVOLVER O MATERIAL AO ESTOQUE (2026-08-17) =====
     *"devolução de material ao estoque"* — o aluno cancela e devolve o livro.
     A diferença para `removerEntrega` é o que cada uma AFIRMA. Desfazer diz "esta entrega nunca
     existiu" e apaga a linha; devolver diz "existiu, durou, e terminou". Por isso aqui nada é
     apagado: a entrega fica com a data de devolução e o fato vira uma linha em
     `devolucao_material`, com o exemplar que voltou.
     O exemplar volta para a prateleira do jeito que `removerEntrega` já fazia — `entrega_id=NULL`
     sem tocar em `entrada` —, então ele reassume o lugar dele na fila em vez de virar o mais novo.
     Livro usado que volta é o mais velho da prateleira, e é ele que deve sair primeiro. */
  devolverMaterial({ idMatricula, livro, data, hora, motivo }: any) {
    if (!idMatricula || !livro) throw new Error("Matrícula e estágio são obrigatórios.");
    const ent = G("SELECT * FROM entrega_material WHERE id_matricula=? AND livro=?", idMatricula, livro);
    if (!ent) throw new Error("Não há entrega registrada para devolver.");
    if (ent.devolvida) throw new Error("Este material já consta como devolvido em " + ent.devolvida + ".");
    const d = data || dataISO(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error("Data de devolução inválida.");
    /* mesma regra da entrega: quem carimba a hora é o RELÓGIO DO SERVIDOR, e só quando é HOJE.
       Devolução lançada com data passada é memória — a hora dela ninguém sabe, e 00:00 inventado
       seria pior que o campo vazio. */
    const h = horaEntrega(hora) ?? (d === dataISO(new Date()) ? agora().slice(11, 16) : null);
    /* qual exemplar está voltando: o que saiu nesta entrega. Entrega deduzida das matrículas
       antigas não tem nenhum ligado, e a devolução acontece do mesmo jeito — o livro voltou para a
       prateleira ainda que ninguém sabia qual era. */
    const u = G("SELECT id, numero, codigo FROM estoque_unidade WHERE entrega_id=?", ent.id);
    R(`INSERT INTO devolucao_material (id_matricula,livro,item_id,unidade_id,data,hora,motivo,momento)
       VALUES (?,?,?,?,?,?,?,?)`,
      idMatricula, livro, ent.item_id ?? null, u?.id ?? null, d, h,
      String(motivo || "").trim() || null, agora());
    if (u) R("UPDATE estoque_unidade SET entrega_id=NULL, saida=NULL WHERE id=?", u.id);
    R("UPDATE entrega_material SET devolvida=? WHERE id=?", d, ent.id);
    const it = ent.item_id ? G("SELECT id FROM estoque_item WHERE id=?", ent.item_id)
                           : G("SELECT id FROM estoque_item WHERE livro=?", livro);
    return { ok: true, data: d, hora: h, saldo: it ? saldoItem(it.id) : null,
      unidade: u ? { id: u.id, numero: u.numero ?? null, codigo: u.codigo || "" } : null };
  },
  /* DESFAZER a devolução: o aluno não devolveu, foi engano de digitação. Reata o mesmo exemplar à
     entrega (se ele ainda estiver livre — outra pessoa pode tê-lo levado nesse meio-tempo, e aí a
     entrega volta a valer sem exemplar ligado, que é o mesmo estado das 122 deduzidas). */
  desfazerDevolucao({ idMatricula, livro }: any) {
    const ent = G("SELECT * FROM entrega_material WHERE id_matricula=? AND livro=?", idMatricula, livro);
    if (!ent) throw new Error("Entrega não encontrada.");
    if (!ent.devolvida) throw new Error("Esta entrega não consta como devolvida.");
    const dev = G(`SELECT * FROM devolucao_material WHERE id_matricula=? AND livro=?
                   ORDER BY data DESC, id DESC LIMIT 1`, idMatricula, livro);
    let religou = false;
    if (dev?.unidade_id) {
      const u = G("SELECT id FROM estoque_unidade WHERE id=? AND entrega_id IS NULL", dev.unidade_id);
      if (u) {
        R("UPDATE estoque_unidade SET entrega_id=?, saida=? WHERE id=?",
          ent.id, instanteSaida(ent.data ?? null, ent.hora ?? null) ?? agora().slice(0, 16), u.id);
        religou = true;
      }
    }
    if (dev) R("DELETE FROM devolucao_material WHERE id=?", dev.id);
    /* `devolvida=NULL`, e NÃO "a devolução anterior volta a valer".
       Tentei o segundo e está errado — descobri testando o ciclo completo. Uma devolução mais
       antiga já foi ENCERRADA pela re-entrega que veio depois dela (`entregarMaterial` limpa o
       `devolvida` justamente por isso): ressuscitá-la marcaria como devolvido um material que o
       aluno tem na mão. O ciclo antigo continua no histórico, que é onde ele pertence.
       Desfazer ESTA devolução significa uma coisa só: o aluno segue com o material. */
    R("UPDATE entrega_material SET devolvida=NULL WHERE id=?", ent.id);
    const it = G("SELECT id FROM estoque_item WHERE livro=?", livro);
    return { ok: true, religou, saldo: it ? saldoItem(it.id) : null };
  },
  /* O SINO: o que chegou e tem dono esperando. A tela pergunta a cada carga do estoque e ao voltar
     para a aba — a outra estação do balcão pode ter entregue nesse meio-tempo. */
  getAvisosEstoque: () => avisosDeChegada(),
  /* Célula da matriz Kits × Peças. Zero (ou vazio) APAGA o vínculo: na matriz, "não tem" é o número
     zero, e ele foi explícito — *"o número já vai dizer se é sim ou não; zero quer dizer que não
     tem"*, sem checkbox. Teto de 10 por precaução dele: não existe kit com dez peças iguais. */
  salvarKitItem({ kitId, itemId, quantidade }: any) {
    if (!kitId || !itemId) throw new Error("Kit e peça são obrigatórios.");
    if (kitId === itemId) throw new Error("Um kit não pode conter ele mesmo.");
    const bruto = quantidade === "" || quantidade == null ? 0 : parseInt(quantidade, 10);
    const q = Math.min(10, Math.max(0, Number.isFinite(bruto) ? bruto : 0));
    if (!q) { R("DELETE FROM estoque_kit_item WHERE kit_id=? AND item_id=?", kitId, itemId); return { ok: true, q: 0 }; }
    R(`INSERT INTO estoque_kit_item (kit_id,item_id,quantidade) VALUES (?,?,?)
       ON CONFLICT(kit_id,item_id) DO UPDATE SET quantidade=excluded.quantidade`, kitId, itemId, q);
    return { ok: true, q };
  },
  removerKitItem: ({ kitId, itemId }: any) => ({ ok: R("DELETE FROM estoque_kit_item WHERE kit_id=? AND item_id=?", kitId, itemId).changes > 0 }),

  /* ===== BIBLIOTECA · ESTÁGIOS =====
     Uma rota monta a tela inteira: são 26 estágios e 3 modelos, e a grade precisa do conjunto
     para desenhar a trilha de qualquer jeito. */
  getEstagios() {
    /* edição do material vinculado, com o que está no estágio como rede de segurança */
    const itemDe = (e: any) => e.item_estoque_id
      ? G("SELECT edicao_nome, edicao_ano FROM estoque_item WHERE id=?", e.item_estoque_id) : null;
    const limpa = (v: any) => (v && !/^oficial$/i.test(v) ? v : "");
    /* material vinculado manda; sem material (edição aposentada, por exemplo) vale o que está
       gravado no próprio estágio, senão duas edições do mesmo livro ficariam com o mesmo nome */
    const edicaoDe = (e: any) => limpa(itemDe(e)?.edicao_nome) || limpa(e.edicao_nome) || "";
    const edicaoAnoDe = (e: any) => itemDe(e)?.edicao_ano ?? e.edicao_ano ?? null;
    /* `licoes` é a lista DIGITADA do modelo. Vazia = o modelo segue sendo fórmula, que é o caso de
       todos os três que vieram semeados. */
    const linhas = (t: string, dono: number) =>
      A(`SELECT * FROM ${t} WHERE dono_id=? ORDER BY ordem, id`, dono)
        .map(l => ({ id: l.id, ordem: l.ordem, numero: l.numero, sigla: l.sigla || "",
                     descricao: l.descricao, bloco: l.bloco, tipo: l.tipo }));
    const modelos = A("SELECT * FROM estagio_modelo WHERE arquivado IS NULL ORDER BY id").map(m => ({
      id: m.id, nome: m.nome, licoesPorCapitulo: m.licoes_por_capitulo, capitulos: m.capitulos,
      comuns: m.licoes_por_capitulo * m.capitulos,
      licoes: linhas("estagio_modelo_licao", m.id) }));
    const prox: Record<number, number[]> = {}, equiv: Record<number, number[]> = {};
    A("SELECT * FROM estagio_proximo").forEach(r => (prox[r.de_id] ||= []).push(r.para_id));
    A("SELECT * FROM estagio_equivalente").forEach(r => (equiv[r.a_id] ||= []).push(r.b_id));
    /* ordem PEDAGÓGICA das categorias, não alfabética: por nome, "Outros Idiomas" caía entre
       Kids e Teens e quebrava a leitura da progressão. */
    const estagios = A(`SELECT * FROM estagio WHERE arquivado IS NULL ORDER BY
        CASE categoria WHEN 'Kids' THEN 1 WHEN 'Teens' THEN 2 WHEN 'Ws' THEN 3 ELSE 4 END,
        ordem, id`).map(e => ({
      id: e.id, sigla: e.sigla, nome: e.nome, nomeCurto: e.nome_curto || "",
      /* nome de EXIBIÇÃO = nome + edição, concatenados aqui e não digitados: assim "Kids 4" com
         edição "Old" e "Kids 4" com "3rd Edition" se distinguem em toda tela sem ninguém repetir a
         edição dentro do nome (e sem o par sair do ar quando ele renomear um dos dois) */
      /* a edição vem do ITEM vinculado — é do material, não da estrutura. Enquanto o estágio não
         tiver item, cai no que ainda estiver gravado nele, para nenhum nome ficar ambíguo na
         virada (os dois Kids 4 precisam continuar distinguíveis). */
      nomeExibicao: e.nome + (edicaoDe(e) ? " · " + edicaoDe(e) : ""),
      edicaoDoItem: edicaoDe(e), edicaoAnoDoItem: edicaoAnoDe(e),
      idioma: e.idioma, categoria: e.categoria,
      /* `grupo` saiu da resposta em 2026-08-17: a categoria é o único agrupamento do sistema */
      /* FINAL é HERDADO do material: quem decide é a página de Estoque, e aqui só se mostra.
         Vem como `finalDoItem` para o nome deixar claro que não é campo do estágio. */
      finalDoItem: !!G("SELECT final FROM estoque_item WHERE id=?", e.item_estoque_id)?.final,
      modeloId: e.modelo_id, licaoInicial: e.licao_inicial,
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
      /* estrutura PRÓPRIA deste livro: quando existe, vence o modelo e a fórmula */
      licoesProprias: linhas("estagio_licao", e.id),
      proximos: prox[e.id] || [], equivalentes: equiv[e.id] || [],
      /* quantos alunos estão neste estágio hoje — o vínculo é pelo LIVRO, que é o que
         `aluno_livro` conhece; edições diferentes do mesmo livro somam no mesmo número */
      alunos: e.livro ? (G(`SELECT COUNT(*) n FROM aluno_livro al JOIN alunos a ON a.id_matricula=al.id_matricula
          JOIN situacoes s ON s.situacao=a.situacao AND s.ativa=1 WHERE al.livro=?`, e.livro)?.n || 0) : 0,
    }));
    return { modelos, estagios,
      livros: A("SELECT nome FROM livros ORDER BY ordem").map(r => r.nome),
      /* itens de estoque para o vínculo do estágio: ele pediu para a tela falar em ITEM e não em
         livro, porque o que o estágio consome pode ser kit ou unidade — "o estágio é a
         conglomeração disso tudo" */
      itens: A(`SELECT id, descricao, unidade, livro, edicao_nome, edicao_ano FROM estoque_item
                WHERE componente=0 ORDER BY ordem, descricao`)
        .map(i => ({ id: i.id, descricao: i.descricao, unidade: i.unidade, livro: i.livro || null,
                     edicaoNome: i.edicao_nome || "", edicaoAno: i.edicao_ano ?? null })) };
  },
  salvarEstagio(p: any) {
    if (!p?.sigla || !p?.nome) throw new Error("Sigla e nome são obrigatórios.");
    if (p.livro && !G("SELECT 1 FROM livros WHERE nome=?", p.livro)) throw new Error("Estágio inválido: " + p.livro);
    const num = (v: any) => (v === "" || v == null ? null : Number(v));
    /* O ANO da edição saiu do formulário (ele decidiu que o NOME da edição já identifica), mas o
       valor continua no banco. Sem esta guarda, o primeiro salvamento vindo da tela mandaria
       `undefined` e apagaria em silêncio o 2020/2014/2025 que ele digitou. Campo que sumiu da tela
       não pode virar campo apagado no banco. */
    const atual = p.id ? G("SELECT edicao_ano, item_estoque_id FROM estagio WHERE id=?", p.id) : null;
    const edicaoAno = p.edicaoAno === undefined ? (atual?.edicao_ano ?? null) : num(p.edicaoAno);
    /* mesma guarda para o item de estoque: o formulário não tinha este campo e mandava `undefined`
       a cada salvamento, então 10 dos 27 estágios já tinham perdido o vínculo sem ninguém pedir */
    const itemId = p.itemEstoqueId === undefined ? (atual?.item_estoque_id ?? null) : num(p.itemEstoqueId);
    /* O LIVRO deixou de ser campo de tela e passa a ser DERIVADO do item vinculado (2026-08-10,
       dele): *"o estágio é vinculado ao item no estoque"*. O `estagio.livro` continua existindo —
       é por ele que matrícula, agenda e ficha impressa acham o estágio — mas quem o define agora é
       o material escolhido, e não um segundo select dizendo quase a mesma coisa. */
    if (p.itemEstoqueId) {
      const it = G("SELECT livro FROM estoque_item WHERE id=?", num(p.itemEstoqueId));
      if (it?.livro) p.livro = it.livro;
    }
    /* `grupo` SAIU (2026-08-17, ordem dele): *"categoria já é o suficiente... vale para qualquer
       módulo, estágio, estoque"*. Era um segundo eixo de agrupamento ("Tots", "W New", "Teens 3rd")
       que ninguém lia — nenhuma consulta, filtro ou tela dependia dele, só o próprio campo. A
       COLUNA fica no banco, dormente: derrubá-la exige reconstruir `estagio`, que é referenciada
       por estagio_licao (1414 linhas), trilha, equivalências e extras — risco sem retorno para um
       campo que já não é lido nem escrito. */
    const campos = [p.sigla, p.nome, p.nomeCurto || p.livro || null,
      p.idioma || "Inglês", p.categoria || "Kids",
      num(p.modeloId), Number(p.licaoInicial) || 1, p.entrada ? 1 : 0, Number(p.ordem) || 100,
      num(p.idadeMin), num(p.idadeMax), p.escalaAtiva ? 1 : 0,
      p.cefrMin || null, p.cefrMax || null, num(p.gseMin), num(p.gseMax),
      p.edicaoNome || null, edicaoAno, p.status || "ativo", p.livro || null,
      itemId, p.descricao || null];
    if (p.id) {
      R(`UPDATE estagio SET sigla=?,nome=?,nome_curto=?,idioma=?,categoria=?,modelo_id=?,licao_inicial=?,
         entrada=?,ordem=?,idade_min=?,idade_max=?,escala_ativa=?,cefr_min=?,cefr_max=?,gse_min=?,
         gse_max=?,edicao_nome=?,edicao_ano=?,status=?,livro=?,item_estoque_id=?,descricao=? WHERE id=?`,
        ...campos, p.id);
      return { ok: true, id: p.id };
    }
    const r = R(`INSERT INTO estagio (sigla,nome,nome_curto,idioma,categoria,modelo_id,licao_inicial,entrada,
       ordem,idade_min,idade_max,escala_ativa,cefr_min,cefr_max,gse_min,gse_max,edicao_nome,edicao_ano,
       status,livro,item_estoque_id,descricao) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...campos);
    return { ok: true, id: Number(r.lastInsertRowid) };
  },
  excluirEstagio: ({ id }: any) => ({ ok: R("DELETE FROM estagio WHERE id=?", id).changes > 0 }),
  salvarLicaoExtra(p: any) {
    /* Na EDIÇÃO, o que não vier fica como está. Antes, um `ordem` ausente virava 1 e um `posicao`
       ausente virava 'abertura' — então renomear uma lição podia mudá-la de lugar, e a tela ainda
       tinha de reenviar dois campos que não estava editando. Reenviar uma `ordem` desatualizada
       (tela um passo atrás de um "mover") deixava DUAS lições com a mesma ordem, e a partir daí a
       fila desempatava por id, não pela ordem escolhida. */
    if (p?.id) {
      const atual = G("SELECT * FROM estagio_licao_extra WHERE id=?", p.id);
      if (!atual) throw new Error("Lição não encontrada.");
      const rotulo = String(p.rotulo ?? atual.rotulo).trim();
      if (!rotulo) throw new Error("O rótulo não pode ficar vazio.");
      R("UPDATE estagio_licao_extra SET rotulo=?, posicao=?, ordem=? WHERE id=?",
        rotulo, p.posicao || atual.posicao,
        p.ordem === undefined || p.ordem === null || p.ordem === "" ? atual.ordem : Number(p.ordem),
        p.id);
      return { ok: true, id: p.id };
    }
    if (!p?.estagioId || !p?.rotulo) throw new Error("Estágio e rótulo são obrigatórios.");
    const prox = (G("SELECT MAX(ordem) m FROM estagio_licao_extra WHERE estagio_id=? AND posicao=?",
      p.estagioId, p.posicao || "abertura")?.m || 0) + 1;
    const r = R("INSERT INTO estagio_licao_extra (estagio_id,ordem,rotulo,posicao) VALUES (?,?,?,?)",
      p.estagioId, prox, p.rotulo, p.posicao || "abertura");
    return { ok: true, id: Number(r.lastInsertRowid) };
  },
  excluirLicaoExtra: ({ id }: any) => ({ ok: R("DELETE FROM estagio_licao_extra WHERE id=?", id).changes > 0 }),
  /* Troca de lugar com a vizinha da MESMA posição (abertura com abertura, remind com remind).
     Trocar os dois valores de `ordem` de uma vez evita ter que renumerar a lista inteira — e como
     as duas linhas são conhecidas, não há como sobrar duplicata. */
  moverLicaoExtra({ id, direcao }: any) {
    const eu = G("SELECT * FROM estagio_licao_extra WHERE id=?", id);
    if (!eu) throw new Error("Lição não encontrada.");
    const cmp = direcao === "cima" ? "<" : ">";
    const ord = direcao === "cima" ? "DESC" : "ASC";
    const viz = G(`SELECT * FROM estagio_licao_extra WHERE estagio_id=? AND posicao=? AND ordem ${cmp} ?
                   ORDER BY ordem ${ord} LIMIT 1`, eu.estagio_id, eu.posicao, eu.ordem);
    if (!viz) return { ok: true, moveu: false }; // já está na ponta
    R("UPDATE estagio_licao_extra SET ordem=? WHERE id=?", eu.ordem, viz.id);
    R("UPDATE estagio_licao_extra SET ordem=? WHERE id=?", viz.ordem, eu.id);
    return { ok: true, moveu: true };
  },
  /* ===== modelos de estrutura =====
     Eram só leitura: dava para escolher entre os três semeados e nada mais. Se um livro novo vier
     com outro agrupamento, o modelo tem de poder nascer aqui. */
  salvarModelo(p: any) {
    const nome = String(p?.nome || "").trim();
    if (!nome) throw new Error("O modelo precisa de um nome.");
    const lpc = Number(p.licoesPorCapitulo), caps = Number(p.capitulos);
    if (!Number.isInteger(lpc) || lpc < 1) throw new Error("Lições por capítulo deve ser 1 ou mais.");
    if (!Number.isInteger(caps) || caps < 1) throw new Error("Capítulos deve ser 1 ou mais.");
    /* 60 lições comuns é o invariante da Wizard — mas é AVISO, não trava: quem conhece a exceção
       é ele, e um livro fora do padrão não pode ficar impossível de cadastrar. */
    const comuns = lpc * caps;
    const aviso = comuns === 60 ? null
      : "Este modelo dá " + comuns + " lições comuns. Todo livro da Wizard costuma ter 60 — confira se é mesmo assim.";
    if (p.id) {
      R("UPDATE estagio_modelo SET nome=?, licoes_por_capitulo=?, capitulos=? WHERE id=?", nome, lpc, caps, p.id);
      return { ok: true, id: p.id, aviso };
    }
    const r = R("INSERT INTO estagio_modelo (nome,licoes_por_capitulo,capitulos) VALUES (?,?,?)", nome, lpc, caps);
    return { ok: true, id: Number(r.lastInsertRowid), aviso };
  },
  excluirModelo({ id }: any) {
    /* `estagio.modelo_id` não tem ON DELETE: apagar um modelo em uso deixaria estágios sem
       estrutura e o gerador de lições cairia no primeiro modelo da lista em silêncio. */
    const usam = A("SELECT sigla FROM estagio WHERE modelo_id=?", id).map(e => e.sigla);
    if (usam.length) throw new Error("Este modelo é usado por " + usam.length + " estágio(s): " + usam.join(", ") + ".");
    if (A("SELECT 1 FROM estagio_modelo").length <= 1) throw new Error("Tem de sobrar ao menos um modelo.");
    return { ok: R("DELETE FROM estagio_modelo WHERE id=?", id).changes > 0 };
  },
  /* ===== estrutura digitada (lista de lições do modelo ou do estágio) =====
     Uma rota só para os dois alvos: as tabelas têm a mesma forma e o que muda é de quem a lista é.
     Duplicar quatro rotas para modelo e outras quatro para estágio faria duas cópias que divergem
     na primeira melhoria — foi assim que print e prévia se separaram um dia. */
  salvarLicaoEstrutura(p: any) {
    const t = tabelaLicao(p.alvo);
    if (!p?.alvoId && !p?.id) throw new Error("Informe o modelo ou o estágio.");
    const num = (v: any) => (v === "" || v == null ? null : Number(v));
    const desc = String(p.descricao ?? "").trim();
    if (p.id) {
      const at = G(`SELECT * FROM ${t} WHERE id=?`, p.id);
      if (!at) throw new Error("Lição não encontrada.");
      R(`UPDATE ${t} SET numero=?, sigla=?, descricao=?, bloco=?, tipo=? WHERE id=?`,
        p.numero === undefined ? at.numero : num(p.numero),
        p.sigla === undefined ? at.sigla : (String(p.sigla).trim() || null),
        desc || at.descricao,
        p.bloco === undefined ? at.bloco : num(p.bloco),
        p.tipo || at.tipo, p.id);
      /* MUDAR O Nº É MOVER: o índice é a posição na fila, então digitar 57 numa lição que está na 13
         a leva para a 57 e empurra as vizinhas. É o que ele pediu ao dizer que o índice é editável —
         e cobre, sem popover nenhum, o "quero levar esta lição para bem longe" que ele descartou. */
      if (p.ordem !== undefined && p.ordem !== null && p.ordem !== "") {
        const destino = Math.max(1, parseInt(String(p.ordem), 10) || 1);
        const outras = A(`SELECT id FROM ${t} WHERE dono_id=? AND id<>? ORDER BY ordem, id`, at.dono_id, p.id)
          .map(r => r.id);
        outras.splice(Math.min(destino - 1, outras.length), 0, p.id);
        outras.forEach((id, i) => R(`UPDATE ${t} SET ordem=? WHERE id=?`, i + 1, id));
      }
      return { ok: true, id: p.id };
    }
    if (!desc) throw new Error("A lição precisa de uma descrição.");
    /* nasce no fim da fila: construir uma estrutura é acrescentar linha após linha */
    const ordem = num(p.ordem) ?? ((G(`SELECT MAX(ordem) m FROM ${t} WHERE dono_id=?`, p.alvoId)?.m || 0) + 1);
    const r = R(`INSERT INTO ${t} (dono_id,ordem,numero,sigla,descricao,bloco,tipo) VALUES (?,?,?,?,?,?,?)`,
      p.alvoId, ordem, num(p.numero), (p.sigla == null ? null : String(p.sigla).trim() || null),
      desc, num(p.bloco), p.tipo || "input");
    return { ok: true, id: Number(r.lastInsertRowid) };
  },
  excluirLicaoEstrutura: ({ alvo, id }: any) =>
    ({ ok: R(`DELETE FROM ${tabelaLicao(alvo)} WHERE id=?`, id).changes > 0 }),
  /* troca de lugar com a vizinha, trocando as duas ordens — nunca renumera a lista inteira */
  moverLicaoEstrutura({ alvo, id, direcao }: any) {
    const t = tabelaLicao(alvo);
    const eu = G(`SELECT * FROM ${t} WHERE id=?`, id);
    if (!eu) throw new Error("Lição não encontrada.");
    const viz = G(`SELECT * FROM ${t} WHERE dono_id=? AND ordem ${direcao === "cima" ? "<" : ">"} ?
                   ORDER BY ordem ${direcao === "cima" ? "DESC" : "ASC"} LIMIT 1`, eu.dono_id, eu.ordem);
    if (!viz) return { ok: true, moveu: false };
    R(`UPDATE ${t} SET ordem=? WHERE id=?`, eu.ordem, viz.id);
    R(`UPDATE ${t} SET ordem=? WHERE id=?`, viz.ordem, eu.id);
    /* NORMALIZA a fila para 1..N depois do troca-troca. A coluna Nº da tela É a posição, então ela
       precisa ser contígua: uma lista que já tenha buracos (lição apagada no meio) mostraria
       "13, 15, 16" e o número deixaria de ser o índice que ele pediu. */
    A(`SELECT id FROM ${t} WHERE dono_id=? ORDER BY ordem, id`, eu.dono_id)
      .forEach((r, i) => R(`UPDATE ${t} SET ordem=? WHERE id=?`, i + 1, r.id));
    return { ok: true, moveu: true };
  },
  /* Materializa uma estrutura GERADA em linhas editáveis. O cliente manda a lista que ele já
     desenha na tela (`egLicoes`), em vez de o servidor recalcular: o gerador existe num lugar só,
     e é o mesmo que o Vitor está vendo quando clica. Reescreve tudo — é "partir daqui". */
  materializarEstrutura({ alvo, alvoId, linhas }: any) {
    const t = tabelaLicao(alvo);
    if (!alvoId || !Array.isArray(linhas)) throw new Error("Dados incompletos.");
    R(`DELETE FROM ${t} WHERE dono_id=?`, alvoId);
    linhas.forEach((l: any, i: number) =>
      R(`INSERT INTO ${t} (dono_id,ordem,numero,sigla,descricao,bloco,tipo) VALUES (?,?,?,?,?,?,?)`,
        alvoId, i + 1,
        l.numero === "" || l.numero == null ? null : Number(l.numero),
        l.sigla == null ? null : String(l.sigla).trim() || null,
        String(l.descricao ?? "").trim() || "—",
        l.bloco === "" || l.bloco == null ? null : Number(l.bloco),
        l.tipo || "input"));
    /* a sigla vem preenchida quando a origem é um MODELO (que já tem a dele); vindo da fórmula,
       `siglarLicoes` completa o que ficou nulo com L1, L2, R1... */
    siglarLicoes();
    return { ok: true, linhas: linhas.length };
  },
  /* SÓ o vínculo com o modelo. Existe em vez de reaproveitar `salvarEstagio` porque aquele grava o
     registro INTEIRO: mandar dois campos exigiria repetir os outros vinte, e um esquecido volta
     nulo — foi exatamente assim que 10 estágios perderam o `item_estoque_id` um dia. */
  definirModeloDoEstagio({ estagioId, modeloId }: any) {
    if (!estagioId || !modeloId) throw new Error("Estágio e modelo são obrigatórios.");
    if (!G("SELECT 1 FROM estagio_modelo WHERE id=?", modeloId)) throw new Error("Modelo não encontrado.");
    const r = R("UPDATE estagio SET modelo_id=? WHERE id=?", modeloId, estagioId);
    if (!r.changes) throw new Error("Estágio não encontrado.");
    return { ok: true };
  },
  /* apagar a lista devolve o estágio ao modelo (ou o modelo à fórmula) */
  limparEstrutura: ({ alvo, alvoId }: any) =>
    ({ ok: true, apagadas: R(`DELETE FROM ${tabelaLicao(alvo)} WHERE dono_id=?`, alvoId).changes }),

  /* ===== ARQUIVO: uma base só para o que saiu de circulação =====
     Cada tipo sabe de qual tabela vem, como se chama na tela e o que mostrar como rótulo. Assim a
     página de Arquivados não precisa conhecer o esquema de cinco tabelas. */
  /* ===== CENTRAL DE CONTROLE =====
     Roda TODAS as checagens e devolve a tela inteira. Uma rota só, como `getEstoque`: são ~23
     consultas curtas e a página não faz sentido pela metade — o número que ela mostra é a soma.
     Cada item já vem separado em ABERTO ou SILENCIADO, para a tela não precisar conhecer a regra. */
  getCentral() {
    const sil: Record<string, any> = {};
    for (const s of A("SELECT * FROM aviso_silenciado")) sil[s.regra + " " + s.chave] = s;
    let orfaos = 0;
    const vistos: Record<string, boolean> = {};
    const regras = CHECAGENS.map(c => {
      let itens: any[] = [];
      /* uma consulta quebrada não pode derrubar a página inteira: a central existe justamente para
         quem quer ver o estado do sistema, e sumir em silêncio seria o pior desfecho possível */
      try { itens = A(c.sql); } catch (e) {
        return { id: c.id, area: c.area, titulo: c.titulo, porque: c.porque, acao: c.acao,
          gravidade: c.gravidade, aba: c.aba, erro: (e as Error).message,
          destino: c.destino || null, campo: c.campo || null,
          abertos: [], silenciados: [], total: 0, regraSilenciada: false, motivoRegra: null };
      }
      const daRegra = sil[c.id + " *"];
      const abertos: any[] = [], silenciados: any[] = [];
      for (const r of itens) {
        const chave = String(r.k);
        vistos[c.id + " " + chave] = true;
        const s = daRegra || sil[c.id + " " + chave];
        const item = { chave, rotulo: String(r.r ?? ""), detalhe: r.d == null ? null : String(r.d),
          /* o alvo da navegação, resolvido pelo SQL (coluna `a`); sem ele o cliente teria de
             adivinhar o dono de cada chave, e as chaves têm formatos diferentes por regra */
          alvo: r.a == null ? null : String(r.a) };
        if (s) silenciados.push({ ...item, motivo: s.motivo || "", desde: s.momento, porRegra: !!daRegra });
        else abertos.push(item);
      }
      return { id: c.id, area: c.area, titulo: c.titulo, porque: c.porque, acao: c.acao,
        gravidade: c.gravidade, aba: c.aba, erro: null,
        destino: c.destino || null, campo: c.campo || null,
        abertos, silenciados, total: itens.length,
        regraSilenciada: !!daRegra, motivoRegra: daRegra?.motivo || null };
    });
    /* silêncio de um caso que já não aparece (foi resolvido ou o registro sumiu) vira lixo: ele não
       atrapalha nada, mas contá-lo deixa a limpeza possível em vez de invisível */
    for (const k of Object.keys(sil)) if (!k.endsWith(" *") && !vistos[k]) orfaos++;
    const abertos = regras.reduce((s, r) => s + r.abertos.length, 0);
    const porArea: Record<string, number> = {};
    const porGravidade: Record<string, number> = { alta: 0, media: 0, baixa: 0 };
    for (const r of regras) {
      porArea[r.area] = (porArea[r.area] || 0) + r.abertos.length;
      porGravidade[r.gravidade] += r.abertos.length;
    }
    return { regras, abertos, porArea, porGravidade, orfaos,
      silenciados: regras.reduce((s, r) => s + r.silenciados.length, 0) };
  },
  /* SILENCIAR: `chave='*'` cala a regra toda, qualquer outra chave cala um caso.
     O motivo é opcional mas pedido: daqui a três meses, "por que este está calado" é a pergunta. */
  silenciarAviso({ regra, chave, motivo }: any) {
    if (!regra || !chave) throw new Error("Regra e caso são obrigatórios.");
    if (!CHECAGENS.some(c => c.id === regra)) throw new Error("Checagem desconhecida: " + regra);
    R(`INSERT INTO aviso_silenciado (regra,chave,motivo,momento) VALUES (?,?,?,?)
       ON CONFLICT(regra,chave) DO UPDATE SET motivo=excluded.motivo, momento=excluded.momento`,
      regra, String(chave), String(motivo || "").trim() || null, agora());
    return { ok: true };
  },
  reativarAviso({ regra, chave }: any) {
    const r = R("DELETE FROM aviso_silenciado WHERE regra=? AND chave=?", regra, String(chave));
    return { ok: true, reativados: r.changes };
  },
  /* limpa os silêncios de casos que não existem mais — o único jeito de a tabela não crescer para
     sempre com decisões sobre registros apagados */
  limparSilenciosObsoletos() {
    const vivos: Record<string, boolean> = {};
    for (const c of CHECAGENS) {
      try { for (const r of A(c.sql)) vivos[c.id + " " + String(r.k)] = true; } catch { /* regra quebrada não apaga nada */ }
    }
    let n = 0;
    for (const s of A("SELECT regra, chave FROM aviso_silenciado WHERE chave<>'*'")) {
      if (!vivos[s.regra + " " + s.chave]) {
        R("DELETE FROM aviso_silenciado WHERE regra=? AND chave=?", s.regra, s.chave); n++;
      }
    }
    return { ok: true, removidos: n };
  },
  /* ===== CALENDÁRIO LETIVO =====
     Uma rota monta o ano inteiro: 12 meses × 42 células é barato, e a tela não faz sentido pela
     metade. O SERVIDOR é quem resolve as datas — a mesma resposta vai alimentar a contagem de dias
     letivos quando ela existir, e regra de data em dois lugares diverge no primeiro ajuste. */
  getCalendario({ ano }: any) {
    const y = Number(ano) || new Date().getFullYear();
    const sabUtil = (G("SELECT valor FROM config WHERE chave='cal_sabado_util'")?.valor ?? "1") === "1";
    const domUtil = (G("SELECT valor FROM config WHERE chave='cal_domingo_util'")?.valor ?? "0") === "1";
    const marcacoes = A("SELECT * FROM calendario_marcacao WHERE arquivado IS NULL ORDER BY tipo, nome");
    /* data -> marcações daquele dia. Um dia pode ter mais de uma (feriado que cai dentro das
       férias), e a tela precisa saber de todas para o `title` contar a história inteira. */
    const porData: Record<string, any[]> = {};
    const lista = marcacoes.map(m => {
      const datas = datasDaMarcacao(m, y);
      for (const d of datas) (porData[d] ||= []).push({ id: m.id, nome: m.nome, tipo: m.tipo, cor: m.cor, fecha: m.fecha === 1 });
      return {
        id: m.id, nome: m.nome, tipo: m.tipo,
        tipos: String(m.tipos || m.tipo).split(",").filter(Boolean),
        trechos: A("SELECT * FROM calendario_trecho WHERE marcacao_id=? ORDER BY ordem,id", m.id)
          .map(t => ({ modo: t.modo, dataIni: t.data_ini, dataFim: t.data_fim,
            dia: t.dia, mes: t.mes, diaFim: t.dia_fim, mesFim: t.mes_fim,
            offIni: t.off_ini, offFim: t.off_fim,
            semN: t.sem_n, semDow: t.sem_dow, semNFim: t.sem_n_fim, semDowFim: t.sem_dow_fim })),
        ambito: m.ambito, repeticao: m.repeticao,
        dataIni: m.data_ini, dataFim: m.data_fim, mes: m.mes, dia: m.dia,
        offsetPascoa: m.offset_pascoa, duracao: m.duracao, fecha: m.fecha === 1,
        cor: m.cor, observacao: m.observacao, origem: m.origem || "manual",
        /* onde ela cai NESTE ano — é o que a lista mostra, e o que torna a repetição legível */
        datas, primeira: datas[0] || null,
      };
    });
    /* OS 12 MESES, já em grade 7×7 (1 fileira de cabeçalho + 6 semanas), começando na SEGUNDA.
       Seis semanas SEMPRE, mesmo quando o mês cabe em cinco: cartão que muda de altura faz a grade
       de 4×3 dançar. Os dias de fora vêm marcados para a tela esmaecê-los. */
    const meses = [];
    for (let mes = 1; mes <= 12; mes++) {
      const primeiro = new Date(Date.UTC(y, mes - 1, 1));
      /* getUTCDay: 0=domingo. Queremos segunda=0 … domingo=6 */
      const desloc = (primeiro.getUTCDay() + 6) % 7;
      const inicio = maisDias(`${y}-${("0" + mes).slice(-2)}-01`, -desloc);
      const dias = [];
      for (let i = 0; i < 42; i++) {
        const iso = maisDias(inicio, i);
        const d = new Date(iso + "T12:00:00Z");
        const dow = (d.getUTCDay() + 6) % 7;                 // 0=segunda … 6=domingo
        const doMes = Number(iso.slice(5, 7)) === mes && iso.slice(0, 4) === String(y);
        const marcas = porData[iso] || [];
        /* FIM DE SEMANA é regra da escola, não do calendário: aqui o sábado é dia de aula. */
        const fds = (dow === 5 && !sabUtil) || (dow === 6 && !domUtil);

        dias.push({
          iso, n: Number(iso.slice(8, 10)), dow, doMes, fds,
          marcas,
          /* letivo = a escola abre. Um feriado fecha; um evento pode não fechar. */
          letivo: doMes && !fds && !marcas.some((x: any) => x.fecha),
        });
      }
      meses.push({ mes, dias });
    }
    const letivos = meses.reduce((s, m) => s + m.dias.filter(d => d.letivo).length, 0);
    return { ano: y, meses, marcacoes: lista, sabadoUtil: sabUtil, domingoUtil: domUtil,
      letivos, pascoa: pascoa(y) };
  },
  /* SINCRONIZAR com as fontes externas. Três regras que valem mais que o código:
     1. NUNCA sobrescreve nem apaga o que já existe — só ACRESCENTA o que a escola não tem.
     2. RESPEITA EXCLUSÃO: chave já vista no livro-caixa não volta, mesmo que ele tenha apagado a
        marcação. Feriado que ressuscita sozinho destrói a confiança na tela.
     3. Fonte que falha não derruba as outras: cada uma tem o seu try/catch e o seu status. */
  async sincronizarCalendario({ anos, gatilho }: any) {
    const y = new Date().getFullYear();
    const lista: number[] = Array.isArray(anos) && anos.length ? anos.map(Number) : [y, y + 1];
    const fontes = A("SELECT * FROM calendario_fonte WHERE ativa=1");
    let novos = 0, okN = 0, erroN = 0;
    const resumo: string[] = [];
    for (const f of fontes) {
      let achados = 0, novosF = 0;
      try {
        for (const ano of lista) {
          const alvo = urlDaFonte(f, ano);
          /* fonte que exige token e ainda não tem: não é erro, é "não configurada" */
          if (!alvo) throw new Error("falta o token desta fonte (configure na tela)");
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 10000);
          const resp = await fetch(alvo, { signal: ctrl.signal });
          clearTimeout(t);
          if (!resp.ok) throw new Error("HTTP " + resp.status);
          const itens = normalizarFonte(f.id, await resp.json());
          achados += itens.length;
          /* o que a escola JÁ cobre naquele ano, venha de semente, regra anual ou digitação */
          const cobertas = new Set<string>();
          for (const m of A("SELECT * FROM calendario_marcacao WHERE arquivado IS NULL"))
            for (const d of datasDaMarcacao(m, ano)) cobertas.add(d);
          for (const it of itens) {
            if (!it.data || !it.data.startsWith(String(ano))) continue;
            const chave = chaveFeriado(it.data, it.nome);
            /* já vista alguma vez = decidida. Ou virou marcação, ou ele a apagou de propósito. */
            if (G("SELECT 1 FROM calendario_importado WHERE fonte=? AND chave=?", f.id, chave)) continue;
            const jaTem = cobertas.has(it.data);
            R("INSERT INTO calendario_importado (fonte,chave,visto_em,virou_marcacao) VALUES (?,?,?,?)",
              f.id, chave, agora(), jaTem ? 0 : 1);
            if (jaTem) continue;                 // a data já está coberta: registra e segue
            R(`INSERT INTO calendario_marcacao
               (nome,tipo,ambito,repeticao,data_ini,duracao,fecha,cor,observacao,origem,chave_externa,momento)
               VALUES (?,?,?,'nenhuma',?,1,?,?,?,?,?,?)`,
              it.nome, it.tipo, it.ambito, it.data,
              /* PONTO FACULTATIVO NÃO FECHA A ESCOLA por padrão: é decisão da direção, não da lei.
                 Entra com `fecha=0` e ele decide caso a caso — chegar fechando a escola sozinho em
                 dias como 28/10 ou 24/12 seria pior que não trazer nada. */
              it.tipo === "facultativo" ? 0 : 1,
              it.tipo === "feriado" ? "#B3261E" : "#B26A00",
              it.observacao || null, f.id, chave, agora());
            novosF++; novos++;
            cobertas.add(it.data);
          }
        }
        R("UPDATE calendario_fonte SET ultima_sync=?,ultimo_status='ok',ultimo_erro=NULL,achados=?,novos=? WHERE id=?",
          agora(), achados, novosF, f.id);
        okN++; resumo.push(`${f.id}: ${achados} lidos, ${novosF} novos`);
      } catch (e) {
        R("UPDATE calendario_fonte SET ultima_sync=?,ultimo_status='erro',ultimo_erro=? WHERE id=?",
          agora(), (e as Error).message, f.id);
        erroN++; resumo.push(`${f.id}: FALHOU (${(e as Error).message})`);
      }
    }
    R(`INSERT INTO calendario_sync (momento,gatilho,anos,fontes_ok,fontes_erro,novos,resumo)
       VALUES (?,?,?,?,?,?,?)`, agora(), gatilho || "manual", lista.join(","), okN, erroN, novos,
      resumo.join(" · "));
    return { ok: true, anos: lista, novos, fontesOk: okN, fontesErro: erroN, resumo };
  },
  getFontesCalendario() {
    const uf = cfg("cal_uf") || "MS";
    const tk = cfg("cal_token_invertexto");
    return {
      uf,
      /* O TOKEN NUNCA VOLTA INTEIRO para a tela. Basta ela saber que existe e mostrar as pontas,
         para ele reconhecer qual é sem que o segredo trafegue de novo nem apareça em log de rede. */
      temToken: !!tk,
      tokenMascarado: tk ? tk.slice(0, 5) + "…" + tk.slice(-4) : "",
      fontes: A("SELECT * FROM calendario_fonte ORDER BY id").map(f => ({
        id: f.id, nome: String(f.nome).replace(/\{uf\}/g, uf), ativa: f.ativa === 1,
        /* a `url` vai SEM o token — ela é o molde, não o valor */
        url: String(f.url).replace(/\{token\}/g, "•••"),
        precisaToken: String(f.url).includes("{token}"),
        ultimaSync: f.ultima_sync, status: f.ultimo_status, erro: f.ultimo_erro,
        achados: f.achados, novos: f.novos })),
      hora: G("SELECT valor FROM config WHERE chave='cal_sync_hora'")?.valor || "15:30",
      ultimas: A("SELECT * FROM calendario_sync ORDER BY id DESC LIMIT 5").map(s => ({
        momento: s.momento, gatilho: s.gatilho, anos: s.anos, novos: s.novos,
        ok: s.fontes_ok, erro: s.fontes_erro, resumo: s.resumo })),
      importados: G("SELECT COUNT(*) n FROM calendario_importado")?.n || 0,
    };
  },
  /* guarda o token e a UF. O token entra por aqui e não volta por lugar nenhum — quem quiser
     trocá-lo digita outro; quem quiser desligar a fonte manda string vazia. */
  salvarTokenCalendario({ token, uf }: any) {
    const p = (c: string, v: string) =>
      R("INSERT INTO config (chave,valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor", c, v);
    if (token !== undefined) {
      const t = String(token || "").trim();
      p("cal_token_invertexto", t);
      /* liga/desliga a fonte junto: token vazio com fonte ativa só produziria erro todo dia */
      R("UPDATE calendario_fonte SET ativa=? WHERE id='invertexto'", t ? 1 : 0);
    }
    if (uf !== undefined) {
      const u = String(uf || "").trim().toUpperCase();
      if (u && !/^[A-Z]{2}$/.test(u)) throw new Error("UF inválida (duas letras, ex.: MS).");
      p("cal_uf", u || "MS");
    }
    return { ok: true };
  },
  salvarFonteCalendario({ id, ativa, hora }: any) {
    if (hora !== undefined) {
      if (!/^[0-2][0-9]:[0-5][0-9]$/.test(String(hora))) throw new Error("Hora inválida (use HH:MM).");
      R("INSERT INTO config (chave,valor) VALUES ('cal_sync_hora',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor", hora);
    }
    if (id !== undefined && ativa !== undefined)
      R("UPDATE calendario_fonte SET ativa=? WHERE id=?", ativa ? 1 : 0, id);
    return { ok: true };
  },
  salvarConfigCalendario({ sabadoUtil, domingoUtil }: any) {
    const p = (c: string, v: boolean) =>
      R("INSERT INTO config (chave,valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor",
        c, v ? "1" : "0");
    if (sabadoUtil !== undefined) p("cal_sabado_util", !!sabadoUtil);
    if (domingoUtil !== undefined) p("cal_domingo_util", !!domingoUtil);
    return { ok: true };
  },
  /* Salva a marcação COM OS SEUS TRECHOS. Os trechos são substituídos por inteiro a cada gravação:
     é mais simples e mais honesto que casar um a um, e a lista é curta por natureza. */
  salvarMarcacao(p: any) {
    const nome = String(p.nome || "").trim();
    if (!nome) throw new Error("A descrição é obrigatória.");
    const t = normalizarTipos(p.tipos, p.tipo);
    /* ---- valida cada trecho: marcação que entra sem data nenhuma parece salva e não aparece em
       lugar nenhum, que é o pior desfecho possível ---- */
    const brutos: any[] = Array.isArray(p.trechos) ? p.trechos : [];
    const trechos = brutos.map((x: any, i: number) => {
      const modo = ["data", "anual", "pascoa", "semana"].includes(x.modo) ? x.modo : "data";
      if (modo === "semana" && !(x.mes >= 1 && x.mes <= 12 && x.semDow != null))
        throw new Error(`Trecho ${i + 1}: escolha o dia da semana e o mês.`);
      if (modo === "data") {
        if (!x.dataIni) throw new Error(`Trecho ${i + 1}: escolha a data de início.`);
        if (x.dataFim && x.dataFim < x.dataIni)
          throw new Error(`Trecho ${i + 1}: o fim é antes do início.`);
      }
      if (modo === "anual" && !(x.mes >= 1 && x.mes <= 12 && x.dia >= 1 && x.dia <= 31))
        throw new Error(`Trecho ${i + 1}: informe dia e mês.`);
      if (modo === "pascoa" && !Number.isFinite(Number(x.offIni)))
        throw new Error(`Trecho ${i + 1}: informe os dias a contar da Páscoa.`);
      const porSemana = modo === "semana";
      return { modo, ordem: i + 1,
        dataIni: modo === "data" ? x.dataIni : null,
        dataFim: modo === "data" ? (x.dataFim || null) : null,
        dia: modo === "anual" ? Number(x.dia) : null,
        /* `mes` serve ao anual E ao por-semana: nos dois é "de que mês estamos falando" */
        mes: (modo === "anual" || porSemana) ? Number(x.mes) : null,
        diaFim: modo === "anual" && x.diaFim ? Number(x.diaFim) : null,
        mesFim: (modo === "anual" && x.mesFim) || (porSemana && x.mesFim) ? Number(x.mesFim) : null,
        offIni: modo === "pascoa" ? Number(x.offIni) : null,
        offFim: modo === "pascoa" && x.offFim !== "" && x.offFim != null ? Number(x.offFim) : null,
        semN: porSemana ? (Number(x.semN) || 1) : null,
        semDow: porSemana ? Number(x.semDow) : null,
        semNFim: porSemana && x.mesFim ? (Number(x.semNFim) || 1) : null,
        semDowFim: porSemana && x.mesFim && x.semDowFim != null ? Number(x.semDowFim) : null };
    });
    if (!trechos.length) throw new Error("Acrescente ao menos um período ou data.");
    /* as colunas antigas continuam preenchidas a partir do PRIMEIRO trecho: nada mais as lê para
       calcular datas, mas elas mantêm o registro legível por fora e servem de rede se algum dia a
       tabela de trechos se perder */
    const t1 = trechos[0];
    const rep = t1.modo === "anual" ? "anual" : t1.modo === "pascoa" ? "pascoa" : "nenhuma";
    const campos = [nome, t.tipo, t.tipos, p.ambito || "escola", rep,
      t1.dataIni, t1.dataFim, t1.mes, t1.dia, t1.offIni, 1,
      /* férias/recesso ignoram o que veio da tela: não existe férias com aula */
      t.fecha === true ? 1 : (p.fecha === false ? 0 : 1),
      p.cor || null, String(p.observacao || "").trim() || null];
    let id = p.id;
    if (id) {
      R(`UPDATE calendario_marcacao SET nome=?,tipo=?,tipos=?,ambito=?,repeticao=?,data_ini=?,data_fim=?,
         mes=?,dia=?,offset_pascoa=?,duracao=?,fecha=?,cor=?,observacao=? WHERE id=?`, ...campos, id);
    } else {
      const r = R(`INSERT INTO calendario_marcacao
        (nome,tipo,tipos,ambito,repeticao,data_ini,data_fim,mes,dia,offset_pascoa,duracao,fecha,cor,observacao,momento)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...campos, agora());
      id = Number(r.lastInsertRowid);
    }
    R("DELETE FROM calendario_trecho WHERE marcacao_id=?", id);
    for (const x of trechos)
      R(`INSERT INTO calendario_trecho
         (marcacao_id,ordem,modo,data_ini,data_fim,dia,mes,dia_fim,mes_fim,off_ini,off_fim,
          sem_n,sem_dow,sem_n_fim,sem_dow_fim)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, x.ordem, x.modo, x.dataIni, x.dataFim, x.dia, x.mes, x.diaFim, x.mesFim, x.offIni, x.offFim,
        x.semN, x.semDow, x.semNFim, x.semDowFim);
    return { ok: true, id, tipos: t.tipos, trechos: trechos.length, fechaForcado: t.fecha === true };
  },
  excluirMarcacao: ({ id }: any) => ({ ok: R("DELETE FROM calendario_marcacao WHERE id=?", id).changes > 0 }),
  /* `conferirFeriados` SAIU em 2026-08-17, a pedido dele: *"tira esse botão que não precisa,
     porque já tá tudo lá na fonte automática"*. E ele tem razão — a sincronização faz o mesmo
     trabalho, todo dia, com três fontes em vez de uma, e ainda registra o que encontrou. Um botão
     que refaz pior o que já roda sozinho é só mais uma coisa para o usuário decidir. */
  getArquivados() {
    const linhas: any[] = [];
    const push = (tipo: string, origem: string, r: any, rotulo: string, detalhe: string | null) =>
      linhas.push({ tipo, origem, id: r.id, rotulo, detalhe, arquivado: r.arquivado });
    for (const r of A("SELECT * FROM estoque_item WHERE arquivado IS NOT NULL"))
      push("material", "Estoque · Materiais", r, r.descricao,
        (r.livro ? "estágio " + r.livro : "avulso")
        + " · " + (G("SELECT COUNT(*) n FROM estoque_unidade WHERE item_id=?", r.id)?.n || 0) + " exemplar(es)");
    for (const r of A(`SELECT u.*, i.descricao dsc FROM estoque_unidade u
                       LEFT JOIN estoque_item i ON i.id=u.item_id WHERE u.arquivado IS NOT NULL`))
      push("exemplar", "Estoque · fila do material", r,
        (r.dsc || "material apagado") + (r.numero != null ? " nº " + r.numero : ""),
        (r.codigo ? "código " + r.codigo + " · " : "") + "entrou " + r.entrada
        + (r.entrega_id ? " · já foi entregue a um aluno" : ""));
    for (const r of A("SELECT * FROM estoque_evento WHERE arquivado IS NOT NULL"))
      push("pedido", "Estoque · Entradas", r, r.tipo + " de " + r.data,
        (r.observacao || "").slice(0, 80) || null);
    for (const r of A("SELECT * FROM estagio WHERE arquivado IS NOT NULL"))
      push("estagio", "Estágios · Catálogo", r, r.nome,
        r.sigla + " · " + (G("SELECT COUNT(*) n FROM estagio_licao WHERE dono_id=?", r.id)?.n || 0) + " lição(ões)");
    for (const r of A("SELECT * FROM estagio_modelo WHERE arquivado IS NOT NULL"))
      push("modelo", "Estágios · Modelos", r, r.nome,
        r.licoes_por_capitulo + " lições × " + r.capitulos + " blocos");
    /* mais recente primeiro: quem acabou de arquivar por engano acha na primeira linha */
    return linhas.sort((a, b) => String(b.arquivado).localeCompare(String(a.arquivado)));
  },
  arquivarRecurso({ tipo, id, desarquivar }: any) {
    const meta = ARQUIVAVEIS[tipo];
    if (!meta) throw new Error("Tipo desconhecido: " + tipo);
    /* o último modelo não pode sair de circulação: estágio sem modelo não sabe gerar estrutura */
    if (tipo === "modelo" && !desarquivar
      && (G("SELECT COUNT(*) n FROM estagio_modelo WHERE arquivado IS NULL")?.n || 0) <= 1)
      throw new Error("Tem de sobrar ao menos um modelo em uso.");
    const r = R(`UPDATE ${meta.tabela} SET arquivado=? WHERE id=?`, desarquivar ? null : agora(), id);
    if (!r.changes) throw new Error("Registro não encontrado.");
    return { ok: true };
  },
  /* EXCLUIR DE VERDADE, e só a partir do arquivo. O nome digitado tem de bater — é a trava que ele
     pediu, no estilo do GitHub. A contagem regressiva de 5s é da tela; aqui fica a checagem que
     nenhuma pressa contorna. */
  excluirArquivado({ tipo, id, confirmacao }: any) {
    const meta = ARQUIVAVEIS[tipo];
    if (!meta) throw new Error("Tipo desconhecido: " + tipo);
    const alvo = G(`SELECT * FROM ${meta.tabela} WHERE id=?`, id);
    if (!alvo) throw new Error("Registro não encontrado.");
    if (!alvo.arquivado) throw new Error("Só é possível excluir o que está arquivado.");
    const nome = String(alvo[meta.rotulo] ?? "").trim();
    if (String(confirmacao ?? "").trim() !== nome)
      throw new Error("O nome digitado não confere com \"" + nome + "\".");
    R(`DELETE FROM ${meta.tabela} WHERE id=?`, id);
    return { ok: true, nome };
  },
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

  /* ===== PERCURSO DO ALUNO =====
     A trajetória inteira: o que ele cursa agora e o que já cursou. Uma rota só, porque a tela
     mostra as duas coisas na mesma lista — separar em "atual" e "passado" faria duas chamadas para
     desenhar um único bloco. */
  getPercursoAluno({ idMatricula }: any) {
    if (!idMatricula) return [];
    /* total de lições do estágio: o mesmo cálculo do gerador da tela (extras + comuns + revisões).
       Vem do servidor para a ficha do aluno não precisar carregar o catálogo inteiro só para
       escrever "lição 34 de 71". */
    const totalDoEstagio = (estagioId: number | null) => {
      if (!estagioId) return null;
      const e = G("SELECT modelo_id FROM estagio WHERE id=?", estagioId);
      const m = e?.modelo_id ? G("SELECT * FROM estagio_modelo WHERE id=?", e.modelo_id) : null;
      if (!m) return null;
      const extras = G("SELECT COUNT(*) n FROM estagio_licao_extra WHERE estagio_id=?", estagioId)?.n || 0;
      return m.licoes_por_capitulo * m.capitulos + m.capitulos + extras;
    };
    /* em curso primeiro (é a pergunta que se faz), depois o passado do mais recente para o mais
       antigo. Sem data de início a linha vai para o fim: ela não sabe se situar na linha do tempo. */
    return A(`SELECT ae.*, e.sigla, e.nome AS estagio_nome,
                     date(ae.data_inicio,'+1 year') AS vence
              FROM aluno_estagio ae LEFT JOIN estagio e ON e.id=ae.estagio_id
              WHERE ae.id_matricula=?
              ORDER BY (ae.estado='cursando') DESC, (ae.data_inicio IS NULL),
                       ae.data_inicio DESC, ae.id DESC`, idMatricula)
      .map(r => ({
        id: r.id, livro: r.livro, estagioId: r.estagio_id,
        sigla: r.sigla || null, estagioNome: r.estagio_nome || null,
        estado: r.estado, dataInicio: r.data_inicio, dataFim: r.data_fim,
        licaoAtual: r.licao_atual, observacao: r.observacao || "",
        contratoSeq: r.contrato_seq, contrato: r.contrato_seq ? idMatricula + "/" + r.contrato_seq : null,
        /* contrato de 1 ano por livro, contando da matrícula — só existe se a data existir */
        vence: r.data_inicio ? r.vence : null,
        totalLicoes: totalDoEstagio(r.estagio_id),
        /* pista para preencher a lição atual, NÃO um palpite gravado: o lançamento de presença
           começou em julho/2026, então este número subestima quem entrou antes disso. */
        presencas: G("SELECT COUNT(*) n FROM presenca WHERE id_matricula=? AND livro=? AND status='P'",
          idMatricula, r.livro)?.n || 0,
      }));
  },
  salvarAlunoEstagio(p: any) {
    if (!p?.idMatricula || !p?.livro) throw new Error("Aluno e estágio são obrigatórios.");
    const ESTADOS = ["cursando", "encerrado", "trancado", "evadido", "cancelado"];
    const estado = p.estado || "cursando";
    if (!ESTADOS.includes(estado)) throw new Error("Estado inválido: " + estado);
    const vazio = (v: any) => (v === "" || v == null ? null : v);
    const fim = vazio(p.dataFim), ini = vazio(p.dataInicio);
    if (estado !== "cursando" && !fim) throw new Error("Estágio que não está em curso precisa da data de saída.");
    if (estado === "cursando" && fim) throw new Error("Estágio em curso não tem data de saída.");
    if (ini && fim && fim < ini) throw new Error("A data de saída não pode ser anterior à de entrada.");
    const licao = vazio(p.licaoAtual) == null ? null : Number(p.licaoAtual);
    if (licao != null && (!Number.isFinite(licao) || licao < 1)) throw new Error("A lição atual deve ser 1 ou maior.");
    try {
      if (p.id) {
        R(`UPDATE aluno_estagio SET estado=?, data_inicio=?, data_fim=?, licao_atual=?, observacao=?
           WHERE id=?`, estado, ini, fim, licao, vazio(p.observacao), p.id);
        return { ok: true, id: p.id };
      }
      const r = R(`INSERT INTO aluno_estagio (id_matricula,estagio_id,livro,estado,data_inicio,data_fim,
                   licao_atual,observacao,contrato_seq,momento) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        p.idMatricula, estagioDoLivro(p.livro), p.livro, estado, ini, fim, licao, vazio(p.observacao),
        G("SELECT contrato_seq c FROM aluno_livro WHERE id_matricula=? AND livro=?", p.idMatricula, p.livro)?.c ?? null,
        agora());
      return { ok: true, id: Number(r.lastInsertRowid) };
    } catch (e) {
      /* o índice único é PARCIAL (só sobre 'cursando'), então a mensagem crua do SQLite não diz o
         que aconteceu — traduz para o que a recepção precisa fazer */
      if (String((e as Error).message).includes("UNIQUE"))
        throw new Error("Este aluno já tem " + p.livro + " em curso. Encerre o outro registro antes de abrir mais um.");
      throw e;
    }
  },
  excluirAlunoEstagio: ({ id }: any) => ({ ok: R("DELETE FROM aluno_estagio WHERE id=?", id).changes > 0 }),

  getHorariosHistoricoAluno: ({ idMatricula }: any) =>
    A("SELECT * FROM aluno_horario_historico WHERE id_matricula=? ORDER BY momento DESC", idMatricula)
      .map(r => ({ id: r.id, livro: r.livro, antes: r.antes, depois: r.depois, momento: r.momento })),

  salvarAgendaLivro(p) { // sincroniza a agenda do aluno NESTE livro (desmarcar = remover; mesmo slot = troca de livro)
    if (!p?.itens) throw new Error("Dados incompletos.");
    const mat = getMatricula(p.idMatricula, p.livro);
    if (!mat) throw new Error("Matricule o aluno no estágio " + p.livro + " antes de definir os horários.");
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
        if (tu && tu.livro && tu.livro !== p.livro) avisos.push(it.dia + " " + it.horario + ": o aluno fica na turma " + tu.nome + " com estágio diferente — considere atualizar o estágio da turma.");
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
    if (t.livro && !lv) throw new Error("Estágio inválido: " + t.livro);
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
    if (!G("SELECT 1 FROM livros WHERE nome=?", novoLivro)) throw new Error("Estágio inválido: " + novoLivro);
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
    if (!idMatricula || !livro || !data || !hora) throw new Error("Informe aluno, estágio, data e hora.");
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
      if (!livro || !getMatricula(al.id, livro)) { avisos.push(al.nome + ": sem matrícula no estágio — ignorado."); continue; }
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
  /* quem fecha o dia, e o botão para designar esta máquina. Fica na página de Backup porque é lá
     que já mora a identidade da estação. */
  getEstacaoFecho: () => { const q = estacaoFechaODia();
    return { alvo: q.alvo, aqui: q.aqui, estaMaquinaFecha: q.pode, travado: !!q.alvo } },
  definirEstacaoFecho({ alvo }: any) {
    /* `alvo` vazio devolve o comportamento antigo (qualquer máquina fecha) */
    const v = alvo === undefined ? (() => { try { return Deno.hostname() } catch { return "" } })()
      : String(alvo || "").trim();
    R("INSERT INTO config (chave,valor) VALUES ('fecho_estacao',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor", v);
    return { ok: true, alvo: v };
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

/* ===== A SINCRONIZAÇÃO DIÁRIA (2026-08-17) =====
   Ele pediu uma atualização por dia, "umas três e meia da tarde". Não é cron nem serviço: o app é
   um processo que ele liga e desliga várias vezes ao dia, então o agendador tem de sobreviver a
   isso. A conta é feita ao contrário — a cada 10 minutos pergunta-se *"já passou da hora e ainda
   não rodou HOJE?"*. Assim:
     · reiniciar o servidor não faz rodar de novo (a marca é a DATA da última rodada);
     · ligar o app às 18h ainda pega a rodada do dia, em vez de pulá-la;
     · duas estações ligadas não duplicam nada — a segunda vê a marca da primeira no banco.
   Falha de rede não é evento: fica no `calendario_sync` e a tela mostra. */
async function tentarSyncCalendario() {
  try {
    const hora = G("SELECT valor FROM config WHERE chave='cal_sync_hora'")?.valor || "15:30";
    const agoraD = new Date();
    const hhmm = ("0" + agoraD.getHours()).slice(-2) + ":" + ("0" + agoraD.getMinutes()).slice(-2);
    if (hhmm < hora) return;
    const hoje = dataISO(agoraD);
    const ultima = G("SELECT momento FROM calendario_sync WHERE gatilho='automatico' ORDER BY id DESC LIMIT 1")?.momento;
    if (ultima && String(ultima).slice(0, 10) >= hoje) return;
    const r = await (api as any).sincronizarCalendario({ gatilho: "automatico" });
    if (r.novos) console.log(`   calendário: ${r.novos} data(s) nova(s) das fontes externas`);
  } catch (e) { console.warn("sync do calendário falhou (segue o baile):", (e as Error).message); }
}
/* 10 minutos: fino o bastante para acertar a hora escolhida, grosso o bastante para não pesar */
setInterval(tentarSyncCalendario, 10 * 60 * 1000);
setTimeout(tentarSyncCalendario, 20000);   // e uma tentativa 20s depois de subir

const PORTA = Number(Deno.env.get("WIZ_PORT")) || 8420;
Deno.serve({ port: PORTA, hostname: "0.0.0.0" }, async (req, info) => {
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
      /* `await` — sem ele, uma rota `async` devolve a Promise e o `Response.json` a serializa como
         `{}`: a tela recebe um objeto vazio e nenhum erro. `conferirFeriados` (que fala com a
         BrasilAPI) foi a primeira rota assíncrona do projeto e destapou isto. Em rota síncrona o
         `await` não custa nada, e passa a levar a exceção dela para o `catch` abaixo. */
      const resposta = await api[fn](args);
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
/* a porta ANUNCIADA tem de ser a que está escutando: com a instância de ensaio dizendo 8420 no log,
   quem lê o terminal abre o painel dele achando que abriu o teste — ou o contrário. */
console.log(`Wizard local em http://localhost:${PORTA}  (painel único: Alunos, Turmas, Horários e Impressão)`
  + (ENSAIO ? `  [ENSAIO sobre ${Deno.env.get("WIZ_DB")} — não é o banco da recepção]` : ""));
/* endereços por onde os notebooks alcançam esta máquina — a recepção precisa saber qual digitar
   nos outros computadores, e o IP do Wi-Fi muda de vez em quando */
try {
  for (const [nome, faixas] of Object.entries(Deno.networkInterfaces().reduce((m: Record<string, string[]>, i) => {
    if (i.family === "IPv4" && i.address !== "127.0.0.1") (m[i.name] ||= []).push(i.address);
    return m;
  }, {}))) console.log(`   na rede (${nome}): http://${faixas.join(" / ")}:${PORTA}`);
} catch { /* sem permissão de rede: não é essencial */ }

