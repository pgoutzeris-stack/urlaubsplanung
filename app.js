import { SB_URL, SB_ANON, URLAUB_API_URL } from "./config.js";

const STATUS = {
  pending: { label: "Ausstehend", cls: "status--pending", icon: "fa-clock" },
  approved: { label: "Genehmigt", cls: "status--approved", icon: "fa-circle-check" },
  rejected: { label: "Abgelehnt", cls: "status--rejected", icon: "fa-circle-xmark" },
};

let sb = null;
let isAdmin = false;
let requests = [];
let rejectTargetId = null;

const els = {};

function toast(msg, kind = "ok") {
  const t = document.createElement("div");
  t.className = `toast ${kind === "err" ? "error" : kind === "info" ? "" : "success"}`;
  t.innerHTML = `<i class="fa-solid ${kind === "err" ? "fa-circle-exclamation" : "fa-circle-check"}"></i><span>${escapeHtml(msg)}</span>`;
  els.toast.appendChild(t);
  setTimeout(() => {
    t.classList.add("fade-out");
    setTimeout(() => t.remove(), 300);
  }, 3200);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDeYmd(ymd) {
  if (!ymd) return "—";
  const d = new Date(ymd + "T12:00:00");
  return d.toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" });
}

function countDays(start, end) {
  const a = new Date(start + "T12:00:00");
  const b = new Date(end + "T12:00:00");
  return Math.round((b - a) / 86400000) + 1;
}

async function api(method, body, query = "") {
  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session?.access_token) throw new Error("Nicht angemeldet");
  const url = query ? `${URLAUB_API_URL}${query}` : URLAUB_API_URL;
  const r = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      apikey: SB_ANON,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || r.statusText };
  }
  const errMsg =
    data?.error ||
    data?.message ||
    (typeof data === "string" ? data : null) ||
    r.statusText ||
    "Anfrage fehlgeschlagen";
  if (!r.ok) throw new Error(errMsg);
  return data;
}

function isProfileReady() {
  const ru = window.RootsUser;
  return Boolean(ru?._uid && ru?._p && ru._p.id === ru._uid);
}

function waitForProfile(ms = 20000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (isProfileReady()) resolve(window.RootsUser);
      else if (Date.now() - t0 > ms) resolve(null);
      else setTimeout(tick, 100);
    };
    tick();
  });
}

async function refreshRole() {
  const ru = await waitForProfile();
  if (!ru) throw new Error("Profil nicht geladen");
  isAdmin = Boolean(window.RootsUser?.isAdmin?.());
  els.adminPanel.hidden = !isAdmin;
  els.userPanel.hidden = isAdmin;
  els.userBadge.hidden = isAdmin;
  els.adminBadge.hidden = !isAdmin;
  if (els.greetingDesc) {
    els.greetingDesc.textContent = isAdmin
      ? "Prüfe offene Urlaubsanträge. Bei Genehmigung wird der Urlaub automatisch im Team-Kalender eingetragen."
      : "Reiche hier deinen Urlaub ein. Nach der Freigabe durch einen Admin wird er automatisch im Team-Kalender eingetragen.";
  }
}

async function loadRequests() {
  const scope = isAdmin ? "admin" : "mine";
  requests = (await api("GET", null, `?scope=${scope}`)) || [];
  renderLists();
  updateStats();
}

function updateStats() {
  if (!isAdmin) {
    const pending = requests.filter((r) => r.status === "pending").length;
    els.statPending.textContent = String(pending);
    els.statApproved.textContent = String(requests.filter((r) => r.status === "approved").length);
    return;
  }
  els.adminPendingCount.textContent = String(requests.filter((r) => r.status === "pending").length);
}

function renderRequestCard(r, { showActions = false } = {}) {
  const st = STATUS[r.status] || STATUS.pending;
  const days = countDays(r.start_date, r.end_date);
  const actions =
    showActions && r.status === "pending"
      ? `<div class="req-actions">
          <button type="button" class="btn-approve" data-approve="${r.id}"><i class="fa-solid fa-check"></i> Genehmigen</button>
          <button type="button" class="btn-reject" data-reject="${r.id}"><i class="fa-solid fa-xmark"></i> Ablehnen</button>
        </div>`
      : "";
  const rejectNote =
    r.status === "rejected" && r.rejection_reason
      ? `<p class="req-reject-reason"><i class="fa-solid fa-comment"></i> ${escapeHtml(r.rejection_reason)}</p>`
      : "";
  const calNote =
    r.status === "approved" && r.calendar_event_id
      ? `<p class="req-cal-hint"><i class="fa-solid fa-calendar-check"></i> Im Team-Kalender eingetragen</p>`
      : "";

  return `<article class="req-card" data-id="${r.id}">
    <div class="req-card-top">
      <div>
        <h3 class="req-name">${escapeHtml(r.applicant_name)}</h3>
        <p class="req-range">${formatDeYmd(r.start_date)} – ${formatDeYmd(r.end_date)} · ${days} ${days === 1 ? "Tag" : "Tage"}</p>
      </div>
      <span class="status-pill ${st.cls}"><i class="fa-solid ${st.icon}"></i> ${st.label}</span>
    </div>
    ${r.note ? `<p class="req-note">${escapeHtml(r.note)}</p>` : ""}
    ${rejectNote}
    ${calNote}
    ${actions}
  </article>`;
}

function renderLists() {
  if (isAdmin) {
    const pending = requests.filter((r) => r.status === "pending");
    const done = requests.filter((r) => r.status !== "pending");
    els.adminPendingList.innerHTML = pending.length
      ? pending.map((r) => renderRequestCard(r, { showActions: true })).join("")
      : `<div class="empty-state"><i class="fa-solid fa-inbox"></i><p>Keine offenen Anträge</p></div>`;
    els.adminHistoryList.innerHTML = done.length
      ? done.map((r) => renderRequestCard(r)).join("")
      : `<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>Noch keine bearbeiteten Anträge</p></div>`;
    bindAdminActions(els.adminPendingList);
    return;
  }

  els.myList.innerHTML = requests.length
    ? requests.map((r) => renderRequestCard(r)).join("")
    : `<div class="empty-state"><i class="fa-solid fa-umbrella-beach"></i><p>Noch keine Urlaubsanträge – reiche deinen ersten Antrag ein.</p></div>`;
}

function bindAdminActions(root) {
  root.querySelectorAll("[data-approve]").forEach((btn) => {
    btn.addEventListener("click", () => void handleApprove(btn.dataset.approve));
  });
  root.querySelectorAll("[data-reject]").forEach((btn) => {
    btn.addEventListener("click", () => openRejectModal(btn.dataset.reject));
  });
}

async function handleApprove(id) {
  if (!confirm("Urlaub genehmigen und im Team-Kalender eintragen?")) return;
  try {
    await api("POST", { action: "approve", id });
    toast("Urlaub genehmigt und im Team-Kalender eingetragen", "ok");
    await loadRequests();
  } catch (e) {
    toast(e.message || "Genehmigung fehlgeschlagen", "err");
  }
}

function openRejectModal(id) {
  rejectTargetId = id;
  els.rejectReason.value = "";
  els.rejectModal.classList.add("is-open");
  els.rejectModal.setAttribute("aria-hidden", "false");
}

function closeRejectModal() {
  rejectTargetId = null;
  els.rejectModal.classList.remove("is-open");
  els.rejectModal.setAttribute("aria-hidden", "true");
}

async function handleReject() {
  if (!rejectTargetId) return;
  try {
    await api("POST", {
      action: "reject",
      id: rejectTargetId,
      reason: els.rejectReason.value.trim() || null,
    });
    toast("Antrag abgelehnt", "info");
    closeRejectModal();
    await loadRequests();
  } catch (e) {
    toast(e.message || "Ablehnung fehlgeschlagen", "err");
  }
}

async function handleSubmit(e) {
  e.preventDefault();
  const start = els.fStart.value;
  const end = els.fEnd.value;
  const note = els.fNote.value.trim();
  if (!start || !end || end < start) {
    toast("Bitte einen gültigen Zeitraum wählen", "err");
    return;
  }
  const btn = els.btnSubmit;
  btn.disabled = true;
  try {
    await api("POST", { action: "create", start_date: start, end_date: end, note: note || null });
    toast("Urlaubsantrag eingereicht", "ok");
    els.form.reset();
    const today = new Date().toISOString().slice(0, 10);
    els.fStart.value = today;
    els.fEnd.value = today;
    await loadRequests();
  } catch (err) {
    toast(err.message || "Einreichung fehlgeschlagen", "err");
  } finally {
    btn.disabled = false;
  }
}

function showDashboard() {
  document.getElementById("screen-login").style.display = "none";
  els.dashboard.style.display = "block";
  document.body.classList.add("body-dashboard");
  const name = window.RootsUser?._p?.full_name?.split(" ")[0] || "du";
  els.greeting.textContent = `Hallo, ${name}!`;
}

function showLogin() {
  els.dashboard.style.display = "none";
  document.getElementById("screen-login").style.display = "flex";
  document.body.classList.remove("body-dashboard");
}

async function bootApp() {
  try {
    await refreshRole();
    await loadRequests();
    showDashboard();
  } catch (e) {
    console.error(e);
    toast(e.message || "Laden fehlgeschlagen", "err");
  }
}

function bindUi() {
  els.form.addEventListener("submit", handleSubmit);
  els.fStart.addEventListener("change", () => {
    if (els.fEnd.value && els.fEnd.value < els.fStart.value) els.fEnd.value = els.fStart.value;
  });
  els.btnRejectConfirm.addEventListener("click", () => void handleReject());
  els.btnRejectCancel.addEventListener("click", closeRejectModal);
  els.rejectModal.addEventListener("click", (e) => {
    if (e.target === els.rejectModal) closeRejectModal();
  });

  document.addEventListener("roots-profile-ready", () => void bootApp());
}

function cacheEls() {
  els.toast = document.getElementById("toast-container");
  els.dashboard = document.getElementById("screen-dashboard");
  els.greeting = document.getElementById("greeting-text");
  els.form = document.getElementById("form-request");
  els.fStart = document.getElementById("f-start");
  els.fEnd = document.getElementById("f-end");
  els.fNote = document.getElementById("f-note");
  els.btnSubmit = document.getElementById("btn-submit");
  els.myList = document.getElementById("my-requests");
  els.statPending = document.getElementById("stat-pending");
  els.statApproved = document.getElementById("stat-approved");
  els.userPanel = document.getElementById("user-panel");
  els.adminPanel = document.getElementById("admin-panel");
  els.userBadge = document.getElementById("user-badge");
  els.greetingDesc = document.getElementById("greeting-desc");
  els.adminBadge = document.getElementById("admin-badge");
  els.adminPendingCount = document.getElementById("admin-pending-count");
  els.adminPendingList = document.getElementById("admin-pending-list");
  els.adminHistoryList = document.getElementById("admin-history-list");
  els.rejectModal = document.getElementById("reject-modal");
  els.rejectReason = document.getElementById("reject-reason");
  els.btnRejectConfirm = document.getElementById("btn-reject-confirm");
  els.btnRejectCancel = document.getElementById("btn-reject-cancel");
}

let appInitialized = false;

export function initApp(client) {
  sb = client;
  if (!appInitialized) {
    appInitialized = true;
    cacheEls();
    bindUi();
  }
  const today = new Date().toISOString().slice(0, 10);
  els.fStart.value = today;
  els.fEnd.value = today;
  if (isProfileReady()) void bootApp();
}
