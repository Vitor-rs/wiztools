/* schema.sql — Wizard local (SQLite). Arquitetura portada do Excel (aba Esquema), revisada contra redundância. */
PRAGMA foreign_keys = ON;

/* ===== domínios ===== */
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
CREATE TABLE turmas (
  id TEXT PRIMARY KEY,                 -- T001...
  livro TEXT REFERENCES livros(nome),  -- NULL = turma Inter (multi-livro); obrigatório p/ Conn (regra no app)
  modalidade TEXT NOT NULL,            -- Conn | Inter | On
  vip INTEGER NOT NULL DEFAULT 0,      -- VIP = sem conceito de turma (nome VIP-)
  hora_inicio TEXT NOT NULL,
  hora_fim TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Ativa',
  CHECK (hora_fim > hora_inicio)       -- validador de horário impossível, agora no banco
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
  UNIQUE (id_matricula, dia, hora)     -- um aluno não está em dois lugares na mesma hora
  -- SEM nome do aluno e SEM id_funcionario gravados: eram cópias redundantes na planilha
);
CREATE TABLE aula_professor (
  aula_id INTEGER NOT NULL REFERENCES aulas(id) ON DELETE CASCADE,
  funcionario_id TEXT NOT NULL REFERENCES funcionarios(id),
  PRIMARY KEY (aula_id, funcionario_id)
);

/* ===== derivados (as fórmulas da planilha viram VIEWs) ===== */
CREATE VIEW v_alunos AS                -- Status derivado da situação
  SELECT a.id_matricula, a.nome, a.situacao,
         CASE WHEN s.ativa=1 THEN 'Ativado' ELSE 'Desativado' END AS status
  FROM alunos a JOIN situacoes s ON s.situacao=a.situacao;
CREATE VIEW v_turma_nome AS            -- mesma regra do Nome_Turma (VIP-/Tur- + MOD + livro? + dias + horas + profs)
  SELECT t.id,
         (CASE WHEN t.vip=1 THEN 'VIP-' ELSE 'Tur-' END) || UPPER(t.modalidade)
         || COALESCE(' | '||t.livro,'')
         || ' | ' || COALESCE((SELECT GROUP_CONCAT(td.dia,'+') FROM turma_dia td WHERE td.turma_id=t.id),'')
         || ' | ' || t.hora_inicio || '-' || t.hora_fim
         || COALESCE(' | '||(SELECT GROUP_CONCAT(f.nome,'/') FROM turma_professor tp JOIN funcionarios f ON f.id=tp.funcionario_id WHERE tp.turma_id=t.id),'')
         AS nome
  FROM turmas t;
CREATE VIEW v_tipo_aula AS             -- Tipo_Aula derivado (p/ prioridade dos blocos)
  SELECT id, CASE WHEN vip=1 THEN 'Vip '||modalidade ELSE modalidade END AS tipo FROM turmas;