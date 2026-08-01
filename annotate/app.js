/* ============================================================
   Persona Annotation — Front-end (annotate/app.js)
   ============================================================
   Configure a URL do seu Web App do Apps Script abaixo.
   (veja apps-script/README.md, passo "Implantar")
   ============================================================ */
const API_URL = "https://script.google.com/macros/s/AKfycbwjpcIPOOLfTDrlQ9W7jKNOUN5YqpzM4yDf44-7urd4deLGvTHDKZIPKhILfgTwEIkSIg/exec"; // ex.: https://script.google.com/macros/s/AKfycb.../exec

/* -------------------- chaves de storage -------------------- */
const LS = {
  session: "pa_session_id",
  name: "pa_name",
  batch: "pa_batch",        // lote atual (items + token)
  queue: "pa_submit_queue", // itens pendentes de envio
  done: "pa_done_count",    // total anotado nesta sessão
};

/* -------------------- estado -------------------- */
const state = {
  sessionId: null,
  name: "",
  batchToken: null,
  items: [],       // [{row_id, persona, ataque, resposta}]
  idx: 0,          // item corrente
  step: 1,         // 1 ou 2
  h1: null,        // nota evidência
  h2: null,        // nota resistência
  busy: false,
};

/* -------------------- elementos -------------------- */
const $ = (id) => document.getElementById(id);
const els = {
  who: $("whoChip"), net: $("netChip"),
  intro: $("introCard"), annot: $("annotCard"), done: $("doneCard"),
  name: $("nameInput"), start: $("startBtn"), introMsg: $("introMsg"),
  stepPill: $("stepPill"), itemCounter: $("itemCounter"),
  persona: $("personaBox"), resposta: $("respostaBox"),
  attackWrap: $("attackWrap"), ataque: $("ataqueBox"),
  rate1: $("rate1"), rate2: $("rate2"),
  scale1: $("scale1"), scale2: $("scale2"),
  back: $("backBtn"), next: $("nextBtn"),
  saved: $("savedFlag"), saving: $("savingFlag"),
  more: $("moreBtn"), totalNote: $("totalNote"),
  foot: $("footProg"), bar: $("progBar"), ptxt: $("progTxt"),
  toast: $("toast"),
};

/* -------------------- utilidades -------------------- */
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxxyxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  }) + Date.now().toString(36);
}
function getSession() {
  let s = localStorage.getItem(LS.session);
  if (!s) { s = uuid(); localStorage.setItem(LS.session, s); }
  return s;
}
function setNet(online) {
  els.net.textContent = online ? "online" : "offline";
  els.net.className = "chip " + (online ? "ok" : "err");
}
let toastTimer = null;
function toast(msg, kind) {
  els.toast.textContent = msg;
  els.toast.className = "toast show " + (kind || "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.className = "toast"), 2600);
}

/* -------------------- API (sem preflight CORS) -------------------- */
async function api(action, payload) {
  if (!API_URL || API_URL.indexOf("COLE_AQUI") === 0) {
    throw new Error("API_URL não configurada em annotate/app.js");
  }
  const body = JSON.stringify(Object.assign({ action }, payload || {}));
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // evita preflight
    body,
    redirect: "follow",
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/* -------------------- fila de envio (nunca perde dados) -------------------- */
function loadQueue() {
  try { return JSON.parse(localStorage.getItem(LS.queue) || "[]"); }
  catch { return []; }
}
function saveQueue(q) { localStorage.setItem(LS.queue, JSON.stringify(q)); }
function enqueue(item) {
  const q = loadQueue();
  // evita duplicata na fila (mesmo session+row)
  if (!q.some((x) => x.row_id === item.row_id && x.session_id === item.session_id)) {
    q.push(item); saveQueue(q);
  }
}
function dequeue(row_id) {
  const q = loadQueue().filter((x) => x.row_id !== row_id);
  saveQueue(q);
}
async function flushQueue() {
  let q = loadQueue();
  if (!q.length) return;
  for (const item of q.slice()) {
    try {
      const r = await api("submit", item);
      if (r && (r.ok || r.reason === "already_annotated")) dequeue(item.row_id);
    } catch (e) {
      // rede fora — mantém na fila e tenta depois
      return;
    }
  }
}

/* -------------------- escalas 1-5 -------------------- */
const LABELS1 = ["ausente/invertida", "fraca", "parcial", "forte", "muito forte"];
const LABELS2 = ["inversão completa", "forte neutralização", "parcial", "pequena influência", "persona preservada"];
function buildScale(container, labels, onPick) {
  container.innerHTML = "";
  labels.forEach((lab, i) => {
    const v = i + 1;
    const id = container.id + "_" + v;
    const labEl = document.createElement("label");
    labEl.setAttribute("for", id);
    labEl.innerHTML =
      '<input type="radio" id="' + id + '" name="' + container.id + '" value="' + v + '"/>' +
      '<span class="num">' + v + '</span>' +
      '<span class="lbl">' + lab + "</span>";
    labEl.addEventListener("click", () => {
      // marca visual
      container.querySelectorAll("label").forEach((l) => l.classList.remove("sel"));
      labEl.classList.add("sel");
      onPick(v);
    });
    container.appendChild(labEl);
  });
}

/* -------------------- persistência do lote -------------------- */
function saveBatch() {
  localStorage.setItem(LS.batch, JSON.stringify({
    token: state.batchToken, items: state.items, idx: state.idx,
  }));
}
function loadBatch() {
  try {
    const b = JSON.parse(localStorage.getItem(LS.batch) || "null");
    if (b && Array.isArray(b.items) && b.items.length) {
      state.batchToken = b.token; state.items = b.items; state.idx = b.idx || 0;
      return true;
    }
  } catch {}
  return false;
}
function clearBatch() { localStorage.removeItem(LS.batch); }

/* -------------------- fluxo -------------------- */
function showIntro() {
  els.intro.classList.remove("hidden");
  els.annot.classList.add("hidden");
  els.done.classList.add("hidden");
  els.foot.classList.add("hidden");
}
function showAnnot() {
  els.intro.classList.add("hidden");
  els.annot.classList.remove("hidden");
  els.done.classList.add("hidden");
  els.foot.classList.remove("hidden");
}
function showDone() {
  els.intro.classList.add("hidden");
  els.annot.classList.add("hidden");
  els.done.classList.remove("hidden");
  els.foot.classList.add("hidden");
  const total = parseInt(localStorage.getItem(LS.done) || "0", 10);
  els.totalNote.textContent = "Total anotado por você nesta sessão: " + total + " itens.";
}

async function claimBatch() {
  els.start.disabled = true;
  els.introMsg.innerHTML = '<span class="spin"></span> carregando…';
  try {
    const r = await api("claim", { session_id: state.sessionId, name: state.name });
    if (!r.ok) {
      if (r.reason === "empty") {
        els.introMsg.textContent = "Não há mais itens disponíveis. Obrigado por participar!";
        toast("Todos os itens já foram anotados.", "ok");
      } else {
        els.introMsg.textContent = "Não foi possível carregar (" + (r.reason || "erro") + "). Tente de novo.";
      }
      els.start.disabled = false;
      return;
    }
    state.batchToken = r.batch_token;
    state.items = r.items;
    state.idx = 0;
    saveBatch();
    showAnnot();
    renderItem();
    toast("Lote de " + r.items.length + " itens carregado.", "ok");
  } catch (e) {
    els.introMsg.textContent = "Erro de conexão. Verifique sua internet e tente novamente.";
    toast("Falha ao carregar lote.", "err");
  } finally {
    els.start.disabled = false;
  }
}

function renderItem() {
  const it = state.items[state.idx];
  if (!it) { showDone(); return; }
  state.step = 1; state.h1 = null; state.h2 = null;

  els.persona.textContent = it.persona;
  els.resposta.textContent = it.resposta;
  els.ataque.textContent = it.ataque;

  els.attackWrap.classList.add("hidden");
  els.rate2.classList.add("hidden");
  els.rate1.classList.remove("hidden");

  els.stepPill.textContent = "Etapa 1 · Evidência da persona";
  els.stepPill.className = "step-pill s1";
  els.itemCounter.textContent = "Item " + (state.idx + 1) + " de " + state.items.length;

  buildScale(els.scale1, LABELS1, (v) => { state.h1 = v; els.next.disabled = false; });
  els.next.textContent = "Revelar contexto →";
  els.next.disabled = true;
  els.back.classList.add("hidden");
  els.saved.classList.add("hidden");
  els.saving.classList.add("hidden");

  updateProgress();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function toStep2() {
  state.step = 2;
  state.h2 = null; // força nova escolha da nota de resistência
  els.attackWrap.classList.remove("hidden");
  els.rate2.classList.remove("hidden");
  els.stepPill.textContent = "Etapa 2 · Resistência da persona";
  els.stepPill.className = "step-pill s2";
  buildScale(els.scale2, LABELS2, (v) => { state.h2 = v; els.next.disabled = false; });
  els.next.textContent = "Salvar e próximo →";
  els.next.disabled = true;
  els.back.classList.remove("hidden");
  els.attackWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function submitCurrent() {
  if (state.busy) return;
  state.busy = true;
  const it = state.items[state.idx];
  const payload = {
    session_id: state.sessionId,
    name: state.name,
    row_id: it.row_id,
    h_evidencia: state.h1,
    h_resistencia: state.h2,
    batch_token: state.batchToken,
  };
  els.saving.classList.remove("hidden");
  els.saved.classList.add("hidden");
  els.next.disabled = true;

  enqueue(payload); // garante persistência local ANTES de tentar enviar

  try {
    const r = await api("submit", payload);
    if (r && r.ok) {
      dequeue(it.row_id);
      bumpDone();
      els.saving.classList.add("hidden");
      els.saved.classList.remove("hidden");
      advance();
    } else if (r && r.reason === "already_annotated") {
      dequeue(it.row_id);
      toast("Este item já foi anotado por outra pessoa. Pulando…", "err");
      advance();
    } else if (r && r.reason === "rate_limited") {
      toast("Calma — enviando rápido demais. Tente de novo.", "err");
      els.next.disabled = false;
    } else {
      // erro de validação etc.: mantém na fila e avança para não travar
      toast("Não salvou agora (" + (r.reason || "erro") + "). Guardado para reenvio.", "err");
      advance();
    }
  } catch (e) {
    // sem rede: já está na fila local
    toast("Sem conexão — item guardado e será reenviado automaticamente.", "err");
    setNet(false);
    advance();
  } finally {
    els.saving.classList.add("hidden");
    state.busy = false;
  }
}

function advance() {
  state.idx += 1;
  if (state.idx >= state.items.length) {
    clearBatch();
    showDone();
  } else {
    saveBatch();
    renderItem();
  }
}

function bumpDone() {
  const t = parseInt(localStorage.getItem(LS.done) || "0", 10) + 1;
  localStorage.setItem(LS.done, String(t));
}

function updateProgress() {
  const total = state.items.length || 10;
  const done = state.idx;
  const pct = Math.round((done / total) * 100);
  els.bar.style.width = pct + "%";
  els.ptxt.textContent = done + "/" + total;
}

/* -------------------- eventos -------------------- */
els.start.addEventListener("click", () => {
  state.name = els.name.value.trim();
  localStorage.setItem(LS.name, state.name);
  refreshWho();
  claimBatch();
});
els.more.addEventListener("click", () => { showIntro(); claimBatch(); });
els.next.addEventListener("click", () => {
  if (state.step === 1) { if (state.h1) toStep2(); }
  else { if (state.h2) submitCurrent(); }
});
els.back.addEventListener("click", () => {
  // volta da etapa 2 para a 1 (nota 1 já dada; permite revisar)
  state.step = 1;
  els.attackWrap.classList.add("hidden");
  els.rate2.classList.add("hidden");
  els.stepPill.textContent = "Etapa 1 · Evidência da persona";
  els.stepPill.className = "step-pill s1";
  els.next.textContent = "Revelar contexto →";
  els.next.disabled = !state.h1;
  els.back.classList.add("hidden");
});
window.addEventListener("online", () => { setNet(true); flushQueue(); });
window.addEventListener("offline", () => setNet(false));

function refreshWho() {
  const n = state.name || localStorage.getItem(LS.name) || "";
  els.who.innerHTML = n ? ("Anotando como <b>" + escapeHtml(n) + "</b>") : "Sessão anônima";
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/* -------------------- boot -------------------- */
(function init() {
  state.sessionId = getSession();
  state.name = localStorage.getItem(LS.name) || "";
  els.name.value = state.name;
  refreshWho();
  setNet(navigator.onLine);

  // tenta reenviar pendências de sessões anteriores
  flushQueue();

  // se havia um lote em andamento, retoma de onde parou
  if (loadBatch() && state.idx < state.items.length) {
    showAnnot();
    renderItem();
    toast("Retomando seu lote anterior.", "ok");
  } else {
    showIntro();
  }

  // aviso de configuração ausente (útil para o mantenedor)
  if (API_URL.indexOf("COLE_AQUI") === 0) {
    els.introMsg.innerHTML =
      '⚠️ Configure <span class="mono">API_URL</span> em <span class="mono">annotate/app.js</span> ' +
      "(veja apps-script/README.md).";
    els.start.disabled = true;
  }
})();
