// pddSearch.js
// Строим инвертированный индекс при старте → поиск за ~1мс вместо перебора всего массива

import questionsRaw from './assets/pdd_answers.json';

function normalize(s) {
  return s.toLowerCase().replace(/[^\wа-яё]/gi, ' ').trim();
}
function tokenize(s) {
  return normalize(s).split(/\s+/).filter(t => t.length > 2);
}

// Стоп-слова чтобы не мусорить индекс
const STOP = new Set([
  'что','как','для','при','если','это','все','или','но','не',
  'на','по','за','до','из','над','под','про','без','через',
  'the','and','for','are','with',
]);

let _questions = null;
let _index     = null;   // Map<слово, Set<idx>>

export function loadQuestions() {
  if (_questions) return _questions;
  const raw = questionsRaw;
  if (Array.isArray(raw)) {
    _questions = raw;
  } else {
    _questions = [];
    for (const v of Object.values(raw)) {
      if (Array.isArray(v)) _questions.push(...v);
    }
  }
  buildIndex();
  console.log(`✅ Загружено: ${_questions.length}, индекс: ${_index.size} слов`);
  return _questions;
}

function buildIndex() {
  _index = new Map();
  _questions.forEach((q, idx) => {
    for (const token of tokenize(q['вопрос'] || '')) {
      if (STOP.has(token)) continue;
      if (!_index.has(token)) _index.set(token, new Set());
      _index.get(token).add(idx);
    }
  });
}

export function findBestMatch(ocrText) {
  if (!_questions) loadQuestions();

  const queryTokens = tokenize(ocrText).filter(t => !STOP.has(t));
  if (!queryTokens.length) return { result: null, score: 0 };

  // Считаем hits по индексу — только кандидаты
  const hits = new Map(); // idx → кол-во совпавших токенов
  for (const token of queryTokens) {
    // Точное совпадение
    const exact = _index.get(token);
    if (exact) exact.forEach(i => hits.set(i, (hits.get(i) || 0) + 2));

    // Частичное совпадение (первые 5 букв)
    if (token.length >= 5) {
      const prefix = token.slice(0, 5);
      for (const [word, idxSet] of _index) {
        if (word.startsWith(prefix) && word !== token) {
          idxSet.forEach(i => hits.set(i, (hits.get(i) || 0) + 1));
        }
      }
    }
  }

  if (!hits.size) return { result: null, score: 0 };

  // Берём топ-5 кандидатов и делаем точный score только им
  const top5 = [...hits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([i]) => i);

  let best = null, bestScore = 0;
  for (const i of top5) {
    const score = tokenSetRatio(ocrText, _questions[i]['вопрос'] || '');
    if (score > bestScore) { bestScore = score; best = _questions[i]; }
  }

  return bestScore >= 38
    ? { result: best, score: bestScore }
    : { result: null, score: 0 };
}

function tokenSetRatio(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  const inter = [...setA].filter(t => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union ? Math.round((inter / union) * 100) : 0;
}