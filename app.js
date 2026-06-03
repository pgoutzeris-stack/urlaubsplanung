import { SB_URL, SB_ANON, URLAUB_API_URL } from "./config.js";

const STATUS = {
  pending: { label: "Ausstehend", cls: "status--pending", icon: "fa-clock" },
  approved: { label: "Genehmigt", cls: "status--approved", icon: "fa-circle-check" },
  rejected: { label: "Abgelehnt", cls: "status--rejected", icon: "fa-circle-xmark" },
  withdrawn: { label: "Zurückgezogen", cls: "status--withdrawn", icon: "fa-rotate-left" },
  cancelled: { label: "Storniert", cls: "status--cancelled", icon: "fa-ban" },
};

let sb = null;
let isAdmin = false;
let requests = [];
let balance = null;
let rejectTargetId = null;
let holidaysByDate = new Map();
let refreshTimer = null;
let closures = [];
let closureYear = new Date().getFullYear();
let teamOverview = [];
let teamOverviewYear = new Date().getFullYear();

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

function addDaysYmd(ymd, n) {
  const d = new Date(ymd + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function isWeekendYmd(ymd) {
  const wd = new Date(ymd + "T12:00:00").getDay();
  return wd === 0 || wd === 6;
}

function eachDayYmd(start, end) {
  const days = [];
  let cur = start;
  while (cur <= end) {
    days.push(cur);
    cur = addDaysYmd(cur, 1);
  }
  return days;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

function countWorkingDays(start, end) {
  let n = 0;
  for (const day of eachDayYmd(start, end)) {
    if (isWeekendYmd(day)) continue;
    if (holidaysByDate.has(day)) continue;
    n++;
  }
  return n;
}

function validateVacationRange(start, end) {
  let days = 0;
  for (const day of eachDayYmd(start, end)) {
    if (isWeekendYmd(day)) continue;
    if (holidaysByDate.has(day)) continue;
    days++;
  }
  if (days === 0) {
    return { ok: false, error: "Der gewählte Zeitraum enthält keine gültigen Urlaubstage." };
  }
  return { ok: true, days };
}

function findLocalConflict(start, end) {
  for (const row of requests) {
    if (row.status !== "pending" && row.status !== "approved") continue;
    if (!rangesOverlap(start, end, row.start_date, row.end_date)) continue;
    const range = `${formatDeYmd(row.start_date)} – ${formatDeYmd(row.end_date)}`;
    if (row.status === "pending") {
      return `Für diesen Zeitraum liegt bereits ein ausstehender Antrag vor (${range}).`;
    }
    return `In diesem Zeitraum hast du bereits genehmigten Urlaub (${range}).`;
  }
  return null;
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

async function loadHolidays(year = new Date().getFullYear()) {
  try {
    const data = await api("GET", null, `?scope=holidays&year=${year}`);
    holidaysByDate = new Map(
      (data?.holidays || []).map((h) => [String(h.holiday_date).slice(0, 10), h.label]),
    );
  } catch (e) {
    console.warn("Feiertage konnten nicht geladen werden", e);
    holidaysByDate = new Map();
  }
}

async function refreshRole() {
  const ru = await waitForProfile();
  if (!ru) throw new Error("Profil nicht geladen");
  isAdmin = window.RootsUser?._p?.app_role === "admin";
  els.adminPanel.hidden = !isAdmin;
  els.userPanel.hidden = isAdmin;
  if (els.navUser) els.navUser.hidden = isAdmin;
  if (els.navAdmin) els.navAdmin.hidden = !isAdmin;
  syncAdminSettingsButton();
  setActiveNav(isAdmin ? "admin" : "user");
  if (els.userBadge) els.userBadge.hidden = isAdmin;
  if (els.adminBadge) els.adminBadge.hidden = !isAdmin;
  if (els.greetingDesc) {
    els.greetingDesc.textContent = isAdmin
      ? "Prüfe offene Urlaubsanträge und behalte Urlaubskontingente im Blick. Betriebsferien und freie Tage verwaltest du unter „Einstellungen“ in der Sidebar."
      : "Reiche hier deinen Urlaub ein. Nach der Freigabe durch einen Admin wird er automatisch im Team-Kalender eingetragen. Wochenenden und Feiertage sind nicht möglich.";
  }
}

function setActiveNav(view) {
  const titles = { user: "Mein Urlaub", admin: "Freigaben" };
  if (els.dashViewTitle) els.dashViewTitle.textContent = titles[view] || titles.user;
  [els.navUser, els.navAdmin].forEach((btn) => {
    if (!btn || btn.hidden) return;
    btn.classList.toggle("active", btn.dataset.view === view);
  });
}

function syncAdminSettingsButton() {
  const btn = els.btnAdminSettings;
  if (!btn) return;
  const show = isAdmin === true;
  btn.hidden = !show;
  btn.setAttribute("aria-hidden", show ? "false" : "true");
  if (!show && els.adminSettingsModal?.classList.contains("is-open")) {
    closeAdminSettingsModal();
  }
}

async function loadBalance() {
  if (isAdmin) return;
  balance = await api("GET", null, "?scope=balance");
  updateStats();
}

async function loadRequests() {
  const scope = isAdmin ? "admin" : "mine";
  requests = (await api("GET", null, `?scope=${scope}`)) || [];
  renderLists();
  updateStats();
  if (isAdmin) await loadTeamOverview(teamOverviewYear);
}

async function loadTeamOverview(year) {
  if (!isAdmin) return;
  teamOverviewYear = year;
  const data = await api("GET", null, `?scope=team_overview&year=${year}`);
  teamOverview = data?.team || [];
  renderTeamOverview();
}

function closureKindLabel(kind) {
  const k = String(kind || "").toLowerCase();
  if (k.includes("betrieb")) return "Betriebsferien";
  if (k.includes("bridge") || k.includes("brueck")) return "Brückentag";
  if (k.includes("holiday") || k.includes("feiertag")) return "Feiertag";
  if (k.includes("roots") || k.includes("firm")) return "Firmenfreier Tag";
  return "Freier Tag";
}

function renderTeamOverview() {
  if (!els.adminTeamOverview) return;
  if (els.teamOverviewYearLabel) {
    els.teamOverviewYearLabel.textContent = String(teamOverviewYear);
  }
  if (els.adminTeamCount) {
    els.adminTeamCount.textContent = String(teamOverview.length);
  }
  if (!teamOverview.length) {
    els.adminTeamOverview.innerHTML =
      '<div class="empty-state"><i class="fa-solid fa-users"></i><p>Keine Mitarbeiter-Daten für dieses Jahr.</p></div>';
    return;
  }
  els.adminTeamOverview.innerHTML = teamOverview
    .map((row) => {
      const kz = escapeHtml((row.kuerzel || row.full_name || "?").slice(0, 4).toUpperCase());
      // total_allowance = immer urlaubstage_jahr (30)
      const total      = Math.max(row.total_allowance || 30, 1);
      const betrieb    = row.betrieb_days  || 0;  // Betriebsferien (fest abgezogen)
      const approved   = row.approved_days || 0;  // genehmigter Urlaub
      const pending    = row.pending_days  || 0;  // offene Anträge
      // Balken-Prozentsätze (alle relativ zu total = 30)
      const pctBetrieb  = Math.min(100, Math.round((betrieb           / total) * 100));
      const pctApproved = Math.min(100 - pctBetrieb, Math.round((approved / total) * 100));
      const pctPending  = Math.min(100 - pctBetrieb - pctApproved, Math.round((pending / total) * 100));
      const pendingHint =
        row.pending_count > 0
          ? `${row.pending_count} offene${row.pending_count === 1 ? "r" : ""} Antrag${row.pending_count === 1 ? "" : "e"}`
          : "Keine offenen Anträge";
      // Sub-Zeile: zeige was genommen wurde aus initialen 30
      const takenTotal = betrieb + approved;
      return `<article class="team-row">
        <div class="team-row-head">
          <div class="team-row-name">
            <span class="team-kuerzel">${kz}</span>
            <span class="team-row-title">${escapeHtml(row.full_name)}</span>
          </div>
          <span class="team-row-main">${takenTotal} von ${total} Tagen<small>genommen</small></span>
        </div>
        <div class="team-row-sub">${row.remaining ?? 0} Tage frei · ${pendingHint}</div>
        <div class="team-progress team-progress--segmented" aria-hidden="true" title="${betrieb}d Betriebsferien · ${approved}d Urlaub · ${pending}d offen">
          <span class="team-progress-betrieb" style="width:${pctBetrieb}%"></span>
          <span class="team-progress-approved" style="width:${pctApproved}%"></span>
          <span class="team-progress-pending"  style="width:${pctPending}%"></span>
        </div>
      </article>`;
    })
    .join("");
}

async function openAdminSettingsModal() {
  if (!isAdmin || !els.adminSettingsModal) return;
  els.adminSettingsModal.classList.add("is-open");
  els.adminSettingsModal.setAttribute("aria-hidden", "false");
  await loadClosures(closureYear);
}

function closeAdminSettingsModal() {
  if (!els.adminSettingsModal) return;
  els.adminSettingsModal.classList.remove("is-open");
  els.adminSettingsModal.setAttribute("aria-hidden", "true");
}

async function loadClosures(year) {
  if (!isAdmin) return;
  closureYear = year;
  const data = await api("GET", null, `?scope=closures&year=${year}`);
  closures = data?.closures || [];
  renderClosuresAdmin();
}

function renderClosuresAdmin() {
  const listEl = els.settingsClosuresList;
  const yearEl = els.settingsClosureYear;
  if (!listEl || !yearEl) return;
  const yNow = new Date().getFullYear();
  if (!yearEl.options.length) {
    for (let y = yNow - 1; y <= yNow + 3; y++) {
      const o = document.createElement("option");
      o.value = String(y);
      o.textContent = String(y);
      yearEl.appendChild(o);
    }
  }
  yearEl.value = String(closureYear);
  if (!closures.length) {
    listEl.innerHTML =
      '<div class="empty-state"><i class="fa-regular fa-calendar"></i>Keine firmenfreien Tage für dieses Jahr hinterlegt.</div>';
    return;
  }
  listEl.innerHTML = closures
    .map(
      (row) => `<div class="closure-row" data-closure-id="${row.id}">
      <div>
        <div class="closure-row-date">${formatDeYmd(row.closure_date)}</div>
        <span class="closure-row-badge">${escapeHtml(closureKindLabel(row.closure_kind))}</span>
      </div>
      <div>
        <div class="closure-field-label">Bezeichnung</div>
        <input type="text" data-field="label" value="${escapeHtml(row.label || "")}" placeholder="z. B. Betriebsferien Sommer" aria-label="Bezeichnung" />
      </div>
      <div>
        <div class="closure-field-label">Abzug Urlaub (Tage)</div>
        <input type="number" data-field="deduct_days" min="0" max="5" step="0.5" value="${Number(row.deduct_days || 0)}" aria-label="Abzug vom Urlaubskonto in Tagen" />
      </div>
      <button type="button" class="btn-closure-save" data-save-closure="${row.id}">Speichern</button>
    </div>`,
    )
    .join("");
  listEl.querySelectorAll("[data-save-closure]").forEach((btn) => {
    btn.addEventListener("click", () => void saveClosureRow(btn.dataset.saveClosure));
  });
}

async function saveClosureRow(id) {
  const rowEl = els.settingsClosuresList?.querySelector(`[data-closure-id="${id}"]`);
  if (!rowEl) return;
  const label = rowEl.querySelector('[data-field="label"]')?.value?.trim();
  const deduct_days = rowEl.querySelector('[data-field="deduct_days"]')?.value;
  const btn = rowEl.querySelector("[data-save-closure]");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Speichern…";
  }
  try {
    await api("POST", { action: "update_closure", id, label, deduct_days });
    toast("Freier Tag gespeichert", "ok");
    await loadClosures(closureYear);
  } catch (e) {
    toast(e.message || "Speichern fehlgeschlagen", "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Speichern";
    }
  }
}

async function refreshData() {
  if (!sb || !isProfileReady()) return;
  try {
    if (!isAdmin) await loadBalance();
    await loadRequests();
    if (isAdmin && els.adminSettingsModal?.classList.contains("is-open")) {
      await loadClosures(closureYear);
    }
  } catch (e) {
    console.warn("Hintergrund-Aktualisierung fehlgeschlagen", e);
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    if (els.dashboard?.style.display === "none") return;
    void refreshData();
  }, 45000);
  window.addEventListener("focus", onWindowFocus);
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  window.removeEventListener("focus", onWindowFocus);
}

function onWindowFocus() {
  void refreshData();
}

function updateStats() {
  if (!isAdmin) {
    if (balance && els.statRemaining) {
      const { remaining, pending, default_annual } = balance;
      els.statRemaining.textContent = String(remaining ?? 0);
      const pendingHint = pending > 0 ? `, ${pending} in offenen Anträgen reserviert` : "";
      els.statRemaining.title = `${remaining} von ${default_annual ?? 30} Urlaubstagen verfügbar${pendingHint}`;
    }
    const pending = requests.filter((r) => r.status === "pending").length;
    els.statPending.textContent = String(pending);
    els.statApproved.textContent = String(requests.filter((r) => r.status === "approved").length);
    return;
  }
  els.adminPendingCount.textContent = String(requests.filter((r) => r.status === "pending").length);
}

function renderRequestCard(r, { showActions = false, showUserActions = false } = {}) {
  const st = STATUS[r.status] || STATUS.pending;
  const isHalf = (r.day_part === "am" || r.day_part === "pm") && r.start_date === r.end_date;
  const days = isHalf ? 0.5 : countWorkingDays(r.start_date, r.end_date);
  const dayLabel = days === 1 ? "Urlaubstag" : days === 0.5 ? "Urlaubstag" : "Urlaubstage";
  const halfBadge = isHalf
    ? `<span class="half-day-badge"><i class="fa-solid fa-${r.day_part === "am" ? "mug-saucer" : "cloud-sun"}"></i> ${r.day_part === "am" ? "Vormittag" : "Nachmittag"}</span>`
    : "";
  const actions =
    showActions && r.status === "pending"
      ? `<div class="req-actions">
          <button type="button" class="btn-approve" data-approve="${r.id}"><i class="fa-solid fa-check"></i> Genehmigen</button>
          <button type="button" class="btn-reject" data-reject="${r.id}"><i class="fa-solid fa-xmark"></i> Ablehnen</button>
        </div>`
      : "";
  const userActions =
    showUserActions && r.can_withdraw
      ? `<div class="req-actions">
          <button type="button" class="btn-withdraw" data-withdraw="${r.id}"><i class="fa-solid fa-rotate-left"></i> Zurückziehen</button>
        </div>`
      : showUserActions && r.can_cancel
        ? `<div class="req-actions">
            <button type="button" class="btn-cancel-vacation" data-cancel-vacation="${r.id}"><i class="fa-solid fa-trash-can"></i> Urlaub stornieren</button>
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
        <p class="req-range">${formatDeYmd(r.start_date)} – ${formatDeYmd(r.end_date)} · ${days} ${dayLabel}${halfBadge}</p>
      </div>
      <span class="status-pill ${st.cls}"><i class="fa-solid ${st.icon}"></i> ${st.label}</span>
    </div>
    ${r.note ? `<p class="req-note">${escapeHtml(r.note)}</p>` : ""}
    ${rejectNote}
    ${calNote}
    ${actions}
    ${userActions}
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
    ? requests.map((r) => renderRequestCard(r, { showUserActions: true })).join("")
    : `<div class="empty-state"><i class="fa-solid fa-umbrella-beach"></i><p>Noch keine Urlaubsanträge – reiche deinen ersten Antrag ein.</p></div>`;
  bindUserActions(els.myList);
}

function bindAdminActions(root) {
  root.querySelectorAll("[data-approve]").forEach((btn) => {
    btn.addEventListener("click", () => void handleApprove(btn.dataset.approve));
  });
  root.querySelectorAll("[data-reject]").forEach((btn) => {
    btn.addEventListener("click", () => openRejectModal(btn.dataset.reject));
  });
}

function bindUserActions(root) {
  if (!root) return;
  root.querySelectorAll("[data-withdraw]").forEach((btn) => {
    btn.addEventListener("click", () => void handleWithdraw(btn.dataset.withdraw));
  });
  root.querySelectorAll("[data-cancel-vacation]").forEach((btn) => {
    btn.addEventListener("click", () => void handleCancelApproved(btn.dataset.cancelVacation));
  });
}

// ── Modal-Helfer ──────────────────────────────────────────────────────────────
function openModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.classList.add("is-open");
  m.setAttribute("aria-hidden", "false");
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.classList.remove("is-open");
  m.setAttribute("aria-hidden", "true");
}

// ── Zurückziehen ──────────────────────────────────────────────────────────────
let _withdrawTargetId = null;
function handleWithdraw(id) {
  _withdrawTargetId = id;
  openModal("withdraw-modal");
}
async function _confirmWithdraw() {
  if (!_withdrawTargetId) return;
  const id = _withdrawTargetId;
  closeModal("withdraw-modal");
  _withdrawTargetId = null;
  try {
    await api("POST", { action: "withdraw", id });
    toast("Antrag zurückgezogen", "ok");
    await refreshData();
  } catch (e) {
    toast(e.message || "Zurückziehen fehlgeschlagen", "err");
  }
}

// ── Stornieren ────────────────────────────────────────────────────────────────
let _cancelTargetId = null;
function handleCancelApproved(id) {
  _cancelTargetId = id;
  openModal("cancel-modal");
}
async function _confirmCancel() {
  if (!_cancelTargetId) return;
  const id = _cancelTargetId;
  closeModal("cancel-modal");
  _cancelTargetId = null;
  try {
    await api("POST", { action: "cancel_approved", id });
    toast("Urlaub storniert", "ok");
    await refreshData();
  } catch (e) {
    toast(e.message || "Stornierung fehlgeschlagen", "err");
  }
}

// ── Genehmigen ────────────────────────────────────────────────────────────────
let _approveTargetId = null;
function handleApprove(id) {
  _approveTargetId = id;
  openModal("approve-modal");
}
async function _confirmApprove() {
  if (!_approveTargetId) return;
  const id = _approveTargetId;
  closeModal("approve-modal");
  _approveTargetId = null;
  try {
    await api("POST", { action: "approve", id });
    toast("Urlaub genehmigt und im Team-Kalender eingetragen", "ok");
    await refreshData();
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
    await refreshData();
  } catch (e) {
    toast(e.message || "Ablehnung fehlgeschlagen", "err");
  }
}

async function handleSubmit(e) {
  e.preventDefault();
  const start = els.fStart.value;
  const end = els.fEnd.value;
  const note = els.fNote.value.trim();
  const day_part = (document.getElementById("f-daypart")?.value) || "full";
  if (!start || !end || end < start) {
    toast("Bitte einen gültigen Zeitraum wählen", "err");
    return;
  }

  const year = Number(start.slice(0, 4));
  if (!holidaysByDate.size || ![...holidaysByDate.keys()].some((d) => d.startsWith(String(year)))) {
    await loadHolidays(year);
  }

  const rangeCheck = validateVacationRange(start, end);
  if (!rangeCheck.ok) {
    toast(rangeCheck.error, "err");
    return;
  }

  const conflict = findLocalConflict(start, end);
  if (conflict) {
    toast(conflict, "err");
    return;
  }

  const btn = els.btnSubmit;
  btn.disabled = true;
  try {
    await api("POST", { action: "create", start_date: start, end_date: end, note: note || null, day_part });
    toast("Urlaubsantrag eingereicht", "ok");
    els.form.reset();
    const today = new Date().toISOString().slice(0, 10);
    els.fStart.value = today;
    els.fEnd.value = today;
    await refreshData();
  } catch (err) {
    toast(err.message || "Einreichung fehlgeschlagen", "err");
    await refreshData();
  } finally {
    btn.disabled = false;
  }
}

function showDashboard() {
  document.getElementById("screen-login").style.display = "none";
  els.dashboard.style.display = "flex";
  document.body.classList.add("body-dashboard");
  const name = window.RootsUser?._p?.full_name?.split(" ")[0] || "du";
  els.greeting.textContent = `Hallo, ${name}!`;
  startAutoRefresh();
}

function showLogin() {
  stopAutoRefresh();
  isAdmin = false;
  syncAdminSettingsButton();
  els.dashboard.style.display = "none";
  document.getElementById("screen-login").style.display = "flex";
  document.body.classList.remove("body-dashboard");
}

async function bootApp() {
  try {
    await refreshRole();
    await loadHolidays(new Date().getFullYear());
    if (!isAdmin) await loadBalance();
    await loadRequests();
    showDashboard();
  } catch (e) {
    console.error(e);
    toast(e.message || "Laden fehlgeschlagen", "err");
  }
}

// Global: Halbtag-Chips zeigen/verstecken — außerhalb bindUi damit sie
// auch beim Init-Aufruf nach dem Date-Setzen erreichbar ist
function updateDaypartVisibility() {
  const wrap = document.getElementById("f-daypart-wrap");
  const hdnInput = document.getElementById("f-daypart");
  if (!wrap) return;
  const startEl = document.getElementById("f-start");
  const endEl   = document.getElementById("f-end");
  const isSingleDay = startEl?.value && endEl?.value && startEl.value === endEl.value;
  wrap.style.display = isSingleDay ? "" : "none";
  if (!isSingleDay && hdnInput) {
    hdnInput.value = "full";
    document.querySelectorAll("#f-daypart-chips .daypart-chip").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.part === "full");
    });
  }
}

function bindUi() {
  document.getElementById("f-daypart-chips")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-part]");
    if (!btn) return;
    document.querySelectorAll("#f-daypart-chips .daypart-chip").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    const hdnInput = document.getElementById("f-daypart");
    if (hdnInput) hdnInput.value = btn.dataset.part;
  });

  els.form.addEventListener("submit", handleSubmit);
  els.fStart.addEventListener("change", () => {
    if (els.fEnd.value && els.fEnd.value < els.fStart.value) els.fEnd.value = els.fStart.value;
    updateDaypartVisibility();
  });
  els.fEnd?.addEventListener("change", updateDaypartVisibility);
  els.btnRejectConfirm.addEventListener("click", () => void handleReject());
  els.btnRejectCancel.addEventListener("click", closeRejectModal);
  els.rejectModal.addEventListener("click", (e) => {
    if (e.target === els.rejectModal) closeRejectModal();
  });

  // Approve-Modal
  document.getElementById("btn-approve-confirm")?.addEventListener("click", () => void _confirmApprove());
  document.getElementById("btn-approve-cancel")?.addEventListener("click", () => closeModal("approve-modal"));
  document.getElementById("approve-modal")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("approve-modal")) closeModal("approve-modal");
  });

  // Withdraw-Modal
  document.getElementById("btn-withdraw-confirm")?.addEventListener("click", () => void _confirmWithdraw());
  document.getElementById("btn-withdraw-cancel")?.addEventListener("click", () => closeModal("withdraw-modal"));
  document.getElementById("withdraw-modal")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("withdraw-modal")) closeModal("withdraw-modal");
  });

  // Cancel-Modal
  document.getElementById("btn-cancel-confirm")?.addEventListener("click", () => void _confirmCancel());
  document.getElementById("btn-cancel-cancel")?.addEventListener("click", () => closeModal("cancel-modal"));
  document.getElementById("cancel-modal")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("cancel-modal")) closeModal("cancel-modal");
  });
  if (els.closureYear) {
    els.closureYear.addEventListener("change", () => {
      void loadClosures(Number(els.closureYear.value) || new Date().getFullYear());
    });
  }
  if (els.btnAdminSettings) {
    els.btnAdminSettings.addEventListener("click", () => void openAdminSettingsModal());
  }
  if (els.navUser) {
    els.navUser.addEventListener("click", () => {
      if (isAdmin) return;
      setActiveNav("user");
    });
  }
  if (els.navAdmin) {
    els.navAdmin.addEventListener("click", () => {
      if (!isAdmin) return;
      els.adminPanel.hidden = false;
      els.userPanel.hidden = true;
      setActiveNav("admin");
    });
  }
  if (els.btnAdminSettingsClose) {
    els.btnAdminSettingsClose.addEventListener("click", closeAdminSettingsModal);
  }
  if (els.adminSettingsModal) {
    els.adminSettingsModal.addEventListener("click", (e) => {
      if (e.target === els.adminSettingsModal) closeAdminSettingsModal();
    });
  }
  if (els.settingsClosureYear) {
    els.settingsClosureYear.addEventListener("change", () => {
      void loadClosures(Number(els.settingsClosureYear.value) || new Date().getFullYear());
    });
  }

  document.addEventListener("roots-profile-ready", () => void bootApp());

  window.onRootsTeamRefresh = () => {
    void refreshRole().then(() => loadRequests()).catch(() => {});
  };
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
  els.statRemaining = document.getElementById("stat-remaining");
  els.statPending = document.getElementById("stat-pending");
  els.statApproved = document.getElementById("stat-approved");
  els.userPanel = document.getElementById("user-panel");
  els.adminPanel = document.getElementById("admin-panel");
  els.navUser = document.getElementById("nav-user");
  els.navAdmin = document.getElementById("nav-admin");
  els.dashViewTitle = document.getElementById("dash-view-title");
  els.userBadge = document.getElementById("user-badge");
  els.greetingDesc = document.getElementById("greeting-desc");
  els.adminBadge = document.getElementById("admin-badge");
  els.adminPendingCount = document.getElementById("admin-pending-count");
  els.adminPendingList = document.getElementById("admin-pending-list");
  els.adminHistoryList = document.getElementById("admin-history-list");
  els.adminTeamOverview = document.getElementById("admin-team-overview");
  els.adminTeamCount = document.getElementById("admin-team-count");
  els.teamOverviewYearLabel = document.getElementById("team-overview-year-label");
  els.btnAdminSettings = document.getElementById("btn-admin-settings");
  els.adminSettingsModal = document.getElementById("admin-settings-modal");
  els.btnAdminSettingsClose = document.getElementById("btn-admin-settings-close");
  els.settingsClosuresList = document.getElementById("admin-settings-closures-list");
  els.settingsClosureYear = document.getElementById("settings-closure-year");
  els.closureYear = document.getElementById("closure-year");
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
  updateDaypartVisibility(); // Chips beim Start zeigen wenn Von=Bis=heute
  syncAdminSettingsButton();
  if (isProfileReady()) void bootApp();
}
