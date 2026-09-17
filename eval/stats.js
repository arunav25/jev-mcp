/**
 * Statistical primitives, written out rather than pulled in so the harness
 * stays dependency-free and every number is auditable.
 */

/** Seeded PRNG (mulberry32) so a bootstrap is reproducible across runs. */
export function rng(seed = 42) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal CDF via the Abramowitz-Stegun 7.1.26 error function. */
export function normalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return 0.5 * (1 + sign * (1 - poly * Math.exp(-z * z)));
}

/** Inverse standard normal CDF (Acklam's rational approximation). */
export function normalQuantile(p) {
  if (p <= 0 || p >= 1) throw new RangeError(`normalQuantile expects 0 < p < 1, got ${p}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;

  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);

  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** log(n choose k), via log-gamma, so large n does not overflow. */
function logChoose(n, k) {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** Lanczos approximation. */
function logGamma(x) {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) a += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** P(X >= k) for X ~ Binomial(n, 0.5). */
export function binomialUpperTail(k, n) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let total = 0;
  for (let i = k; i <= n; i++) total += Math.exp(logChoose(n, i) + n * Math.log(0.5));
  return Math.min(1, total);
}

/**
 * McNemar's test on paired binary outcomes.
 * @param {number} b Items the first system got right and the second got wrong.
 * @param {number} c The reverse.
 * @returns {{b:number, c:number, discordant:number, pValue:number, method:string}}
 */
export function mcnemar(b, c) {
  const discordant = b + c;
  if (discordant === 0) return { b, c, discordant, pValue: 1, method: "no discordant pairs" };

  // The exact binomial test is the honest choice at the sample sizes a first
  // eval run tends to have; chi-square only agrees once discordance is large.
  if (discordant < 25) {
    return {
      b, c, discordant,
      pValue: Math.min(1, 2 * binomialUpperTail(Math.max(b, c), discordant)),
      method: "exact binomial",
    };
  }
  const chi = (Math.abs(b - c) - 1) ** 2 / discordant;
  return { b, c, discordant, pValue: 2 * (1 - normalCdf(Math.sqrt(chi))), method: "chi-square (continuity corrected)" };
}

/**
 * Percentile bootstrap CI for a statistic over paired samples.
 * @param {number} n Number of items.
 * @param {(indices:number[]) => number} statistic Computed on a resample.
 * @param {object} [options]
 */
export function bootstrapCI(n, statistic, { resamples = 2000, alpha = 0.05, seed = 42 } = {}) {
  if (n === 0) return { point: NaN, lower: NaN, upper: NaN, resamples: 0 };
  const next = rng(seed);
  const values = [];
  const draw = new Array(n);

  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < n; i++) draw[i] = Math.floor(next() * n);
    const value = statistic(draw);
    if (Number.isFinite(value)) values.push(value);
  }
  values.sort((x, y) => x - y);

  const all = Array.from({ length: n }, (_, i) => i);
  const at = (q) => values[Math.min(values.length - 1, Math.max(0, Math.floor(q * values.length)))];
  return {
    point: statistic(all),
    lower: at(alpha / 2),
    upper: at(1 - alpha / 2),
    resamples: values.length,
  };
}

/**
 * Items needed for a paired (McNemar) comparison, via Connor (1987).
 * @param {object} args
 * @param {number} args.from Accuracy of the weaker system, 0-1.
 * @param {number} args.to Accuracy of the stronger system, 0-1.
 * @param {number} args.discordance Share of items the two systems disagree on.
 * @param {number} [args.power]
 * @param {number} [args.alpha]
 * @returns {{items:number, discordantPairs:number, oddsRatio:number}}
 */
export function pairedSampleSize({ from, to, discordance, power = 0.8, alpha = 0.05 }) {
  if (!(to > from)) throw new RangeError("`to` must exceed `from`");
  const delta = to - from;
  if (discordance <= delta) {
    throw new RangeError(
      `discordance (${discordance}) must exceed the accuracy gap (${delta.toFixed(3)}): ` +
        "every point of difference is itself a disagreement.",
    );
  }
  // Split the discordant mass so that b - c equals the observed accuracy gap.
  const b = (discordance + delta) / 2;
  const c = (discordance - delta) / 2;
  const psi = b / c;

  const zA = normalQuantile(1 - alpha / 2);
  const zB = normalQuantile(power);
  const numerator = zA * (psi + 1) + zB * Math.sqrt((psi + 1) ** 2 - (psi - 1) ** 2 * discordance);
  const items = (numerator / ((psi - 1) * Math.sqrt(discordance))) ** 2;

  return {
    items: Math.ceil(items),
    discordantPairs: Math.ceil(items * discordance),
    oddsRatio: psi,
  };
}

/** Mean of a numeric array. */
export const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
