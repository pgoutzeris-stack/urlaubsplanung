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

async function ensureTeamMember(
  kal: ReturnType<typeof createClient>,
  userId: string,
  name: string,
) {
  const { data: byUser } = await kal
    .from("team_members")
    .select("id,name,user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (byUser) {
    if (byUser.name !== name) {
      const { data: updated, error } = await kal
        .from("team_members")
        .update({ name })
        .eq("id", byUser.id)
        .select("id,name,user_id")
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
      .update({ user_id: userId, name })
      .eq("id", orphan.id)
      .is("user_id", null)
      .select("id,name,user_id")
      .single();
    if (error) throw error;
    return linked;
  }
  let insertName = name;
  let { data, error } = await kal
    .from("team_members")
    .insert({ name: insertName, user_id: userId })
    .select("id,name,user_id")
    .single();
  if (error?.code === "23505") {
    insertName = `${name} (${userId.slice(0, 8)})`;
    ({ data, error } = await kal
      .from("team_members")
      .insert({ name: insertName, user_id: userId })
      .select("id,name,user_id")
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
    .select("id,full_name,email,app_role,urlaubstage")
    .eq("id", userId)
    .maybeSingle();
  if (!profUsers.error) return profUsers;
  return service
    .from("profiles")
    .select("id,full_name,email,app_role,urlaubstage")
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

function sumDaysForYear(
  rows: Array<{ start_date: string; end_date: string; status: string }>,
  year: number,
  statuses: Set<string>,
): number {
  let total = 0;
  for (const row of rows) {
    if (!statuses.has(row.status)) continue;
    const startYear = Number(row.start_date.slice(0, 4));
    const endYear = Number(row.end_date.slice(0, 4));
    if (startYear > year || endYear < year) continue;
    total += countDays(row.start_date, row.end_date);
  }
  return total;
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
      const scope = new URL(req.url).searchParams.get("scope") || "mine";
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
        const pending = sumDaysForYear(rows, year, new Set(["pending"]));
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
      const { data, error } = await service
        .from("urlaub_requests")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return json((data ?? []).map((r) => rowOut(r as Record<string, unknown>)), 200, c);
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
        const requestedDays = countDays(start_date, end_date);
        const year = Number(start_date.slice(0, 4));
        const annual = getUrlaubstage(profile);
        if (annual > 0) {
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
          const used = sumDaysForYear(rows, year, new Set(["approved"]));
          const pending = sumDaysForYear(rows, year, new Set(["pending"]));
          const remaining = annual - used - pending;
          if (requestedDays > remaining) {
            return json(
              {
                error: `Nicht genug Urlaubstage (${remaining} von ${annual} verfügbar)`,
              },
              400,
              c,
            );
          }
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
        return json(rowOut(data as Record<string, unknown>), 201, c);
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

        const approvedDays = countDays(
          reqRow.start_date as string,
          reqRow.end_date as string,
        );
        await deductUrlaubstage(service, reqRow.user_id as string, approvedDays);

        const member = await ensureTeamMember(
          kalender,
          reqRow.user_id as string,
          (reqRow.applicant_name as string) || displayName,
        );
        const title = `${member.name} Urlaub`;
        const { data: ev, error: evErr } = await kalender
          .from("events")
          .insert({
            member_id: member.id,
            type: "urlaub",
            title,
            start_date: reqRow.start_date,
            end_date: reqRow.end_date,
            note: reqRow.note,
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

      return json({ error: "Unbekannte Aktion" }, 400, c);
    }

    return json({ error: "Methode nicht erlaubt" }, 405, c);
  } catch (e) {
    console.error("[urlaubsplanung]", e);
    const msg = e instanceof Error ? e.message : "Interner Fehler";
    return json({ error: msg }, 500, c);
  }
});
