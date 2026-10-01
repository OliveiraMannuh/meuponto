/*
 * Meu Ponto — login (Firebase Authentication) e dados na nuvem (Cloud Firestore).
 *
 * Quem decide quem pode ler e gravar são as REGRAS DO FIRESTORE, executadas nos
 * servidores do Google (veja firestore.rules.example). Este arquivo só cuida da
 * experiência: mostrar o login, carregar os dados e esconder o app de quem não entrou.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, onSnapshot, setDoc, serverTimestamp, terminate, clearIndexedDbPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// Versão anterior do app guardava tudo no localStorage; migramos uma única vez.
const CHAVE_LOCAL_ANTIGA = 'meuponto:v1';

const $ = seletor => document.querySelector(seletor);
const telaLogin = $('#tela-login');
const areaApp = $('#app');
const btnLogin = $('#btn-login');
const statusLogin = $('#login-status');
const erroLogin = $('#login-erro');

function mostrarLogin({ mensagem = '', erro = '', podeEntrar = true } = {}) {
  areaApp.hidden = true;
  $('#usuario').hidden = true;
  telaLogin.hidden = false;
  btnLogin.hidden = !podeEntrar;
  btnLogin.disabled = false;
  statusLogin.textContent = mensagem;
  statusLogin.hidden = !mensagem;
  erroLogin.textContent = erro;
  erroLogin.hidden = !erro;
}

function mostrarApp(email) {
  telaLogin.hidden = true;
  areaApp.hidden = false;
  $('#usuario').hidden = false;
  $('#usuario-email').textContent = email;
}

function traduzirErro(e) {
  const mensagens = {
    'auth/unauthorized-domain': 'Este endereço não está autorizado no Firebase (Authentication → Settings → Authorized domains).',
    'auth/network-request-failed': 'Sem conexão com a internet. Tente novamente.',
    'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos.',
    'auth/operation-not-allowed': 'O login com Google não está ativado no Firebase.',
  };
  return mensagens[e.code] || `Não foi possível entrar (${e.code || e.message}).`;
}

async function principal() {
  let config;
  try {
    config = await import('./firebase-config.js');
  } catch {
    mostrarLogin({ podeEntrar: false, erro: 'Configuração do Firebase não encontrada (firebase-config.js). Veja o README.' });
    return;
  }

  const firebaseApp = initializeApp(config.firebaseConfig);
  const auth = getAuth(firebaseApp);
  auth.useDeviceLanguage();
  // Cache local permite registrar ponto sem internet; sincroniza quando a conexão voltar.
  const db = initializeFirestore(firebaseApp, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });

  let pararEscuta = null;
  let erroAoSair = '';

  function gravar(ref, estado) {
    // JSON remove campos `undefined`, que o Firestore não aceita.
    const dados = JSON.parse(JSON.stringify(estado));
    return setDoc(ref, { dados, atualizadoEm: serverTimestamp() });
  }

  function lerDadosLocaisAntigos() {
    try {
      const bruto = localStorage.getItem(CHAVE_LOCAL_ANTIGA);
      return bruto ? JSON.parse(bruto) : null;
    } catch {
      return null;
    }
  }

  async function entrar() {
    const provedor = new GoogleAuthProvider();
    provedor.setCustomParameters({ prompt: 'select_account' });
    btnLogin.disabled = true;
    erroLogin.hidden = true;
    try {
      await signInWithPopup(auth, provedor);
    } catch (e) {
      btnLogin.disabled = false;
      if (e.code === 'auth/popup-blocked') return signInWithRedirect(auth, provedor);
      if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
      mostrarLogin({ erro: traduzirErro(e) });
    }
  }

  async function sair() {
    if (!navigator.onLine &&
        !confirm('Você está sem internet. Registros ainda não sincronizados serão perdidos ao sair. Sair mesmo assim?')) return;
    pararEscuta?.();
    pararEscuta = null;
    await signOut(auth);
    // Apaga a cópia offline deste aparelho para não deixar dados para trás.
    try {
      await terminate(db);
      await clearIndexedDbPersistence(db);
    } catch { /* outra aba ainda usando o cache; ele é limpo no próximo logout */ }
    location.reload();
  }

  function aoMudarUsuario(usuario) {
    pararEscuta?.();
    pararEscuta = null;
    window.MeuPonto.encerrarSessao();

    if (!usuario) {
      mostrarLogin({ erro: erroAoSair });
      erroAoSair = '';
      return;
    }

    mostrarLogin({ mensagem: 'Carregando seus registros…', podeEntrar: false });
    const ref = doc(db, 'usuarios', usuario.uid);
    let carregado = false;

    pararEscuta = onSnapshot(ref, snap => {
      // Eco das nossas próprias gravações: a tela já está atualizada.
      if (snap.metadata.hasPendingWrites) return;

      if (!snap.exists()) {
        // Sem conexão e sem cache: espera o servidor para não sobrescrever dados existentes.
        if (snap.metadata.fromCache) {
          mostrarLogin({ mensagem: 'Sem conexão. Aguardando a internet para carregar seus registros…', podeEntrar: false });
          return;
        }
        if (carregado) return;
        // Primeiro acesso: aproveita o que estava salvo só neste navegador, se houver.
        const antigos = lerDadosLocaisAntigos();
        carregado = true;
        window.MeuPonto.iniciarSessao(antigos, estado => gravar(ref, estado));
        mostrarApp(usuario.email);
        if (antigos) {
          gravar(ref, window.MeuPonto.obterEstado())
            .then(() => localStorage.removeItem(CHAVE_LOCAL_ANTIGA))
            .catch(() => {});
        }
        return;
      }

      const dados = snap.data().dados;
      if (!carregado) {
        carregado = true;
        window.MeuPonto.iniciarSessao(dados, estado => gravar(ref, estado));
        mostrarApp(usuario.email);
      } else {
        window.MeuPonto.receberDados(dados);
      }
    }, erro => {
      if (erro.code === 'permission-denied') {
        // As regras do Firestore recusaram esta conta: não é o e-mail autorizado.
        erroAoSair = `A conta ${usuario.email} não tem permissão para acessar o Meu Ponto.`;
        signOut(auth);
        return;
      }
      mostrarLogin({ podeEntrar: false, erro: `Não foi possível carregar seus dados (${erro.code}).` });
    });
  }

  btnLogin.addEventListener('click', entrar);
  $('#btn-sair').addEventListener('click', sair);
  onAuthStateChanged(auth, aoMudarUsuario);
}

principal();
