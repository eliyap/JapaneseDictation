// Japanese-aware answer comparison. Pure functions, no DOM.

// Punctuation and brackets that carry no listening information -- you cannot
// hear a comma. Note what is NOT here: ー (U+30FC, chouonpu) is a vowel length
// marker and 々 is a real character, so both stay significant.
const IGNORABLE = /[\s　。、，．,.！!？?「」『』（）()【】〈〉《》・:：;；…‥~〜​]/g;

// Deliberately excludes ー from IGNORABLE above; strip it only for the
// "close" comparison, never for the strict one.
const CHOUONPU = /[ー]/g;

/**
 * NFKC folds full-width ASCII and half-width kana into canonical forms, so
 * ｱ→ア and Ａ→A. Then drop punctuation and case.
 */
export function normalize(s) {
  return (s ?? "")
    .normalize("NFKC")
    .replace(IGNORABLE, "")
    .toLowerCase();
}

/** Strict "word-perfect" judgement -- the grade the spec asks for. */
export function isExact(answer, target) {
  return normalize(answer) === normalize(target) && normalize(target) !== "";
}

/** True when the only differences are long-vowel marks. Used to soften hints. */
export function isNearMiss(answer, target) {
  if (isExact(answer, target)) return false;
  const a = normalize(answer).replace(CHOUONPU, "");
  const b = normalize(target).replace(CHOUONPU, "");
  return a === b && b !== "";
}

/**
 * Character-level diff over the raw target so the reveal can highlight exactly
 * where the ear slipped. Classic LCS table -- sentences here are short enough
 * (< 100 chars) that the O(n*m) table is free.
 *
 * Returns [{ type: 'same'|'add'|'del', text }] where 'add' is text the learner
 * typed but the target lacks, and 'del' is target text they missed.
 */
export function diffChars(answer, target) {
  const a = [...(answer ?? "")];
  const b = [...(target ?? "")];
  const n = a.length;
  const m = b.length;

  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out = [];
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push("add", a[i++]);
    } else {
      push("del", b[j++]);
    }
  }
  while (i < n) push("add", a[i++]);
  while (j < m) push("del", b[j++]);
  return out;
}
