/**
 * ============================================================
 *  Persona Annotation — Backend (Google Apps Script Web App)
 * ============================================================
 *  Repo: https://github.com/henriquegalva0/logprob-persona-annotation
 *
 *  Como publicar: veja apps-script/README.md
 *
 *  Rotas (POST JSON em e.postData.contents, campo "action"):
 *    - action:"claim"  {session_id, name?}            -> reserva 10 itens
 *    - action:"submit" {session_id, name?, row_id,
 *                        h_evidencia, h_resistencia,
 *                        batch_token}                  -> grava 1 anotacao
 *    - action:"release"{session_id, batch_token}       -> libera claim ativo
 *    - GET (qualquer)                                   -> health check
 *
 *  Seguranca implementada:
 *    1. append-only  -> a aba "annotations" nunca e editada, so acrescentada
 *    2. idempotencia -> (session_id,row_id): a 1a gravacao vence
 *    3. anti-overwrite -> se outro anotador ja anotou row_id, rejeita
 *    4. token-bound    -> so aceita row_id presente no claim (batch_token)
 *    5. validacao      -> notas inteiras 1..5, payload <= 2KB
 *    6. rate-limit     -> 1 submit/segundo por sessao
 *    7. LockService    -> serializa trechos criticos (sem corrida)
 * ============================================================
 */

const CONFIG = {
  MASTER_SHEET: 'master',
  ANNOTATIONS_SHEET: 'annotations',
  CLAIMS_SHEET: 'claims',
  BATCH_SIZE: 10,
  CLAIM_TTL_MIN: 30,          // tempo que um lote fica reservado
  MAX_PAYLOAD_BYTES: 2048,    // teto do corpo da requisicao
  MIN_SUBMIT_INTERVAL_MS: 800,// rate-limit por sessao
  IDEMP_CACHE_TTL_SEC: 21600, // 6h de cache p/ checagem de duplicata
};

/* =========================== ENTRY =========================== */

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, reason: 'bad_request' });
    }
    if (e.postData.contents.length > CONFIG.MAX_PAYLOAD_BYTES) {
      return json({ ok: false, reason: 'payload_too_large' });
    }
    let body;
    try { body = JSON.parse(e.postData.contents); }
    catch (err) { return json({ ok: false, reason: 'invalid_json' }); }

    const action = String(body.action || '');
    switch (action) {
      case 'claim':   return handleClaim(body);
      case 'submit':  return handleSubmit(body);
      case 'release': return handleRelease(body);
      default:        return json({ ok: false, reason: 'unknown_action' });
    }
  } catch (err) {
    return json({ ok: false, reason: 'server_error', message: String(err) });
  }
}

function doGet() {
  return json({ ok: true, service: 'persona-annotation', time: isoNow() });
}

/* =========================== CLAIM =========================== */

function handleClaim(body) {
  const sessionId = sanitizeId(body.session_id);
  if (!sessionId) return json({ ok: false, reason: 'missing_session' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return json({ ok: false, reason: 'busy' });
  }
  try {
    expireOldClaims_();
    const pool = computeAvailablePool_();
    if (pool.length === 0) {
      return json({ ok: false, reason: 'empty' });
    }

    // Selecao deterministica por hash(session:id) -> ordens diferentes por
    // sessao, o que espalha anotadores e reduz colisao no N-10.
    const scored = pool.map(function (id) {
      return { id: id, s: djb2(sessionId + ':' + id) };
    });
    scored.sort(function (a, b) { return a.s - b.s; });
    const picked = scored.slice(0, CONFIG.BATCH_SIZE).map(function (x) { return x.id; });

    const batchToken = Utilities.getUuid();
    const now = new Date();
    const exp = new Date(now.getTime() + CONFIG.CLAIM_TTL_MIN * 60000);

    getSheet_(CONFIG.CLAIMS_SHEET).appendRow([
      sessionId, JSON.stringify(picked), now.toISOString(), exp.toISOString(),
      batchToken, 'active'
    ]);

    const items = readItems_(picked);
    return json({
      ok: true,
      batch_token: batchToken,
      expires_at: exp.toISOString(),
      remaining_estimate: pool.length,
      items: items
    });
  } finally {
    lock.releaseLock();
  }
}

/* =========================== SUBMIT =========================== */

function handleSubmit(body) {
  const sessionId = sanitizeId(body.session_id);
  const name = sanitizeName(body.name);
  const rowId = toInt_(body.row_id);
  const hEv = toInt_(body.h_evidencia);
  const hRes = toInt_(body.h_resistencia);
  const batchToken = String(body.batch_token || '');

  if (!sessionId) return json({ ok: false, reason: 'missing_session' });
  if (rowId === null || rowId < 0) return json({ ok: false, reason: 'bad_row_id' });
  if (!inScale_(hEv) || !inScale_(hRes)) {
    return json({ ok: false, reason: 'bad_score' });
  }
  if (!rateLimitOk_(sessionId)) {
    return json({ ok: false, reason: 'rate_limited' });
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return json({ ok: false, reason: 'busy' });
  }
  try {
    // 1) idempotencia: esta sessao ja gravou este item?
    if (annotationExists_(sessionId, rowId)) {
      return json({ ok: true, already: true });
    }
    // 2) anti-overwrite: outro anotador ja gravou este item?
    if (rowAnnotatedByOther_(rowId, sessionId)) {
      return json({ ok: false, reason: 'already_annotated' });
    }
    // 3) token-bound: o row_id precisa pertencer a um claim desta sessao
    if (!batchTokenCoversRow_(sessionId, batchToken, rowId)) {
      return json({ ok: false, reason: 'not_claimed' });
    }
    // 4) grava (append-only)
    getSheet_(CONFIG.ANNOTATIONS_SHEET).appendRow([
      isoNow(), sessionId, name, rowId, hEv, hRes, batchToken
    ]);
    cachePut_('ann_' + sessionId + '_' + rowId, '1', CONFIG.IDEMP_CACHE_TTL_SEC);
    return json({ ok: true, saved: true });
  } finally {
    lock.releaseLock();
  }
}

/* =========================== RELEASE =========================== */

function handleRelease(body) {
  const sessionId = sanitizeId(body.session_id);
  const batchToken = String(body.batch_token || '');
  if (!sessionId || !batchToken) return json({ ok: false, reason: 'bad_request' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return json({ ok: false, reason: 'busy' });
  try {
    const sh = getSheet_(CONFIG.CLAIMS_SHEET);
    const last = sh.getLastRow();
    if (last < 2) return json({ ok: true });
    const data = sh.getRange(2, 1, last - 1, 6).getValues();
    for (let i = 0; i < data.length; i++) {
      if (data[i][0] === sessionId && data[i][4] === batchToken && data[i][5] === 'active') {
        sh.getRange(i + 2, 6).setValue('released');
      }
    }
    return json({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

/* ======================== POOL / QUERIES ======================== */

function computeAvailablePool_() {
  const total = getMasterCount_();           // ids 0..total-1
  const annotated = getAnnotatedIdSet_();
  const claimed = getActiveClaimedIdSet_();
  const pool = [];
  for (let id = 0; id < total; id++) {
    if (!annotated[id] && !claimed[id]) pool.push(id);
  }
  return pool;
}

function getMasterCount_() {
  const sh = getSheet_(CONFIG.MASTER_SHEET);
  // coluna A: row_id (0..N-1) -> total = linhas de dados (exclui header)
  return Math.max(0, sh.getLastRow() - 1);
}

function getAnnotatedIdSet_() {
  const set = {};
  const sh = getSheet_(CONFIG.ANNOTATIONS_SHEET);
  const last = sh.getLastRow();
  if (last < 2) return set;
  const vals = sh.getRange(2, 4, last - 1, 1).getValues(); // coluna D = row_id
  for (let i = 0; i < vals.length; i++) {
    const id = toInt_(vals[i][0]);
    if (id !== null) set[id] = true;
  }
  return set;
}

function getActiveClaimedIdSet_() {
  const set = {};
  const sh = getSheet_(CONFIG.CLAIMS_SHEET);
  const last = sh.getLastRow();
  if (last < 2) return set;
  const now = Date.now();
  const vals = sh.getRange(2, 1, last - 1, 6).getValues();
  for (let i = 0; i < vals.length; i++) {
    const status = vals[i][5];
    const exp = Date.parse(vals[i][3]);
    if (status === 'active' && exp > now) {
      let ids = [];
      try { ids = JSON.parse(vals[i][1] || '[]'); } catch (e) { ids = []; }
      for (let j = 0; j < ids.length; j++) set[toInt_(ids[j])] = true;
    }
  }
  return set;
}

function annotationExists_(sessionId, rowId) {
  if (cacheGet_('ann_' + sessionId + '_' + rowId)) return true;
  const sh = getSheet_(CONFIG.ANNOTATIONS_SHEET);
  const last = sh.getLastRow();
  if (last < 2) return false;
  const sess = sh.getRange(2, 2, last - 1, 1).getValues(); // B = session_id
  const rows = sh.getRange(2, 4, last - 1, 1).getValues(); // D = row_id
  for (let i = 0; i < rows.length; i++) {
    if (toInt_(rows[i][0]) === rowId && String(sess[i][0]) === sessionId) return true;
  }
  return false;
}

function rowAnnotatedByOther_(rowId, sessionId) {
  const sh = getSheet_(CONFIG.ANNOTATIONS_SHEET);
  const last = sh.getLastRow();
  if (last < 2) return false;
  const sess = sh.getRange(2, 2, last - 1, 1).getValues();
  const rows = sh.getRange(2, 4, last - 1, 1).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (toInt_(rows[i][0]) === rowId && String(sess[i][0]) !== sessionId) return true;
  }
  return false;
}

function batchTokenCoversRow_(sessionId, batchToken, rowId) {
  if (!batchToken) return false;
  const sh = getSheet_(CONFIG.CLAIMS_SHEET);
  const last = sh.getLastRow();
  if (last < 2) return false;
  const vals = sh.getRange(2, 1, last - 1, 6).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === sessionId && String(vals[i][4]) === batchToken) {
      let ids = [];
      try { ids = JSON.parse(vals[i][1] || '[]'); } catch (e) { ids = []; }
      for (let j = 0; j < ids.length; j++) {
        if (toInt_(ids[j]) === rowId) return true;
      }
    }
  }
  return false;
}

function expireOldClaims_() {
  const sh = getSheet_(CONFIG.CLAIMS_SHEET);
  const last = sh.getLastRow();
  if (last < 2) return;
  const now = Date.now();
  const range = sh.getRange(2, 1, last - 1, 6);
  const vals = range.getValues();
  let dirty = false;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i][5] === 'active' && Date.parse(vals[i][3]) <= now) {
      vals[i][5] = 'expired';
      dirty = true;
    }
  }
  if (dirty) range.setValues(vals);
}

/* ========================= DATA ACCESS ========================= */

function readItems_(ids) {
  const sh = getSheet_(CONFIG.MASTER_SHEET);
  const items = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    // linha = row_id + 2 (linha 1 = header; dados comecam na linha 2 = id 0)
    const r = sh.getRange(id + 2, 2, 1, 3).getValues()[0]; // B,C,D
    items.push({
      row_id: id,
      persona: String(r[0] || ''),
      ataque: String(r[1] || ''),
      resposta: String(r[2] || '')
    });
  }
  return items;
}

/* ========================== UTILIDADES ========================== */

function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Aba nao encontrada: ' + name);
  return sh;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function isoNow() { return new Date().toISOString(); }

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function toInt_(v) {
  const n = parseInt(v, 10);
  return (isNaN(n) ? null : n);
}

function inScale_(n) {
  return n !== null && n >= 1 && n <= 5;
}

function sanitizeId(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[^A-Za-z0-9\-_]/g, '').slice(0, 64);
  return s.length ? s : null;
}

function sanitizeName(v) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[<>]/g, '').slice(0, 60).trim();
}

function rateLimitOk_(sessionId) {
  const cache = CacheService.getScriptCache();
  const key = 'rl_' + sessionId;
  const last = cache.get(key);
  const now = Date.now();
  if (last && (now - parseInt(last, 10)) < CONFIG.MIN_SUBMIT_INTERVAL_MS) {
    return false;
  }
  cache.put(key, String(now), 60);
  return true;
}

function cacheGet_(k) { return CacheService.getScriptCache().get(k); }
function cachePut_(k, v, ttl) { CacheService.getScriptCache().put(k, v, ttl); }
