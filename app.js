import {
  dbPutOT, dbGetOTByTechDate, dbDeleteOTByTechDate,
  dbAddHistory, dbGetHistoryByTech,
  dbExportAll, dbImportAll
} from "./db.js";

const $ = (id) => document.getElementById(id);

const screens = {
  profile: $("screenProfile"),
  home: $("screenHome"),
  scan: $("screenScan"),
  point: $("screenPoint"),
  timer: $("screenTimer"),
  history: $("screenHistory"),
};

const state = {
  tech: localStorage.getItem("isivolt.tech") || "",
  currentCode: "",
  stream: null,
  detector: null,
  timer: {
    running: false,
    paused: false,
    startTs: 0,
    durationMs: 0,
    elapsedMs: 0,
    raf: 0,
  }
};

const SETTINGS_KEY = "isivolt.settings";
const DEFAULT_SETTINGS = {
  bleachPct: 5,      // %
  targetPpm: 50,     // ppm (mg/L) provisional
  baseMin: 10,       // minutes
  factorPerL: 0.00,  // min/L
};

function todayStr(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${dd}`;
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

function saveSettings(s){
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

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
function mgPerMlFromPct(pct){
  return Number(pct) * 100;
}

function calcDoseMl(liters, settings){
  const L = Number(liters);
  if (!isFinite(L) || L <= 0) return null;

  const ppm = Number(settings.targetPpm); // mg/L
  const mgTotal = ppm * L; // mg
  const mgPerMl = mgPerMlFromPct(settings.bleachPct);
  if (mgPerMl <= 0) return null;

  const ml = mgTotal / mgPerMl;
  return Math.max(0, ml);
}

function calcAutoMinutes(liters, settings){
  const L = Number(liters);
  const base = Number(settings.baseMin);
  const f = Number(settings.factorPerL);
  if (!isFinite(L) || L <= 0) return Math.max(1, Math.round(base));
  const val = base + (L * f);
  return Math.max(1, Math.round(val));
}

// ---------------- UI: OT ----------------
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
    const badgeClass = it.status === "ok" ? "ok" : it.status === "issue" ? "issue" : "todo";
    const badgeText = it.status === "ok" ? "✅ Hecho" : it.status === "issue" ? "⚠ Incid." : "⏳ Pend.";
    el.innerHTML = `
      <div class="left">
        <div class="code">${it.code}</div>
        <div class="meta">${it.updatedAt ? new Date(it.updatedAt).toLocaleTimeString() : "—"}</div>
      </div>
      <div class="row">
        <span class="badge ${badgeClass}">${badgeText}</span>
        <button class="btn btn-ghost" data-open="${it.code}">Abrir</button>
      </div>
    `;
    el.querySelector("[data-open]").addEventListener("click", () => openPoint(it.code));
    list.appendChild(el);
  }
}

async function addOTCode(code){
  const c = normalizeCode(code);
  if (!c) return alert("Introduce un código válido (5 dígitos o similar).");
  const tech = state.tech;
  const date = todayStr();

  const existing = await dbGetOTByTechDate(tech, date);
  if (existing.some(x => x.code === c)){
    return openPoint(c);
  }

  const item = {
    key: `${tech}|${date}|${c}`,
    tech, date, code: c,
    status: "todo",
    order: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    defaultLiters: 60, // habitual provisional
  };
  await dbPutOT(item);
  await refreshOT();
  openPoint(c);
}

// ---------------- UI: Punto ----------------
async function openPoint(code){
  state.currentCode = normalizeCode(code);
  if (!state.currentCode) return;

  const tech = state.tech;
  const date = todayStr();
  const items = await dbGetOTByTechDate(tech, date);
  const it = items.find(x => x.code === state.currentCode);

  $("pointCode").textContent = state.currentCode;

  const settings = getSettings();

  const liters = it?.defaultLiters ?? 60;
  $("liters").value = liters;

  $("targetMinutes").value = calcAutoMinutes(liters, settings);

  $("chkConnect").checked = false;
  $("chkReturn").checked = false;
  $("chkDose").checked = false;
  $("chkStart").checked = false;

  updateDoseUI();

  show("point");
}

function updateDoseUI(){
  const settings = getSettings();
  const liters = $("liters").value;
  const ml = calcDoseMl(liters, settings);
  $("doseMl").textContent = ml == null ? "—" : `${Math.round(ml)} ml`;
}

// ---------------- Timer ----------------
function setRingProgress(pct){
  const deg = Math.max(0, Math.min(360, 360 * pct));
  $("timerRing").style.background = `conic-gradient(rgba(0,212,255,.85) ${deg}deg, rgba(255,255,255,.08) 0deg)`;
}

function stopRaf(){
  if (state.timer.raf) cancelAnimationFrame(state.timer.raf);
  state.timer.raf = 0;
}

function timerTick(){
  const t = state.timer;
  if (!t.running || t.paused) return;

  const now = performance.now();
  t.elapsedMs = now - t.startTs;
  const left = Math.max(0, t.durationMs - t.elapsedMs);

  $("timerLeft").textContent = fmtTime(left);
  setRingProgress(t.elapsedMs / t.durationMs);

  if (left <= 0){
    finishTimer(true);
    return;
  }
  t.raf = requestAnimationFrame(timerTick);
}

function startTimerForCurrent(){
  const code = state.currentCode;
  if (!code) return;

  const mins = Number($("targetMinutes").value);
  if (!isFinite(mins) || mins <= 0) return alert("Tiempo objetivo inválido.");

  $("timerCode").textContent = code;
  $("timerTarget").textContent = `Objetivo: ${mins} min`;

  $("sealDone").classList.add("hidden");
  $("sealWarn").classList.add("hidden");
  $("btnPause").classList.remove("hidden");
  $("btnResume").classList.add("hidden");

  const t = state.timer;
  t.running = true;
  t.paused = false;
  t.durationMs = mins * 60 * 1000;
  t.elapsedMs = 0;
  t.startTs = performance.now();

  $("timerLeft").textContent = fmtTime(t.durationMs);
  setRingProgress(0);

  show("timer");
  stopRaf();
  t.raf = requestAnimationFrame(timerTick);
}

async function markOTStatus(code, status){
  const tech = state.tech;
  const date = todayStr();
  const items = await dbGetOTByTechDate(tech, date);
  const it = items.find(x => x.code === code);
  if (!it) return;

  it.status = status;
  it.updatedAt = Date.now();
  await dbPutOT(it);
  await refreshOT();
}

async function finishTimer(auto=false){
  const t = state.timer;
  t.running = false;
  stopRaf();

  try { navigator.vibrate?.([120, 60, 120]); } catch {}
  if (auto) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.06;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start();
      setTimeout(()=>{ osc.stop(); ctx.close(); }, 180);
    } catch {}
  }

  $("sealDone").classList.remove("hidden");

  const liters = Number($("liters").value) || null;
  const settings = getSettings();
  const dose = liters ? Math.round(calcDoseMl(liters, settings) ?? 0) : null;
  const mins = Number($("targetMinutes").value) || null;

  await dbAddHistory({
    tech: state.tech,
    date: todayStr(),
    code: state.currentCode,
    ts: Date.now(),
    liters,
    doseMl: dose,
    minutes: mins,
    result: "ok",
  });

  await markOTStatus(state.currentCode, "ok");
}

function pauseTimer(){
  const t = state.timer;
  if (!t.running || t.paused) return;
  t.paused = true;
  stopRaf();
  $("btnPause").classList.add("hidden");
  $("btnResume").classList.remove("hidden");
}

function resumeTimer(){
  const t = state.timer;
  if (!t.running || !t.paused) return;
  t.paused = false;
  t.startTs = performance.now() - t.elapsedMs;
  $("btnPause").classList.remove("hidden");
  $("btnResume").classList.add("hidden");
  t.raf = requestAnimationFrame(timerTick);
}

async function markIssue(){
  const code = state.currentCode;
  if (!code) return;

  const reason = prompt("Incidencia (rápido):\n- No accesible\n- Bomba no arranca\n- Sin retorno\n- Fuga\n\nEscribe una frase corta:");
  if (reason == null) return;

  $("timerCode").textContent = code;
  $("sealDone").classList.add("hidden");
  $("sealWarn").classList.remove("hidden");

  await dbAddHistory({
    tech: state.tech,
    date: todayStr(),
    code,
    ts: Date.now(),
    liters: Number($("liters").value) || null,
    doseMl: null,
    minutes: Number($("targetMinutes").value) || null,
    result: "issue",
    note: reason.trim().slice(0,120),
  });

  await markOTStatus(code, "issue");
  show("timer");
  try { navigator.vibrate?.([80,40,80]); } catch {}
}

// ---------------- QR Scan ----------------
async function startScan(){
  if (!("mediaDevices" in navigator)) {
    alert("Este navegador no soporta cámara. Usa 'Añadir código'.");
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
      alert("Este móvil no soporta BarcodeDetector. Usa 'Añadir código'.");
    }
  }catch(e){
    alert("No se pudo abrir la cámara. Revisa permisos.");
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
        await addOTCode(c);
        show("home");
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
  const tech = state.tech;
  const items = await dbGetHistoryByTech(tech, 200);
  const list = $("historyList");
  list.innerHTML = "";
  $("historyEmpty").classList.toggle("hidden", items.length !== 0);

  for (const h of items){
    const el = document.createElement("div");
    el.className = "item";
    const dt = new Date(h.ts || Date.now());
    const badgeClass = h.result === "ok" ? "ok" : "issue";
    const badgeText = h.result === "ok" ? "✅ OK" : "⚠ Incid.";
    el.innerHTML = `
      <div class="left">
        <div class="code">${h.code}</div>
        <div class="meta">${dt.toLocaleString()} · ${h.liters ?? "—"} L · ${h.minutes ?? "—"} min ${h.note ? "· " + h.note : ""}</div>
      </div>
      <span class="badge ${badgeClass}">${badgeText}</span>
    `;
    list.appendChild(el);
  }
  show("history");
}

async function exportData(){
  const dump = await dbExportAll();
  const payload = {
    app: "IsiVolt Pro V1 Legionella",
    exportedAt: Date.now(),
    tech: state.tech,
    data: dump
  };
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
  try{ payload = JSON.parse(text); }catch{ return alert("Archivo inválido."); }
  if (!payload?.data) return alert("No contiene datos.");

  await dbImportAll(payload.data);
  alert("Importación completada.");
  await refreshOT();
  await openHistory();
}

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

function resetSettings(){
  saveSettings({ ...DEFAULT_SETTINGS });
  openSettings();
}

// ---------------- Navigation & Events ----------------
function bindNav(){
  document.querySelectorAll("[data-nav]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const to = btn.getAttribute("data-nav");
      if (to === "home") show("home");
    });
  });
}

function init(){
  if ("serviceWorker" in navigator){
    navigator.serviceWorker.register("./sw.js").catch(()=>{});
  }

  bindNav();

  if (!state.tech){
    show("profile");
  } else {
    show("home");
    refreshOT();
  }

  $("btnSetTech").addEventListener("click", async ()=>{
    const name = String($("techName").value || "").trim();
    if (!name) return alert("Escribe el nombre del técnico.");
    state.tech = name;
    localStorage.setItem("isivolt.tech", name);
    show("home");
    await refreshOT();
  });

  $("btnSwitchTech").addEventListener("click", ()=>{
    localStorage.removeItem("isivolt.tech");
    state.tech = "";
    $("techName").value = "";
    show("profile");
  });

  $("btnAddCode").addEventListener("click", async ()=>{
    const code = prompt("Introduce el código (se usarán los 5 últimos):");
    if (code == null) return;
    await addOTCode(code);
  });

  $("btnScan").addEventListener("click", ()=> show("scan"));
  $("btnHistory").addEventListener("click", ()=> openHistory());

  $("btnNewOT").addEventListener("click", async ()=>{
    alert("OT de hoy lista. Añade puntos con QR o código.");
    await refreshOT();
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
    if (!c) return alert("Código inválido.");
    stopScan();
    await addOTCode(c);
    show("home");
  });

  $("liters").addEventListener("input", ()=>{
    updateDoseUI();
  });

  $("btnUseDefaultLiters").addEventListener("click", ()=>{
    $("liters").value = 60;
    updateDoseUI();
    $("targetMinutes").value = calcAutoMinutes($("liters").value, getSettings());
  });

  $("btnTimeAuto").addEventListener("click", ()=>{
    $("targetMinutes").value = calcAutoMinutes($("liters").value, getSettings());
  });

  $("btnStartTimer").addEventListener("click", ()=>{
    updateDoseUI();
    startTimerForCurrent();
  });

  $("btnMarkIssue").addEventListener("click", markIssue);

  $("btnPause").addEventListener("click", pauseTimer);
  $("btnResume").addEventListener("click", resumeTimer);
  $("btnFinish").addEventListener("click", ()=> finishTimer(false));
  $("btnExitTimer").addEventListener("click", ()=>{
    state.timer.running = false;
    stopRaf();
    show("home");
  });

  $("btnExport").addEventListener("click", exportData);
  $("btnImport").addEventListener("click", ()=> $("fileImport").click());
  $("fileImport").addEventListener("change", async (e)=>{
    const file = e.target.files?.[0];
    if (!file) return;
    await importData(file);
    e.target.value = "";
  });

  $("btnSettings").addEventListener("click", openSettings);
  $("btnCloseSettings").addEventListener("click", closeSettings);
  $("btnSaveSettings").addEventListener("click", saveSettingsFromUI);
  $("btnResetSettings").addEventListener("click", resetSettings);

  const pill = $("pillOffline");
  function updateOnline(){
    const on = navigator.onLine;
    pill.textContent = on ? "Online" : "Offline OK";
    pill.style.opacity = on ? "0.95" : "0.8";
  }
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);
  updateOnline();
}

init();
