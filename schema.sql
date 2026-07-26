/* schema.sql — Wizard local (SQLite). Arquitetura portada do Excel (aba Esquema), revisada contra redundância. */
PRAGMA foreign_keys = ON;

/* ===== domínios ===== */
CREATE TABLE IF NOT EXISTS config (   -- preferências do app (ex.: backup_onedrive = pasta escolhida)
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
CREATE TABLE situacoes (
  situacao TEXT PRIMARY KEY,          -- Matriculado, Rematriculado, Cancelado, Encerrado, Trancado, Evadido
  ativa    INTEGER NOT NULL DEFAULT 0 -- 1 = aluno Ativado (regra que deriva o Status)
);
CREATE TABLE dias (
  nome  TEXT PRIMARY KEY,  -- Segunda..Domingo
  curto TEXT NOT NULL,     -- Seg, Ter...
  codigo TEXT NOT NULL,    -- 2ª, 3ª... (coluna Dias das fichas)
  ordem INTEGER NOT NULL
);
CREATE TABLE livros (
  nome TEXT PRIMARY KEY,
  ordem INTEGER NOT NULL,              -- ordem de impressão (era a ordem das linhas da Lista_Livros)
  tipo_padrao TEXT NOT NULL DEFAULT 'Conn', -- Conn | Inter | On (pré-preenche a modalidade)
  kids INTEGER NOT NULL DEFAULT 0,     -- 1 = Connections Kids (TOTS, L. Kids, Kids...)
  tipo_fixo INTEGER NOT NULL DEFAULT 0 -- 1 = nunca muda de modalidade (TOTS, L. Kids)
);
CREATE TABLE prioridade (
  tipo TEXT PRIMARY KEY,               -- Inter, Conn, Vip Conn, Vip Inter, On
  prioridade INTEGER NOT NULL          -- ordena blocos na mesma hora (asc)
);
CREATE TABLE funcionarios (
  id TEXT PRIMARY KEY,
  nome_completo TEXT NOT NULL,
  nome TEXT NOT NULL UNIQUE            -- nome curto (pílulas e fichas)
);
CREATE TABLE horario_ativo (           -- a matriz de horários, normalizada (1 linha = dia × hora)
  dia  TEXT NOT NULL REFERENCES dias(nome),
  hora TEXT NOT NULL,                  -- 'HH:MM' (início; aula dura 1h)
  ativo INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (dia, hora)
);

/* ===== núcleo ===== */
CREATE TABLE alunos (
  id_matricula TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  situacao TEXT NOT NULL REFERENCES situacoes(situacao)
  -- SEM coluna status: é derivado (v_alunos) — era redundante na planilha
);
CREATE TABLE turmas (                  -- turma = SALA (professora+dias+horário); sem opinião sobre
  id TEXT PRIMARY KEY,                 -- modalidade/VIP — isso é do aluno agora (tabela aluno_livro)
  livro TEXT REFERENCES livros(nome),  -- NULL = turma Inter (multi-livro); obrigatório p/ Conn (regra no app)
  hora_inicio TEXT NOT NULL,
  hora_fim TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Ativa',
  CHECK (hora_fim > hora_inicio)       -- validador de horário impossível, agora no banco
);
CREATE TABLE aluno_livro (             -- matrícula do aluno num livro: fonte da verdade de
  id_matricula TEXT NOT NULL REFERENCES alunos(id_matricula) ON DELETE CASCADE,  -- modalidade/VIP/tipo de encontro (não a turma)
  livro TEXT NOT NULL REFERENCES livros(nome),
  modalidade TEXT NOT NULL CHECK (modalidade IN ('Conn','Inter','On')),
  vip INTEGER NOT NULL DEFAULT 0 CHECK (vip IN (0,1)), -- VIP = sem turma (regra aplicada no app)
  tipo_encontro TEXT NOT NULL DEFAULT 'Presencial' CHECK (tipo_encontro IN ('Presencial','Online')),
  PRIMARY KEY (id_matricula, livro)
);
CREATE TABLE turma_dia (               -- era o texto 'Terça+Quinta' — normalizado
  turma_id TEXT NOT NULL REFERENCES turmas(id) ON DELETE CASCADE,
  dia TEXT NOT NULL REFERENCES dias(nome),
  PRIMARY KEY (turma_id, dia)
);
CREATE TABLE turma_professor (         -- professora faz parte da IDENTIDADE da turma (desempata gêmeas)
  turma_id TEXT NOT NULL REFERENCES turmas(id) ON DELETE CASCADE,
  funcionario_id TEXT NOT NULL REFERENCES funcionarios(id),
  PRIMARY KEY (turma_id, funcionario_id)
);
CREATE TABLE aulas (                   -- combinatória: 1 linha = aluno × dia × hora (por livro)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  id_matricula TEXT NOT NULL REFERENCES alunos(id_matricula) ON DELETE CASCADE,
  dia  TEXT NOT NULL REFERENCES dias(nome),
  hora TEXT NOT NULL,
  livro TEXT NOT NULL REFERENCES livros(nome),
  UNIQUE (id_matricula, dia, hora),    -- um aluno não está em dois lugares na mesma hora
  FOREIGN KEY (id_matricula, livro) REFERENCES aluno_livro(id_matricula, livro) ON DELETE CASCADE
  -- precisa matricular no livro (aluno_livro) antes de marcar dia/hora nele
  -- SEM nome do aluno e SEM id_funcionario gravados: eram cópias redundantes na planilha
);
CREATE TABLE aula_professor (
  aula_id INTEGER NOT NULL REFERENCES aulas(id) ON DELETE CASCADE,
  funcionario_id TEXT NOT NULL REFERENCES funcionarios(id),
  PRIMARY KEY (aula_id, funcionario_id)
);
CREATE TABLE IF NOT EXISTS presenca (  -- lançador de presença: 1 linha = aluno × livro × DIA
  id_matricula TEXT NOT NULL REFERENCES alunos(id_matricula) ON DELETE CASCADE,
  livro TEXT NOT NULL,                 -- texto solto de propósito: trocar de livro não apaga frequência
  data TEXT NOT NULL CHECK (data GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('P','F','N')), -- Presente | Falta | Não aula (não conta pra nada)
  entrada TEXT CHECK (entrada IS NULL OR entrada GLOB '[0-2][0-9]:[0-5][0-9]'), -- check-in na recepção
  saida   TEXT CHECK (saida   IS NULL OR saida   GLOB '[0-2][0-9]:[0-5][0-9]'), -- check-out
  minutos INTEGER GENERATED ALWAYS AS (   -- duração da aula: derivada, nunca dessincroniza
    CASE WHEN entrada IS NOT NULL AND saida IS NOT NULL THEN
      (CAST(substr(saida,1,2) AS INTEGER)*60 + CAST(substr(saida,4,2) AS INTEGER))
    - (CAST(substr(entrada,1,2) AS INTEGER)*60 + CAST(substr(entrada,4,2) AS INTEGER)) END) VIRTUAL,
  CHECK (saida IS NULL OR entrada IS NOT NULL),  -- não existe saída sem entrada
  CHECK (saida IS NULL OR saida >= entrada),     -- saída nunca antes da entrada
  CHECK (status='P' OR entrada IS NULL),         -- só quem esteve presente tem ponto
  PRIMARY KEY (id_matricula, livro, data)
);
CREATE TABLE aluno_situacao_historico (  -- linha do tempo manual: quando o aluno entrou em cada situação
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  id_matricula TEXT NOT NULL REFERENCES alunos(id_matricula) ON DELETE CASCADE,
  situacao TEXT NOT NULL REFERENCES situacoes(situacao),
  data TEXT NOT NULL                     -- 'AAAA-MM-DD', digitada manualmente pela recepção
);

/* ===== índices ===== (o banco nasceu sem nenhum: toda consulta era varredura de tabela) */
CREATE INDEX IF NOT EXISTS ix_aulas_matricula ON aulas(id_matricula);
CREATE INDEX IF NOT EXISTS ix_aulas_dia_hora ON aulas(dia, hora);
CREATE INDEX IF NOT EXISTS ix_aulas_livro ON aulas(id_matricula, livro);
CREATE INDEX IF NOT EXISTS ix_presenca_data ON presenca(data);
CREATE INDEX IF NOT EXISTS ix_presenca_matricula ON presenca(id_matricula);
CREATE INDEX IF NOT EXISTS ix_aula_prof_func ON aula_professor(funcionario_id);
CREATE INDEX IF NOT EXISTS ix_turma_dia_dia ON turma_dia(dia);
CREATE INDEX IF NOT EXISTS ix_aluno_livro_livro ON aluno_livro(livro);
CREATE INDEX IF NOT EXISTS ix_hist_matricula ON aluno_situacao_historico(id_matricula);
CREATE UNIQUE INDEX IF NOT EXISTS ux_hist_unico ON aluno_situacao_historico(id_matricula, situacao, data);

/* ===== derivados (as fórmulas da planilha viram VIEWs) ===== */
CREATE VIEW v_alunos AS                -- Status derivado da situação
  SELECT a.id_matricula, a.nome, a.situacao,
         CASE WHEN s.ativa=1 THEN 'Ativado' ELSE 'Desativado' END AS status
  FROM alunos a JOIN situacoes s ON s.situacao=a.situacao;
/* Nome_Turma não é mais VIEW: precisa da modalidade ATUAL dos integrantes (aluno_livro), calculada em
   JS (main.ts: turmaObj/modalidadeDaTurma) — turmas não guardam mais modalidade própria. */