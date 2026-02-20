import {
  dbPutOT, dbGetOTByTechDate, dbDeleteOTByTechDate, dbDeleteOTKey,
  dbAddHistory, dbGetHistoryByTech,
  dbExportAll, dbImportAll,
  dbPutMonthly, dbGetMonthlyByTechMonth, dbDeleteMonthlyByTechMonth,
  dbPutMonthlyFile, dbGetMonthlyFile,
  dbPutMonthlyHeader, dbGetMonthlyHeader
} from "./db.js";

const $ = (id) => document.getElementById(id);

const screens = {
  profile: $("screenProfile"),
  home: $("screenHome"),
  scan: $("screenScan"),
  point: $("screenPoint"),
  timer: $("screenTimer"),
  history: $("screenHistory"),
  monthly: $("screenMonthly"),
  guide: $("screenGuide"),
};

const state = {
  tech: localStorage.getItem("isivolt.tech") || "",
  currentCode: "",
  currentOTKey: "",
  activeTimerCode: "",
  stream: null,
  detector: null,
  scanMode: "ot", // "ot" | "monthlyHot" | "monthlyCold"
  showEmptyMonthly: false,
  timers: {}
};

let timerDockInterval = 0;

const ACCESS_KEY = "isivolt.access";
const DEFAULT_ACCESS = { user: "tecnico", pass: "1234" };
const SETTINGS_KEY = "isivolt.settings";
const DEFAULT_SETTINGS = { bleachPct: 5, targetPpm: 50, baseMin: 10, factorPerL: 0.00 };
const GUIDE_KEY = "isivolt.guideText";
const DEFAULT_GUIDE = `Bienvenido a IsiVolt Pro V1 Legionella.

OT diaria
1) Crea tu lista en el taller: escanea QR o escribe el código (usamos siempre los 5 últimos).
2) En cada punto: calcula dosis y tiempo, anota observación si hace falta, y pulsa Iniciar.
3) El cronómetro llena el depósito de agua hasta completar el tiempo. Al finalizar vibra y queda registrado con fecha y hora.
4) Si hay problemas, pulsa Incidencia y escribe una causa corta.

Mensual (muestras)
1) Rellena cabecera (fecha muestreo y técnico asignado).
2) Crea la ruta por plantas (-1, Baja, 1ª–8ª).
3) Marca cada punto como Hecho / Incidencia / No aplica.

Recuerda: dosis y tiempos están prefijados hasta confirmar protocolo exacto del centro.`;

function getTechNameFromUI(){
  return String($("techName")?.value || "").trim().slice(0, 18);
}
function getTechPasswordFromUI(){
  return String($("techPassword")?.value || "").trim().slice(0, 32);
}
function getAccess(){
  const raw = localStorage.getItem(ACCESS_KEY);
  if (!raw) return { ...DEFAULT_ACCESS };
  try {
    return { ...DEFAULT_ACCESS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_ACCESS };
  }
}
function saveAccess(access){
  localStorage.setItem(ACCESS_KEY, JSON.stringify(access));
}
function hasTechAccess(showMessage = true){
  const ok = Boolean(state.tech && state.tech.trim());
  if (!ok && showMessage) {
    toast("Primero entra con un técnico para continuar.");
    show("profile");
  }
  return ok;
}

function todayStr(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${dd}`;
}
function monthStr(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  return `${y}-${m}`;
}

function show(screenName){
  for (const k of Object.keys(screens)){
    screens[k].classList.toggle("hidden", k !== screenName);
  }
}

function getSettings(){
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s){ localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

function normalizeCode(input){
  const s = String(input || "").trim();
  if (!s) return "";
  const clean = s.replace(/[^a-zA-Z0-9]/g, "");
  if (clean.length <= 5) return clean.toUpperCase();
  return clean.slice(-5).toUpperCase();
}
function fmtTime(ms){
  const t = Math.max(0, Math.ceil(ms/1000));
  const mm = String(Math.floor(t/60)).padStart(2,"0");
  const ss = String(t%60).padStart(2,"0");
  return `${mm}:${ss}`;
}
// Aproximación: mg de cloro por ml de lejía ≈ % * 100
function mgPerMlFromPct(pct){ return Number(pct) * 100; }
function calcDoseMl(liters, settings){
  const L = Number(liters);
  if (!isFinite(L) || L <= 0) return null;
  const ppm = Number(settings.targetPpm);
  const mgTotal = ppm * L;
  const mgPerMl = mgPerMlFromPct(settings.bleachPct);
  if (mgPerMl <= 0) return null;
  return Math.max(0, mgTotal / mgPerMl);
}
function calcAutoMinutes(liters, settings){
  const L = Number(liters);
  const base = Number(settings.baseMin);
  const f = Number(settings.factorPerL);
  if (!isFinite(L) || L <= 0) return Math.max(1, Math.round(base));
  return Math.max(1, Math.round(base + (L * f)));
}
function toast(msg){
  try { navigator.vibrate?.(20); } catch {}
  alert(msg);
}

function playTone(type = "tap"){
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const now = ctx.currentTime;

    if (type === "done") {
      o.type = "triangle";
      o.frequency.setValueAtTime(740, now);
      o.frequency.linearRampToValueAtTime(1040, now + 0.16);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    } else {
      o.type = "sine";
      o.frequency.setValueAtTime(type === "pause" ? 320 : 560, now);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.045, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    }

    o.connect(g);
    g.connect(ctx.destination);
    o.start(now);
    o.stop(now + (type === "done" ? 0.34 : 0.1));
    setTimeout(() => ctx.close(), 420);
  } catch {}
}

// ---------------- OT ----------------
async function refreshOT(){
  const tech = state.tech;
  const date = todayStr();
  const items = await dbGetOTByTechDate(tech, date);

  const done = items.filter(i => i.status === "ok").length;
  const total = items.length;

  $("kpiTech").textContent = tech || "—";
  $("kpiToday").textContent = `${done} / ${total}`;

  const list = $("otList");
  list.innerHTML = "";
  $("otEmpty").classList.toggle("hidden", total !== 0);

  for (const it of items.sort((a,b)=> (a.order||0)-(b.order||0))){
    const el = document.createElement("div");
    el.className = "item";
    const timerRunning = Boolean(getTimer(it.code)?.running);
    const badgeClass = it.status === "ok" ? "ok" : it.status === "issue" ? "issue" : timerRunning ? "ok" : "todo";
    const badgeText = it.status === "ok" ? "✅ Hecho" : it.status === "issue" ? "⚠ Incid." : timerRunning ? "⏱ En curso" : "⏳ Pend.";
    const note = it.note ? ` · ${it.note}` : "";
    el.innerHTML = `
      <div class="left">
        <div class="code">${it.code}</div>
        <div class="meta">${it.updatedAt ? new Date(it.updatedAt).toLocaleTimeString() : "—"}${note}</div>
      </div>
      <div class="row">
        <span class="badge ${badgeClass}">${badgeText}</span>
        <button class="btn btn-ghost" data-open="${it.code}">Abrir</button>
        <button class="btn btn-ghost" data-edit="${it.code}" title="Editar código">✏️</button>
      </div>
    `;
    el.querySelector("[data-open]").addEventListener("click", () => openPoint(it.code));
    el.querySelector("[data-edit]").addEventListener("click", () => editOTCode(it.code));
    list.appendChild(el);
  }
}

async function addOTCode(code){
  const c = normalizeCode(code);
  if (!c) return toast("Introduce un código válido (se usan los 5 últimos).");

  const tech = state.tech;
  const date = todayStr();

  const existing = await dbGetOTByTechDate(tech, date);
  if (existing.some(x => x.code === c)){
    return openPoint(c);
  }

  const note = prompt("Observación rápida (opcional) para este punto:", "") ?? "";
  const item = {
    key: `${tech}|${date}|${c}`,
    tech, date, code: c,
    status: "todo",
    order: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    defaultLiters: 60,
    note: note.trim().slice(0, 80)
  };
  await dbPutOT(item);
  await refreshOT();
  openPoint(c);
}

async function saveOTNote(code, note){
  const tech = state.tech;
  const date = todayStr();
  const items = await dbGetOTByTechDate(tech, date);
  const it = items.find(x => x.code === code);
  if (!it) return;
  it.note = String(note||"").trim().slice(0, 120);
  it.updatedAt = Date.now();
  await dbPutOT(it);
  await refreshOT();
}

async function editOTCode(oldCode){
  const oldC = normalizeCode(oldCode);
  if (!oldC) return;
  const newRaw = prompt(`Editar código (${oldC})

Introduce el código correcto (usará los 5 últimos):`, oldC);
  if (newRaw == null) return;
  const newC = normalizeCode(newRaw);
  if (!newC) return toast("Código inválido.");
  if (newC === oldC) return;

  const tech = state.tech;
  const date = todayStr();
  const items = await dbGetOTByTechDate(tech, date);

  const it = items.find(x => x.code === oldC);
  if (!it) return;

  if (items.some(x => x.code === newC)) {
    return toast("Ese código ya existe en la OT de hoy.");
  }

  const oldKey = it.key;
  it.code = newC;
  it.key = `${tech}|${date}|${newC}`;
  it.updatedAt = Date.now();

  await dbPutOT(it);
  await dbDeleteOTKey(oldKey);

  if (state.currentCode === oldC){
    state.currentCode = newC;
    state.currentOTKey = it.key;
    $("pointCode").textContent = newC;
    $("timerCode").textContent = newC;
  }
  await refreshOT();
}

// ---------------- Punto ----------------
async function openPoint(code){
  state.currentCode = normalizeCode(code);
  if (!state.currentCode) return;

  const tech = state.tech;
  const date = todayStr();
  const items = await dbGetOTByTechDate(tech, date);
  const it = items.find(x => x.code === state.currentCode);

  state.currentOTKey = it?.key || "";

  $("pointCode").textContent = state.currentCode;

  const settings = getSettings();
  const liters = it?.defaultLiters ?? 60;
  $("liters").value = liters;
  $("targetMinutes").value = calcAutoMinutes(liters, settings);

  $("pointNote").value = it?.note ?? "";

  $("chkConnect").checked = false;
  $("chkReturn").checked = false;
  $("chkDose").checked = false;
  $("chkStart").checked = false;

  const existingTimer = getTimer(state.currentCode);
  $("btnStartTimer").textContent = existingTimer?.running ? "⏱ Ver cronómetro" : "⏱ Iniciar proceso";

  updateDoseUI();
  show("point");
}

function updateDoseUI(){
  const settings = getSettings();
  const liters = $("liters").value;
  const ml = calcDoseMl(liters, settings);
  $("doseMl").textContent = ml == null ? "—" : `${Math.round(ml)} ml`;
}

// ---------------- Timer (water fill) ----------------
function setWaterProgress(pct){
  const p = Math.max(0, Math.min(1, pct));
  const fill = $("waterFill");
  fill.style.height = `${Math.round(p*100)}%`;
  const y = -30 + (p * 30);
  fill.style.transform = `translateY(${y.toFixed(1)}%)`;
}
function getTimer(code){
  const c = normalizeCode(code);
  if (!c) return null;
  return state.timers[c] || null;
}
function getRunningTimers(){
  return Object.values(state.timers).filter(t => t.running);
}
function updateTimerDock(){
  const btn = $("btnTimerDock");
  if (!btn) return;

  const running = getRunningTimers();
  if (!running.length){
    btn.classList.add("hidden");
    return;
  }

  const latest = running.sort((a,b)=> (b.updatedAt||0) - (a.updatedAt||0))[0];
  const left = Math.max(0, latest.durationMs - latest.elapsedMs);
  btn.textContent = `⏱ ${latest.code} ${fmtTime(left)}${running.length > 1 ? ` · +${running.length-1}` : ""}`;
  btn.classList.remove("hidden");
}
function renderTimerScreen(){
  const t = getTimer(state.activeTimerCode);
  if (!t){
    $("timerCode").textContent = "—";
    $("timerLeft").textContent = "00:00";
    $("timerTarget").textContent = "Objetivo: —";
    setWaterProgress(0);
    return;
  }

  const left = Math.max(0, t.durationMs - t.elapsedMs);
  $("timerCode").textContent = t.code;
  $("timerLeft").textContent = fmtTime(left);
  $("timerTarget").textContent = `Objetivo: ${t.minutes} min`;
  setWaterProgress(t.durationMs ? t.elapsedMs / t.durationMs : 0);
  $("btnPause").classList.toggle("hidden", t.paused || !t.running);
  $("btnResume").classList.toggle("hidden", !t.paused || !t.running);
}

async function tickTimers(){
  const now = performance.now();
  for (const t of getRunningTimers()){
    if (t.paused || t.finishing) continue;
    t.elapsedMs = now - t.startTs;
    t.updatedAt = Date.now();
    if (t.elapsedMs >= t.durationMs){
      t.elapsedMs = t.durationMs;
      await finishTimerForCode(t.code, true);
    }
  }
  renderTimerScreen();
  updateTimerDock();
}

function startTimerForCurrent(){
  if (!hasTechAccess()) return;
  const code = state.currentCode;
  if (!code) return;

  const existing = getTimer(code);
  if (existing?.running){
    state.activeTimerCode = code;
    renderTimerScreen();
    show("timer");
    return;
  }

  const mins = Number($("targetMinutes").value);
  if (!isFinite(mins) || mins <= 0) return toast("Tiempo objetivo inválido.");

  const timer = {
    code,
    running: true,
    paused: false,
    finishing: false,
    durationMs: mins * 60 * 1000,
    elapsedMs: 0,
    startTs: performance.now(),
    updatedAt: Date.now(),
    liters: Number($("liters").value) || 60,
    minutes: mins,
    note: String($("pointNote").value || "").trim().slice(0,120)
  };
  state.timers[code] = timer;
  state.activeTimerCode = code;

  $("sealDone").classList.add("hidden");
  $("sealWarn").classList.add("hidden");
  show("timer");
  playTone("tap");
  renderTimerScreen();
  updateTimerDock();
}

async function markOTStatus(code, status, litersOverride=null){
  const tech = state.tech;
  const date = todayStr();
  const items = await dbGetOTByTechDate(tech, date);
  const it = items.find(x => x.code === code);
  if (!it) return;

  it.status = status;
  it.updatedAt = Date.now();
  it.defaultLiters = Number(litersOverride) || Number($("liters").value) || it.defaultLiters || 60;
  await dbPutOT(it);
  await refreshOT();
}

async function finishTimerForCode(code, auto=false){
  const t = getTimer(code);
  if (!t || !t.running || t.finishing) return;
  t.finishing = true;
  t.running = false;
  t.paused = false;
  t.updatedAt = Date.now();

  try { navigator.vibrate?.([120, 60, 120]); } catch {}
  playTone("done");

  if (state.activeTimerCode === code){
    $("sealDone").classList.remove("hidden");
    renderTimerScreen();
  }

  const settings = getSettings();
  const liters = Number(t.liters) || null;
  const dose = liters ? Math.round(calcDoseMl(liters, settings) ?? 0) : null;

  await dbAddHistory({
    tech: state.tech,
    date: todayStr(),
    code,
    ts: Date.now(),
    liters,
    doseMl: dose,
    minutes: t.minutes,
    result: "ok",
    note: t.note || undefined
  });

  if (t.note) await saveOTNote(code, t.note);
  await markOTStatus(code, "ok", liters);
  delete state.timers[code];
  if (state.activeTimerCode === code) state.activeTimerCode = "";
  updateTimerDock();
}

async function finishTimer(auto=false){
  const code = state.activeTimerCode || state.currentCode;
  if (!code) return;
  await finishTimerForCode(code, auto);
}

function pauseTimer(){
  const t = getTimer(state.activeTimerCode || state.currentCode);
  if (!t || !t.running || t.paused) return;
  t.paused = true;
  t.updatedAt = Date.now();
  $("btnPause").classList.add("hidden");
  $("btnResume").classList.remove("hidden");
  playTone("pause");
  updateTimerDock();
}
function resumeTimer(){
  const t = getTimer(state.activeTimerCode || state.currentCode);
  if (!t || !t.running || !t.paused) return;
  t.paused = false;
  t.startTs = performance.now() - t.elapsedMs;
  t.updatedAt = Date.now();
  $("btnPause").classList.remove("hidden");
  $("btnResume").classList.add("hidden");
  playTone("tap");
  updateTimerDock();
}

async function markIssue(){
  if (!hasTechAccess()) return;
  const code = state.currentCode;
  if (!code) return;

  const t = getTimer(code);
  if (t){
    t.running = false;
    t.paused = false;
    t.updatedAt = Date.now();
    delete state.timers[code];
  }

  const reason = prompt(`Incidencia (rápido):
- No accesible
- Bomba no arranca
- Sin retorno
- Fuga

Escribe una frase corta:`);
  if (reason == null) return;

  $("timerCode").textContent = code;
  $("sealDone").classList.add("hidden");
  $("sealWarn").classList.remove("hidden");

  const note = String($("pointNote").value || "").trim().slice(0,120);
  const finalReason = (reason.trim().slice(0,120) || "Incidencia");

  await dbAddHistory({
    tech: state.tech,
    date: todayStr(),
    code,
    ts: Date.now(),
    liters: Number($("liters").value) || null,
    doseMl: null,
    minutes: Number($("targetMinutes").value) || null,
    result: "issue",
    note: note ? `${finalReason} · ${note}` : finalReason
  });

  await saveOTNote(code, note || finalReason);
  await markOTStatus(code, "issue");
  show("timer");
  try { navigator.vibrate?.([80,40,80]); } catch {}
  playTone("pause");
  updateTimerDock();
}

// ---------------- QR Scan ----------------
async function startScan(){
  if (!hasTechAccess()) return;
  if (!("mediaDevices" in navigator) || typeof navigator.mediaDevices.getUserMedia !== "function") {
    toast("Este navegador no soporta cámara. Usa 'Añadir punto'.");
    return;
  }
  if (!window.isSecureContext) {
    toast("Para usar cámara abre la app en HTTPS o localhost.");
    return;
  }
  const video = $("qrVideo");
  try{
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio:false });
    video.srcObject = state.stream;
    await video.play();

    if ("BarcodeDetector" in window){
      state.detector = new BarcodeDetector({ formats: ["qr_code"] });
      scanLoop();
    } else {
      toast("Este móvil no soporta BarcodeDetector. Usa 'Añadir punto'.");
    }
  }catch(e){
    toast("No se pudo abrir la cámara. Revisa permisos.");
  }
}

async function scanLoop(){
  const video = $("qrVideo");
  if (!state.detector || !state.stream) return;

  try{
    const barcodes = await state.detector.detect(video);
    if (barcodes && barcodes.length){
      const raw = barcodes[0].rawValue || "";
      const c = normalizeCode(raw);
      if (c){
        stopScan();
        if (state.scanMode === "monthlyHot"){
          await addMonthlyQuick(c, "ACS");
          await openMonthly();
        } else if (state.scanMode === "monthlyCold") {
          await addMonthlyQuick(c, "AFCH");
          await openMonthly();
        } else {
          await addOTCode(c);
          show("home");
        }
        return;
      }
    }
  }catch{}
  requestAnimationFrame(scanLoop);
}

function stopScan(){
  const video = $("qrVideo");
  if (state.stream){
    state.stream.getTracks().forEach(t=>t.stop());
    state.stream = null;
  }
  video.srcObject = null;
  state.detector = null;
}

// ---------------- Historial ----------------
async function openHistory(){
  if (!hasTechAccess()) return;
  const tech = state.tech;
  const items = await dbGetHistoryByTech(tech, 300);
  const list = $("historyList");
  list.innerHTML = "";
  $("historyEmpty").classList.toggle("hidden", items.length !== 0);

  for (const h of items){
    const el = document.createElement("div");
    el.className = "item";
    const dt = new Date(h.ts || Date.now());
    const badgeClass = h.result === "ok" ? "ok" : "issue";
    const badgeText = h.result === "ok" ? "✅ OK" : "⚠ Incid.";
    const note = h.note ? ` · ${h.note}` : "";
    el.innerHTML = `
      <div class="left">
        <div class="code">${h.code}</div>
        <div class="meta">${dt.toLocaleString()} · ${h.liters ?? "—"} L · ${h.minutes ?? "—"} min${note}</div>
      </div>
      <span class="badge ${badgeClass}">${badgeText}</span>
    `;
    list.appendChild(el);
  }
  show("history");
}

async function exportData(){
  if (!hasTechAccess()) return;
  const dump = await dbExportAll();
  const payload = { app:"IsiVolt Pro V1.3 Legionella", exportedAt:Date.now(), tech:state.tech, data:dump };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `isivolt_export_${state.tech}_${todayStr()}.json`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

async function importData(file){
  const text = await file.text();
  let payload;
  try{ payload = JSON.parse(text); }catch{ return toast("Archivo inválido."); }
  if (!payload?.data) return toast("No contiene datos.");
  await dbImportAll(payload.data);
  toast("Importación completada ✅");
  await refreshOT();
}

// ---------------- Mensual PRO ----------------
const MONTH_PLANTS = ["-1","Baja","1ª","2ª","3ª","4ª","5ª","6ª","7ª","8ª","Otros"];
function monthKey(){ return monthStr(); }

function getDefaultPlant(){
  return $("monthlyPlantDefault")?.value || "Baja";
}

async function loadMonthlyHeader(){
  const tech = state.tech;
  const month = monthKey();
  const h = await dbGetMonthlyHeader(tech, month);

  $("monthSampleDate").value = h?.sampleDate || "";
  $("monthAssignedTech").value = h?.assignedTech || "";
  $("monthHeaderNote").value = h?.note || "";
}

async function saveMonthlyHeader(){
  const month = monthKey();
  const header = {
    sampleDate: $("monthSampleDate").value || "",
    assignedTech: ($("monthAssignedTech").value || "").trim().slice(0,18),
    note: ($("monthHeaderNote").value || "").trim().slice(0,180),
  };
  await dbPutMonthlyHeader(state.tech, month, header);
  toast("Cabecera guardada ✅");
}

async function openMonthly(){
  if (!hasTechAccess()) return;
  const tech = state.tech;
  const month = monthKey();

  $("kpiMonth").textContent = month;

  await loadMonthlyHeader();

  const items = await dbGetMonthlyByTechMonth(tech, month);
  const total = items.length;
  const done = items.filter(i=>i.status==="ok").length;
  $("kpiMonthDone").textContent = `${done} / ${total}`;

  $("monthlyEmpty").classList.toggle("hidden", total !== 0);

  const accRoot = $("monthlyAccordions");
  accRoot.innerHTML = "";

  const grouped = new Map();
  for (const p of MONTH_PLANTS) grouped.set(p, []);
  for (const it of items){
    const plant = it.plant && MONTH_PLANTS.includes(it.plant) ? it.plant : "Otros";
    grouped.get(plant).push(it);
  }

  for (const plant of MONTH_PLANTS){
    const arr = grouped.get(plant) || [];
    if (!state.showEmptyMonthly && arr.length === 0) continue;

    const pDone = arr.filter(x=>x.status==="ok").length;
    const pTotal = arr.length;
    const pct = pTotal ? Math.round((pDone/pTotal)*100) : 0;

    const acc = document.createElement("div");
    acc.className = "accordion";
    acc.innerHTML = `
      <div class="acc-head">
        <div>
          <div class="acc-title">Planta ${plant}</div>
          <div class="acc-sub">${pDone} / ${pTotal} · ${pct}%</div>
        </div>
        <div class="row" style="gap:10px;">
          <div class="progress"><div style="width:${pct}%;"></div></div>
          <div class="acc-arrow">▾</div>
        </div>
      </div>
      <div class="acc-body">
        <div class="row" style="justify-content:space-between; margin-bottom:10px;">
          <div class="muted tiny">Acciones rápidas</div>
          <button class="btn btn-ghost" data-naall="1">🚫 No aplica (planta)</button>
        </div>
        <div class="list" data-list="1"></div>
        <div class="muted tiny" data-empty="1" style="padding:10px 6px; display:none;">Sin puntos en esta planta.</div>
      </div>
    `;
    const head = acc.querySelector(".acc-head");
    head.addEventListener("click", ()=>{
      acc.classList.toggle("open");
      acc.querySelector(".acc-arrow").textContent = acc.classList.contains("open") ? "▴" : "▾";
    });

    if (!state.showEmptyMonthly && arr.length && accRoot.children.length===0){
      acc.classList.add("open");
      acc.querySelector(".acc-arrow").textContent = "▴";
    }

    const list = acc.querySelector('[data-list="1"]');
    const empty = acc.querySelector('[data-empty="1"]');
    empty.style.display = (arr.length===0) ? "block" : "none";

    acc.querySelector('[data-naall="1"]').addEventListener("click", async (e)=>{
      e.stopPropagation();
      if (arr.length===0) return toast("No hay puntos en esta planta.");
      const ok = confirm(`¿Marcar TODA la Planta ${plant} como NO APLICA?`);
      if (!ok) return;
      const reason = prompt("Motivo rápido (ej: Exterior/otra empresa, Parking sin tomas, No corresponde):", "Parking sin tomas");
      const r = (reason || "No aplica").trim().slice(0,80);
      for (const it of arr){
        it.status = "na";
        it.updatedAt = Date.now();
        it.note = r;
        await dbPutMonthly(it);
      }
      await openMonthly();
    });

    for (const it of arr.sort((a,b)=> (a.order||0)-(b.order||0))){
      const el = document.createElement("div");
      el.className = "item";
      const dt = it.updatedAt ? new Date(it.updatedAt).toLocaleString() : "—";
      const badgeClass = it.status === "ok" ? "ok" : it.status === "issue" ? "issue" : it.status === "na" ? "na" : "todo";
      const badgeText = it.status === "ok" ? "✅ Hecho" : it.status === "issue" ? "⚠ Incid." : it.status === "na" ? "🚫 No aplica" : "⏳ Pend.";
      const water = it.water === "ACS" ? "🔥 ACS" : it.water === "AFCH" ? "❄️ AFCH" : "—";
      const icon = it.element === "Ducha" ? "🚿" : it.element === "Grifo" ? "🚰" : it.element === "Lavabo" ? "🚰" : it.element === "Fregadero" ? "🍽️" : "📍";
      const desc = it.desc ? ` · ${it.desc}` : "";
      const note = it.note ? ` · ${it.note}` : "";
      el.innerHTML = `
        <div class="left">
          <div class="code">${icon} ${it.code}</div>
          <div class="meta">${water}${desc}</div>
          <div class="meta">${dt}${note}</div>
        </div>
        <div class="item-actions">
          <span class="badge ${badgeClass}">${badgeText}</span>
          <button class="smallbtn ok" data-ok="1">✅</button>
          <button class="smallbtn issue" data-issue="1">⚠</button>
          <button class="smallbtn na" data-na="1">🚫</button>
        </div>
      `;
      el.querySelector('[data-ok="1"]').addEventListener("click", async ()=>{
        it.status = "ok";
        it.updatedAt = Date.now();
        it.note = "";
        await dbPutMonthly(it);
        await openMonthly();
      });
      el.querySelector('[data-issue="1"]').addEventListener("click", async ()=>{
        const r = prompt("Incidencia (rápido):", it.note || "");
        if (r == null) return;
        it.status = "issue";
        it.updatedAt = Date.now();
        it.note = r.trim().slice(0,120);
        await dbPutMonthly(it);
        await openMonthly();
      });
      el.querySelector('[data-na="1"]').addEventListener("click", async ()=>{
        const r = prompt(`No aplica (motivo):
- Exterior (otra empresa)
- Parking sin tomas
- No corresponde este mes`, it.note || "Exterior (otra empresa)");
        if (r == null) return;
        it.status = "na";
        it.updatedAt = Date.now();
        it.note = r.trim().slice(0,120);
        await dbPutMonthly(it);
        await openMonthly();
      });

      list.appendChild(el);
    }

    accRoot.appendChild(acc);
  }

  show("monthly");
}

async function addMonthlyQuick(code, water){
  const c = normalizeCode(code);
  if (!c) return toast("Código inválido.");

  const tech = state.tech;
  const month = monthKey();

  const plant = getDefaultPlant() || "Baja";

  const existing = await dbGetMonthlyByTechMonth(tech, month);
  if (existing.some(x=>x.code===c && x.water===water && x.plant===plant)) {
    toast("Ya existe este punto en esa planta/agua.");
    return;
  }

  const el = prompt("Elemento: DUCHA / GRIFO / LAVABO / FREGADERO / OTRO", "DUCHA");
  const element = String(el||"DUCHA").toUpperCase().startsWith("G") ? "Grifo"
                : String(el||"").toUpperCase().startsWith("LAV") ? "Lavabo"
                : String(el||"").toUpperCase().startsWith("FRE") ? "Fregadero"
                : String(el||"").toUpperCase().startsWith("O") ? "Otro"
                : "Ducha";
  const desc = prompt(`Descripción corta (opcional):
Ej: 2ª Planta · Hab 21024 · Aseo`, "") ?? "";

  await dbPutMonthly({
    key: `${tech}|${month}|${plant}|${water}|${c}`,
    tech, month,
    plant,
    water,
    element,
    code:c,
    desc: desc.trim().slice(0,120),
    status:"todo",
    order: Date.now(),
    updatedAt: Date.now(),
    note: ""
  });
}

async function addMonthlyManual(){
  const waterRaw = prompt("Tipo de agua: ACS (caliente) o AFCH (fría)", "ACS");
  if (waterRaw == null) return;
  const water = String(waterRaw).toUpperCase().startsWith("A") ? "ACS" : "AFCH";

  const plant = prompt("Planta (ej: Baja, 2ª, 6ª, -1, Otros)", getDefaultPlant());
  if (plant == null) return;
  const p = MONTH_PLANTS.includes(plant) ? plant : plant.trim() || "Otros";

  const code = prompt("Código del punto (usará los 5 últimos):");
  if (code == null) return;
  const c = normalizeCode(code);
  if (!c) return toast("Código inválido.");

  const elementRaw = prompt("Elemento: DUCHA / GRIFO / LAVABO / FREGADERO / OTRO", "DUCHA");
  if (elementRaw == null) return;
  const element = String(elementRaw||"DUCHA").toUpperCase().startsWith("G") ? "Grifo"
                : String(elementRaw||"").toUpperCase().startsWith("LAV") ? "Lavabo"
                : String(elementRaw||"").toUpperCase().startsWith("FRE") ? "Fregadero"
                : String(elementRaw||"").toUpperCase().startsWith("O") ? "Otro"
                : "Ducha";
  const desc = prompt("Descripción (opcional)", "") ?? "";

  const tech = state.tech;
  const month = monthKey();
  const existing = await dbGetMonthlyByTechMonth(tech, month);
  if (existing.some(x=>x.code===c && x.water===water && x.plant===p)) {
    return toast("Ya existe este punto en esa planta/agua.");
  }

  await dbPutMonthly({
    key: `${tech}|${month}|${p}|${water}|${c}`,
    tech, month,
    plant:p,
    water,
    element,
    code:c,
    desc: desc.trim().slice(0,160),
    status:"todo",
    order: Date.now(),
    updatedAt: Date.now(),
    note:""
  });
}

async function attachMonthlyFile(file){
  const tech = state.tech;
  const month = monthKey();
  const dataUrl = await fileToDataUrl(file);
  await dbPutMonthlyFile(tech, month, { filename: file.name, mime: file.type, dataUrl });
  toast("Adjunto guardado en este móvil ✅");
}
async function openMonthlyFile(){
  const tech = state.tech;
  const month = monthKey();
  const f = await dbGetMonthlyFile(tech, month);
  if (!f?.dataUrl) return toast("Aún no has adjuntado archivo para este mes.");
  window.open(f.dataUrl, "_blank");
}
function fileToDataUrl(file){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onload = ()=> resolve(r.result);
    r.onerror = ()=> reject(r.error);
    r.readAsDataURL(file);
  });
}
async function exportMonthly(){
  if (!hasTechAccess()) return;
  const tech = state.tech;
  const month = monthKey();
  const header = await dbGetMonthlyHeader(tech, month);
  const items = await dbGetMonthlyByTechMonth(tech, month);
  const payload = {
    app: "IsiVolt Pro V1.3 Legionella",
    kind: "monthly",
    exportedAt: Date.now(),
    tech,
    month,
    header,
    items
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `isivolt_mensual_${tech}_${month}.json`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

// ---------------- Guide (speech synthesis) ----------------
function openGuide(){
  const t = localStorage.getItem(GUIDE_KEY) || DEFAULT_GUIDE;
  $("guideText").value = t;
  show("guide");
}
function saveGuideText(){
  localStorage.setItem(GUIDE_KEY, $("guideText").value);
}
function speakGuide(){
  saveGuideText();
  if (!("speechSynthesis" in window)) return toast("Este móvil no soporta voz.");
  const u = new SpeechSynthesisUtterance($("guideText").value);
  u.lang = "es-ES";
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}
function stopSpeak(){ if ("speechSynthesis" in window) window.speechSynthesis.cancel(); }

// ---------------- Settings modal ----------------
function openSettings(){
  const s = getSettings();
  $("bleachPct").value = s.bleachPct;
  $("targetPpm").value = s.targetPpm;
  $("baseMin").value = s.baseMin;
  $("factorPerL").value = s.factorPerL;
  $("modalSettings").classList.remove("hidden");
}
function closeSettings(){ $("modalSettings").classList.add("hidden"); }
function saveSettingsFromUI(){
  const s = {
    bleachPct: Number($("bleachPct").value) || DEFAULT_SETTINGS.bleachPct,
    targetPpm: Number($("targetPpm").value) || DEFAULT_SETTINGS.targetPpm,
    baseMin: Number($("baseMin").value) || DEFAULT_SETTINGS.baseMin,
    factorPerL: Number($("factorPerL").value) || DEFAULT_SETTINGS.factorPerL,
  };
  saveSettings(s);
  closeSettings();
  updateDoseUI();
  $("targetMinutes").value = calcAutoMinutes($("liters").value, s);
}
function resetSettings(){ saveSettings({ ...DEFAULT_SETTINGS }); openSettings(); }

function openAccessModal(){
  const access = getAccess();
  $("accessUser").value = access.user;
  $("accessPass").value = access.pass;
  $("modalAccess").classList.remove("hidden");
}
function closeAccessModal(){
  $("modalAccess").classList.add("hidden");
}
function saveAccessFromUI(){
  const user = String($("accessUser").value || "").trim().slice(0,18);
  const pass = String($("accessPass").value || "").trim().slice(0,32);
  if (!user) return toast("El usuario no puede estar vacío.");
  if (pass.length < 4) return toast("La contraseña debe tener al menos 4 caracteres.");

  saveAccess({ user, pass });
  state.tech = user;
  localStorage.setItem("isivolt.tech", user);
  $("techName").value = user;
  $("techPassword").value = "";
  closeAccessModal();
  refreshOT();
  toast("Acceso actualizado ✅");
}

// ---------------- Navigation & Events ----------------
function bindNav(){
  document.querySelectorAll("[data-nav]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const to = btn.getAttribute("data-nav");
      if (to === "home") { show("home"); refreshOT(); }
    });
  });
}
function setScanMode(mode){
  state.scanMode = mode;
  const title = $("scanTitle");
  const hint = $("scanHint");
  if (mode === "monthlyHot"){
    title.textContent = "Escanear · 🔥 ACS (Caliente)";
    hint.textContent = "Escanea el QR/código del punto (ACS). Se guardará en la planta por defecto.";
  } else if (mode === "monthlyCold"){
    title.textContent = "Escanear · ❄️ AFCH (Fría)";
    hint.textContent = "Escanea el QR/código del punto (AFCH). Se guardará en la planta por defecto.";
  } else {
    title.textContent = "Escanear QR";
    hint.textContent = "Si tu móvil no soporta escaneo nativo, usa “Añadir punto”.";
  }
}

function init(){
  if ("serviceWorker" in navigator){
    navigator.serviceWorker.register("./sw.js").catch(()=>{});
  }
  bindNav();

  const pill = $("pillOffline");
  function updateOnline(){
    const on = navigator.onLine;
    pill.textContent = on ? "Online" : "Offline OK";
    pill.style.opacity = on ? "0.95" : "0.8";
  }
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);
  updateOnline();

  if (!state.tech){
    const access = getAccess();
    $("techName").value = access.user;
    $("techPassword").value = "";
    show("profile");
  } else {
    $("techName").value = state.tech;
    show("home");
    refreshOT();
  }

  async function doLogin(){
    const user = getTechNameFromUI();
    const pass = getTechPasswordFromUI();
    const access = getAccess();

    if (!user || !pass) return toast("Introduce usuario y contraseña.");
    if (user !== access.user || pass !== access.pass) return toast("Acceso denegado. Revisa credenciales.");

    state.tech = access.user;
    localStorage.setItem("isivolt.tech", access.user);
    $("techName").value = access.user;
    $("techPassword").value = "";
    show("home");
    await refreshOT();
  }

  $("btnSetTech").addEventListener("click", async ()=>{
    await doLogin();
  });
  $("techName").addEventListener("keydown", async (e)=>{
    if (e.key === "Enter") await doLogin();
  });
  $("techPassword").addEventListener("keydown", async (e)=>{
    if (e.key === "Enter") await doLogin();
  });

  $("btnEditAccess").addEventListener("click", openAccessModal);
  $("btnCloseAccess").addEventListener("click", closeAccessModal);
  $("btnSaveAccess").addEventListener("click", saveAccessFromUI);



  $("btnLogout").addEventListener("click", ()=>{
    if (!confirm("¿Cerrar sesión en este móvil?")) return;
    localStorage.removeItem("isivolt.tech");
    state.tech = "";
    const access = getAccess();
    $("techName").value = access.user;
    $("techPassword").value = "";
    show("profile");
  });

  $("btnAddCode").addEventListener("click", async ()=>{
    const code = prompt("Introduce el código (se usarán los 5 últimos):");
    if (code == null) return;
    await addOTCode(code);
  });

  $("btnScan").addEventListener("click", ()=>{
    if (!hasTechAccess()) return;
    setScanMode("ot");
    show("scan");
  });

  $("btnHistory").addEventListener("click", ()=> openHistory());
  $("btnMonthly").addEventListener("click", ()=> openMonthly());

  $("btnExplainOT").addEventListener("click", ()=>{
    alert(`OT de hoy = la lista de puntos que vas a hacer hoy.

Se crea añadiendo puntos (QR o código).
Cuando completas un punto, queda ✅ y se guarda en el historial.`);
  });

  $("btnClearOT").addEventListener("click", async ()=>{
    if (!confirm("¿Vaciar OT de hoy? (solo en este móvil)")) return;
    await dbDeleteOTByTechDate(state.tech, todayStr());
    await refreshOT();
  });

  $("btnStartScan").addEventListener("click", startScan);
  $("btnStopScan").addEventListener("click", stopScan);
  $("btnManualGo").addEventListener("click", async ()=>{
    const c = normalizeCode($("manualCodeFromScan").value);
    if (!c) return toast("Código inválido.");
    stopScan();
    if (state.scanMode === "monthlyHot"){
      await addMonthlyQuick(c, "ACS");
      await openMonthly();
    } else if (state.scanMode === "monthlyCold"){
      await addMonthlyQuick(c, "AFCH");
      await openMonthly();
    } else {
      await addOTCode(c);
      show("home");
    }
  });

  $("liters").addEventListener("input", ()=> updateDoseUI());
  $("btnUseDefaultLiters").addEventListener("click", ()=>{
    $("liters").value = 60;
    updateDoseUI();
    $("targetMinutes").value = calcAutoMinutes($("liters").value, getSettings());
  });
  $("btnTimeAuto").addEventListener("click", ()=>{
    $("targetMinutes").value = calcAutoMinutes($("liters").value, getSettings());
  });
  $("btnSaveNote").addEventListener("click", async ()=>{
    await saveOTNote(state.currentCode, $("pointNote").value);
    toast("Nota guardada ✅");
  });
  $("btnStartTimer").addEventListener("click", ()=> startTimerForCurrent());
  $("btnMarkIssue").addEventListener("click", markIssue);
  $("btnEditCode").addEventListener("click", ()=> editOTCode(state.currentCode));

  $("btnPause").addEventListener("click", pauseTimer);
  $("btnResume").addEventListener("click", resumeTimer);
  $("btnFinish").addEventListener("click", ()=> finishTimer(false));
  $("btnExitTimer").addEventListener("click", ()=>{
    if (getRunningTimers().length && !confirm("Los cronómetros seguirán en marcha. ¿Salir para revisar otras pantallas?")) return;
    show("home");
    updateTimerDock();
  });

  $("btnTimerDock").addEventListener("click", ()=>{
    const running = getRunningTimers();
    if (!running.length) return;
    state.activeTimerCode = running.sort((a,b)=> (b.updatedAt||0) - (a.updatedAt||0))[0].code;
    renderTimerScreen();
    show("timer");
  });

  $("btnExport").addEventListener("click", exportData);
  $("btnImport").addEventListener("click", ()=> $("fileImport").click());
  $("fileImport").addEventListener("change", async (e)=>{
    const file = e.target.files?.[0];
    if (!file) return;
    await importData(file);
    e.target.value = "";
  });

  $("btnMonthlyAdd").addEventListener("click", async ()=>{
    await addMonthlyManual();
    await openMonthly();
  });
  $("btnMonthlyClear").addEventListener("click", async ()=>{
    if (!confirm("¿Vaciar checklist mensual del mes actual?")) return;
    await dbDeleteMonthlyByTechMonth(state.tech, monthKey());
    await openMonthly();
  });
  $("btnMonthlyAttach").addEventListener("click", ()=> $("monthlyFile").click());
  $("monthlyFile").addEventListener("change", async (e)=>{
    const file = e.target.files?.[0];
    if (!file) return;
    await attachMonthlyFile(file);
    e.target.value = "";
  });
  $("btnMonthlyOpen").addEventListener("click", openMonthlyFile);

  $("btnMonthlyScanHot").addEventListener("click", ()=>{
    if (!hasTechAccess()) return;
    setScanMode("monthlyHot");
    show("scan");
  });
  $("btnMonthlyScanCold").addEventListener("click", ()=>{
    if (!hasTechAccess()) return;
    setScanMode("monthlyCold");
    show("scan");
  });
  $("btnMonthlyShowEmpty").addEventListener("click", async ()=>{
    state.showEmptyMonthly = !state.showEmptyMonthly;
    $("btnMonthlyShowEmpty").textContent = `👁️ Mostrar vacías: ${state.showEmptyMonthly ? "ON" : "OFF"}`;
    await openMonthly();
  });
  $("btnSaveMonthlyHeader").addEventListener("click", saveMonthlyHeader);
  $("btnMonthlyExport").addEventListener("click", exportMonthly);

  $("btnSettings").addEventListener("click", openSettings);
  $("btnCloseSettings").addEventListener("click", closeSettings);
  $("btnSaveSettings").addEventListener("click", saveSettingsFromUI);
  $("btnResetSettings").addEventListener("click", resetSettings);

  $("btnGuide").addEventListener("click", openGuide);
  $("btnSpeak").addEventListener("click", speakGuide);
  $("btnStopSpeak").addEventListener("click", stopSpeak);

  clearInterval(timerDockInterval);
  timerDockInterval = setInterval(() => { tickTimers(); }, 250);
  tickTimers();
}

init();
