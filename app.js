'use strict';

/*
 * Meu Ponto — registro pessoal de ponto.
 * Interface e regras de cálculo. Login e gravação na nuvem ficam em auth.js.
 */

const DIAS_CURTOS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const ORDEM_DIAS = [1, 2, 3, 4, 5, 6, 0];
const TIPOS = { falta: 'Falta', atestado: 'Atestado médico', folga: 'Folga / feriado' };
const MAX_REGISTRO = 24 * 60;

/* ============================== Datas ============================== */

const pad = n => String(n).padStart(2, '0');
const dataISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dataHoraLocal = d => `${dataISO(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const mesISO = d => dataISO(d).slice(0, 7);

function lerData(s) {
  const [a, m, d] = s.split('-').map(Number);
  return new Date(a, m - 1, d);
}

function lerDataHora(s) {
  const [data, hora] = s.split('T');
  const [a, m, d] = data.split('-').map(Number);
  const [h, mi] = hora.split(':').map(Number);
  return new Date(a, m - 1, d, h, mi);
}

const minutosDoDia = hhmm => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const diffMin = (inicio, fim) => Math.round((lerDataHora(fim) - lerDataHora(inicio)) / 60000);
const horaDe = s => s.slice(11, 16);

function fmtData(s) {
  const d = lerData(s);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
const fmtDataHora = s => `${fmtData(s.slice(0, 10))} ${horaDe(s)}`;
const fmtIso = iso => (iso ? new Date(iso).toLocaleString('pt-BR') : '—');

function fmtDuracao(min, comSinal = false) {
  const abs = Math.abs(min);
  const texto = `${Math.floor(abs / 60)}h${pad(abs % 60)}`;
  if (min < 0) return `−${texto}`;
  return comSinal && min > 0 ? `+${texto}` : texto;
}

function nomeMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  const s = new Date(a, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return s[0].toUpperCase() + s.slice(1);
}

function diasDoMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  const total = new Date(a, m, 0).getDate();
  return Array.from({ length: total }, (_, i) => `${mes}-${pad(i + 1)}`);
}

/* ============================== Estado ============================== */

function estadoPadrao() {
  return {
    config: {
      definida: false, inicio: '08:00', fim: '17:00', almocoInicio: '12:00', almocoFim: '13:15',
      tolerancia: 10, dias: [1, 2, 3, 4, 5],
    },
    registros: [],
    ocorrencias: [],
  };
}

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_DATA_HORA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const RE_HORA = /^\d{2}:\d{2}$/;

// Aceita dados da nuvem ou de um backup, descartando o que estiver malformado.
function normalizar(bruto) {
  const padrao = estadoPadrao();
  const cfg = { ...padrao.config, ...(bruto && typeof bruto.config === 'object' ? bruto.config : {}) };
  if (!RE_HORA.test(cfg.inicio)) cfg.inicio = padrao.config.inicio;
  if (!RE_HORA.test(cfg.fim)) cfg.fim = padrao.config.fim;
  // Vazio = sem almoço. Dados antigos (só com "intervalo" em minutos) recebem o horário padrão.
  if (cfg.almocoInicio !== '' && !RE_HORA.test(cfg.almocoInicio)) cfg.almocoInicio = padrao.config.almocoInicio;
  if (cfg.almocoFim !== '' && !RE_HORA.test(cfg.almocoFim)) cfg.almocoFim = padrao.config.almocoFim;
  delete cfg.intervalo;
  cfg.tolerancia = Math.max(0, Number(cfg.tolerancia) || 0);
  cfg.dias = Array.isArray(cfg.dias) ? cfg.dias.filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : padrao.config.dias;

  const registros = (Array.isArray(bruto?.registros) ? bruto.registros : []).filter(r =>
    r && typeof r.id === 'string' && RE_DATA_HORA.test(r.entrada) && (r.saida == null || RE_DATA_HORA.test(r.saida)));
  registros.forEach(r => { if (r.saida === undefined) r.saida = null; });

  const ocorrencias = (Array.isArray(bruto?.ocorrencias) ? bruto.ocorrencias : []).filter(o =>
    o && typeof o.id === 'string' && RE_DATA.test(o.data) && o.tipo in TIPOS);

  return { config: cfg, registros, ocorrencias };
}

// A gravação é feita pela sessão autenticada (auth.js); sem login, nada é salvo.
function salvar() {
  if (!persistir) return;
  persistir(estado).catch(() => avisar('Não foi possível salvar na nuvem. Verifique sua conexão.', true));
}

const novoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

let estado = estadoPadrao();
let persistir = null;
let editandoId = null;

/* ============================== Cálculos ============================== */

const temAlmoco = cfg => RE_HORA.test(cfg.almocoInicio) && RE_HORA.test(cfg.almocoFim) &&
  minutosDoDia(cfg.almocoFim) > minutosDoDia(cfg.almocoInicio);

const duracaoAlmoco = cfg => (temAlmoco(cfg) ? minutosDoDia(cfg.almocoFim) - minutosDoDia(cfg.almocoInicio) : 0);

// Minutos do período [inicio, fim) que caem dentro do horário de almoço de cada dia que ele toca.
function minutosNoAlmoco(inicio, fim, cfg = estado.config) {
  if (!temAlmoco(cfg)) return 0;
  let total = 0;
  const dia = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate());
  while (dia < fim) {
    const janelaIni = new Date(dia);
    janelaIni.setMinutes(minutosDoDia(cfg.almocoInicio));
    const janelaFim = new Date(dia);
    janelaFim.setMinutes(minutosDoDia(cfg.almocoFim));
    total += Math.max(0, Math.min(fim, janelaFim) - Math.max(inicio, janelaIni));
    dia.setDate(dia.getDate() + 1);
  }
  return Math.round(total / 60000);
}

function jornadaPrevista(cfg = estado.config) {
  const inicio = new Date(2000, 0, 3);
  inicio.setMinutes(minutosDoDia(cfg.inicio));
  const fim = new Date(2000, 0, 3);
  fim.setMinutes(minutosDoDia(cfg.fim));
  if (fim <= inicio) fim.setDate(fim.getDate() + 1); // turno que vira a noite
  return Math.max(0, Math.round((fim - inicio) / 60000) - minutosNoAlmoco(inicio, fim, cfg));
}

function registrosDoDia(data) {
  return estado.registros
    .filter(r => r.entrada.slice(0, 10) === data)
    .sort((a, b) => a.entrada.localeCompare(b.entrada));
}

const registroAberto = () => estado.registros.find(r => !r.saida) || null;

function resumoDia(data, hoje = dataISO(new Date())) {
  const cfg = estado.config;
  const diaUtil = cfg.dias.includes(lerData(data).getDay());
  const registros = registrosDoDia(data);
  const ocorrencia = estado.ocorrencias.find(o => o.data === data) || null;
  const fechados = registros.filter(r => r.saida);
  const emAndamento = registros.some(r => !r.saida);

  // Tempo dentro do horário de almoço não conta, tenha ou não sido batido o ponto do almoço.
  const almoco = fechados.reduce((soma, r) => soma + minutosNoAlmoco(lerDataHora(r.entrada), lerDataHora(r.saida)), 0);
  const trabalhado = fechados.reduce((soma, r) => soma + diffMin(r.entrada, r.saida), 0) - almoco;

  let atraso = 0;
  if (diaUtil && !ocorrencia && registros.length) {
    const passou = minutosDoDia(horaDe(registros[0].entrada)) - minutosDoDia(cfg.inicio);
    if (passou > cfg.tolerancia) atraso = passou;
  }

  let status;
  let esperado = 0;
  let contaSaldo = false;
  if (ocorrencia) {
    status = ocorrencia.tipo;
    // Falta gera débito da jornada; atestado e folga abonam o dia.
    esperado = ocorrencia.tipo === 'falta' && diaUtil ? jornadaPrevista() : 0;
    contaSaldo = true;
  } else if (registros.length) {
    status = emAndamento ? 'andamento' : 'trabalhado';
    esperado = diaUtil ? jornadaPrevista() : 0;
    contaSaldo = !emAndamento;
  } else if (!diaUtil) {
    status = 'descanso';
  } else if (data > hoje) {
    status = 'futuro';
  } else if (data === hoje) {
    status = 'hoje';
  } else {
    status = 'sem-registro';
  }

  const saldo = contaSaldo ? trabalhado - esperado : 0;
  return { data, diaUtil, registros, ocorrencia, trabalhado, almoco, emAndamento, atraso, status, esperado, saldo };
}

function resumoMes(mes) {
  const hoje = dataISO(new Date());
  const dias = diasDoMes(mes).map(d => resumoDia(d, hoje));
  const r = { dias, trabalhado: 0, saldo: 0, diasTrabalhados: 0, minutosAtraso: 0, atrasos: [], faltas: [], atestados: [], folgas: [], semRegistro: [] };
  for (const d of dias) {
    r.trabalhado += d.trabalhado;
    r.saldo += d.saldo;
    if (d.registros.length) r.diasTrabalhados++;
    if (d.atraso) { r.atrasos.push(d); r.minutosAtraso += d.atraso; }
    if (d.status === 'falta') r.faltas.push(d);
    if (d.status === 'atestado') r.atestados.push(d);
    if (d.status === 'folga') r.folgas.push(d);
    if (d.status === 'sem-registro') r.semRegistro.push(d);
  }
  return r;
}

const ROTULO_STATUS = {
  trabalhado: 'Normal', andamento: 'Em andamento', descanso: 'Descanso', futuro: '',
  hoje: 'Hoje', 'sem-registro': 'Sem registro', falta: 'Falta', atestado: 'Atestado', folga: 'Folga / feriado',
};

/* ============================== Ações ============================== */

function baterPonto() {
  const agora = new Date();
  const agoraStr = dataHoraLocal(agora);
  const aberto = registroAberto();

  if (aberto) {
    const duracao = diffMin(aberto.entrada, agoraStr);
    if (duracao < 1) {
      avisar('Aguarde ao menos 1 minuto entre a entrada e a saída.', true);
      return;
    }
    if (duracao > MAX_REGISTRO) {
      avisar(`A entrada de ${fmtDataHora(aberto.entrada)} ficou aberta por mais de 24h. Corrija a saída em Registros.`, true);
      iniciarEdicao(aberto.id);
      return;
    }
    aberto.saida = agoraStr;
    aberto.saidaOrigem = 'agora';
    aberto.saidaRegistradaEm = agora.toISOString();
    avisar(`Saída registrada às ${horaDe(agoraStr)}.`);
  } else {
    estado.registros.push({
      id: novoId(),
      entrada: agoraStr,
      saida: null,
      obs: '',
      entradaOrigem: 'agora',
      entradaRegistradaEm: agora.toISOString(),
    });
    avisar(`Entrada registrada às ${horaDe(agoraStr)}.`);
  }
  salvar();
  renderizarTudo();
}

function validarRegistro(entrada, saida, ignorarId) {
  if (!RE_DATA_HORA.test(entrada)) return 'Informe a data e a hora de entrada.';
  const agora = new Date();
  if (lerDataHora(entrada) > agora) return 'A entrada não pode estar no futuro.';
  if (saida) {
    const duracao = diffMin(entrada, saida);
    if (duracao <= 0) return 'A saída precisa ser depois da entrada.';
    if (duracao > MAX_REGISTRO) return 'Um registro não pode passar de 24 horas.';
    if (lerDataHora(saida) > agora) return 'A saída não pode estar no futuro.';
  } else if (estado.registros.some(r => !r.saida && r.id !== ignorarId)) {
    return 'Já existe um registro sem saída. Feche-o antes de abrir outro.';
  }

  const ini = lerDataHora(entrada);
  const fim = saida ? lerDataHora(saida) : ini;
  for (const r of estado.registros) {
    if (r.id === ignorarId) continue;
    const rIni = lerDataHora(r.entrada);
    const rFim = r.saida ? lerDataHora(r.saida) : rIni;
    // Registro sem saída conta como um ponto no tempo (início = fim).
    const sobrepoe = (ini < rFim && rIni < fim) || +ini === +rIni;
    if (sobrepoe) return `Esse horário se sobrepõe ao registro de ${fmtDataHora(r.entrada)}.`;
  }
  return null;
}

// Junta os campos separados de data e hora no formato salvo ("AAAA-MM-DDTHH:MM").
function lerCamposRegistro() {
  const entradaData = $('#reg-entrada-data').value;
  const entradaHora = $('#reg-entrada-hora').value;
  const saidaData = $('#reg-saida-data').value;
  const saidaHora = $('#reg-saida-hora').value;

  if (!entradaData || !entradaHora) return { erro: 'Informe a data e a hora de entrada.' };
  if (saidaData && !saidaHora) return { erro: 'Informe a hora de saída ou apague a data de saída.' };

  return {
    entrada: `${entradaData}T${entradaHora}`,
    saida: saidaHora ? `${saidaData || entradaData}T${saidaHora}` : null,
  };
}

function preencherCamposRegistro(entrada, saida) {
  $('#reg-entrada-data').value = entrada ? entrada.slice(0, 10) : '';
  $('#reg-entrada-hora').value = entrada ? horaDe(entrada) : '';
  $('#reg-saida-data').value = saida ? saida.slice(0, 10) : '';
  $('#reg-saida-hora').value = saida ? horaDe(saida) : '';
}

function salvarRegistro(evento) {
  evento.preventDefault();
  const { entrada, saida, erro: erroCampos } = lerCamposRegistro();
  if (erroCampos) { avisar(erroCampos, true); return; }
  const obs = $('#reg-obs').value.trim();

  const erro = validarRegistro(entrada, saida, editandoId);
  if (erro) { avisar(erro, true); return; }

  const agoraIso = new Date().toISOString();
  if (editandoId) {
    const r = estado.registros.find(x => x.id === editandoId);
    if (r.entrada !== entrada) {
      r.entrada = entrada;
      r.entradaOrigem = 'manual';
      r.entradaRegistradaEm = agoraIso;
    }
    if (r.saida !== saida) {
      r.saida = saida;
      r.saidaOrigem = saida ? 'manual' : null;
      r.saidaRegistradaEm = saida ? agoraIso : null;
    }
    r.obs = obs;
    r.editadoEm = agoraIso;
    avisar('Registro atualizado.');
  } else {
    estado.registros.push({
      id: novoId(),
      entrada,
      saida,
      obs,
      entradaOrigem: 'manual',
      entradaRegistradaEm: agoraIso,
      saidaOrigem: saida ? 'manual' : null,
      saidaRegistradaEm: saida ? agoraIso : null,
    });
    avisar('Registro salvo.');
  }
  salvar();
  cancelarEdicao();
  $('#hist-mes').value = entrada.slice(0, 7);
  renderizarTudo();
}

function iniciarEdicao(id) {
  const r = estado.registros.find(x => x.id === id);
  if (!r) return;
  editandoId = id;
  preencherCamposRegistro(r.entrada, r.saida);
  $('#reg-obs').value = r.obs || '';
  $('#titulo-form-registro').textContent = `Editando registro de ${fmtData(r.entrada.slice(0, 10))}`;
  $('#btn-cancelar-edicao').hidden = false;
  abrirAba('registros');
  $('#cartao-form-registro').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelarEdicao() {
  editandoId = null;
  $('#form-registro').reset();
  preencherCamposRegistro(dataHoraLocal(new Date()), null);
  $('#titulo-form-registro').textContent = 'Registro manual';
  $('#btn-cancelar-edicao').hidden = true;
}

function excluirRegistro(id) {
  const r = estado.registros.find(x => x.id === id);
  if (!r || !confirm(`Excluir o registro de entrada ${fmtDataHora(r.entrada)}?`)) return;
  estado.registros = estado.registros.filter(x => x.id !== id);
  if (editandoId === id) cancelarEdicao();
  salvar();
  renderizarTudo();
  avisar('Registro excluído.');
}

function salvarOcorrencia(evento) {
  evento.preventDefault();
  const data = $('#oc-data').value;
  const tipo = $('#oc-tipo').value;
  const obs = $('#oc-obs').value.trim();
  if (!RE_DATA.test(data)) { avisar('Informe a data.', true); return; }

  const existente = estado.ocorrencias.find(o => o.data === data);
  if (existente && !confirm(`Já existe "${TIPOS[existente.tipo]}" em ${fmtData(data)}. Substituir?`)) return;
  if (tipo === 'falta' && registrosDoDia(data).length &&
      !confirm('Há registros de ponto nesse dia. Marcar como falta mesmo assim?')) return;

  estado.ocorrencias = estado.ocorrencias.filter(o => o.data !== data);
  estado.ocorrencias.push({ id: novoId(), data, tipo, obs, registradoEm: new Date().toISOString() });
  salvar();
  $('#form-ocorrencia').reset();
  $('#oc-data').value = dataISO(new Date());
  $('#hist-mes').value = data.slice(0, 7);
  renderizarTudo();
  avisar(`${TIPOS[tipo]} registrada em ${fmtData(data)}.`);
}

function excluirOcorrencia(id) {
  const o = estado.ocorrencias.find(x => x.id === id);
  if (!o || !confirm(`Excluir "${TIPOS[o.tipo]}" de ${fmtData(o.data)}?`)) return;
  estado.ocorrencias = estado.ocorrencias.filter(x => x.id !== id);
  salvar();
  renderizarTudo();
  avisar('Ocorrência excluída.');
}

function salvarConfig(evento) {
  evento.preventDefault();
  const inicio = $('#cfg-inicio').value;
  const fim = $('#cfg-fim').value;
  const almocoInicio = $('#cfg-almoco-inicio').value;
  const almocoFim = $('#cfg-almoco-fim').value;
  const tolerancia = Number($('#cfg-tolerancia').value) || 0;
  const dias = [...document.querySelectorAll('#cfg-dias input:checked')].map(i => Number(i.value));

  if (!RE_HORA.test(inicio) || !RE_HORA.test(fim)) { avisar('Informe os horários de entrada e saída.', true); return; }
  if (inicio === fim) { avisar('A entrada e a saída não podem ser iguais.', true); return; }
  if (Boolean(almocoInicio) !== Boolean(almocoFim)) { avisar('Informe o início e o fim do almoço, ou deixe os dois vazios.', true); return; }
  if (almocoInicio && almocoFim <= almocoInicio) { avisar('O fim do almoço precisa ser depois do início.', true); return; }
  if (!dias.length) { avisar('Marque pelo menos um dia de trabalho.', true); return; }
  if (tolerancia < 0) { avisar('Use valores positivos.', true); return; }

  const nova = { definida: true, inicio, fim, almocoInicio, almocoFim, tolerancia, dias: dias.sort() };
  if (jornadaPrevista(nova) <= 0) { avisar('O almoço ocupa toda a jornada.', true); return; }

  estado.config = nova;
  salvar();
  renderizarTudo();
  renderizarConfig();
  avisar('Configurações salvas.');
}

/* ============================== Backup ============================== */

function baixar(nomeArquivo, conteudo, tipo) {
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportarBackup() {
  const dados = { app: 'meu-ponto', versao: 1, exportadoEm: new Date().toISOString(), ...estado };
  baixar(`meu-ponto-backup-${dataISO(new Date())}.json`, JSON.stringify(dados, null, 2), 'application/json');
}

function importarBackup(evento) {
  const arquivo = evento.target.files[0];
  evento.target.value = '';
  if (!arquivo) return;
  const leitor = new FileReader();
  leitor.onload = () => {
    let dados;
    try {
      dados = JSON.parse(leitor.result);
    } catch {
      avisar('Arquivo inválido: não é um backup do Meu Ponto.', true);
      return;
    }
    if (!dados || !Array.isArray(dados.registros)) {
      avisar('Arquivo inválido: não é um backup do Meu Ponto.', true);
      return;
    }
    const novo = normalizar(dados);
    const msg = `Restaurar ${novo.registros.length} registro(s) e ${novo.ocorrencias.length} ocorrência(s)? ` +
      'Os dados atuais deste navegador serão substituídos.';
    if (!confirm(msg)) return;
    estado = novo;
    salvar();
    cancelarEdicao();
    renderizarTudo();
    renderizarConfig();
    avisar('Backup restaurado.');
  };
  leitor.readAsText(arquivo);
}

function apagarTudo() {
  if (!confirm('Apagar TODOS os registros e configurações deste navegador? Recomendamos baixar um backup antes.')) return;
  if (!confirm('Tem certeza? Essa ação não pode ser desfeita.')) return;
  estado = estadoPadrao();
  salvar();
  cancelarEdicao();
  renderizarTudo();
  renderizarConfig();
  avisar('Todos os dados foram apagados.');
}

function exportarCSV() {
  const mes = $('#rel-mes').value;
  const { dias } = resumoMes(mes);
  const linhas = [['Data', 'Dia', 'Entrada', 'Saída', 'Almoço descontado', 'Trabalhado', 'Atraso', 'Saldo', 'Situação', 'Observação']];
  for (const d of dias) {
    const obs = [d.ocorrencia?.obs, ...d.registros.map(r => r.obs)].filter(Boolean).join(' | ');
    linhas.push([
      fmtData(d.data),
      DIAS_CURTOS[lerData(d.data).getDay()],
      d.registros.map(r => horaDe(r.entrada)).join(' / '),
      d.registros.map(r => (r.saida ? horaDe(r.saida) : '')).join(' / '),
      d.almoco ? fmtDuracao(d.almoco) : '',
      d.registros.length ? fmtDuracao(d.trabalhado) : '',
      d.atraso ? fmtDuracao(d.atraso) : '',
      d.saldo ? fmtDuracao(d.saldo, true) : '',
      d.atraso ? 'Atraso' : ROTULO_STATUS[d.status],
      obs,
    ]);
  }
  const csv = linhas.map(l => l.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  baixar(`meu-ponto-${mes}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
}

/* ============================== Interface ============================== */

const $ = seletor => document.querySelector(seletor);

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let temporizadorAviso;
function avisar(texto, erro = false) {
  const el = $('#aviso');
  el.textContent = texto;
  el.classList.toggle('erro', erro);
  el.classList.add('visivel');
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => el.classList.remove('visivel'), erro ? 5000 : 3000);
}

function abrirAba(nome) {
  if (!document.getElementById(`aba-${nome}`)) nome = 'hoje';
  document.querySelectorAll('.abas button').forEach(b => {
    if (b.dataset.aba === nome) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.aba').forEach(s => s.classList.toggle('ativa', s.id === `aba-${nome}`));
  history.replaceState(null, '', `#${nome}`);
}

function textoOrigem(origem, quando) {
  if (!origem) return '';
  return origem === 'agora'
    ? `gravada no momento do clique em ${fmtIso(quando)}`
    : `informada manualmente em ${fmtIso(quando)}`;
}

function htmlRegistro(r) {
  const mesmoDia = !r.saida || r.saida.slice(0, 10) === r.entrada.slice(0, 10);
  const saidaTxt = r.saida ? (mesmoDia ? horaDe(r.saida) : fmtDataHora(r.saida)) : '—';
  const duracao = r.saida ? fmtDuracao(diffMin(r.entrada, r.saida)) : 'em aberto';
  const selo = origem => (origem === 'agora'
    ? '<span class="selo ok">no momento</span>'
    : origem ? '<span class="selo">manual</span>' : '');

  return `
    <li class="registro">
      <div class="registro-horas">
        <span><small>Entrada</small><strong>${horaDe(r.entrada)}</strong>${selo(r.entradaOrigem)}</span>
        <span><small>Saída</small><strong>${saidaTxt}</strong>${selo(r.saidaOrigem)}</span>
        <span><small>Duração</small><strong>${duracao}</strong></span>
      </div>
      ${r.obs ? `<p class="obs">${esc(r.obs)}</p>` : ''}
      <div class="registro-rodape">
        <details>
          <summary>Comprovação</summary>
          <p>Entrada ${textoOrigem(r.entradaOrigem, r.entradaRegistradaEm)}.</p>
          ${r.saida ? `<p>Saída ${textoOrigem(r.saidaOrigem, r.saidaRegistradaEm)}.</p>` : ''}
          ${r.editadoEm ? `<p>Última edição em ${fmtIso(r.editadoEm)}.</p>` : ''}
        </details>
        <div class="registro-acoes">
          <button type="button" class="link" data-acao="editar" data-id="${r.id}">Editar</button>
          <button type="button" class="link perigo" data-acao="excluir" data-id="${r.id}">Excluir</button>
        </div>
      </div>
    </li>`;
}

function htmlOcorrencia(o) {
  return `
    <li class="ocorrencia">
      <div>
        <span class="selo ${o.tipo}">${TIPOS[o.tipo]}</span>
        ${o.obs ? `<p>${esc(o.obs)}</p>` : ''}
      </div>
      <button type="button" class="link perigo" data-acao="excluir-ocorrencia" data-id="${o.id}">Excluir</button>
    </li>`;
}

function renderizarRelogio() {
  const agora = new Date();
  $('#relogio-hora').textContent = agora.toLocaleTimeString('pt-BR');
  const data = agora.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('#relogio-data').textContent = data[0].toUpperCase() + data.slice(1);
}

function renderizarHoje() {
  const agora = new Date();
  const hoje = dataISO(agora);
  const cfg = estado.config;
  const dia = resumoDia(hoje, hoje);
  const aberto = registroAberto();

  $('#aviso-config').hidden = cfg.definida;

  const botao = $('#btn-bater');
  botao.textContent = aberto ? 'Registrar saída' : 'Registrar entrada';
  botao.classList.toggle('saida', Boolean(aberto));

  let status;
  if (aberto && aberto.entrada.slice(0, 10) !== hoje) {
    status = `Há uma entrada em aberto desde <strong>${fmtDataHora(aberto.entrada)}</strong>.`;
  } else if (aberto) {
    const decorrido = diffMin(aberto.entrada, dataHoraLocal(agora)) - minutosNoAlmoco(lerDataHora(aberto.entrada), agora);
    status = `Trabalhando desde <strong>${horaDe(aberto.entrada)}</strong> · ${fmtDuracao(Math.max(0, decorrido))}`;
  } else if (dia.ocorrencia) {
    status = `Hoje está marcado como <strong>${TIPOS[dia.ocorrencia.tipo]}</strong>.`;
  } else if (dia.registros.length) {
    status = `Trabalhado hoje: <strong>${fmtDuracao(dia.trabalhado)}</strong>` +
      (dia.esperado ? ` · saldo <strong>${fmtDuracao(dia.saldo, true)}</strong>` : '');
  } else if (dia.diaUtil) {
    status = `Entrada prevista às <strong>${cfg.inicio}</strong>.`;
  } else {
    status = 'Hoje não é dia de trabalho.';
  }
  if (dia.atraso) status += `<br><span class="txt-alerta">Atraso de ${fmtDuracao(dia.atraso)} na entrada.</span>`;
  $('#status-hoje').innerHTML = status;

  const lista = [...dia.registros];
  if (aberto && !lista.includes(aberto)) lista.unshift(aberto);
  $('#lista-hoje').innerHTML = lista.length
    ? lista.map(htmlRegistro).join('')
    : '<li class="vazio">Nenhum registro hoje.</li>';
}

function renderizarHistorico() {
  const mes = $('#hist-mes').value;
  const hoje = dataISO(new Date());
  const dias = diasDoMes(mes).reverse()
    .map(d => resumoDia(d, hoje))
    .filter(d => d.registros.length || d.ocorrencia);

  $('#lista-historico').innerHTML = dias.length ? dias.map(d => {
    const semana = DIAS_CURTOS[lerData(d.data).getDay()];
    const total = d.registros.length ? `${fmtDuracao(d.trabalhado)}${d.almoco ? ` (−${fmtDuracao(d.almoco)} almoço)` : ''}` : '';
    const atraso = d.atraso ? ` <span class="selo atraso">atraso ${fmtDuracao(d.atraso)}</span>` : '';
    return `
      <div class="grupo-dia">
        <h3>${semana}, ${fmtData(d.data)}${atraso}<span>${total}</span></h3>
        <ul class="lista">
          ${d.ocorrencia ? htmlOcorrencia(d.ocorrencia) : ''}
          ${d.registros.map(htmlRegistro).join('')}
        </ul>
      </div>`;
  }).join('') : '<p class="vazio">Nenhum registro neste mês.</p>';
}

function indicador(rotulo, valor, detalhe = '', classe = '') {
  return `<div class="indicador ${classe}"><small>${rotulo}</small><strong>${valor}</strong>${detalhe ? `<em>${detalhe}</em>` : ''}</div>`;
}

function renderizarRelatorio() {
  const mes = $('#rel-mes').value;
  const cfg = estado.config;
  const r = resumoMes(mes);

  $('#titulo-relatorio').textContent = `Relatório — ${nomeMes(mes)}`;
  const diasTxt = ORDEM_DIAS.filter(d => cfg.dias.includes(d)).map(d => DIAS_CURTOS[d]).join(', ');
  $('#rel-jornada').textContent =
    `Horário: ${cfg.inicio} às ${cfg.fim} · ` +
    `${temAlmoco(cfg) ? `almoço ${cfg.almocoInicio} às ${cfg.almocoFim}` : 'sem almoço'} · ` +
    `jornada ${fmtDuracao(jornadaPrevista(cfg))} · tolerância ${cfg.tolerancia} min · ${diasTxt}`;

  const classeSaldo = r.saldo > 0 ? 'positivo' : r.saldo < 0 ? 'negativo' : '';
  $('#resumo-mes').innerHTML = [
    indicador('Horas trabalhadas', fmtDuracao(r.trabalhado), `${r.diasTrabalhados} dia(s)`),
    indicador(r.saldo >= 0 ? 'Horas extras' : 'Horas devidas', fmtDuracao(r.saldo, true), 'saldo do mês', classeSaldo),
    indicador('Atrasos', r.atrasos.length, r.atrasos.length ? `total ${fmtDuracao(r.minutosAtraso)}` : '', r.atrasos.length ? 'alerta' : ''),
    indicador('Faltas', r.faltas.length, '', r.faltas.length ? 'negativo' : ''),
    indicador('Atestados', r.atestados.length),
    indicador('Sem registro', r.semRegistro.length, 'dias úteis passados', r.semRegistro.length ? 'alerta' : ''),
  ].join('');

  $('#lista-atrasos').innerHTML = r.atrasos.length ? `
    <table class="tabela-simples">
      <thead><tr><th>Data</th><th>Previsto</th><th>Chegada</th><th>Atraso</th></tr></thead>
      <tbody>${r.atrasos.map(d => `
        <tr>
          <td>${DIAS_CURTOS[lerData(d.data).getDay()]}, ${fmtData(d.data)}</td>
          <td>${cfg.inicio}</td>
          <td>${horaDe(d.registros[0].entrada)}</td>
          <td class="num-neg">${fmtDuracao(d.atraso)}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : '<p class="vazio">Nenhum atraso neste mês. 🎉</p>';

  const ocorrencias = [...r.faltas, ...r.atestados, ...r.folgas].sort((a, b) => a.data.localeCompare(b.data));
  $('#lista-ocorrencias').innerHTML = ocorrencias.length ? `
    <table class="tabela-simples">
      <thead><tr><th>Data</th><th>Tipo</th><th>Observação</th></tr></thead>
      <tbody>${ocorrencias.map(d => `
        <tr>
          <td>${DIAS_CURTOS[lerData(d.data).getDay()]}, ${fmtData(d.data)}</td>
          <td><span class="selo ${d.ocorrencia.tipo}">${TIPOS[d.ocorrencia.tipo]}</span></td>
          <td>${esc(d.ocorrencia.obs) || '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : '<p class="vazio">Nenhuma falta, atestado ou folga neste mês.</p>';

  const numero = min => (min ? `<span class="${min > 0 ? 'num-pos' : 'num-neg'}">${fmtDuracao(min, true)}</span>` : '');
  $('#tabela-mes').innerHTML = `
    <thead><tr><th>Data</th><th>Entrada</th><th>Saída</th><th>Trabalhado</th><th>Atraso</th><th>Saldo</th><th>Situação</th></tr></thead>
    <tbody>${r.dias.map(d => {
      const classe = d.atraso ? 'atraso' : d.status;
      const entradas = d.registros.map(x => horaDe(x.entrada)).join(' / ');
      const saidas = d.registros.map(x => (x.saida ? horaDe(x.saida) : '…')).join(' / ');
      return `
        <tr class="${classe}">
          <td>${fmtData(d.data).slice(0, 5)} <small>${DIAS_CURTOS[lerData(d.data).getDay()]}</small></td>
          <td>${entradas}</td>
          <td>${saidas}</td>
          <td>${d.registros.length ? fmtDuracao(d.trabalhado) : ''}</td>
          <td>${d.atraso ? fmtDuracao(d.atraso) : ''}</td>
          <td>${numero(d.saldo)}</td>
          <td>${d.atraso ? 'Atraso' : ROTULO_STATUS[d.status]}</td>
        </tr>`;
    }).join('')}
    </tbody>
    <tfoot><tr><td colspan="3">Total</td><td>${fmtDuracao(r.trabalhado)}</td><td>${r.minutosAtraso ? fmtDuracao(r.minutosAtraso) : ''}</td><td>${numero(r.saldo)}</td><td></td></tr></tfoot>`;
}

function renderizarConfig() {
  const cfg = estado.config;
  $('#cfg-inicio').value = cfg.inicio;
  $('#cfg-fim').value = cfg.fim;
  $('#cfg-almoco-inicio').value = cfg.almocoInicio;
  $('#cfg-almoco-fim').value = cfg.almocoFim;
  $('#cfg-tolerancia').value = cfg.tolerancia;
  $('#cfg-dias').innerHTML = ORDEM_DIAS.map(d => `
    <label><input type="checkbox" value="${d}" ${cfg.dias.includes(d) ? 'checked' : ''}>${DIAS_CURTOS[d]}</label>`).join('');
  atualizarPreviaJornada();
}

function atualizarPreviaJornada() {
  const inicio = $('#cfg-inicio').value;
  const fim = $('#cfg-fim').value;
  const dias = document.querySelectorAll('#cfg-dias input:checked').length;
  if (!RE_HORA.test(inicio) || !RE_HORA.test(fim) || inicio === fim) {
    $('#cfg-jornada').textContent = '';
    return;
  }
  const cfg = { inicio, fim, almocoInicio: $('#cfg-almoco-inicio').value, almocoFim: $('#cfg-almoco-fim').value };
  const diaria = jornadaPrevista(cfg);
  const almoco = duracaoAlmoco(cfg) ? ` (já descontado ${fmtDuracao(duracaoAlmoco(cfg))} de almoço)` : '';
  $('#cfg-jornada').textContent =
    `Jornada diária: ${fmtDuracao(diaria)}${almoco} · semanal: ${fmtDuracao(diaria * dias)} (${dias} dia(s)).`;
}

function renderizarTudo() {
  renderizarHoje();
  renderizarHistorico();
  renderizarRelatorio();
}

/* ============================== Início ============================== */

function iniciar() {
  const agora = new Date();
  $('#hist-mes').value = mesISO(agora);
  $('#rel-mes').value = mesISO(agora);
  $('#oc-data').value = dataISO(agora);
  preencherCamposRegistro(dataHoraLocal(agora), null);

  document.querySelectorAll('.abas button').forEach(b => b.addEventListener('click', () => abrirAba(b.dataset.aba)));
  $('#btn-bater').addEventListener('click', baterPonto);
  $('#form-registro').addEventListener('submit', salvarRegistro);
  $('#btn-cancelar-edicao').addEventListener('click', cancelarEdicao);
  $('#form-ocorrencia').addEventListener('submit', salvarOcorrencia);
  $('#form-config').addEventListener('submit', salvarConfig);
  $('#form-config').addEventListener('input', atualizarPreviaJornada);
  $('#hist-mes').addEventListener('change', renderizarHistorico);
  $('#rel-mes').addEventListener('change', renderizarRelatorio);
  $('#btn-imprimir').addEventListener('click', () => window.print());
  $('#btn-csv').addEventListener('click', exportarCSV);
  $('#btn-exportar').addEventListener('click', exportarBackup);
  $('#inp-importar').addEventListener('change', importarBackup);
  $('#btn-apagar').addEventListener('click', apagarTudo);

  document.addEventListener('click', evento => {
    const alvo = evento.target.closest('[data-acao], [data-ir]');
    if (!alvo) return;
    if (alvo.dataset.ir) return abrirAba(alvo.dataset.ir);
    const { acao, id } = alvo.dataset;
    if (acao === 'editar') iniciarEdicao(id);
    if (acao === 'excluir') excluirRegistro(id);
    if (acao === 'excluir-ocorrencia') excluirOcorrencia(id);
  });

  // Pede ao navegador para não apagar o cache offline quando faltar espaço.
  navigator.storage?.persist?.().catch(() => {});

  renderizarConfig();
  renderizarTudo();
  renderizarRelogio();

  let ultimoDia = dataISO(agora);
  setInterval(() => {
    renderizarRelogio();
    const hoje = dataISO(new Date());
    if (hoje !== ultimoDia) { ultimoDia = hoje; renderizarTudo(); }
  }, 1000);
  setInterval(renderizarHoje, 30000);
}

/* ============================== Sessão ============================== */

// Ponte usada pelo auth.js: os dados só entram no app depois do login confirmado.
const MeuPonto = {
  iniciarSessao(dados, fnPersistir) {
    estado = normalizar(dados || {});
    persistir = fnPersistir;
    renderizarTudo();
    renderizarConfig();
    abrirAba(location.hash.slice(1) || (estado.config.definida ? 'hoje' : 'config'));
  },

  // Alteração vinda de outro aparelho ou aba.
  receberDados(dados) {
    estado = normalizar(dados || {});
    if (editandoId && !estado.registros.some(r => r.id === editandoId)) cancelarEdicao();
    renderizarTudo();
    renderizarConfig();
  },

  encerrarSessao() {
    persistir = null;
    estado = estadoPadrao();
    cancelarEdicao();
    renderizarTudo();
    renderizarConfig();
  },

  obterEstado: () => estado,
  normalizar,
};

// O script fica no fim do <body>, então o HTML já está disponível aqui.
if (typeof window !== 'undefined') {
  window.MeuPonto = MeuPonto;
  iniciar();
}
