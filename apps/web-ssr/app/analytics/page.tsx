"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import MiraLogo from "../components/MiraLogo";

import { clearToken, getAnalyticsOverview, me } from "../lib/api.js";

type WeeklyItem = {
  day: string;
  date: string;
  views: number;
};

type AnalyticsPayload = {
  metrics?: {
    papersReadThisMonth?: number;
  };
  weeklyActivity?: {
    rangeDays?: number;
    maxViews?: number;
    items?: WeeklyItem[];
  };
};

function sumViews(items: WeeklyItem[]) {
  return items.reduce((sum, row) => sum + Number(row?.views || 0), 0);
}

function formatDeltaPct(value: number) {
  if (!Number.isFinite(value)) return "0%";
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function computeStreak(items: WeeklyItem[]) {
  let streak = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const views = Number(items[i]?.views || 0);
    if (views <= 0) break;
    streak += 1;
  }
  return streak;
}

function applyDemoWeeklyValues(items: WeeklyItem[]) {
  const byDay: Record<string, number> = {
    Mon: 2,
    Tue: 0,
    Wed: 3,
    Thu: 4,
    Fri: 1,
    Sat: 0,
    Sun: 0,
  };
  const base = Array.isArray(items) && items.length
    ? items
    : [
        { day: "Sat", date: "demo-sat", views: 0 },
        { day: "Sun", date: "demo-sun", views: 0 },
        { day: "Mon", date: "demo-mon", views: 0 },
        { day: "Tue", date: "demo-tue", views: 0 },
        { day: "Wed", date: "demo-wed", views: 0 },
        { day: "Thu", date: "demo-thu", views: 0 },
        { day: "Fri", date: "demo-fri", views: 0 },
      ];
  return base.map((row) => ({
    ...row,
    views: Number(byDay[String(row?.day || "").trim()] ?? 0),
  }));
}

export default function AnalyticsPage() {
  const router = useRouter();

  const [authChecked, setAuthChecked] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [payload, setPayload] = useState<AnalyticsPayload | null>(null);

  async function loadOverview() {
    setLoading(true);
    setLoadErr("");
    try {
      const out = await getAnalyticsOverview(14);
      setPayload(out || null);
    } catch (e: any) {
      setLoadErr(String(e?.message || "Could not load analytics."));
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const out = await me();
        if (cancelled) return;
        setUser(out?.ok ? out.user : null);
      } catch {
        if (cancelled) return;
        setUser(null);
      } finally {
        if (!cancelled) setAuthChecked(true);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authChecked) return;
    if (!user) {
      router.replace("/auth/login");
    }
  }, [authChecked, user, router]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    async function run() {
      setLoading(true);
      setLoadErr("");
      try {
        const out = await getAnalyticsOverview(14);
        if (cancelled) return;
        setPayload(out || null);
      } catch (e: any) {
        if (cancelled) return;
        setLoadErr(String(e?.message || "Could not load analytics."));
        setPayload(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  function logout() {
    clearToken();
    setUser(null);
    router.replace("/auth/login");
  }

  const emailLower = String(user?.email || "").trim().toLowerCase();
  const isSaraPreview = emailLower === "saradubey6@gmail.com";
  const metrics = payload?.metrics || {};
  const allWeekly = Array.isArray(payload?.weeklyActivity?.items) ? payload?.weeklyActivity?.items : [];
  const liveWeekly = allWeekly.length > 7 ? allWeekly.slice(-7) : allWeekly;
  const weekly = isSaraPreview ? applyDemoWeeklyValues(liveWeekly) : liveWeekly;
  const previousWeekly = isSaraPreview
    ? [
        { day: "Sat", date: "demo-prev-sat", views: 0 },
        { day: "Sun", date: "demo-prev-sun", views: 0 },
        { day: "Mon", date: "demo-prev-mon", views: 1 },
        { day: "Tue", date: "demo-prev-tue", views: 0 },
        { day: "Wed", date: "demo-prev-wed", views: 1 },
        { day: "Thu", date: "demo-prev-thu", views: 2 },
        { day: "Fri", date: "demo-prev-fri", views: 1 },
      ]
    : allWeekly.length >= 14
    ? allWeekly.slice(-14, -7)
    : [];
  const maxViews = Math.max(1, ...weekly.map((w) => Number(w?.views || 0)));
  const weeklySearches = sumViews(weekly);
  const prevWeeklySearches = sumViews(previousWeekly);
  const wowDeltaPct =
    prevWeeklySearches > 0
      ? ((weeklySearches - prevWeeklySearches) / prevWeeklySearches) * 100
      : weeklySearches > 0
      ? 100
      : 0;
  const activeDays = weekly.filter((row) => Number(row?.views || 0) > 0).length;
  const streakDays = computeStreak(weekly);
  const peakDay = weekly.reduce(
    (best, row) => (Number(row?.views || 0) > Number(best?.views || 0) ? row : best),
    weekly[0] || { day: "--", date: "", views: 0 }
  );
  const rangeDays = 7;
  const cards = [
    {
      icon: "01",
      value: Number(metrics.papersReadThisMonth || 0),
      label: "Papers this month",
      compact: false,
    },
    {
      icon: "02",
      value: weeklySearches,
      label: "Searches (last 7 days)",
      compact: false,
    },
    {
      icon: "03",
      value: activeDays,
      label: "Active days (7d)",
      compact: false,
    },
    {
      icon: "04",
      value: formatDeltaPct(wowDeltaPct),
      label: "Week-over-week",
      compact: true,
    },
  ];
  const isSuperadmin = String(user?.role || "").trim().toLowerCase() === "superadmin";

  if (!authChecked || !user) {
    return (
      <div className="shell homeShell">
        <header className="topbar">
          <div className="brand">
            <MiraLogo variant="nav" />
          </div>
        </header>
        <main className="container">
          <div className="card">
            <div className="cardBody">Loading analytics...</div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="shell analyticsShell">
      <header className="topbar">
        <div className="brand">
          <MiraLogo variant="nav" />
        </div>

        <nav className="topnav">
          <Link className="toplink" href="/">
            Home
          </Link>
          <Link className="toplink" href="/paper">
            Dashboard
          </Link>
          <Link className="toplink active" href="/analytics">
            Analytics
          </Link>
          {isSuperadmin ? (
            <>
              <Link className="toplink" href="/admin/users">
                Admin Users
              </Link>
              <Link className="toplink" href="/admin/ops">
                Admin Ops
              </Link>
            </>
          ) : null}
          <button className="toplink btnLink" onClick={logout}>
            Logout
          </button>
        </nav>
      </header>

      <main className="analyticsMain">
        <section className="analyticsWrap">
          <h1 className="analyticsTitle">Analytics</h1>
          <p className="analyticsSub">Your activity overview from search history.</p>

          <article className="analyticsPanel analyticsSpotlight">
            <div className="analyticsSpotlightMain">
              <div className="analyticsSpotlightLabel">
                {isSaraPreview ? "Sara's Weekly Snapshot" : "Weekly Snapshot"}
              </div>
              <div className="analyticsSpotlightValue">
                {weeklySearches} searches, {activeDays} active days
              </div>
              <div className="analyticsSpotlightSub">
                Peak: {String(peakDay?.day || "--")} ({Number(peakDay?.views || 0)}) · Current streak: {streakDays} day
                {streakDays === 1 ? "" : "s"}
              </div>
            </div>
          </article>

          {loadErr ? (
            <div className="stateCard stateCardError">
              <div className="stateCardTitle">Could not load analytics</div>
              <div className="stateCardText">{loadErr}</div>
              <button className="btn btnTiny stateCardBtn" onClick={loadOverview} disabled={loading}>
                {loading ? "Retrying..." : "Retry"}
              </button>
            </div>
          ) : null}

          <div className="analyticsCardGrid">
            {cards.map((card) => (
              <article key={card.label} className="analyticsMetricCard">
                <div className="analyticsMetricIcon">{card.icon}</div>
                <div className={`analyticsMetricValue ${card.compact ? "analyticsMetricValueCompact" : ""}`}>
                  {loading && !payload ? "..." : card.value}
                </div>
                <div className="analyticsMetricLabel">{card.label}</div>
              </article>
            ))}
          </div>

          <article className="analyticsPanel analyticsWeeklyPanel">
            <div className="analyticsPanelHead">
              <div className="analyticsPanelTitle">Weekly activity</div>
              <span className="analyticsTag">Last {rangeDays} days</span>
            </div>
            <div className="analyticsBars">
              {(weekly.length ? weekly : [{ day: "Mon", date: "", views: 0 }]).map((item) => {
                const views = Number(item?.views || 0);
                const pct = maxViews > 0 ? Math.round((views / maxViews) * 100) : 0;
                const height = views > 0 ? Math.max(14, pct) : 8;
                return (
                  <div key={`${item.day}-${item.date}`} className="analyticsBarCol">
                    <div className="analyticsBarTrack" title={`${views} views`}>
                      <div className="analyticsBarFill" style={{ height: `${height}%` }} />
                      <span className="analyticsBarValue">{views}</span>
                    </div>
                    <div className="analyticsBarDay">{item.day}</div>
                  </div>
                );
              })}
            </div>
          </article>
        </section>
      </main>

      <footer className="dashFooterBar">
        <div className="dashFooterInner">
          <div className="dashFooterLeft">
            <span className="dashFooterAvatar">S</span>
            <span>© Sara Dubey 2026</span>
          </div>
          <div className="dashFooterLinks">
            <a href="https://github.com/sara-dubey" target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href="https://www.linkedin.com/in/sara-dubey" target="_blank" rel="noreferrer">
              LinkedIn
            </a>
            <a href="mailto:saradubey98@gmail.com">Email</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
