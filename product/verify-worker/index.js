/**
 * Gumroad subscription verifier — Cloudflare Worker
 *
 * POST /verify  { "email": "user@example.com" }
 * Returns:      { valid, email, plan, trialEndsOn? } | { valid: false, reason }
 *
 * Secrets (set via: npx wrangler secret put GUMROAD_TOKEN):
 *   GUMROAD_TOKEN — your Gumroad access token
 */

const PRODUCT = "jzkzn";
const MAX_PAGES = 20;  // handles up to 1,000 subscribers

// Free-access whitelist — these emails bypass Gumroad entirely.
// Add emails here and redeploy to grant free access.
const FREE_EMAILS = new Set([
  "jason_morris1@comcast.net",
  "kylemart5418@gmail.com",
]);

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return corsOk("");
    }
    if (request.method !== "POST") {
      return corsJson({ valid: false, reason: "Method not allowed" }, 405);
    }

    let body;
    try { body = await request.json(); } catch {
      return corsJson({ valid: false, reason: "Invalid JSON" }, 400);
    }

    const email    = (body.email    ?? "").toLowerCase().trim();
    const deviceId = (body.deviceId ?? "").trim() || null;

    if (!email || !email.includes("@")) {
      return corsJson({ valid: false, reason: "Email required" }, 400);
    }

    // Whitelist check — grant access without hitting Gumroad (multi-device allowed)
    if (FREE_EMAILS.has(email)) {
      return corsJson({ valid: true, email, plan: "Free Access", isFreeLoader: true, daysLeft: null });
    }

    // Search Gumroad sales for this email/product
    let sale = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = new URL("https://api.gumroad.com/v2/sales");
      url.searchParams.set("product_permalink", PRODUCT);
      url.searchParams.set("page", String(page));

      let gumRes;
      try {
        gumRes = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${env.GUMROAD_TOKEN}` },
        });
      } catch {
        return corsJson({ valid: false, reason: "Could not reach Gumroad API" }, 502);
      }

      if (!gumRes.ok) {
        return corsJson({ valid: false, reason: `Gumroad API error ${gumRes.status}` }, 502);
      }

      const data = await gumRes.json();
      if (!data.success || !Array.isArray(data.sales)) break;

      const found = data.sales.find(s => (s.email ?? "").toLowerCase() === email);
      if (found) { sale = found; break; }
      if (data.sales.length < 50) break;
    }

    if (!sale) {
      return corsJson({
        valid: false,
        reason: "No subscription found for this email. Subscribe at nigelbot.gumroad.com/l/jzkzn",
      });
    }

    // access_revoked = hard revoke by seller, always deny
    if (sale.access_revoked) {
      return corsJson({
        valid: false,
        reason: "Your access has been revoked. Contact support.",
      });
    }

    // ended = billing period is actually over, deny
    // cancelled = won't renew but current period still active, allow until ended
    if (sale.ended) {
      return corsJson({
        valid: false,
        reason: "Your subscription has ended. Renew at nigelbot.gumroad.com/l/jzkzn",
      });
    }

    // Single-device enforcement via KV (optional — only active when KV is bound)
    if (env.DEVICE_MAP && deviceId) {
      const stored = await env.DEVICE_MAP.get(email, { type: "json" });
      if (!stored) {
        // First activation — bind this device
        await env.DEVICE_MAP.put(email, JSON.stringify({ deviceId, boundAt: Date.now() }), { expirationTtl: 400 * 86400 });
      } else if (stored.deviceId !== deviceId) {
        // Different device — allow transfer after 30 days
        const daysSince = (Date.now() - stored.boundAt) / 86400000;
        if (daysSince < 30) {
          return corsJson({
            valid: false,
            reason: "This subscription is already active on another machine. Contact support to transfer, or wait 30 days for automatic transfer.",
          });
        }
        await env.DEVICE_MAP.put(email, JSON.stringify({ deviceId, boundAt: Date.now() }), { expirationTtl: 400 * 86400 });
      }
    }

    // Calculate days remaining in current period
    const now = Date.now();
    let daysLeft = null;
    let isTrial  = false;

    if (sale.free_trial_ends_on) {
      const trialEnd = new Date(sale.free_trial_ends_on).getTime();
      if (trialEnd > now) {
        isTrial  = true;
        daysLeft = Math.ceil((trialEnd - now) / 86400000);
      }
    }

    if (!isTrial && sale.created_at) {
      // Monthly billing: find how far into the current 30-day cycle we are
      const created    = new Date(sale.created_at).getTime();
      const elapsed    = now - created;
      const periodMs   = 30 * 86400000;
      const intoperiod = elapsed % periodMs;
      daysLeft = Math.ceil((periodMs - intoperiod) / 86400000);
    }

    return corsJson({
      valid: true,
      email:       sale.email,
      plan:        sale.variants?.Tier ?? "Monthly Access",
      trialEndsOn: sale.free_trial_ends_on ?? null,
      isTrial,
      daysLeft,
      isFreeLoader: false,
    });
  },
};

function corsJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function corsOk(body) {
  return new Response(body, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
