import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";

const DEFAULT_CORS = [
  "https://pgoutzeris-stack.github.io",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://127.0.0.1:8080",
  "http://localhost:8080",
];

function corsHeaders(req: Request) {
  const o = req.headers.get("origin");
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
  if (o && DEFAULT_CORS.includes(o)) h["Access-Control-Allow-Origin"] = o;
  else if (!o) h["Access-Control-Allow-Origin"] = "https://pgoutzeris-stack.github.io";
  return h;
}

function json(data: unknown, status: number, c: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...c, "Content-Type": "application/json" },
  });
}

function deriveKuerzel(name: string, stored?: string | null): string {
  const k = (stored || "").trim().toUpperCase();
  if (k.length >= 2) return k.slice(0, 4);
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return (parts[0]?.slice(0, 2) || "??").toUpperCase();
}

async function ensureTeamMember(
  kal: ReturnType<typeof createClient>,
  userId: string,
  name: string,
  kuerzel?: string | null,
) {
  const kz = deriveKuerzel(name, kuerzel);
  const { data: byUser } = await kal
    .from("team_members")
    .select("id,name,user_id,kuerzel")
    .eq("user_id", userId)
    .maybeSingle();
  if (byUser) {
    if (byUser.name !== name || byUser.kuerzel !== kz) {
      const { data: updated, error } = await kal
        .from("team_members")
        .update({ name, kuerzel: kz })
        .eq("id", byUser.id)
        .select("id,name,user_id,kuerzel")
        .single();
      if (error) throw error;
      return updated;
    }
    return byUser;
  }
  const { data: orphan } = await kal
    .from("team_members")
    .select("id,name,user_id")
    .eq("name", name)
    .is("user_id", null)
    .maybeSingle();
  if (orphan) {
    const { data: linked, error } = await kal
      .from("team_members")
      .update({ user_id: userId, name, kuerzel: kz })
      .eq("id", orphan.id)
      .is("user_id", null)
      .select("id,name,user_id,kuerzel")
      .single();
    if (error) throw error;
    return linked;
  }
  let insertName = name;
  let { data, error } = await kal
    .from("team_members")
    .insert({ name: insertName, user_id: userId, kuerzel: kz })
    .select("id,name,user_id,kuerzel")
    .single();
  if (error?.code === "23505") {
    insertName = `${name} (${userId.slice(0, 8)})`;
    ({ data, error } = await kal
      .from("team_members")
      .insert({ name: insertName, user_id: userId, kuerzel: kz })
      .select("id,name,user_id,kuerzel")
      .single());
  }
  if (error) throw error;
  return data;
}

function rowOut(r: Record<string, unknown>) {
  return {
    id: r.id,
    user_id: r.user_id,
    applicant_name: r.applicant_name,
    start_date: r.start_date,
    end_date: r.end_date,
    note: r.note,
    status: r.status,
    reviewed_by: r.reviewed_by,
    reviewed_at: r.reviewed_at,
    rejection_reason: r.rejection_reason,
    calendar_event_id: r.calendar_event_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function countDays(start: string, end: string): number {
  const a = new Date(`${start}T12:00:00`);
  const b = new Date(`${end}T12:00:00`);
  return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
}

function parseYmd(ymd: string): Date {
  return new Date(`${ymd}T12:00:00`);
}

function formatDeYmd(ymd: string): string {
  return parseYmd(ymd).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function addDaysYmd(ymd: string, n: number): string {
  const d = parseYmd(ymd);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function isWeekendYmd(ymd: string): boolean {
  const wd = parseYmd(ymd).getDay();
  return wd === 0 || wd === 6;
}

function* eachDayYmd(start: string, end: string): Generator<string> {
  let cur = start;
  while (cur <= end) {
    yield cur;
    cur = addDaysYmd(cur, 1);
  }
}

function rangesOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

async function loadHolidayMap(
  kalender: ReturnType<typeof createClient>,
  start: string,
  end: string,
): Promise<Map<string, string>> {
  const { data, error } = await kalender
    .from("nrw_holidays")
    .select("holiday_date,label")
    .gte("holiday_date", start)
    .lte("holiday_date", end);
  if (error) throw error;
  const map = new Map<string, string>();
  for (const h of data ?? []) {
    map.set(String(h.holiday_date).slice(0, 10), String(h.label));
  }
  return map;
}

function countWorkingDaysInRange(
  start: string,
  end: string,
  holidays: Map<string, string>,
): number {
  let n = 0;
  for (const day of eachDayYmd(start, end)) {
    if (isWeekendYmd(day)) continue;
    if (holidays.has(day)) continue;
    n++;
  }
  return n;
}

function validateNewVacationRange(
  start: string,
  end: string,
  holidays: Map<string, string>,
): { ok: true; days: number } | { ok: false; error: string } {
  let days = 0;
  for (const day of eachDayYmd(start, end)) {
    if (isWeekendYmd(day)) {
      const weekday = parseYmd(day).toLocaleDateString("de-DE", { weekday: "long" });
      return {
        ok: false,
        error:
          `Urlaub an Wochenenden ist nicht möglich (${formatDeYmd(day)}, ${weekday}). Bitte nur Werktage wählen.`,
      };
    }
    const label = holidays.get(day);
    if (label) {
      return {
        ok: false,
        error:
          `Am ${formatDeYmd(day)} (${label}) ist Feiertag – an diesem Tag kann kein Urlaub beantragt werden.`,
      };
    }
    days++;
  }
  if (days === 0) {
    return { ok: false, error: "Der gewählte Zeitraum enthält keine gültigen Urlaubstage." };
  }
  return { ok: true, days };
}

function findRequestConflict(
  rows: Array<{ start_date: string; end_date: string; status: string }>,
  start: string,
  end: string,
  excludeId?: string,
): string | null {
  for (const row of rows) {
    if (row.status !== "pending" && row.status !== "approved") continue;
    if (excludeId && (row as { id?: string }).id === excludeId) continue;
    if (!rangesOverlap(start, end, row.start_date, row.end_date)) continue;
    const range = `${formatDeYmd(row.start_date)} – ${formatDeYmd(row.end_date)}`;
    if (row.status === "pending") {
      return `Für diesen Zeitraum liegt bereits ein ausstehender Antrag vor (${range}).`;
    }
    return `In diesem Zeitraum hast du bereits genehmigten Urlaub (${range}).`;
  }
  return null;
}

async function isClosureAutoRequest(
  service: ReturnType<typeof createClient>,
  requestId: string,
): Promise<boolean> {
  const { count, error } = await service
    .from("roots_closure_assignments")
    .select("id", { count: "exact", head: true })
    .eq("urlaub_request_id", requestId);
  if (error) throw error;
  return (count ?? 0) > 0;
}

async function loadAdminIds(service: ReturnType<typeof createClient>): Promise<string[]> {
  const { data, error } = await service
    .schema("users")
    .from("profiles")
    .select("id")
    .eq("app_role", "admin");
  if (error) throw error;
  return (data ?? []).map((r) => String(r.id));
}

async function notifyAdmins(
  service: ReturnType<typeof createClient>,
  payload: {
    type: string;
    title: string;
    message: string;
    meta?: Record<string, unknown>;
  },
) {
  const adminIds = await loadAdminIds(service);
  if (!adminIds.length) return;
  const rows = adminIds.map((adminId) => ({
    user_id: adminId,
    type: payload.type,
    title: payload.title,
    message: payload.message,
    session_id: null,
    runde: null,
    meta: {
      ...(payload.meta ?? {}),
      source: "urlaubsplanung",
    },
  }));
  const { error } = await service.schema("recruiting").from("notifications").insert(rows);
  if (error) console.error("[urlaubsplanung] notifyAdmins", error.message);
}

async function enrichRowOut(
  service: ReturnType<typeof createClient>,
  r: Record<string, unknown>,
  viewerId: string,
) {
  const base = rowOut(r);
  const isOwner = r.user_id === viewerId;
  const status = String(r.status ?? "");
  const isClosureAuto = r.id ? await isClosureAutoRequest(service, String(r.id)) : false;
  return {
    ...base,
    can_withdraw: isOwner && status === "pending" && !isClosureAuto,
    can_cancel: isOwner && status === "approved" && !isClosureAuto,
    is_closure_auto: isClosureAuto,
  };
}

async function refundUrlaubstage(
  service: ReturnType<typeof createClient>,
  userId: string,
  days: number,
) {
  const { data, error } = await service
    .schema("users")
    .from("profiles")
    .select("urlaubstage")
    .eq("id", userId)
    .single();
  if (error) throw error;
  const current = getUrlaubstage(data);
  const { error: updErr } = await service
    .schema("users")
    .from("profiles")
    .update({
      urlaubstage: current + days,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);
  if (updErr) throw updErr;
}

async function loadClosureRequestIds(
  service: ReturnType<typeof createClient>,
): Promise<Set<string>> {
  const { data, error } = await service
    .from("roots_closure_assignments")
    .select("urlaub_request_id");
  if (error) throw error;
  return new Set(
    (data ?? [])
      .map((r) => r.urlaub_request_id as string | null)
      .filter((id): id is string => Boolean(id)),
  );
}

async function buildTeamOverview(
  service: ReturnType<typeof createClient>,
  kalender: ReturnType<typeof createClient>,
  year: number,
) {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const holidays = await loadHolidayMap(kalender, yearStart, yearEnd);
  const closureReqIds = await loadClosureRequestIds(service);

  const { data: profiles, error: profErr } = await service
    .schema("users")
    .from("profiles")
    .select("id,full_name,email,kuerzel,urlaubstage,urlaubstage_jahr")
    .order("full_name");
  if (profErr) throw profErr;

  const { data: allRequests, error: reqErr } = await service
    .from("urlaub_requests")
    .select("id,user_id,start_date,end_date,status");
  if (reqErr) throw reqErr;

  // Betriebsferien-Abzüge pro User (direkt aus closure_assignments, nicht urlaub_requests)
  const { data: closures } = await service
    .from("roots_closure_assignments")
    .select("user_id,deducted_days");
  const betriebsByUser: Record<string, number> = {};
  for (const row of closures ?? []) {
    betriebsByUser[row.user_id] = (betriebsByUser[row.user_id] ?? 0) + Number(row.deducted_days ?? 0);
  }

  const rows = (profiles ?? [])
    .filter((p) => {
      const email = String(p.email || "").toLowerCase();
      return email && !email.endsWith("@test.de");
    })
    .map((p) => {
      const userId = String(p.id);
      let approvedDays = 0;
      let pendingDays = 0;
      let pendingCount = 0;

      for (const req of allRequests ?? []) {
        if (req.user_id !== userId) continue;
        if (closureReqIds.has(String(req.id))) continue;
        if (req.status !== "pending" && req.status !== "approved") continue;
        const startYear = Number(String(req.start_date).slice(0, 4));
        const endYear = Number(String(req.end_date).slice(0, 4));
        if (startYear > year || endYear < year) continue;
        const clipStart = String(req.start_date) < yearStart ? yearStart : String(req.start_date);
        const clipEnd = String(req.end_date) > yearEnd ? yearEnd : String(req.end_date);
        const days = countWorkingDaysInRange(clipStart, clipEnd, holidays);
        if (req.status === "pending") {
          pendingDays += days;
          pendingCount += 1;
        } else {
          approvedDays += days;
        }
      }

      // Initiales Jahres-Kontingent (immer urlaubstage_jahr, Fallback DEFAULT_URLAUBSTAGE)
      const initial = Number((p as any).urlaubstage_jahr ?? DEFAULT_URLAUBSTAGE);
      const betriebsDays = betriebsByUser[userId] ?? 0;
      // urlaubstage = verbleibende Tage (single source of truth, wird von
      // allen Quellen korrekt abgezogen: Betriebsferien, Urlaubsplanung, Team-Kalender-Admin)
      const remaining = Math.max(0, Number((p as any).urlaubstage ?? initial));
      // Tatsächlich verbrauchter Urlaub = initial - betriebsferien - verbleibend
      // Deckt alle Quellen ab: genehmigter Urlaub UND Admin-Direkteinträge im Kalender
      const realApprovedDays = Math.max(0, initial - betriebsDays - remaining);
      const plannedDays = realApprovedDays + pendingDays;

      return {
        user_id: userId,
        full_name: p.full_name || p.email || "—",
        kuerzel: p.kuerzel || null,
        remaining,
        approved_days: realApprovedDays,
        pending_days: pendingDays,
        planned_days: plannedDays,
        betrieb_days: betriebsDays,
        pending_count: pendingCount,
        total_allowance: initial,
      };
    });

  return { year, team: rows };
}

async function loadStaffSettings(service: ReturnType<typeof createClient>) {
  const { data, error } = await service
    .schema("users")
    .from("profiles")
    .select("id,full_name,email,kuerzel,urlaubstage")
    .order("full_name");
  if (error) throw error;
  const staff = (data ?? [])
    .filter((p) => {
      const email = String(p.email || "").toLowerCase();
      return email && !email.endsWith("@test.de");
    })
    .map((p) => ({
      user_id: p.id,
      full_name: p.full_name || p.email || "—",
      kuerzel: p.kuerzel || null,
      urlaubstage: getUrlaubstage(p),
    }));
  return { staff };
}

async function sumWorkingDaysForYear(
  kalender: ReturnType<typeof createClient>,
  rows: Array<{ start_date: string; end_date: string; status: string }>,
  year: number,
  statuses: Set<string>,
): Promise<number> {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const holidays = await loadHolidayMap(kalender, yearStart, yearEnd);
  let total = 0;
  for (const row of rows) {
    if (!statuses.has(row.status)) continue;
    const startYear = Number(row.start_date.slice(0, 4));
    const endYear = Number(row.end_date.slice(0, 4));
    if (startYear > year || endYear < year) continue;
    const clipStart = row.start_date < yearStart ? yearStart : row.start_date;
    const clipEnd = row.end_date > yearEnd ? yearEnd : row.end_date;
    total += countWorkingDaysInRange(clipStart, clipEnd, holidays);
  }
  return total;
}

const DEFAULT_URLAUBSTAGE = 30;

function getUrlaubstage(profile: { urlaubstage?: number | null } | null): number {
  const n = profile?.urlaubstage;
  if (typeof n === "number" && Number.isFinite(n)) return Math.max(0, Math.floor(n));
  return DEFAULT_URLAUBSTAGE;
}

async function loadProfile(
  service: ReturnType<typeof createClient>,
  userId: string,
) {
  const profUsers = await service
    .schema("users")
    .from("profiles")
    .select("id,full_name,email,app_role,urlaubstage,kuerzel")
    .eq("id", userId)
    .maybeSingle();
  if (!profUsers.error) return profUsers;
  return service
    .from("profiles")
    .select("id,full_name,email,app_role,urlaubstage,kuerzel")
    .eq("id", userId)
    .maybeSingle();
}

async function deductUrlaubstage(
  service: ReturnType<typeof createClient>,
  userId: string,
  days: number,
) {
  const { data, error } = await service
    .schema("users")
    .from("profiles")
    .select("urlaubstage")
    .eq("id", userId)
    .single();
  if (error) throw error;
  const current = getUrlaubstage(data);
  if (days > current) {
    throw new Error(`Nicht genug Urlaubstage (${current} verfügbar)`);
  }
  const { error: updErr } = await service
    .schema("users")
    .from("profiles")
    .update({
      urlaubstage: current - days,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);
  if (updErr) throw updErr;
}

async function syncRootsClosures(
  service: ReturnType<typeof createClient>,
  userId: string,
  year: number,
) {
  const { error } = await service.rpc("sync_roots_closures_for_user", {
    p_user_id: userId,
    p_year: year,
  });
  if (error) console.error("[urlaubsplanung] sync_roots_closures", error.message);
}

Deno.serve(async (req) => {
  const c = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: c });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json({ error: "Server-Konfiguration fehlt" }, 500, c);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "Nicht angemeldet" }, 401, c);

  const service = createClient(supabaseUrl, serviceKey);
  const kalender = createClient(supabaseUrl, serviceKey, {
    db: { schema: "team_kalender" },
  });

  const profRes = await loadProfile(service, user.id);
  if (profRes.error) throw profRes.error;
  const profile = profRes.data as {
    full_name?: string;
    email?: string;
    app_role?: string;
    urlaubstage?: number | null;
    kuerzel?: string | null;
  } | null;

  const isAdmin = profile?.app_role === "admin";
  const displayName = (profile?.full_name || profile?.email || "Nutzer").trim();
  const yearNow = new Date().getFullYear();

  try {
    await syncRootsClosures(service, user.id, yearNow);
    const profAfter = await loadProfile(service, user.id);
    if (!profAfter.error && profAfter.data) {
      Object.assign(profile || {}, profAfter.data);
    }

    if (req.method === "GET") {
      const params = new URL(req.url).searchParams;
      const scope = params.get("scope") || "mine";
      if (scope === "holidays") {
        const year = Number(params.get("year") || yearNow);
        const from = `${year}-01-01`;
        const to = `${year}-12-31`;
        const { data, error } = await kalender
          .from("nrw_holidays")
          .select("holiday_date,label")
          .gte("holiday_date", from)
          .lte("holiday_date", to)
          .order("holiday_date");
        if (error) throw error;
        return json({ year, holidays: data ?? [] }, 200, c);
      }
      if (scope === "balance") {
        const year = yearNow;
        const remaining = getUrlaubstage(profile);
        const { data: mine, error: mineErr } = await service
          .from("urlaub_requests")
          .select("start_date,end_date,status")
          .eq("user_id", user.id);
        if (mineErr) throw mineErr;
        const rows = (mine ?? []) as Array<{
          start_date: string;
          end_date: string;
          status: string;
        }>;
        const pending = await sumWorkingDaysForYear(
          kalender,
          rows,
          year,
          new Set(["pending"]),
        );
        const { data: closureDays } = await kalender
          .from("roots_closure_days")
          .select("id")
          .eq("calendar_year", year);
        const closureIds = (closureDays ?? []).map((d) => d.id);
        let rootsAutoDeducted = 0;
        if (closureIds.length) {
          const { data: rootsRows } = await service
            .from("roots_closure_assignments")
            .select("deducted_days")
            .eq("user_id", user.id)
            .in("closure_day_id", closureIds);
          rootsAutoDeducted = (rootsRows ?? []).reduce(
            (sum, r) => sum + Number(r.deducted_days || 0),
            0,
          );
        }
        return json(
          {
            year,
            remaining,
            pending,
            default_annual: DEFAULT_URLAUBSTAGE,
            roots_auto_deducted: rootsAutoDeducted,
          },
          200,
          c,
        );
      }
      if (scope === "admin") {
        if (!isAdmin) return json({ error: "Keine Berechtigung" }, 403, c);
        const { data, error } = await service
          .from("urlaub_requests")
          .select("*")
          .order("created_at", { ascending: false });
        if (error) throw error;
        return json((data ?? []).map((r) => rowOut(r as Record<string, unknown>)), 200, c);
      }
      if (scope === "closures") {
        if (!isAdmin) return json({ error: "Keine Berechtigung" }, 403, c);
        const year = Number(params.get("year") || yearNow);
        const { data, error } = await kalender
          .from("roots_closure_days")
          .select("id,closure_date,label,deduct_days,closure_kind,calendar_year")
          .eq("calendar_year", year)
          .order("closure_date");
        if (error) throw error;
        return json({ year, closures: data ?? [] }, 200, c);
      }
      if (scope === "team_overview") {
        if (!isAdmin) return json({ error: "Keine Berechtigung" }, 403, c);
        const year = Number(params.get("year") || yearNow);
        return json(await buildTeamOverview(service, kalender, year), 200, c);
      }
      if (scope === "staff") {
        if (!isAdmin) return json({ error: "Keine Berechtigung" }, 403, c);
        return json(await loadStaffSettings(service), 200, c);
      }
      const { data, error } = await service
        .from("urlaub_requests")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const enriched = await Promise.all(
        (data ?? []).map((r) => enrichRowOut(service, r as Record<string, unknown>, user.id)),
      );
      return json(enriched, 200, c);
    }

    if (req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      const action = String(body.action ?? "").toLowerCase();

      if (action === "create") {
        const start_date = String(body.start_date ?? "").slice(0, 10);
        const end_date = String(body.end_date ?? "").slice(0, 10);
        const note =
          body.note == null || body.note === "" ? null : String(body.note).trim();
        if (!start_date || !end_date || end_date < start_date) {
          return json({ error: "Ungültiger Zeitraum" }, 400, c);
        }

        const holidays = await loadHolidayMap(kalender, start_date, end_date);
        const rangeCheck = validateNewVacationRange(start_date, end_date, holidays);
        if (!rangeCheck.ok) {
          return json({ error: rangeCheck.error }, 400, c);
        }
        const requestedDays = rangeCheck.days;

        const { data: mine, error: mineErr } = await service
          .from("urlaub_requests")
          .select("id,start_date,end_date,status")
          .eq("user_id", user.id);
        if (mineErr) throw mineErr;
        const rows = (mine ?? []) as Array<{
          id: string;
          start_date: string;
          end_date: string;
          status: string;
        }>;

        const conflict = findRequestConflict(rows, start_date, end_date);
        if (conflict) {
          return json({ error: conflict }, 409, c);
        }

        const year = Number(start_date.slice(0, 4));
        const available = getUrlaubstage(profile);
        const pendingDays = await sumWorkingDaysForYear(
          kalender,
          rows,
          year,
          new Set(["pending"]),
        );
        const remaining = available - pendingDays;
        if (requestedDays > remaining) {
          return json(
            {
              error: `Nicht genug Urlaubstage (${remaining} verfügbar, ${requestedDays} beantragt)`,
            },
            400,
            c,
          );
        }

        const { data, error } = await service
          .from("urlaub_requests")
          .insert({
            user_id: user.id,
            applicant_name: displayName,
            start_date,
            end_date,
            note,
            status: "pending",
          })
          .select("*")
          .single();
        if (error) throw error;
        return json(await enrichRowOut(service, data as Record<string, unknown>, user.id), 201, c);
      }

      if (action === "withdraw") {
        const id = String(body.id ?? "").trim();
        if (!id) return json({ error: "id erforderlich" }, 400, c);

        const { data: reqRow, error: loadErr } = await service
          .from("urlaub_requests")
          .select("*")
          .eq("id", id)
          .maybeSingle();
        if (loadErr) throw loadErr;
        if (!reqRow) return json({ error: "Antrag nicht gefunden" }, 404, c);
        if (reqRow.user_id !== user.id) {
          return json({ error: "Keine Berechtigung" }, 403, c);
        }
        if (reqRow.status !== "pending") {
          return json({ error: "Nur ausstehende Anträge können zurückgezogen werden" }, 409, c);
        }
        if (await isClosureAutoRequest(service, id)) {
          return json({ error: "Dieser Eintrag kann nicht zurückgezogen werden" }, 403, c);
        }

        const { data, error } = await service
          .from("urlaub_requests")
          .update({
            status: "withdrawn",
            updated_at: new Date().toISOString(),
          })
          .eq("id", id)
          .select("*")
          .single();
        if (error) throw error;

        const applicant = (reqRow.applicant_name as string) || displayName;
        await notifyAdmins(service, {
          type: "urlaub_withdrawn",
          title: "Urlaubsantrag zurückgezogen",
          message: `${applicant} hat den Antrag ${formatDeYmd(reqRow.start_date as string)} – ${formatDeYmd(reqRow.end_date as string)} zurückgezogen.`,
          meta: { request_id: id, user_id: user.id, applicant_name: applicant },
        });
        return json(await enrichRowOut(service, data as Record<string, unknown>, user.id), 200, c);
      }

      if (action === "cancel_approved") {
        const id = String(body.id ?? "").trim();
        if (!id) return json({ error: "id erforderlich" }, 400, c);

        const { data: reqRow, error: loadErr } = await service
          .from("urlaub_requests")
          .select("*")
          .eq("id", id)
          .maybeSingle();
        if (loadErr) throw loadErr;
        if (!reqRow) return json({ error: "Antrag nicht gefunden" }, 404, c);
        if (reqRow.user_id !== user.id) {
          return json({ error: "Keine Berechtigung" }, 403, c);
        }
        if (reqRow.status !== "approved") {
          return json({ error: "Nur genehmigter Urlaub kann storniert werden" }, 409, c);
        }
        if (await isClosureAutoRequest(service, id)) {
          return json(
            { error: "Betriebsferien und firmenfreie Tage können nicht storniert werden" },
            403,
            c,
          );
        }

        const eventId = reqRow.calendar_event_id as string | null;
        if (eventId) {
          const { data: evRow, error: evErr } = await kalender
            .from("events")
            .select("id,is_system")
            .eq("id", eventId)
            .maybeSingle();
          if (evErr) throw evErr;
          if (evRow?.is_system) {
            return json(
              { error: "Betriebsferien und firmenfreie Tage können nicht storniert werden" },
              403,
              c,
            );
          }
          const { error: delErr } = await kalender.from("events").delete().eq("id", eventId);
          if (delErr) throw delErr;
        }

        const refundDays = countWorkingDaysInRange(
          reqRow.start_date as string,
          reqRow.end_date as string,
          await loadHolidayMap(
            kalender,
            reqRow.start_date as string,
            reqRow.end_date as string,
          ),
        );
        if (refundDays > 0) {
          await refundUrlaubstage(service, user.id, refundDays);
        }

        const { data, error } = await service
          .from("urlaub_requests")
          .update({
            status: "cancelled",
            calendar_event_id: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id)
          .select("*")
          .single();
        if (error) throw error;

        const applicant = (reqRow.applicant_name as string) || displayName;
        await notifyAdmins(service, {
          type: "urlaub_cancelled",
          title: "Genehmigter Urlaub storniert",
          message: `${applicant} hat genehmigten Urlaub ${formatDeYmd(reqRow.start_date as string)} – ${formatDeYmd(reqRow.end_date as string)} storniert. Der Kalendereintrag wurde entfernt.`,
          meta: { request_id: id, user_id: user.id, applicant_name: applicant },
        });
        return json(await enrichRowOut(service, data as Record<string, unknown>, user.id), 200, c);
      }

      if (action === "approve" || action === "reject") {
        if (!isAdmin) return json({ error: "Keine Berechtigung" }, 403, c);
        const id = String(body.id ?? "").trim();
        if (!id) return json({ error: "id erforderlich" }, 400, c);

        const { data: reqRow, error: loadErr } = await service
          .from("urlaub_requests")
          .select("*")
          .eq("id", id)
          .maybeSingle();
        if (loadErr) throw loadErr;
        if (!reqRow) return json({ error: "Antrag nicht gefunden" }, 404, c);
        if (reqRow.status !== "pending") {
          return json({ error: "Antrag wurde bereits bearbeitet" }, 409, c);
        }

        if (action === "reject") {
          const rejection_reason =
            body.reason == null || body.reason === ""
              ? null
              : String(body.reason).trim();
          const { data, error } = await service
            .from("urlaub_requests")
            .update({
              status: "rejected",
              reviewed_by: user.id,
              reviewed_at: new Date().toISOString(),
              rejection_reason,
              updated_at: new Date().toISOString(),
            })
            .eq("id", id)
            .select("*")
            .single();
          if (error) throw error;
          return json(rowOut(data as Record<string, unknown>), 200, c);
        }

        const approvedDays = countWorkingDaysInRange(
          reqRow.start_date as string,
          reqRow.end_date as string,
          await loadHolidayMap(
            kalender,
            reqRow.start_date as string,
            reqRow.end_date as string,
          ),
        );
        if (approvedDays < 1) {
          return json({ error: "Antrag enthält keine gültigen Urlaubstage" }, 400, c);
        }
        await deductUrlaubstage(service, reqRow.user_id as string, approvedDays);

        const applicantProfileRes = await loadProfile(service, reqRow.user_id as string);
        if (applicantProfileRes.error) throw applicantProfileRes.error;
        const applicantProfile = applicantProfileRes.data as {
          full_name?: string;
          email?: string;
          kuerzel?: string | null;
        } | null;
        const applicantName = (
          (reqRow.applicant_name as string) ||
          applicantProfile?.full_name ||
          applicantProfile?.email ||
          displayName
        ).trim();

        const member = await ensureTeamMember(
          kalender,
          reqRow.user_id as string,
          applicantName,
          applicantProfile?.kuerzel,
        );
        const kz = deriveKuerzel(member.name, member.kuerzel);
        const title = `${kz}: Urlaub`;
        const { data: ev, error: evErr } = await kalender
          .from("events")
          .insert({
            member_id: member.id,
            type: "urlaub",
            title,
            start_date: reqRow.start_date,
            end_date: reqRow.end_date,
            note: reqRow.note,
            is_system: false,
          })
          .select("id")
          .single();
        if (evErr) throw evErr;

        const { data, error } = await service
          .from("urlaub_requests")
          .update({
            status: "approved",
            reviewed_by: user.id,
            reviewed_at: new Date().toISOString(),
            team_member_id: member.id,
            calendar_event_id: ev.id,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id)
          .select("*")
          .single();
        if (error) throw error;
        return json(rowOut(data as Record<string, unknown>), 200, c);
      }

      if (action === "update_closure") {
        if (!isAdmin) return json({ error: "Keine Berechtigung" }, 403, c);
        const id = String(body.id ?? "").trim();
        if (!id) return json({ error: "id erforderlich" }, 400, c);
        const label = body.label != null ? String(body.label).trim() : undefined;
        const deductRaw = body.deduct_days;
        const patch: Record<string, unknown> = {};
        if (label != null && label.length > 0) patch.label = label;
        if (deductRaw != null && deductRaw !== "") {
          const d = Number(deductRaw);
          if (!Number.isFinite(d) || d < 0 || d > 5) {
            return json({ error: "deduct_days muss zwischen 0 und 5 liegen" }, 400, c);
          }
          patch.deduct_days = d;
        }
        if (!Object.keys(patch).length) {
          return json({ error: "Keine Änderungen angegeben" }, 400, c);
        }
        const { data, error } = await kalender
          .from("roots_closure_days")
          .update(patch)
          .eq("id", id)
          .select("id,closure_date,label,deduct_days,closure_kind,calendar_year")
          .single();
        if (error) throw error;
        return json(data, 200, c);
      }

      if (action === "update_urlaubstage") {
        if (!isAdmin) return json({ error: "Keine Berechtigung" }, 403, c);
        const user_id = String(body.user_id ?? "").trim();
        const raw = body.urlaubstage;
        const days = Number(raw);
        if (!user_id) return json({ error: "user_id erforderlich" }, 400, c);
        if (!Number.isFinite(days) || days < 0 || days > 365) {
          return json({ error: "urlaubstage muss zwischen 0 und 365 liegen" }, 400, c);
        }
        const urlaubstage = Math.floor(days);
        const { data, error } = await service
          .schema("users")
          .from("profiles")
          .update({ urlaubstage, updated_at: new Date().toISOString() })
          .eq("id", user_id)
          .select("id,full_name,kuerzel,urlaubstage")
          .single();
        if (error) throw error;
        return json(
          {
            user_id: data.id,
            full_name: data.full_name,
            kuerzel: data.kuerzel,
            urlaubstage: getUrlaubstage(data),
          },
          200,
          c,
        );
      }

      return json({ error: "Unbekannte Aktion" }, 400, c);
    }

    return json({ error: "Methode nicht erlaubt" }, 405, c);
  } catch (e) {
    console.error("[urlaubsplanung]", e);
    const msg = e instanceof Error ? e.message : "Interner Fehler";
    return json({ error: msg }, 500, c);
  }
});
