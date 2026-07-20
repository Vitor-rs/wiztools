/* blocos.js — renderização dos blocos de hora (impressão + prévia ao vivo).
   Fonte única de verdade de cores/layout — usado por app.html (aba Impressão e
   painéis de prévia de Aulas/Turmas). Espelha as cores/medidas do
   Ficha_Recepcao_prototipo/TEMPLATE_BLOCOS_HORA.html. */
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

/* colgroup padrão do template: A290 B100 C100 D60 E-P 40×12 Q130 px */
function colgroupFicha() {
  var h = '<colgroup><col class="cA"><col class="cB"><col class="cC"><col class="cD">';
  for (var k = 0; k < 12; k++) h += '<col class="cE">';
  return h + '<col class="cQ"></colgroup>';
}

/* cabeçalho de página: repete no início de cada página impressa (thead) */
function cabecalhoFicha(titulos) {
  var h = '<thead class="pagina"><tr><td class="dias1" style="text-align:right">' + escBloco(titulos[0]) + '</td>';
  h += titulos.length > 1
    ? '<td class="dias1" style="text-align:center">e</td><td class="dias1" colspan="2">' + escBloco(titulos[1]) + '</td>'
    : '<td colspan="3"></td>';
  for (var k = 0; k < 8; k++) h += '<td></td>';
  h += '<td class="mes" colspan="4">' + MESES[new Date().getMonth()] + '</td><td></td></tr>';
  h += '<tr><td colspan="17" style="height:26px"></td></tr></thead>';
  return h;
}

/* HTML de UM bloco de hora (tbody). compacto=true: sem as 2 linhas extras nem o espaçamento entre blocos
   (usado na prévia ao vivo, embutida nos formulários — não faz sentido paginar ali). */
function blocoHTML(b, opts) {
  opts = opts || {};
  var c = CORES[b.tipoKey] || CORES['Conn'];
  var vazias = ''; for (var k = 0; k < 12; k++) vazias += '<td></td>';
  var h = '<tbody class="bloco">';
  h += '<tr class="h1"><td class="hora" style="background:' + c.a + '">Hora: ' + escBloco(b.hora) + ' - ' + escBloco(b.fim) + '</td>';
  h += '<td class="titulo" colspan="3" style="background:' + c.bq + '">' + escBloco(tituloBloco(b)) + '</td>';
  for (var k2 = 0; k2 < 12; k2++) h += '<td style="background:' + c.bq + '"></td>';
  h += '<td class="obs" style="background:' + c.bq + '">Observações</td></tr>';
  h += '<tr class="h2" style="background:' + c.sub + '"><td style="background:' + c.sub + '">Aluno(a)</td><td style="background:' + c.sub + '">Dias</td><td style="background:' + c.sub + '">Livro</td><td style="background:' + c.sub + '">Aula</td>'
    + vazias.replace(/<td>/g, '<td style="background:' + c.sub + '">') + '<td style="background:' + c.sub + '">Professores</td></tr>';
  (b.alunos || []).forEach(function (a) {
    var tipoCel = b.vip ? (b.mod + ' Vip') : (b.tipoKey === 'Kids' ? 'Conn' : b.mod);
    h += '<tr' + (a.pendente ? ' class="pendente"' : '') + '><td class="nome">' + escBloco(a.nome) + '</td><td>' + escBloco(a.dias) + '</td><td>' + escBloco(a.livro) + '</td><td>' + escBloco(tipoCel) + '</td>' + vazias
      + '<td>' + escBloco((a.profs || []).join(', ') || (b.profs || []).join(', ')) + '</td></tr>';
  });
  if (!opts.compacto) h += '<tr><td colspan="17" style="height:20px"></td></tr><tr><td colspan="17" style="height:20px"></td></tr>';
  h += '</tbody>';
  if (!opts.compacto) h += '<tbody class="esp"><tr><td colspan="17"></td></tr><tr><td colspan="17"></td></tr><tr><td colspan="17"></td></tr></tbody>';
  return h;
}

/* tabela completa (impressão em lote ou prévia). titulos=null → sem cabeçalho de página (uso em prévia). */
function tabelaFichaHTML(blocos, titulos, opts) {
  opts = opts || {};
  var h = '<table class="ficha' + (opts.compacto ? ' compacta' : '') + '">' + colgroupFicha();
  if (titulos) h += cabecalhoFicha(titulos);
  (blocos || []).forEach(function (b) { h += blocoHTML(b, opts); });
  return h + '</table>';
}
