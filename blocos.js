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
   larguras de A/B/C/D/Q são fixas por regra; as 12 de presença são estreitas e em número FIXO:
   sobra sempre coluna vazia para lançar reposição/anteposição que aparecer depois. */
var COLUNAS_FICHA = 12;
function colgroupFicha() {
  var h = '<colgroup><col class="cA"><col class="cB"><col class="cC"><col class="cD">';
  for (var k = 0; k < COLUNAS_FICHA; k++) h += '<col class="cE">';
  return h + '<col class="cQ"></colgroup>';
}
/* marca impressa a partir do que foi lançado no app: P presente, X falta, – não aula
   (não aula não conta como presença nem falta; em branco = ainda não lançado, preenche à mão) */
function marcaImpressa(st) { return st === 'P' ? 'P' : st === 'F' ? 'X' : st === 'N' ? '–' : ''; }

/* banda de título da página (ex.: SEGUNDAS e QUARTAS · JULHO): borda completa na largura da
   tabela, altura fixa, repetida no topo de cada folha impressa via thead da tabela externa. */
function bandaPagina(titulos, mesNome) {
  var h = '<div class="cab-banda"><span class="cab-dias">' + escBloco(titulos[0]) + '</span>';
  if (titulos.length > 1) h += '<span class="cab-e">e</span><span class="cab-dias">' + escBloco(titulos[1]) + '</span>';
  h += '<span class="cab-mes">' + escBloco(mesNome || MESES[new Date().getMonth()]) + '</span></div>';
  return h;
}

/* linha vazia com as células REAIS (não colspan) — as 2 linhas extras de cada bloco precisam
   das bordas verticais para preencher aluno à mão na recepção. */
function linhaVaziaFicha() {
  var h = '<tr>';
  for (var k = 0; k < COLUNAS_FICHA + 5; k++) h += '<td></td>'; // A B C D + 12 datas + Q
  return h + '</tr>';
}

/* UMA <table class="ficha"> completa por bloco de hora. compacto=true: sem as 2 linhas extras
   (prévia ao vivo embutida nos formulários — não faz sentido linha de preenchimento manual ali).
   São SEMPRE 12 colunas estreitas: as primeiras trazem as datas que já têm lançamento (b.colunas,
   em ordem cronológica, incluindo reposição/anteposição em dia fora do grupo) e as demais saem
   totalmente em branco, pra recepção escrever à mão o que ainda vier. Sem b.colunas (prévias ao
   vivo) as 12 saem em branco, exatamente como antes. */
function blocoHTML(b, opts) {
  opts = opts || {};
  var cols = b.colunas || [];
  var c = CORES[b.tipoKey] || CORES['Conn'];
  var h = '<table class="ficha' + (opts.compacto ? ' compacta' : '') + '">' + colgroupFicha() + '<tbody class="bloco">';
  h += '<tr class="h1"><td class="hora" style="background:' + c.a + '">Hora: ' + escBloco(b.hora) + ' - ' + escBloco(b.fim) + '</td>';
  h += '<td class="titulo" colspan="3" style="background:' + c.bq + '">' + escBloco(tituloBloco(b)) + '</td>';
  for (var k2 = 0; k2 < COLUNAS_FICHA; k2++)  // cabeçalho de cima: dia da semana daquela data
    h += '<td class="dt" style="background:' + c.bq + '">' + (cols[k2] ? escBloco(cols[k2].codigo) : '') + '</td>';
  h += '<td class="obs" style="background:' + c.bq + '">Observações</td></tr>';
  h += '<tr class="h2" style="background:' + c.sub + '"><td style="background:' + c.sub + '">Aluno(a)</td><td style="background:' + c.sub + '">Dias</td><td style="background:' + c.sub + '">Livro</td><td style="background:' + c.sub + '">Aula</td>';
  for (var k3 = 0; k3 < COLUNAS_FICHA; k3++)  // cabeçalho de baixo: número do dia do mês
    h += '<td class="dtn" style="background:' + c.sub + '">' + (cols[k3] ? cols[k3].numero : '') + '</td>';
  h += '<td style="background:' + c.sub + '">Professores</td></tr>';
  (b.alunos || []).forEach(function (a) {
    var tipoCel = b.vip ? (b.mod + ' Vip') : (b.tipoKey === 'Kids' ? 'Conn' : b.mod);
    h += '<tr' + (a.pendente ? ' class="pendente"' : '') + '><td class="nome">' + escBloco(a.nome) + '</td><td>' + escBloco(a.dias) + '</td><td>' + escBloco(a.livro) + '</td><td class="aula">' + escBloco(tipoCel) + '</td>';
    for (var k4 = 0; k4 < COLUNAS_FICHA; k4++) {  // marca já lançada no app (reimpressão não perde o que foi preenchido)
      var st = (cols[k4] && a.presencas) ? a.presencas[cols[k4].data] : null;
      h += '<td class="marca' + (st ? ' m-' + st : '') + '">' + marcaImpressa(st) + '</td>';
    }
    h += '<td>' + escBloco((a.profs || []).join(', ') || (b.profs || []).join(', ')) + '</td></tr>';
  });
  if (!opts.compacto) h += linhaVaziaFicha() + linhaVaziaFicha();
  return h + '</tbody></table>';
}

/* conjunto completo (impressão em lote ou prévia). titulos=null → sem banda de página (prévia). */
function tabelaFichaHTML(blocos, titulos, opts) {
  opts = opts || {};
  var h = '<table class="folha' + (opts.compacto ? ' compacta' : '') + '">';
  if (titulos) h += '<thead><tr><td>' + bandaPagina(titulos, opts.mesNome) + '</td></tr></thead>';
  h += '<tbody>';
  (blocos || []).forEach(function (b) { h += '<tr><td>' + blocoHTML(b, opts) + '</td></tr>'; });
  return h + '</tbody></table>';
}
