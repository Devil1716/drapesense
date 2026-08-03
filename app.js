/* ============================================================
   DrapeSense — app.js
   All logic: camera, 4x Groq API calls, UI state management
   ============================================================ */

'use strict';

// ── Config guard ──────────────────────────────────────────────
if (typeof GROQ_API_KEY === 'undefined' || GROQ_API_KEY === 'gsk_YOUR_API_KEY_HERE') {
  document.addEventListener('DOMContentLoaded', () => {
    const shell = document.getElementById('app-shell');
    if (shell) {
      shell.innerHTML = `
        <div style="padding:40px 24px;text-align:center;font-family:Inter,sans-serif">
          <div style="font-size:32px;margin-bottom:16px">🔑</div>
          <h2 style="font-size:18px;margin-bottom:8px;color:#1a1a18">API key not set</h2>
          <p style="font-size:13px;color:#6b6860;line-height:1.6">
            Copy <code>config.example.js</code> to <code>config.js</code><br>
            and paste your Groq API key inside it.<br><br>
            See <strong>README.md</strong> for instructions.
          </p>
        </div>`;
    }
  });
  // stop executing rest of the file
  throw new Error('DrapeSense: GROQ_API_KEY not configured.');
}

// ── Constants ─────────────────────────────────────────────────
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
// Exact model from build spec — supports vision AND text, reasoning disabled below
const MODEL         = 'qwen/qwen3.6-27b'; // used for all 4 calls (vision + text)
const MODEL_TEXT    = 'qwen/qwen3.6-27b'; // same model for text-only calls

// Anchor IDs per garment type — must match id="anchor-*" in SVG files
const ANCHOR_MAP = {
  shirt:  ['shoulder', 'chest', 'sleeve_length', 'body_length'],
  kurta:  ['shoulder', 'chest', 'sleeve_length', 'body_length'],
  dress:  ['bust', 'waist', 'hip', 'full_length'],
  pants:  ['waist', 'hip', 'inseam', 'leg_opening'],
};

// Drape display
const DRAPE_META = {
  stiff:  { icon: '📐', label: 'Stiff' },
  medium: { icon: '🪡', label: 'Medium' },
  flowy:  { icon: '🌊', label: 'Flowy' },
};

function drapeIcon(type) {
  const paths = {
    stiff: 'M5 6h14M5 12h14M5 18h14',
    medium: 'M4 7c4 0 4 10 8 10s4-10 8-10',
    flowy: 'M4 6c5 0 5 12 10 12s5-12 6-12'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[type] || paths.medium}"/></svg>`;
}

// ── State ─────────────────────────────────────────────────────
const state = {
  photoDataUrl:   null,
  fabricResult:   null,   // Call 1 result
  selectedShape:  null,   // 'shirt' | 'kurta' | 'dress' | 'pants'
  fitAdvice:      null,   // Call 2 result
  yardageResult:  null,   // Call 3 result
  measureResult:  null,   // Call 4 result
  isAnalyzing:    false,
};

// ── DOM refs ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const WIZARD_LABELS = { 1: 'Scan', 2: 'Match', 3: 'Yardage', 4: 'Cutting diagram' };

function setWizardStep(step) {
  const normalized = Math.max(1, Math.min(4, Number(step) || 1));
  document.body.dataset.step = String(normalized);
  document.querySelectorAll('.wizard-section').forEach(section => hide(section));
  if (normalized === 2) {
    show($('result-section')); show($('silhouette-section'));
    if (state.selectedShape) show($('preview-section'));
  }
  if (normalized === 3) {
    show($('yardage-section'));
    if (state.fitAdvice) show($('preview-section'));
  }
  if (normalized === 4) show($('diagram-section'));
  document.querySelectorAll('[data-step-dot]').forEach(dot => {
    const dotStep = Number(dot.dataset.stepDot);
    dot.classList.toggle('is-active', dotStep === normalized);
    dot.classList.toggle('is-complete', dotStep < normalized);
  });
  const caption = $('step-caption');
  if (caption) caption.textContent = WIZARD_LABELS[normalized];
  const back = $('back-btn');
  if (back) back.classList.toggle('hidden', normalized === 1);
}

function setupWizardUI() {
  setWizardStep(1);
  $('start-over-btn')?.addEventListener('click', resetWizardState);
  $('back-btn')?.addEventListener('click', () => {
    const current = Number(document.body.dataset.step || 1);
    if (current === 2) {
      hide($('result-section')); hide($('silhouette-section')); hide($('preview-section'));
      show($('scan-section')); setWizardStep(1);
    } else if (current === 3) {
      hide($('yardage-section')); setWizardStep(2);
    } else if (current === 4) {
      hide($('diagram-section')); setWizardStep(3);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function resetWizardState() {
  state.isAnalyzing = false;
  state.photoDataUrl = null;
  state.fabricResult = null;
  state.selectedShape = null;
  state.fitAdvice = null;
  state.yardageResult = null;
  state.measureResult = null;
  ['loading-card', 'photo-review', 'result-section', 'silhouette-section', 'preview-section', 'yardage-section', 'diagram-section'].forEach(id => hide($(id)));
  document.querySelectorAll('.silhouette-btn').forEach(btn => btn.classList.remove('selected'));
  if ($('file-input')) $('file-input').value = '';
  show($('scan-section'));
  clearError($('scan-error-slot'));
  setWizardStep(1);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Utility: strip think blocks & parse JSON ──────────────────
function safeParseJSON(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Groq returned an empty response.');
  }
  // Remove <think>…</think> blocks (reasoning bleed-through)
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // Strip markdown code fences if present
  const stripped = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    return JSON.parse(stripped);
  } catch (firstError) {
    // JSON mode normally returns a clean object, but some model responses can
    // still include a short preamble. Parse the first complete JSON object in
    // the response instead of making the user restart the scan.
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1));
      } catch (_) {
        // Keep the original, more useful parse error below.
      }
    }
    throw new Error('Groq returned an invalid analysis response.');
  }
}

function normalizeFabricResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Groq returned an invalid fabric analysis.');
  }

  const fabricTypes = new Set(['cotton', 'silk', 'denim', 'polyester', 'wool', 'linen', 'chiffon', 'velvet', 'knit', 'blend', 'unknown']);
  const drapes = new Set(['stiff', 'medium', 'flowy']);
  const fabricType = String(result.fabric_type || 'unknown').toLowerCase().trim();
  const drape = String(result.drape || 'medium').toLowerCase().trim();
  const confidence = Number(result.confidence);
  const bestFor = Array.isArray(result.best_for) ? result.best_for : [];

  return {
    fabric_type: fabricTypes.has(fabricType) ? fabricType : 'unknown',
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    drape: drapes.has(drape) ? drape : 'medium',
    dominant_color: String(result.dominant_color || 'unknown').trim() || 'unknown',
    texture_notes: String(result.texture_notes || 'No texture notes available.').trim(),
    best_for: bestFor
      .map(item => String(item).toLowerCase().trim())
      .filter(item => ['shirt', 'kurta', 'dress', 'pants', 'jacket', 'saree', 'skirt'].includes(item))
      .slice(0, 3),
  };
}

// ── Utility: Groq fetch ───────────────────────────────────────
async function groqFetch(messages, { vision = false } = {}) {
  const body = {
    model: vision ? MODEL : MODEL_TEXT,
    messages,
    temperature: 0.2,
    max_completion_tokens: 512,
    response_format: { type: 'json_object' },
    // Disable reasoning to avoid <think> bleed-through
    reasoning_effort: 'none',
    reasoning_format: 'hidden',
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Groq request timed out.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Groq API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  return content;
}

// ── Utility: image → base64 ───────────────────────────────────
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Utility: resize image for API (max 1024px, keep ratio) ───
function resizeImage(dataUrl, maxPx = 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('Could not read the selected image.'));
    img.src = dataUrl;
  });
}

// ── Call 1 — Fabric classification ───────────────────────────
async function callFabricScan(imageDataUrl) {
  const messages = [
    {
      role: 'system',
      content: `You are a textile analysis assistant for a fashion design app. You will be shown
a close-up photo of a fabric swatch. Analyze it visually and respond ONLY with
valid JSON matching this exact schema, no extra text:

{
  "fabric_type": string,
  "confidence": number,
  "drape": string,
  "dominant_color": string,
  "texture_notes": string,
  "best_for": [string]
}

fabric_type must be one of: cotton, silk, denim, polyester, wool, linen, chiffon, velvet, knit, blend, unknown
drape must be one of: stiff, medium, flowy
confidence is 0-1
dominant_color is a simple color name e.g. "maroon"
texture_notes is max 15 words
best_for is 1-3 garment types from: ["shirt","kurta","dress","pants","jacket","saree","skirt"]

Base your answer purely on visual cues: weave tightness, sheen, thickness, how
light falls across folds if visible. If uncertain, lower the confidence score
rather than guessing wildly.`,
    },
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: imageDataUrl },
        },
        { type: 'text', text: 'Analyze this fabric swatch.' },
      ],
    },
  ];

  const raw = await groqFetch(messages, { vision: true });
  return safeParseJSON(raw);
}

// ── Call 2 — Fit advice ───────────────────────────────────────
async function callFitAdvice(fabricType, drape, garment) {
  const messages = [
    {
      role: 'system',
      content: `You are a fashion design assistant helping someone decide, in real time, whether
a fabric they're holding suits the garment they want to make. Given a fabric's
type and drape, and a chosen garment silhouette, respond ONLY with valid JSON
matching this schema, no extra text:

{
  "verdict": string,
  "reason": string,
  "tip": string
}

verdict must be one of: "great match", "workable", "not ideal"
reason is max 20 words, plain and direct, no fluff
tip is max 15 words, one concrete actionable suggestion`,
    },
    {
      role: 'user',
      content: `Fabric: ${fabricType}, drape: ${drape}. Garment: ${garment}. Evaluate this pairing.`,
    },
  ];

  const raw = await groqFetch(messages);
  return safeParseJSON(raw);
}

// ── Call 3 — Yardage estimate ─────────────────────────────────
async function callYardage(garment, size, width, drape) {
  const messages = [
    {
      role: 'system',
      content: `You are a fashion design assistant helping estimate how much fabric to buy.
Given a garment type, a standard size, and the fabric width being sold, give a
practical estimate. Base it on standard garment-industry yardage guidelines for
that garment type and size. Respond ONLY with valid JSON matching this schema,
no extra text:

{
  "length_needed": string,
  "buffer_note": string,
  "cutting_tip": string
}

length_needed is e.g. "2.3 meters" — a single practical number, not a range
buffer_note is max 15 words, e.g. why they should round up
cutting_tip is max 15 words, one practical cutting/layout tip specific to this garment and fabric width

This is a rough working estimate for a designer buying fabric, not a precise
pattern calculation — be practical and slightly generous rather than exact.`,
    },
    {
      role: 'user',
      content: `Garment: ${garment}. Size: ${size}. Fabric width: ${width}. Drape: ${drape}. Estimate fabric needed.`,
    },
  ];

  const raw = await groqFetch(messages);
  return safeParseJSON(raw);
}

// ── Call 4 — Pattern measurements ────────────────────────────
async function callPatternMeasurements(garment, size) {
  const messages = [
    {
      role: 'system',
      content: `You are a fashion design assistant providing standard garment measurements for
pattern cutting. Given a garment type and a standard size, return the key body/
pattern measurements a designer would mark on a flat pattern piece for that
size. Use standard ready-to-wear industry sizing charts as your basis. Respond
ONLY with valid JSON matching this schema, no extra text:

{
  "unit": string,
  "measurements": {
    "waist": string,
    "hip": string,
    "inseam": string,
    "leg_opening": string,
    "chest": string,
    "shoulder": string,
    "sleeve_length": string,
    "body_length": string,
    "bust": string,
    "full_length": string
  },
  "seam_allowance": string,
  "note": string
}

unit is "in" or "cm"
measurements: include only the keys relevant to the garment type:
  pants: waist, hip, inseam, leg_opening
  shirt/kurta: chest, shoulder, sleeve_length, body_length
  dress: bust, waist, hip, full_length
seam_allowance is e.g. "1.5 cm standard seam allowance included"
note is max 15 words

These are standard reference measurements for the given size, not a custom fit
for an individual body. Be practical and use commonly accepted industry values.`,
    },
    {
      role: 'user',
      content: `Garment: ${garment}. Size: ${size}. Provide pattern measurements.`,
    },
  ];

  const raw = await groqFetch(messages);
  return safeParseJSON(raw);
}

// ── UI helpers ────────────────────────────────────────────────

function show(el) { if (el) el.classList.remove('hidden'); }
function hide(el) { if (el) el.classList.add('hidden'); }
function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}
function reveal(el) {
  if (!el) return;
  el.classList.remove('hidden');
  el.classList.add('section-reveal');
}

function colorFromName(name) {
  // best-effort CSS color from a color name string
  const el = document.createElement('div');
  el.style.color = name;
  document.body.appendChild(el);
  const computed = getComputedStyle(el).color;
  document.body.removeChild(el);
  // returns "rgb(0,0,0)" if unknown — fall back to a neutral
  return (computed === 'rgb(0, 0, 0)' && name !== 'black') ? '#888' : name;
}

function verdictClass(verdict) {
  if (!verdict) return '';
  const v = verdict.toLowerCase();
  if (v.includes('great')) return 'great';
  if (v.includes('workable')) return 'workable';
  return 'not-ideal';
}

function verdictEmoji(verdict) {
  const v = (verdict || '').toLowerCase();
  if (v.includes('great')) return '✓';
  if (v.includes('workable')) return '~';
  return '✗';
}

// ── Build SVG garment silhouettes inline ──────────────────────
// Simple flat vector outlines recognizable as each garment type.
// These are used in the silhouette selector AND as the preview container.

const SILHOUETTES = {
  shirt: `<svg viewBox="0 0 80 100" xmlns="http://www.w3.org/2000/svg">
    <path d="M28,10 L10,28 L10,36 L22,40 L22,88 L58,88 L58,40 L70,36 L70,28 L52,10
             Q44,6 40,8 Q36,6 28,10 Z"/>
    <path d="M36,10 Q40,15 44,10" fill="none" stroke-width="1.5"/>
  </svg>`,

  kurta: `<svg viewBox="0 0 80 110" xmlns="http://www.w3.org/2000/svg">
    <path d="M28,10 L8,32 L8,40 L22,44 L20,96 L28,96 L28,88 L52,88 L52,96 L60,96
             L58,44 L72,40 L72,32 L52,10 Q44,6 40,8 Q36,6 28,10 Z"/>
    <line x1="38" y1="10" x2="38" y2="28" stroke-width="1.2"/>
    <line x1="42" y1="10" x2="42" y2="28" stroke-width="1.2"/>
  </svg>`,

  dress: `<svg viewBox="0 0 80 110" xmlns="http://www.w3.org/2000/svg">
    <path d="M30,8 Q40,4 50,8 L56,18 L56,24 L52,28 L54,50 Q62,70 66,106
             L14,106 Q18,70 26,50 L28,28 L24,24 L24,18 Z"/>
    <path d="M33,8 Q40,13 47,8" fill="none" stroke-width="1.5"/>
  </svg>`,

  pants: `<svg viewBox="0 0 80 110" xmlns="http://www.w3.org/2000/svg">
    <rect x="16" y="8" width="48" height="12" rx="2"/>
    <path d="M16,20 L14,50 Q12,64 18,68 L32,68 L40,54 L48,68 L62,68 Q68,64 66,50 L64,20"/>
    <line x1="40" y1="20" x2="40" y2="54" stroke-width="1.2" stroke-dasharray="3 2"/>
    <line x1="18" y1="68" x2="24" y2="106" />
    <line x1="62" y1="68" x2="56" y2="106" />
    <line x1="24" y1="106" x2="56" y2="106"/>
  </svg>`,
};

// ── Screen 1: Scan ─────────────────────────────────────────────
function setupScanScreen() {
  const fileInput = $('file-input');
  const scanSection = $('scan-section');
  const loadingCard = $('loading-card');
  const resultSection = $('result-section');
  const retryBtn = $('retry-btn-scan');

  async function analyzePhoto() {
    const resized = state.photoDataUrl;
    if (!resized || state.isAnalyzing) return;
    state.isAnalyzing = true;
    const analyzeButton = $('use-photo-btn');
    if (analyzeButton) analyzeButton.disabled = true;
    hide($('photo-review'));
    show(loadingCard);
    try {
      const result = normalizeFabricResult(await callFabricScan(resized));
      state.fabricResult = result;
      hide(loadingCard);
      renderResultCard(result, resized);
      reveal(resultSection);
      reveal($('silhouette-section'));
      setWizardStep(2);
      resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      console.error('Call 1 error:', err);
      hide(loadingCard);
      show(scanSection);
      show($('photo-review'));
      renderError($('scan-error-slot'), analyzePhoto, err?.message || 'The fabric could not be analyzed.');
    } finally {
      state.isAnalyzing = false;
      if (analyzeButton) analyzeButton.disabled = false;
    }
  }

  async function handleFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    hide(scanSection);
    hide(resultSection);
    hide($('silhouette-section'));
    hide($('preview-section'));
    hide($('yardage-section'));
    hide($('diagram-section'));
    clearError($('scan-error-slot'));
    state.fabricResult = null;
    state.selectedShape = null;
    state.fitAdvice = null;
    state.yardageResult = null;
    state.measureResult = null;
    try {
      const raw = await fileToBase64(file);
      state.photoDataUrl = await resizeImage(raw, 1024);
      const reviewImage = $('photo-review-image');
      if (reviewImage) reviewImage.src = state.photoDataUrl;
      show($('photo-review'));
      setWizardStep(1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      console.error('Photo preparation error:', err);
      show(scanSection);
      renderError($('scan-error-slot'), () => $('file-input').click());
    }
  }

  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) handleFile(file);
    // Reset so the same file can be re-selected
    fileInput.value = '';
  });

  if (retryBtn) retryBtn.addEventListener('click', () => fileInput.click());
  $('retake-btn')?.addEventListener('click', () => {
    hide($('photo-review'));
    show(scanSection);
    fileInput.click();
  });
  $('use-photo-btn')?.addEventListener('click', analyzePhoto);
}

function renderResultCard(r, imgSrc) {
  const card = $('result-card');
  if (!card) return;

  // Low-confidence / unknown notice
  const showNotice = (r.fabric_type === 'unknown' || r.confidence < 0.4);
  const noticeHtml = showNotice ? `
    <div class="notice-card mt-14">
      <span class="notice-icon" aria-hidden="true">!</span>
      <span>Not sure about this one — try a closer, well-lit shot.</span>
    </div>` : '';

  const drapeInfo = DRAPE_META[r.drape] || { icon: '🪡', label: r.drape || 'Unknown' };
  const confidencePct = Math.round((r.confidence || 0) * 100);
  const swatchColor = colorFromName(r.dominant_color);
  const tagsHtml = (r.best_for || []).map(t =>
    `<span class="tag">${escapeHTML(String(t).charAt(0).toUpperCase() + String(t).slice(1))}</span>`
  ).join('');

  card.innerHTML = `
    <img class="fabric-thumbnail" src="${imgSrc}" alt="Scanned fabric swatch">

    <div class="result-fabric-type">${escapeHTML(String(r.fabric_type || 'Unknown').replace(/^\w/, c => c.toUpperCase()))}</div>
    <div class="result-confidence">${confidencePct}% confident</div>

    <div class="result-meta-grid">
      <div class="meta-item">
        <div class="meta-item-label">Drape</div>
        <div class="meta-item-value drape-badge">
          <span class="drape-icon">${drapeIcon(r.drape)}</span>
          ${drapeInfo.label}
        </div>
      </div>
      <div class="meta-item">
        <div class="meta-item-label">Dominant Color</div>
        <div class="meta-item-value">
          <span class="color-swatch" style="background:${swatchColor}"></span>
          ${escapeHTML(String(r.dominant_color || 'Unknown').replace(/^\w/, c => c.toUpperCase()))}
        </div>
      </div>
    </div>

    <div class="result-texture">${r.texture_notes || '—'}</div>

    <div class="section-label">Best for</div>
    <div class="tag-row">${tagsHtml || '<span class="tag">General use</span>'}</div>

    ${noticeHtml}
  `;
}

// ── Screen 2: Silhouette & preview ────────────────────────────
function setupSilhouetteScreen() {
  const grid = $('silhouette-grid');
  if (!grid) return;

  ['shirt', 'kurta', 'dress', 'pants'].forEach(type => {
    const btn = document.createElement('button');
    btn.className = 'silhouette-btn';
    btn.dataset.shape = type;
    btn.setAttribute('aria-label', `Select ${type} silhouette`);
    btn.innerHTML = `
      ${SILHOUETTES[type]}
      <span class="silhouette-label">${type.charAt(0).toUpperCase() + type.slice(1)}</span>`;
    btn.addEventListener('click', () => selectSilhouette(type));
    grid.appendChild(btn);
  });
}

async function selectSilhouette(shape) {
  if (!state.fabricResult) return;

  // Update button states
  document.querySelectorAll('.silhouette-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.shape === shape);
  });

  state.selectedShape = shape;
  state.fitAdvice = null;
  state.yardageResult = null;
  state.measureResult = null;

  // Show preview section, start loading fit advice
  const previewSection = $('preview-section');
  reveal(previewSection);

    renderGarmentPreview(shape);
    setWizardStep(2);

  // Hide downstream sections
  hide($('fit-advice-card'));
  hide($('yardage-section'));
  hide($('diagram-section'));

  // Fit advice loading
  const adviceLoading = $('advice-loading');
  const adviceCard = $('fit-advice-card');
  const adviceError = $('advice-error-slot');

  show(adviceLoading);
  hide(adviceCard);
  clearError(adviceError);

  previewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const r = state.fabricResult;
    const advice = await callFitAdvice(r.fabric_type, r.drape, shape);
    state.fitAdvice = advice;

    hide(adviceLoading);
    renderFitAdvice(advice);
    reveal(adviceCard);
    reveal($('yardage-section'));
    setWizardStep(3);
  } catch (err) {
    console.error('Call 2 error:', err);
    hide(adviceLoading);
    renderError(adviceError, () => selectSilhouette(shape));
  }
}

function renderGarmentPreview(shape) {
  const wrap = $('garment-preview-wrap');
  if (!wrap) return;

  const imgSrc = state.photoDataUrl;
  const clipId = `fabric-clip-${shape}`;

  // Build inline SVG with clip-path to fill the garment shape with the fabric photo
  const svgContent = buildPreviewSVG(shape, clipId, imgSrc);
  wrap.innerHTML = svgContent;
}

function buildPreviewSVG(shape, clipId, imgSrc) {
  // Garment paths as clip-path shapes (viewBox 0 0 200 240 normalized)
  const CLIP_PATHS = {
    shirt: `M70,25 L25,70 L25,90 L55,100 L55,220 L145,220 L145,100 L175,90 L175,70 L130,25
            Q110,15 100,20 Q90,15 70,25 Z`,
    kurta: `M70,25 L20,80 L20,100 L55,110 L50,240 L75,240 L75,220 L125,220 L125,240 L150,240
            L145,110 L180,100 L180,80 L130,25 Q110,15 100,20 Q90,15 70,25 Z`,
    dress: `M75,20 Q100,10 125,20 L140,45 L140,60 L130,70 L134,125 Q155,175 165,265
            L35,265 Q45,175 66,125 L70,70 L60,60 L60,45 Z`,
    pants: `M40,20 L160,20 L160,32 L158,125 Q162,160 145,170 L100,170 L55,170
            Q38,160 42,125 L40,32 Z
            M100,170 L60,170 L55,240 L95,240 Z
            M100,170 L140,170 L145,240 L105,240 Z`,
  };

  const path = CLIP_PATHS[shape] || CLIP_PATHS.shirt;

  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 270" width="280" style="max-width:100%">
      <defs>
        <clipPath id="${clipId}">
          <path d="${path}"/>
        </clipPath>
        <pattern id="fabric-pat-${shape}" patternUnits="objectBoundingBox" width="1" height="1">
          <image href="${imgSrc}" x="0" y="0" width="200" height="270"
                 preserveAspectRatio="xMidYMid slice"/>
        </pattern>
      </defs>

      <!-- Fabric fill clipped to garment shape -->
      <rect x="0" y="0" width="200" height="270"
            fill="url(#fabric-pat-${shape})"
            clip-path="url(#${clipId})"
            opacity="0.88"/>

      <!-- Garment outline on top -->
      <path d="${path}"
            fill="none"
            stroke="#1a1a18"
            stroke-width="1.8"
            stroke-linejoin="round"
            stroke-linecap="round"/>
    </svg>`;
}

function renderFitAdvice(advice) {
  const card = $('fit-advice-card');
  if (!card) return;

  const vc = verdictClass(advice.verdict);
  const ve = verdictEmoji(advice.verdict);

  card.innerHTML = `
    <span class="verdict-tag ${vc}">
      <span class="verdict-dot"></span>
      ${ve} ${escapeHTML(advice.verdict || 'Unknown')}
    </span>
    <div class="advice-reason">${advice.reason || '—'}</div>
    <div class="advice-tip"><span aria-hidden="true">→</span> ${escapeHTML(advice.tip || '—')}</div>
  `;
}

// ── Screen 3: Yardage ─────────────────────────────────────────
function setupYardageScreen() {
  const estimateBtn = $('estimate-btn');
  if (!estimateBtn) return;

  const widthSelect = $('width-select');
  document.querySelectorAll('.width-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      if (!widthSelect) return;
      widthSelect.value = pill.dataset.width;
      document.querySelectorAll('.width-pill').forEach(item => item.classList.toggle('is-selected', item === pill));
    });
  });

  estimateBtn.addEventListener('click', async () => {
    if (!state.fabricResult || !state.selectedShape) return;

    const size   = $('size-select').value;
    const width  = $('width-select').value;
    const drape  = state.fabricResult.drape;
    const garment = state.selectedShape;

    const loadingEl   = $('yardage-loading');
    const resultEl    = $('yardage-result-card');
    const errorSlot   = $('yardage-error-slot');
    const diagramSect = $('diagram-section');

    show(loadingEl);
    hide(resultEl);
    clearError(errorSlot);
    hide(diagramSect);
    estimateBtn.disabled = true;

    try {
      const r = await callYardage(garment, size, width, drape);
      state.yardageResult = r;
      state.measureResult = null;

      hide(loadingEl);
      renderYardageResult(r);
      reveal(resultEl);
      reveal(diagramSect);
      setWizardStep(4);
    } catch (err) {
      console.error('Call 3 error:', err);
      hide(loadingEl);
      renderError(errorSlot, () => estimateBtn.click());
    } finally {
      estimateBtn.disabled = false;
    }
  });
}

function renderYardageResult(r) {
  const card = $('yardage-result-card');
  if (!card) return;
  card.innerHTML = `
    <div class="yardage-length">${escapeHTML(r.length_needed || '—')}</div>
    <div class="yardage-buffer">${escapeHTML(r.buffer_note || '')}</div>
    <div class="tip-chip">
      <span class="tip-icon" aria-hidden="true">✂</span>
      <span>${escapeHTML(r.cutting_tip || '')}</span>
    </div>
    <p class="disclaimer mt-10">Standard size reference — not a custom fit calculation.</p>
  `;
}

// ── Screen 4: Cutting diagram ─────────────────────────────────
function setupDiagramScreen() {
  const showBtn = $('show-diagram-btn');
  if (!showBtn) return;

  showBtn.addEventListener('click', async () => {
    if (!state.selectedShape) return;

    const garment  = state.selectedShape;
    const size     = $('size-select').value;
    const loadingEl  = $('diagram-loading');
    const diagramEl  = $('diagram-content');
    const errorSlot  = $('diagram-error-slot');

    show(loadingEl);
    hide(diagramEl);
    clearError(errorSlot);
    showBtn.disabled = true;

    try {
      const r = await callPatternMeasurements(garment, size);
      state.measureResult = r;
      hide(loadingEl);
      await renderDiagram(garment, r);
      reveal(diagramEl);
      diagramEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      console.error('Call 4 error:', err);
      hide(loadingEl);
      renderError(errorSlot, () => showBtn.click());
    } finally {
      showBtn.disabled = false;
    }
  });
}

async function renderDiagram(garment, measureData) {
  const container = $('pattern-svg-container');
  if (!container) return;

  // Load the matching SVG template
  const svgFile = `pattern-${garment}.svg`;
  let svgText;
  try {
    const res = await fetch(svgFile);
    if (!res.ok) throw new Error(`SVG fetch failed: ${res.status}`);
    svgText = await res.text();
  } catch (err) {
    throw new Error(`Could not load pattern SVG: ${err.message}`);
  }

  container.innerHTML = svgText;
  const svgEl = container.querySelector('svg');
  if (!svgEl) return;

  // Inject measurements into anchor text elements
  const anchors = ANCHOR_MAP[garment] || [];
  const measurements = measureData.measurements || {};
  const unit = measureData.unit || '';

  anchors.forEach(key => {
    const el = svgEl.querySelector(`#anchor-${key}`);
    if (!el) return;
    const val = measurements[key];
    if (val === undefined || val === null) return;
    // Append the value to the label text
    const currentText = el.textContent.replace(/—[^—]*—/g, '').replace(/^—\s*|\s*—$/g, '').trim();
    const labelBase = currentText || key.replace(/_/g, ' ');
    el.textContent = `${labelBase}: ${val} ${unit}`;
    const ns = 'http://www.w3.org/2000/svg';
    const chip = document.createElementNS(ns, 'rect');
    chip.setAttribute('data-measure-chip', key);
    chip.setAttribute('x', Number(el.getAttribute('x') || 0) - 8);
    chip.setAttribute('y', Number(el.getAttribute('y') || 0) - 13);
    chip.setAttribute('width', Math.max(76, el.textContent.length * 6.2 + 16));
    chip.setAttribute('height', '20');
    chip.setAttribute('rx', '10');
    chip.setAttribute('fill', '#FAF8F5');
    chip.setAttribute('stroke', '#E5DED7');
    chip.setAttribute('stroke-width', '0.8');
    el.parentNode.insertBefore(chip, el);
  });

  // Render seam note and general note below diagram
  const metaEl = $('diagram-meta');
  if (metaEl) {
    metaEl.innerHTML = `
      <span class="pattern-meta-item">Seam · ${escapeHTML(measureData.seam_allowance || '')}</span>
      <span class="pattern-meta-item">💬 ${measureData.note || ''}</span>
      <span class="pattern-meta-item">Standard size reference only</span>
    `;
  }
}

// ── Error rendering helpers ───────────────────────────────────
function renderError(slot, retryFn, message = 'Something went wrong. Please try again.') {
  if (!slot) return;
  slot.classList.remove('hidden');
  slot.innerHTML = `
    <div class="error-card">
   <p>\${escapeHTML(message)}</p>
   <button class="btn btn-outline" id="retry-${Date.now()}" style="width:auto;padding:10px 20px">
        Retry
      </button>
    </div>`;
  slot.querySelector('button').addEventListener('click', () => {
    clearError(slot);
    retryFn();
  });
}

function clearError(slot) {
  if (slot) { slot.innerHTML = ''; slot.classList.add('hidden'); }
}

// ── Init ──────────────────────────────────────────────────────
const RELEASE_REPO = 'Devil1716/drapesense';

function isNewerVersion(latest, current) {
  const latestParts = String(latest).split('.').map(Number);
  const currentParts = String(current).split('.').map(Number);
  for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i += 1) {
    const latestPart = latestParts[i] || 0;
    const currentPart = currentParts[i] || 0;
    if (latestPart > currentPart) return true;
    if (latestPart < currentPart) return false;
  }
  return false;
}

function showUpdateBanner(newVersion, releaseUrl) {
  if (document.querySelector('.update-banner')) return;
  const banner = document.createElement('div');
  banner.className = 'update-banner';
  banner.innerHTML = `
    <span>A new version (v${escapeHTML(newVersion)}) is available.</span>
    <a href="${escapeHTML(releaseUrl)}" target="_blank" rel="noopener">Update</a>
    <button class="dismiss-btn" type="button" aria-label="Dismiss">×</button>`;
  banner.querySelector('.dismiss-btn').addEventListener('click', () => banner.remove());
  document.body.prepend(banner);
}

async function checkForUpdate() {
  if (typeof APP_VERSION === 'undefined') return;
  try {
    const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return;
    const data = await res.json();
    const latestVersion = String(data.tag_name || '').replace(/^v/, '');
    if (latestVersion && isNewerVersion(latestVersion, APP_VERSION)) showUpdateBanner(latestVersion, data.html_url);
  } catch (_) {
    // Update checks are best-effort and never block the app.
  }
}

document.addEventListener('DOMContentLoaded', () => {
  setupWizardUI();
  setupScanScreen();
  setupSilhouetteScreen();
  setupYardageScreen();
  setupDiagramScreen();
});

window.addEventListener('load', checkForUpdate);
