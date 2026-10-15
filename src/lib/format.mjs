// Display formatters shared by status line and CLI output.

// 1_500_000 → "1.5M", 1_500 → "2K", 950 → "950"
// Thresholds sit where rounding would roll over (999_500 → "1.0M", not "1000K").
export function compactNumber(n) {
  if (n >= 999.95e6) return (n / 1e9).toFixed(1) + "B";
  if (n >= 999.5e3) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}

export function plainCount(n) {
  // Fixed locale: the status line mixes these with "1.5M"/"$0.50", so a
  // system locale using "." for thousands would make them ambiguous.
  return Math.round(n).toLocaleString("en-US");
}

// 45_000ms → "45s", 120_000 → "2min", 7_200_000 → "2.0hr"
export function durationMs(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.round(s / 60);
  if (m < 60) return m + "min";
  return (m / 60).toFixed(1) + "hr";
}

export function money(usd, threshold = 100) {
  if (!Number.isFinite(usd)) return "$0.00";
  if (usd >= threshold) return "$" + Math.round(usd).toLocaleString("en-US");
  return "$" + usd.toFixed(2);
}

export function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

// "claude-sonnet-4-6" → "Sonnet", "gpt-5.5" → "GPT-5.5"
export function modelName(model) {
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return "Opus";
  if (lower.includes("sonnet")) return "Sonnet";
  if (lower.includes("haiku")) return "Haiku";
  if (lower.includes("gpt-")) return model.replace(/^gpt-/i, "GPT-");
  return model;
}
