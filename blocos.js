/* blocos.js — renderização dos blocos de hora (impressão + prévia ao vivo).
   Fonte única de verdade de cores/layout — usado por app.html (aba Impressão e
   painéis de prévia de Aulas/Turmas). Cores do Ficha_Recepcao_prototipo/TEMPLATE_BLOCOS_HORA.html.

   Estrutura anti-borda-órfã: uma tabela externa `.folha` pagina o conjunto (células SEM borda —
   nada vaza nas quebras de página; o thead repete a banda de título em toda folha impressa) e cada
   bloco de hora é uma <table class="ficha"> própria com break-inside:avoid — um bloco nunca é
   partido ao meio entre páginas. A versão antiga (tabela única com muitos tbody + border-collapse)
   pintava bordas soltas no topo/rodapé das páginas quando o Chrome quebrava dentro dela. */
var CORES = {
  'Conn':      { a:'#ea9999', bq:'#ea9999', sub:'#f4cccc' },
  'Vip Conn':  { a:'#ea9999', bq:'#90b5d4', sub:'#f4cccc' },
  'Inter':     { a:'#90b5d4', bq:'#90b5d4', sub:'#a6c9ec' },
  'Vip Inter': { a:'#90b5d4', bq:'#90b5d4', sub:'#a6c9ec' },
  'Kids':      { a:'#ea9999', bq:'#ffd966', sub:'#f4cccc' },
  'On':        { a:'#cccccc', bq:'#cccccc', sub:'#e6e6e6' }
};
var MESES = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO','JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];

function escBloco(t) { var d = document.createElement('div'); d.textContent = t == null ? '' : t; return d.innerHTML; }

function tituloBloco(b) {
  var dias = (b.diasTurma || []).join(' | ');
  if (b.tipoKey === 'Kids') return 'Turma Conn KIDS';
  if (b.vip) return b.mod + ' Vip' + (dias ? ' - ' + dias : '');
  if (b.mod === 'Inter') return 'Turma Inter';
  return 'Turma ' + b.mod + (dias ? ' - ' + dias : '');
}

/* colgroup do bloco: A290 B~80 C100 D~80 E-P 40×12 Q130 px. Dias (B) e Aula (D) têm a MESMA
   largura — D=60 era estreito e "Conn Vip" quebrava linha, engordando a linha do aluno. As
   larguras de A/B/C/D/Q são fixas por regra; só as colunas de presença (E-P) podem flexionar. */
function colgroupFicha() {
  var h = '<colgroup><col class="cA"><col class="cB"><col class="cC"><col class="cD">';
  for (var k = 0; k < 12; k++) h += '<col class="cE">';
  return h + '<col class="cQ"></colgroup>';
}

/* banda de título da página (ex.: SEGUNDAS e QUARTAS · JULHO): borda completa na largura da
   tabela, altura fixa, repetida no topo de cada folha impressa via thead da tabela externa. */
function bandaPagina(titulos) {
  var h = '<div class="cab-banda"><span class="cab-dias">' + escBloco(titulos[0]) + '</span>';
  if (titulos.length > 1) h += '<span class="cab-e">e</span><span class="cab-dias">' + escBloco(titulos[1]) + '</span>';
  h += '<span class="cab-mes">' + MESES[new Date().getMonth()] + '</span></div>';
  return h;
}

/* linha vazia com as 17 células REAIS (não colspan) — as 2 linhas extras de cada bloco precisam
   das bordas verticais para preencher aluno à mão na recepção. */
function linhaVaziaFicha() {
  var h = '<tr>';
  for (var k = 0; k < 17; k++) h += '<td></td>';
  return h + '</tr>';
}

/* UMA <table class="ficha"> completa por bloco de hora. compacto=true: sem as 2 linhas extras
   (prévia ao vivo embutida nos formulários — não faz sentido linha de preenchimento manual ali). */
function blocoHTML(b, opts) {
  opts = opts || {};
  var c = CORES[b.tipoKey] || CORES['Conn'];
  var vazias = ''; for (var k = 0; k < 12; k++) vazias += '<td></td>';
  var h = '<table class="ficha' + (opts.compacto ? ' compacta' : '') + '">' + colgroupFicha() + '<tbody class="bloco">';
  h += '<tr class="h1"><td class="hora" style="background:' + c.a + '">Hora: ' + escBloco(b.hora) + ' - ' + escBloco(b.fim) + '</td>';
  h += '<td class="titulo" colspan="3" style="background:' + c.bq + '">' + escBloco(tituloBloco(b)) + '</td>';
  for (var k2 = 0; k2 < 12; k2++) h += '<td style="background:' + c.bq + '"></td>';
  h += '<td class="obs" style="background:' + c.bq + '">Observações</td></tr>';
  h += '<tr class="h2" style="background:' + c.sub + '"><td style="background:' + c.sub + '">Aluno(a)</td><td style="background:' + c.sub + '">Dias</td><td style="background:' + c.sub + '">Livro</td><td style="background:' + c.sub + '">Aula</td>'
    + vazias.replace(/<td>/g, '<td style="background:' + c.sub + '">') + '<td style="background:' + c.sub + '">Professores</td></tr>';
  (b.alunos || []).forEach(function (a) {
    var tipoCel = b.vip ? (b.mod + ' Vip') : (b.tipoKey === 'Kids' ? 'Conn' : b.mod);
    h += '<tr' + (a.pendente ? ' class="pendente"' : '') + '><td class="nome">' + escBloco(a.nome) + '</td><td>' + escBloco(a.dias) + '</td><td>' + escBloco(a.livro) + '</td><td class="aula">' + escBloco(tipoCel) + '</td>' + vazias
      + '<td>' + escBloco((a.profs || []).join(', ') || (b.profs || []).join(', ')) + '</td></tr>';
  });
  if (!opts.compacto) h += linhaVaziaFicha() + linhaVaziaFicha();
  return h + '</tbody></table>';
}

/* conjunto completo (impressão em lote ou prévia). titulos=null → sem banda de página (prévia). */
function tabelaFichaHTML(blocos, titulos, opts) {
  opts = opts || {};
  var h = '<table class="folha' + (opts.compacto ? ' compacta' : '') + '">';
  if (titulos) h += '<thead><tr><td>' + bandaPagina(titulos) + '</td></tr></thead>';
  h += '<tbody>';
  (blocos || []).forEach(function (b) { h += '<tr><td>' + blocoHTML(b, opts) + '</td></tr>'; });
  return h + '</tbody></table>';
}
