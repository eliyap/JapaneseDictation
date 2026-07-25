// localStorage persistence. Progress is keyed by sentence id, so editing the
// deck (adding/removing sentences) never invalidates existing progress.

import { newCard } from "./srs.js";

const KEY = "jpdictation.v1";

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {}; // private mode, quota, or hand-corrupted JSON -- start clean
  }
}

function write(obj) {
  try {
    localStorage.setItem(KEY, JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

/** Merge saved progress onto the deck, creating fresh cards for new sentences. */
export function loadCards(sentences) {
  const saved = read();
  return sentences.map((s) => {
    const c = saved[s.id];
    return c ? { ...newCard(s.id), ...c, id: s.id } : newCard(s.id);
  });
}

export function saveCards(cards) {
  const obj = {};
  for (const c of cards) obj[c.id] = c;
  return write(obj);
}

export function resetAll() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing we can do, and nothing worth surfacing */
  }
}

export function exportJSON() {
  return JSON.stringify(read(), null, 2);
}

export function importJSON(text) {
  const parsed = JSON.parse(text); // caller catches
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object of { sentenceId: card }");
  }
  write(parsed);
}
