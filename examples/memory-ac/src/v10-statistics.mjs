// Paired conversation-cluster inference. Small-cluster intervals are diagnostic, not SLA or causal certification.
export function holm(values) {
  const sorted = values.map((p, i) => ({p, i})).sort((a, b) => a.p - b.p), output = Array(values.length);
  let previous = 0;
  sorted.forEach(({p, i}, j) => {previous = Math.max(previous, Math.min(1, p * (values.length - j))); output[i] = previous;});
  return output;
}
export function clusterSignFlip(pairs, repetitions = 20000) {
  const groups = Object.values(Object.groupBy(pairs, x => x.group_id));
  if (!groups.length) return {p_two_sided: null, clusters: 0};
  const sums = groups.map(xs => xs.reduce((n, x) => n + x.delta, 0)), observed = Math.abs(sums.reduce((a, b) => a + b, 0));
  const exact = sums.length <= 20, draws = exact ? 2 ** sums.length : repetitions;
  let seed = 20260914, extreme = 0;
  const coin = () => {seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return (t ^ t >>> 14) >>> 0;};
  for (let mask = 0; mask < draws; mask++) {
    let sum = 0;
    for (let j = 0; j < sums.length; j++) sum += sums[j] * ((exact ? (mask >>> j) & 1 : coin() & 1) ? 1 : -1);
    if (Math.abs(sum) >= observed - 1e-12) extreme++;
  }
  return {p_two_sided: exact ? extreme / draws : (extreme + 1) / (draws + 1), clusters: sums.length,
    nonzero_clusters: sums.filter(x => x !== 0).length, exact, draws,
    assumption: 'Exchangeability of method labels within independent conversation groups; diagnostic paired cluster sign-flip, not a randomized causal experiment.'};
}
