/* =============================================================
   IMAGEEASE — APPLICATION LOGIC
   Sections:
   0  State & constants
   1  Utilities (toast, formatting, unit conversion)
   2  Theme
   3  Navigation (navbar / mobile menu / smooth scroll)
   4  Upload & drag-drop
   5  Image loading & history (undo/redo/reset/compare)
   6  Tool registry & tool nav / search / recent / grid
   7  Tool panel rendering
   8  Tool implementations
   9  Crop interaction
   10 Download system
   11 Init
   ============================================================= */

"use strict";

/* ---------- 0. STATE & CONSTANTS ---------- */

const MAX_DIMENSION = 4000; // guard against browser crashes on huge images
const MAX_HISTORY = 20;
const RECENT_TOOLS_KEY = "pixelease_recent_tools";
const THEME_KEY = "pixelease_theme";

const state = {
  originalImage: null,      // HTMLImageElement, never mutated
  originalMeta: null,       // { name, size, type }
  history: [],               // array of ImageData snapshots
  historyIndex: -1,
  currentTool: null,
  outputFormat: "jpeg",     // jpeg | png | webp  (working export format)
  comparing: false,
  cropState: null,
  dpiHint: null,             // set when a physical-size operation is used
};

const canvas = document.getElementById("mainCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

/* ---------- 1. UTILITIES ---------- */

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

function showToast(message, type = "default") {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = "toast" + (type !== "default" ? ` toast-${type}` : "");
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 200ms ease";
    setTimeout(() => toast.remove(), 220);
  }, 2600);
}

function showProcessing(label) {
  const overlay = document.getElementById("processingOverlay");
  document.getElementById("processingLabel").textContent = label || "Processing image…";
  overlay.hidden = false;
}
function hideProcessing() {
  document.getElementById("processingOverlay").hidden = true;
}

// Run heavy work on next frame so the loading overlay can paint first.
function runAsync(label, fn) {
  showProcessing(label);
  return new Promise((resolve) => {
    setTimeout(() => {
      try {
        fn();
      } finally {
        hideProcessing();
        resolve();
      }
    }, 30);
  });
}

function cmToPixels(cm, dpi) { return Math.round((cm / 2.54) * dpi); }
function mmToPixels(mm, dpi) { return Math.round((mm / 25.4) * dpi); }
function inchToPixels(inch, dpi) { return Math.round(inch * dpi); }

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

/* ---------- 2. THEME ---------- */

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const toggle = document.getElementById("themeToggle");
  toggle.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  toggle.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
  localStorage.setItem(THEME_KEY, theme);
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) {
    applyTheme(saved);
  } else {
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(prefersDark ? "dark" : "light");
  }
  document.getElementById("themeToggle").addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "dark" ? "light" : "dark");
  });
}

/* ---------- 3. NAVIGATION ---------- */

function initNav() {
  const hamburger = document.getElementById("hamburgerBtn");
  const mobileMenu = document.getElementById("mobileMenu");

  hamburger.addEventListener("click", () => {
    const open = mobileMenu.classList.toggle("open");
    mobileMenu.hidden = !open;
    hamburger.setAttribute("aria-expanded", String(open));
  });

  document.querySelectorAll(".mobile-link").forEach((link) => {
    link.addEventListener("click", () => {
      mobileMenu.classList.remove("open");
      mobileMenu.hidden = true;
      hamburger.setAttribute("aria-expanded", "false");
    });
  });

  const navLinks = document.querySelectorAll(".nav-link");
  const sections = ["home", "tools", "about"].map((id) => document.getElementById(id));
  const setActive = (id) => {
    navLinks.forEach((l) => l.classList.toggle("active", l.dataset.nav === id));
  };
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) setActive(entry.target.id);
      });
    },
    { rootMargin: "-40% 0px -50% 0px" }
  );
  sections.forEach((s) => s && observer.observe(s));
}

/* ---------- 4. UPLOAD & DRAG-DROP ---------- */

const SUPPORTED_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

function initUpload() {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const chooseBtn = document.getElementById("chooseFileBtn");
  const errorBox = document.getElementById("uploadError");

  const openPicker = (e) => {
    if (e) e.stopPropagation();
    fileInput.click();
  };

  dropzone.addEventListener("click", openPicker);
  chooseBtn.addEventListener("click", openPicker);
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); }
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
    fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.remove("dragover");
    });
  });
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  function handleFile(file) {
    errorBox.hidden = true;
    if (!SUPPORTED_TYPES.includes(file.type)) {
      showUploadError("Please choose a valid JPG, PNG, or WEBP image.");
      return;
    }
    const maxBytes = 40 * 1024 * 1024;
    if (file.size > maxBytes) {
      showUploadError("That file is too large. Please choose an image under 40 MB.");
      return;
    }
    loadImage(file);
  }

  function showUploadError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = false;
    showToast(msg, "error");
  }
}

/* ---------- 5. IMAGE LOADING & HISTORY ---------- */

function loadImage(file) {
  showProcessing("Loading your image…");
  const objectUrl = URL.createObjectURL(file);
  const img = new Image();

  img.onload = () => {
    URL.revokeObjectURL(objectUrl);

    let w = img.naturalWidth;
    let h = img.naturalHeight;

    if (w === 0 || h === 0) {
      hideProcessing();
      showToast("This file could not be read as an image.", "error");
      return;
    }

    // Guard against extreme dimensions that could crash the browser.
    if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
      const scale = MAX_DIMENSION / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }

    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    state.originalImage = img;
    state.originalMeta = { name: file.name, size: file.size, type: file.type };
    state.outputFormat = file.type.includes("png") ? "png" : file.type.includes("webp") ? "webp" : "jpeg";
    state.dpiHint = null;

    state.history = [ctx.getImageData(0, 0, w, h)];
    state.historyIndex = 0;

    document.getElementById("uploadSection").hidden = true;
    document.getElementById("editorSection").hidden = false;

    updateEditorMeta();
    updateUndoRedoButtons();
    renderToolList();
    renderRecentTools();
    switchTool(null);

    hideProcessing();
    showToast("Image loaded.", "success");
    flashUploadSuccessBadge();
    scrollEditorIntoViewIfNeeded();
  };

  img.onerror = () => {
    URL.revokeObjectURL(objectUrl);
    hideProcessing();
    showToast("This file could not be read as an image. Please try another file.", "error");
  };

  img.src = objectUrl;
}

// Briefly flash a "✓ Image uploaded" badge in the editor topbar so the
// upload feels confirmed even before the user looks at the preview.
function flashUploadSuccessBadge() {
  const badge = document.getElementById("uploadSuccessBadge");
  if (!badge) return;
  badge.hidden = false;
  // Restart the CSS fade animation each time.
  badge.style.animation = "none";
  void badge.offsetWidth;
  badge.style.animation = "";
  setTimeout(() => { badge.hidden = true; }, 2700);
}

// Desktop: only scroll if the editor isn't already comfortably in view
// (avoids an unnecessary jump). Mobile: always smooth-scroll so the
// preview is reachable without hunting for it.
function scrollEditorIntoViewIfNeeded() {
  const section = document.getElementById("editorSection");
  if (!section) return;
  const isMobile = window.matchMedia("(max-width: 860px)").matches;
  const rect = section.getBoundingClientRect();
  const alreadyVisible = rect.top >= 0 && rect.top < window.innerHeight * 0.4;
  if (isMobile || !alreadyVisible) {
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function pushHistory(imageData) {
  // Drop any redo states beyond current index.
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(imageData);
  if (state.history.length > MAX_HISTORY) {
    state.history.shift();
  } else {
    state.historyIndex++;
  }
  if (state.history.length === MAX_HISTORY) state.historyIndex = state.history.length - 1;
  updateUndoRedoButtons();
  updateEditorMeta();
}

function commitCurrentCanvas() {
  pushHistory(ctx.getImageData(0, 0, canvas.width, canvas.height));
}

function renderFromImageData(data) {
  canvas.width = data.width;
  canvas.height = data.height;
  ctx.putImageData(data, 0, 0);
}

function undo() {
  if (state.historyIndex <= 0) return;
  state.historyIndex--;
  renderFromImageData(state.history[state.historyIndex]);
  updateUndoRedoButtons();
  updateEditorMeta();
}

function redo() {
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex++;
  renderFromImageData(state.history[state.historyIndex]);
  updateUndoRedoButtons();
  updateEditorMeta();
}

function resetEditor() {
  if (!state.originalImage) return;
  const img = state.originalImage;
  let w = img.naturalWidth, h = img.naturalHeight;
  if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
    const scale = MAX_DIMENSION / Math.max(w, h);
    w = Math.round(w * scale); h = Math.round(h * scale);
  }
  canvas.width = w; canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  state.history = [ctx.getImageData(0, 0, w, h)];
  state.historyIndex = 0;
  state.dpiHint = null;
  updateUndoRedoButtons();
  updateEditorMeta();
  showToast("Image reset to original.");
}

function updateUndoRedoButtons() {
  document.getElementById("undoBtn").disabled = state.historyIndex <= 0;
  document.getElementById("redoBtn").disabled = state.historyIndex >= state.history.length - 1;
}

function updateEditorMeta() {
  document.getElementById("editorFileName").textContent = state.originalMeta ? state.originalMeta.name : "";
  estimateCurrentBlobSize().then((bytes) => {
    const w = canvas.width, h = canvas.height;
    document.getElementById("editorFileMeta").textContent = `${w} × ${h} px · ${formatBytes(bytes)}`;
    document.getElementById("previewStats").textContent =
      `${w} × ${h} px · ${state.outputFormat.toUpperCase()} · ${formatBytes(bytes)}`;
  });
  // Refresh Image Info panel if open.
  if (state.currentTool === "info") renderInfoPanel();
}

function estimateCurrentBlobSize(quality = 0.92) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob ? blob.size : 0), mimeFor(state.outputFormat), quality);
  });
}

function mimeFor(fmt) {
  if (fmt === "png") return "image/png";
  if (fmt === "webp") return "image/webp";
  return "image/jpeg";
}

/* Undo/Redo/Reset/Compare/New-image button wiring */
function initEditorToolbar() {
  document.getElementById("undoBtn").addEventListener("click", undo);
  document.getElementById("redoBtn").addEventListener("click", redo);
  document.getElementById("resetBtn").addEventListener("click", resetEditor);
  document.getElementById("newImageBtn").addEventListener("click", () => {
    document.getElementById("editorSection").hidden = true;
    document.getElementById("uploadSection").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  const compareBtn = document.getElementById("compareBtn");
  const badge = document.getElementById("compareBadge");
  const showOriginal = () => {
    if (!state.history.length) return;
    state.comparing = true;
    const orig = state.history[0];
    ctx.save();
    canvas.width = orig.width; canvas.height = orig.height;
    ctx.putImageData(orig, 0, 0);
    ctx.restore();
    badge.hidden = false;
  };
  const showCurrent = () => {
    if (!state.comparing) return;
    state.comparing = false;
    renderFromImageData(state.history[state.historyIndex]);
    badge.hidden = true;
  };
  compareBtn.addEventListener("mousedown", showOriginal);
  compareBtn.addEventListener("touchstart", (e) => { e.preventDefault(); showOriginal(); }, { passive: false });
  ["mouseup", "mouseleave"].forEach((evt) => compareBtn.addEventListener(evt, showCurrent));
  compareBtn.addEventListener("touchend", showCurrent);

  document.addEventListener("keydown", (e) => {
    if (document.getElementById("editorSection").hidden) return;
    const meta = e.ctrlKey || e.metaKey;
    if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    if (meta && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
  });
}

/* ---------- 6. TOOL REGISTRY ---------- */

const TOOLS = [
  { id: "resize", category: "Basic", name: "Resize Image", short: "Change width and height.", desc: "Change the width and height of your image.", icon: iconResize() },
  { id: "resizeCm", category: "Basic", name: "Resize by CM", short: "Resize using real-world units.", desc: "Resize your image using centimeters, millimeters or inches, converted using your chosen DPI.", icon: iconRuler() },
  { id: "compress", category: "Basic", name: "Compress Image", short: "Shrink file size to a target KB.", desc: "Reduce the file size while keeping the image looking good.", icon: iconCompress() },
  { id: "crop", category: "Basic", name: "Crop Image", short: "Cut out part of the image.", desc: "Select an area of your image to keep.", icon: iconCrop() },
  { id: "rotate", category: "Basic", name: "Rotate Image", short: "Turn the image 90° or 180°.", desc: "Rotate your image clockwise or counter-clockwise.", icon: iconRotate() },
  { id: "flip", category: "Basic", name: "Flip Image", short: "Mirror horizontally or vertically.", desc: "Flip your image along the horizontal or vertical axis.", icon: iconFlip() },
  { id: "convert", category: "Basic", name: "Convert Format", short: "Switch between JPG, PNG, WEBP.", desc: "Change the format your image will be saved as.", icon: iconConvert() },
  { id: "quality", category: "Basic", name: "Image Quality", short: "Adjust compression quality.", desc: "Control how much detail is kept when saving.", icon: iconQuality() },
  { id: "brightness", category: "Adjust", name: "Brightness", short: "Make the image lighter or darker.", desc: "Adjust how light or dark your image looks.", icon: iconBrightness() },
  { id: "contrast", category: "Adjust", name: "Contrast", short: "Adjust light and dark difference.", desc: "Adjust the difference between light and dark areas.", icon: iconContrast() },
  { id: "saturation", category: "Adjust", name: "Saturation", short: "Adjust color intensity.", desc: "Make colors more vivid or more muted.", icon: iconSaturation() },
  { id: "grayscale", category: "Adjust", name: "Grayscale", short: "Remove color from the image.", desc: "Convert your image to black and white.", icon: iconGrayscale() },
  { id: "blur", category: "Filters", name: "Blur", short: "Soften the image.", desc: "Soften details across the whole image.", icon: iconBlur() },
  { id: "sharpen", category: "Filters", name: "Sharpen", short: "Enhance edges and detail.", desc: "Make edges and details stand out more clearly.", icon: iconSharpen() },
  { id: "text", category: "Effects", name: "Add Text", short: "Place custom text on the image.", desc: "Add a caption, label or title to your image.", icon: iconText() },
  { id: "watermark", category: "Effects", name: "Add Watermark", short: "Overlay a logo or text mark.", desc: "Protect or brand your image with a watermark.", icon: iconWatermark() },
  { id: "background", category: "Effects", name: "Background Color", short: "Fill transparent areas.", desc: "Add a background color, especially useful for transparent PNGs.", icon: iconBackground() },
  { id: "metadata", category: "Utilities", name: "Remove Metadata", short: "Export a clean copy.", desc: "Create a version of your image without embedded camera or file metadata.", icon: iconMetadata() },
  { id: "info", category: "Utilities", name: "Image Information", short: "View technical details.", desc: "See size, dimensions, format and other details about your image.", icon: iconInfo() },
  { id: "presets", category: "Utilities", name: "Signature / Document Presets", short: "Ready-made sizes for signatures & IDs.", desc: "Quickly resize and compress for signatures, passport photos or a custom target.", icon: iconPreset() },

  /* -------- extended tool set -------- */
  { id: "sepia", category: "Filters", name: "Sepia Filter", short: "Vintage warm-toned look.", desc: "Apply a classic vintage sepia tone to your photo.", icon: iconSepia() },
  { id: "invert", category: "Filters", name: "Invert Colors", short: "Flip colors to a negative.", desc: "Invert the red, green and blue channels for a negative effect.", icon: iconInvert() },
  { id: "threshold", category: "Filters", name: "B&W Threshold", short: "Pure black-and-white cutoff.", desc: "Convert every pixel to pure black or white based on a brightness cutoff.", icon: iconThreshold() },
  { id: "vignette", category: "Filters", name: "Vignette", short: "Darken the edges.", desc: "Darken the corners to draw attention toward the center.", icon: iconVignette() },
  { id: "pixelate", category: "Filters", name: "Pixelate", short: "Blocky, mosaic look.", desc: "Apply a retro, blocky mosaic effect.", icon: iconPixelate() },
  { id: "posterize", category: "Filters", name: "Posterize", short: "Fewer color tones.", desc: "Reduce the number of tones for a flat, poster-like look.", icon: iconPosterize() },
  { id: "emboss", category: "Filters", name: "Emboss", short: "Stamped, relief look.", desc: "Give your image a raised, stamped relief effect.", icon: iconEmboss() },
  { id: "edgeDetect", category: "Filters", name: "Edge Detection", short: "Extract outlines.", desc: "Highlight the outlines and edges in your image.", icon: iconEdge() },
  { id: "tint", category: "Filters", name: "Color Tint", short: "Wash the image in one color.", desc: "Apply a color tint over the whole image.", icon: iconTint() },
  { id: "exposure", category: "Adjust", name: "Exposure", short: "Adjust overall brightness.", desc: "Brighten or darken the overall exposure of your photo.", icon: iconExposure() },
  { id: "temperature", category: "Adjust", name: "Color Temperature", short: "Warm up or cool down.", desc: "Shift the white balance warmer or cooler.", icon: iconTemperature() },
  { id: "hue", category: "Adjust", name: "Hue Shift", short: "Rotate all colors.", desc: "Rotate every color around the color wheel.", icon: iconHue() },
  { id: "gamma", category: "Adjust", name: "Gamma Correction", short: "Adjust midtone brightness.", desc: "Fine-tune midtone brightness without blowing out highlights or shadows.", icon: iconGamma() },
  { id: "vibrance", category: "Adjust", name: "Vibrance", short: "Smart color boost.", desc: "Boost muted colors while keeping already-vivid colors and skin tones natural.", icon: iconVibrance() },
  { id: "border", category: "Effects", name: "Border Frame", short: "Add a solid-color border.", desc: "Add a clean, solid-color border around your image.", icon: iconBorder() },
  { id: "roundedCorners", category: "Effects", name: "Rounded Corners", short: "Round off the corners.", desc: "Round the corners of your image, with a transparent background.", icon: iconRounded() },
  { id: "dropShadow", category: "Effects", name: "Drop Shadow", short: "Soft shadow beneath the image.", desc: "Add a soft drop shadow under your image on a padded canvas.", icon: iconShadow() },
  { id: "mirror", category: "Effects", name: "Mirror Effect", short: "Mirror one half onto the other.", desc: "Mirror the left half onto the right, or the top half onto the bottom.", icon: iconMirror() },
  { id: "noise", category: "Filters", name: "Film Grain", short: "Subtle analog grain.", desc: "Add a subtle grainy, analog film texture.", icon: iconNoise() },
  { id: "duotone", category: "Filters", name: "Duotone", short: "Two-color grade.", desc: "Map shadows and highlights to two colors you choose.", icon: iconDuotone() },
  { id: "aspectRatio", category: "Effects", name: "Aspect Ratio Presets", short: "Fit to Square, Story or Post.", desc: "Fit your image to a common social-media aspect ratio.", icon: iconAspect() },
  { id: "centerCanvas", category: "Effects", name: "Center on Canvas", short: "Add padding around the image.", desc: "Center your image inside a larger, padded canvas.", icon: iconCenter() },
];

const CATEGORY_ORDER = ["Basic", "Adjust", "Filters", "Effects", "Utilities"];

function renderToolList() {
  const list = document.getElementById("toolList");
  list.innerHTML = "";
  CATEGORY_ORDER.forEach((cat) => {
    const toolsInCat = TOOLS.filter((t) => t.category === cat);
    if (toolsInCat.length === 0) return;
    const label = document.createElement("p");
    label.className = "tool-group-label tool-category-label";
    label.textContent = cat;
    list.appendChild(label);
    toolsInCat.forEach((tool) => list.appendChild(buildToolItem(tool)));
  });
}

function buildToolItem(tool) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tool-item";
  btn.dataset.tool = tool.id;
  btn.innerHTML = `<span class="tool-icon">${tool.icon}</span><span>${tool.name}</span>`;
  btn.addEventListener("click", () => switchTool(tool.id));
  return btn;
}

function renderToolsGrid(activeCategory = "All") {
  const grid = document.getElementById("toolsGrid");
  grid.innerHTML = "";
  const countEl = document.getElementById("toolsCountSubtitle");
  if (countEl) {
    countEl.textContent = `${TOOLS.length} browser-based tools for resizing, compressing, editing and converting your images — most with live preview.`;
  }
  const visible = activeCategory === "All" ? TOOLS : TOOLS.filter((t) => t.category === activeCategory);
  visible.forEach((tool) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "tool-card";
    card.innerHTML = `<div class="tool-card-icon">${tool.icon}</div><h3>${tool.name}</h3><p>${tool.short}</p>`;
    card.addEventListener("click", () => {
      if (!state.originalImage) {
        document.getElementById("uploadSection").scrollIntoView({ behavior: "smooth" });
        showToast("Choose an image first, then pick this tool.");
        return;
      }
      document.getElementById("editorSection").scrollIntoView({ behavior: "smooth" });
      switchTool(tool.id);
    });
    grid.appendChild(card);
  });
}

function initToolsGridFilter() {
  const wrap = document.getElementById("toolsGridFilters");
  if (!wrap) return;
  wrap.innerHTML = "";
  ["All", ...CATEGORY_ORDER].forEach((cat) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "category-chip" + (cat === "All" ? " active" : "");
    chip.textContent = cat;
    chip.addEventListener("click", () => {
      wrap.querySelectorAll(".category-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      renderToolsGrid(cat);
    });
    wrap.appendChild(chip);
  });
}

function initToolSearch() {
  const input = document.getElementById("toolSearch");
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    const list = document.getElementById("toolList");
    list.innerHTML = "";
    if (!q) { renderToolList(); return; }
    const matches = TOOLS.filter((t) => t.name.toLowerCase().includes(q) || t.short.toLowerCase().includes(q));
    if (matches.length === 0) {
      const empty = document.createElement("p");
      empty.className = "tool-item-empty";
      empty.textContent = "No tools found.";
      list.appendChild(empty);
      return;
    }
    matches.forEach((tool) => list.appendChild(buildToolItem(tool)));
    // re-mark active
    if (state.currentTool) {
      const el = list.querySelector(`[data-tool="${state.currentTool}"]`);
      if (el) el.classList.add("active");
    }
  });
}


function loadRecentTools() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_TOOLS_KEY) || "[]");
  } catch { return []; }
}
function saveRecentTool(toolId) {
  let recent = loadRecentTools().filter((id) => id !== toolId);
  recent.unshift(toolId);
  recent = recent.slice(0, 5);
  localStorage.setItem(RECENT_TOOLS_KEY, JSON.stringify(recent));
  renderRecentTools();
}
function renderRecentTools() {
  const recent = loadRecentTools();
  const wrap = document.getElementById("toolRecent");
  const list = document.getElementById("toolRecentList");
  if (recent.length === 0) { wrap.hidden = true; return; }
  wrap.hidden = false;
  list.innerHTML = "";
  recent.forEach((id) => {
    const tool = TOOLS.find((t) => t.id === id);
    if (tool) list.appendChild(buildToolItem(tool));
  });
}

function switchTool(toolId) {
  state.currentTool = toolId;

  document.querySelectorAll(".tool-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.tool === toolId);
  });

  const emptyState = document.getElementById("toolPanelEmpty");
  document.querySelectorAll(".tool-panel-section").forEach((el) => el.classList.remove("active"));

  // exit crop mode when leaving crop tool
  if (toolId !== "crop") exitCropMode();

  if (!toolId) {
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;
  saveRecentTool(toolId);

  // Always rebuild: many panels snapshot the current canvas for live preview,
  // so a cached panel from an earlier visit could preview from a stale "before" state.
  const existing = document.getElementById("panel-" + toolId);
  if (existing) existing.remove();
  const section = buildToolPanel(toolId);
  document.getElementById("toolPanel").appendChild(section);
  section.classList.add("active");

  if (toolId === "info") renderInfoPanel();
  if (toolId === "crop") enterCropMode();
}

/* ---------- 7. TOOL PANEL BUILDER ---------- */

function panelShell(tool) {
  const section = document.createElement("div");
  section.className = "tool-panel-section";
  section.id = "panel-" + tool.id;
  section.innerHTML = `
    <div>
      <p class="tool-panel-title">${tool.name}</p>
      <p class="tool-panel-desc">${tool.desc}</p>
    </div>
  `;
  return section;
}

function field(labelText, inputHtml) {
  const row = document.createElement("div");
  row.className = "field-row";
  const id = "f_" + Math.random().toString(36).slice(2, 9);
  row.innerHTML = `<label for="${id}">${labelText}</label>`;
  const wrap = document.createElement("div");
  wrap.innerHTML = inputHtml;
  const input = wrap.firstElementChild;
  input.id = id;
  row.appendChild(input);
  return row;
}

function sliderField(labelText, min, max, value, unit = "") {
  const row = document.createElement("div");
  row.className = "slider-row";
  const id = "s_" + Math.random().toString(36).slice(2, 9);
  row.innerHTML = `
    <div class="slider-label-line"><span>${labelText}</span><span id="${id}_val">${value}${unit}</span></div>
    <input type="range" id="${id}" min="${min}" max="${max}" value="${value}">
  `;
  return row;
}

function buildToolPanel(toolId) {
  const tool = TOOLS.find((t) => t.id === toolId);
  const section = panelShell(tool);
  const builders = {
    resize: buildResizePanel,
    resizeCm: buildResizeCmPanel,
    compress: buildCompressPanel,
    crop: buildCropPanel,
    rotate: buildRotatePanel,
    flip: buildFlipPanel,
    convert: buildConvertPanel,
    quality: buildQualityPanel,
    brightness: buildAdjustPanel("brightness", "Brightness", 100, 0, 200, "%"),
    contrast: buildAdjustPanel("contrast", "Contrast", 100, 0, 200, "%"),
    saturation: buildAdjustPanel("saturation", "Saturation", 100, 0, 200, "%"),
    grayscale: buildGrayscalePanel,
    blur: buildBlurPanel,
    sharpen: buildSharpenPanel,
    text: buildTextPanel,
    watermark: buildWatermarkPanel,
    background: buildBackgroundPanel,
    metadata: buildMetadataPanel,
    info: buildInfoPanel,
    presets: buildPresetsPanel,
    sepia: buildSepiaPanel,
    invert: buildInvertPanel,
    threshold: buildThresholdPanel,
    vignette: buildVignettePanel,
    pixelate: buildPixelatePanel,
    posterize: buildPosterizePanel,
    emboss: buildEmbossPanel,
    edgeDetect: buildEdgeDetectPanel,
    tint: buildTintPanel,
    exposure: buildAdjustPanel("brightness", "Exposure", 100, 40, 200, "%"),
    temperature: buildTemperaturePanel,
    hue: buildHuePanel,
    gamma: buildGammaPanel,
    vibrance: buildVibrancePanel,
    border: buildBorderPanel,
    roundedCorners: buildRoundedCornersPanel,
    dropShadow: buildDropShadowPanel,
    mirror: buildMirrorPanel,
    noise: buildNoisePanel,
    duotone: buildDuotonePanel,
    aspectRatio: buildAspectRatioPanel,
    centerCanvas: buildCenterCanvasPanel,
  };
  builders[toolId](section);
  return section;
}

/* ---------- 8. TOOL IMPLEMENTATIONS ---------- */

/* ---- 8.1 Resize (pixels / percentage) ---- */
function buildResizePanel(section) {
  const unitRow = document.createElement("div");
  unitRow.className = "segmented";
  unitRow.innerHTML = `<button type="button" class="active" data-unit="px">Pixels</button><button type="button" data-unit="pct">Percentage</button>`;
  section.appendChild(unitRow);

  const widthRow = field("Width (px)", `<input type="number" min="1" value="${canvas.width}">`);
  const heightRow = field("Height (px)", `<input type="number" min="1" value="${canvas.height}">`);
  const inlineWrap = document.createElement("div");
  inlineWrap.className = "field-inline";
  inlineWrap.append(widthRow, heightRow);
  section.appendChild(inlineWrap);

  const pctRow = field("Scale (%)", `<input type="number" min="1" max="500" value="100">`);
  pctRow.hidden = true;
  section.appendChild(pctRow);

  const lockRow = document.createElement("div");
  lockRow.className = "checkbox-row";
  lockRow.innerHTML = `<input type="checkbox" id="resizeLock" checked><label for="resizeLock">Maintain aspect ratio</label>`;
  section.appendChild(lockRow);

  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Resize";
  section.appendChild(applyBtn);

  const widthInput = widthRow.querySelector("input");
  const heightInput = heightRow.querySelector("input");
  const pctInput = pctRow.querySelector("input");
  const lockInput = lockRow.querySelector("input");
  const ratio = () => canvas.width / canvas.height;

  let mode = "px";
  unitRow.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      unitRow.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      mode = b.dataset.unit;
      inlineWrap.hidden = mode !== "px";
      pctRow.hidden = mode !== "pct";
    });
  });

  widthInput.addEventListener("input", () => {
    if (lockInput.checked) heightInput.value = Math.round(widthInput.value / ratio());
  });
  heightInput.addEventListener("input", () => {
    if (lockInput.checked) widthInput.value = Math.round(heightInput.value * ratio());
  });

  applyBtn.addEventListener("click", async () => {
    let w, h;
    if (mode === "pct") {
      const pct = parseFloat(pctInput.value) || 100;
      w = Math.round(canvas.width * (pct / 100));
      h = Math.round(canvas.height * (pct / 100));
    } else {
      w = parseInt(widthInput.value, 10);
      h = parseInt(heightInput.value, 10);
    }
    if (!w || !h || w < 1 || h < 1) { showToast("Please enter a valid width and height.", "error"); return; }
    await runAsync("Resizing image…", () => resizeImage(w, h));
    widthInput.value = canvas.width; heightInput.value = canvas.height;
    showToast(`Resized to ${w} × ${h} px.`, "success");
  });
}

function resizeImage(targetW, targetH) {
  const off = document.createElement("canvas");
  off.width = targetW; off.height = targetH;
  const offCtx = off.getContext("2d");
  offCtx.imageSmoothingEnabled = true;
  offCtx.imageSmoothingQuality = "high";
  offCtx.drawImage(canvas, 0, 0, targetW, targetH);
  canvas.width = targetW; canvas.height = targetH;
  ctx.clearRect(0, 0, targetW, targetH);
  ctx.drawImage(off, 0, 0);
  commitCurrentCanvas();
}

/* ---- 8.2 Resize by CM/MM/Inch ---- */
function buildResizeCmPanel(section) {
  const unitRow = field("Unit", `
    <select>
      <option value="cm">Centimeters</option>
      <option value="mm">Millimeters</option>
      <option value="in">Inches</option>
    </select>`);
  section.appendChild(unitRow);

  const wRow = field("Width", `<input type="number" min="0.1" step="0.1" value="10">`);
  const hRow = field("Height", `<input type="number" min="0.1" step="0.1" value="10">`);
  const inlineWrap = document.createElement("div");
  inlineWrap.className = "field-inline";
  inlineWrap.append(wRow, hRow);
  section.appendChild(inlineWrap);

  const dpiRow = field("DPI", `
    <select>
      <option value="72">72 DPI (screen)</option>
      <option value="96">96 DPI</option>
      <option value="150">150 DPI</option>
      <option value="200">200 DPI</option>
      <option value="300" selected>300 DPI (print)</option>
      <option value="600">600 DPI</option>
    </select>`);
  section.appendChild(dpiRow);

  const resultBox = document.createElement("div");
  resultBox.className = "result-box";
  section.appendChild(resultBox);

  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Resize";
  section.appendChild(applyBtn);

  const unitSelect = unitRow.querySelector("select");
  const wInput = wRow.querySelector("input");
  const hInput = hRow.querySelector("input");
  const dpiSelect = dpiRow.querySelector("select");

  function computePixels() {
    const dpi = parseInt(dpiSelect.value, 10);
    const unit = unitSelect.value;
    const wVal = parseFloat(wInput.value) || 0;
    const hVal = parseFloat(hInput.value) || 0;
    let pxW, pxH;
    if (unit === "cm") { pxW = cmToPixels(wVal, dpi); pxH = cmToPixels(hVal, dpi); }
    else if (unit === "mm") { pxW = mmToPixels(wVal, dpi); pxH = mmToPixels(hVal, dpi); }
    else { pxW = inchToPixels(wVal, dpi); pxH = inchToPixels(hVal, dpi); }
    resultBox.innerHTML = `<div class="row"><span>Pixel size</span><span>${pxW} × ${pxH} px</span></div>`;
    return { pxW, pxH, dpi };
  }
  [wInput, hInput, dpiSelect, unitSelect].forEach((el) => el.addEventListener("input", computePixels));
  computePixels();

  applyBtn.addEventListener("click", async () => {
    const { pxW, pxH, dpi } = computePixels();
    if (pxW < 1 || pxH < 1) { showToast("Please enter a valid size.", "error"); return; }
    await runAsync("Resizing image…", () => resizeByPhysicalSize(pxW, pxH, dpi));
    showToast(`Resized to ${pxW} × ${pxH} px at ${dpi} DPI.`, "success");
  });
}

function resizeByPhysicalSize(pxW, pxH, dpi) {
  resizeImage(pxW, pxH);
  state.dpiHint = dpi;
}

/* ---- 8.3 Compress to target KB ---- */
function buildCompressPanel(section) {
  const targetRow = field("Maximum file size (KB)", `<input type="number" min="1" value="100">`);
  section.appendChild(targetRow);
  const note = document.createElement("p");
  note.className = "tool-panel-desc";
  note.textContent = "Works best with JPG or WEBP. PNG compression is lossless, so very small targets may not be reachable.";
  section.appendChild(note);

  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Compress Image";
  section.appendChild(applyBtn);

  const resultBox = document.createElement("div");
  resultBox.className = "result-box";
  resultBox.hidden = true;
  section.appendChild(resultBox);

  const targetInput = targetRow.querySelector("input");

  applyBtn.addEventListener("click", async () => {
    const targetKB = parseFloat(targetInput.value);
    if (!targetKB || targetKB <= 0) { showToast("Please enter a valid target size.", "error"); return; }
    showProcessing("Compressing image…");
    const result = await compressImage(targetKB * 1024);
    hideProcessing();
    resultBox.hidden = false;
    resultBox.innerHTML = `
      <div class="row"><span>Resulting size</span><span>${formatBytes(result.size)}</span></div>
      <div class="row"><span>Quality used</span><span>${Math.round(result.quality * 100)}%</span></div>
      ${!result.reached ? `<div class="result-warning">Unable to reach the requested size without significant quality loss. This is the smallest result achieved.</div>` : ""}
    `;
    showToast(result.reached ? "Target size reached." : "Compressed as much as practical.", result.reached ? "success" : "default");
  });
}

function compressImage(targetBytes) {
  return new Promise((resolve) => {
    const fmt = state.outputFormat === "png" ? "jpeg" : state.outputFormat; // PNG can't be quality-compressed
    const mime = mimeFor(fmt);
    let quality = 0.92;
    const minQuality = 0.05;
    const step = 0.05;
    let lastBlob = null;
    let lastQuality = quality;

    function attempt() {
      canvas.toBlob((blob) => {
        if (!blob) { resolve({ size: 0, quality, reached: false }); return; }
        lastBlob = blob;
        lastQuality = quality;
        if (blob.size <= targetBytes || quality <= minQuality) {
          const reached = blob.size <= targetBytes;
          if (fmt !== state.outputFormat) state.outputFormat = fmt;
          finalize(blob, quality, reached);
          return;
        }
        quality = Math.max(minQuality, quality - step);
        attempt();
      }, mime, quality);
    }

    function finalize(blob, q, reached) {
      const fr = new FileReader();
      fr.onload = () => {
        const img = new Image();
        img.onload = () => {
          canvas.width = img.width; canvas.height = img.height;
          ctx.clearRect(0, 0, img.width, img.height);
          ctx.drawImage(img, 0, 0);
          commitCurrentCanvas();
          resolve({ size: blob.size, quality: q, reached });
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(blob);
    }

    attempt();
  });
}

/* ---- 8.4 Crop ---- (interaction lives in section 9) */
function buildCropPanel(section) {
  const modeRow = document.createElement("div");
  modeRow.className = "segmented";
  modeRow.innerHTML = `<button type="button" class="active" data-mode="free">Free</button><button type="button" data-mode="square">Square</button><button type="button" data-mode="custom">Custom</button>`;
  section.appendChild(modeRow);

  const customWrap = document.createElement("div");
  customWrap.className = "field-inline";
  customWrap.hidden = true;
  const cw = field("Width (px)", `<input type="number" min="1" value="200">`);
  const chh = field("Height (px)", `<input type="number" min="1" value="200">`);
  customWrap.append(cw, chh);
  section.appendChild(customWrap);

  const hint = document.createElement("p");
  hint.className = "tool-panel-desc";
  hint.textContent = "Drag the box on the preview to position it, then use the corner handles to resize.";
  section.appendChild(hint);

  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Crop";
  section.appendChild(applyBtn);

  modeRow.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      modeRow.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      customWrap.hidden = b.dataset.mode !== "custom";
      setCropMode(b.dataset.mode, {
        w: parseInt(cw.querySelector("input").value, 10),
        h: parseInt(chh.querySelector("input").value, 10),
      });
    });
  });
  [cw, chh].forEach((row) => row.querySelector("input").addEventListener("input", () => {
    if (!customWrap.hidden) {
      setCropMode("custom", {
        w: parseInt(cw.querySelector("input").value, 10),
        h: parseInt(chh.querySelector("input").value, 10),
      });
    }
  }));

  applyBtn.addEventListener("click", async () => {
    if (!state.cropState) { showToast("Adjust the crop box first.", "error"); return; }
    await runAsync("Cropping image…", () => cropImage(state.cropState.rect));
    showToast("Image cropped.", "success");
    exitCropMode();
    enterCropMode();
  });
}

function cropImage(rect) {
  const { x, y, w, h } = rect;
  const off = document.createElement("canvas");
  off.width = w; off.height = h;
  off.getContext("2d").drawImage(canvas, x, y, w, h, 0, 0, w, h);
  canvas.width = w; canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(off, 0, 0);
  commitCurrentCanvas();
}

/* ---- 8.5 Rotate ---- */
function buildRotatePanel(section) {
  const row = document.createElement("div");
  row.className = "btn-row";
  row.innerHTML = `
    <button class="btn btn-secondary" data-deg="-90">Rotate ⟲ 90°</button>
    <button class="btn btn-secondary" data-deg="90">Rotate ⟳ 90°</button>
    <button class="btn btn-secondary" data-deg="180" style="flex-basis:100%;">Rotate 180°</button>
  `;
  section.appendChild(row);
  row.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", async () => {
      await runAsync("Rotating image…", () => rotateImage(parseInt(b.dataset.deg, 10)));
      showToast("Image rotated.", "success");
    });
  });
}

function rotateImage(degrees) {
  const rad = (degrees * Math.PI) / 180;
  const swap = Math.abs(degrees) === 90 || Math.abs(degrees) === 270;
  const newW = swap ? canvas.height : canvas.width;
  const newH = swap ? canvas.width : canvas.height;
  const off = document.createElement("canvas");
  off.width = newW; off.height = newH;
  const offCtx = off.getContext("2d");
  offCtx.translate(newW / 2, newH / 2);
  offCtx.rotate(rad);
  offCtx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  canvas.width = newW; canvas.height = newH;
  ctx.clearRect(0, 0, newW, newH);
  ctx.drawImage(off, 0, 0);
  commitCurrentCanvas();
}

/* ---- 8.6 Flip ---- */
function buildFlipPanel(section) {
  const row = document.createElement("div");
  row.className = "btn-row";
  row.innerHTML = `
    <button class="btn btn-secondary" data-axis="h">Flip Horizontal</button>
    <button class="btn btn-secondary" data-axis="v">Flip Vertical</button>
  `;
  section.appendChild(row);
  row.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", async () => {
      await runAsync("Flipping image…", () => flipImage(b.dataset.axis));
      showToast("Image flipped.", "success");
    });
  });
}

function flipImage(axis) {
  const off = document.createElement("canvas");
  off.width = canvas.width; off.height = canvas.height;
  const offCtx = off.getContext("2d");
  if (axis === "h") { offCtx.translate(canvas.width, 0); offCtx.scale(-1, 1); }
  else { offCtx.translate(0, canvas.height); offCtx.scale(1, -1); }
  offCtx.drawImage(canvas, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(off, 0, 0);
  commitCurrentCanvas();
}

/* ---- 8.7 Convert format ---- */
function buildConvertPanel(section) {
  const row = field("Save as", `
    <select>
      <option value="jpeg">JPG</option>
      <option value="png">PNG</option>
      <option value="webp">WEBP</option>
    </select>`);
  section.appendChild(row);
  const note = document.createElement("p");
  note.className = "tool-panel-desc";
  note.textContent = "JPG does not support transparency — transparent areas will be filled white unless you set a background color first.";
  section.appendChild(note);

  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Convert";
  section.appendChild(applyBtn);

  const select = row.querySelector("select");
  select.value = state.outputFormat;

  applyBtn.addEventListener("click", async () => {
    await runAsync("Converting image…", () => convertFormat(select.value));
    showToast(`Converted to ${select.value.toUpperCase()}.`, "success");
    updateEditorMeta();
  });
}

function convertFormat(fmt) {
  if (fmt === "jpeg") {
    // Flatten transparency onto white for formats without alpha support.
    const off = document.createElement("canvas");
    off.width = canvas.width; off.height = canvas.height;
    const offCtx = off.getContext("2d");
    offCtx.fillStyle = "#FFFFFF";
    offCtx.fillRect(0, 0, off.width, off.height);
    offCtx.drawImage(canvas, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0);
  }
  state.outputFormat = fmt;
  commitCurrentCanvas();
}

/* ---- 8.8 Quality slider (live preview of resulting size) ---- */
function buildQualityPanel(section) {
  const sliderRow = sliderField("Quality", 10, 100, 90, "%");
  section.appendChild(sliderRow);
  const resultBox = document.createElement("div");
  resultBox.className = "result-box";
  section.appendChild(resultBox);
  const note = document.createElement("p");
  note.className = "tool-panel-desc";
  note.textContent = "Drag the slider to preview exactly how your image will look and how large the file will be. PNG is lossless, so quality has no visual effect there.";
  section.appendChild(note);

  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Quality";
  section.appendChild(applyBtn);

  const slider = sliderRow.querySelector("input");
  const valEl = sliderRow.querySelector("span[id$='_val']");
  window.__imageQuality = window.__imageQuality || 0.9;
  slider.value = Math.round(window.__imageQuality * 100);
  valEl.textContent = slider.value + "%";

  const baseData = state.history[state.historyIndex];

  let debounce;
  const update = () => {
    valEl.textContent = slider.value + "%";
    window.__imageQuality = slider.value / 100;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (state.outputFormat === "png") {
        resultBox.innerHTML = `<div class="row"><span>Note</span><span>PNG is lossless — no visual change</span></div>`;
        return;
      }
      // Re-encode a hidden copy at this quality and draw the *decoded* result back,
      // so the preview shows real compression artifacts, not just a size estimate.
      const off = document.createElement("canvas");
      off.width = baseData.width; off.height = baseData.height;
      off.getContext("2d").putImageData(baseData, 0, 0);
      off.toBlob((blob) => {
        if (!blob) return;
        resultBox.innerHTML = `<div class="row"><span>Live preview size</span><span>${formatBytes(blob.size)}</span></div>`;
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          canvas.width = baseData.width; canvas.height = baseData.height;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
        };
        img.src = url;
      }, mimeFor(state.outputFormat), window.__imageQuality);
    }, 120);
  };
  slider.addEventListener("input", update);
  update();

  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying quality…", () => commitCurrentCanvas());
    showToast("Quality applied.", "success");
  });
}

/* ---- 8.9–8.11 Brightness / Contrast / Saturation (shared implementation) ---- */
function buildAdjustPanel(key, label, defaultVal, min, max, unit) {
  return (section) => {
    const sliderRow = sliderField(label, min, max, defaultVal, unit);
    section.appendChild(sliderRow);
    const resetBtn = document.createElement("button");
    resetBtn.className = "btn btn-secondary btn-block";
    resetBtn.textContent = "Reset";
    section.appendChild(resetBtn);
    const applyBtn = document.createElement("button");
    applyBtn.className = "btn btn-primary btn-block";
    applyBtn.textContent = "Apply";
    section.appendChild(applyBtn);

    const slider = sliderRow.querySelector("input");
    const valEl = sliderRow.querySelector("span[id$='_val']");
    const baseData = state.history[state.historyIndex];

    function preview() {
      valEl.textContent = slider.value + unit;
      applyFilterPreview(baseData, { [key]: slider.value });
    }
    slider.addEventListener("input", preview);
    resetBtn.addEventListener("click", () => { slider.value = defaultVal; preview(); });
    applyBtn.addEventListener("click", async () => {
      await runAsync("Applying " + label.toLowerCase() + "…", () => commitCurrentCanvas());
      showToast(label + " applied.", "success");
    });
  };
}

function applyFilterPreview(baseImageData, { brightness = 100, contrast = 100, saturation = 100, grayscale = 0 } = {}) {
  const off = document.createElement("canvas");
  off.width = baseImageData.width; off.height = baseImageData.height;
  off.getContext("2d").putImageData(baseImageData, 0, 0);
  ctx.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%) grayscale(${grayscale}%)`;
  canvas.width = off.width; canvas.height = off.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(off, 0, 0);
  ctx.filter = "none";
}

/* ---- 8.12 Grayscale ---- */
function buildGrayscalePanel(section) {
  const sliderRow = sliderField("Intensity", 0, 100, 100, "%");
  section.appendChild(sliderRow);
  const resetBtn = document.createElement("button");
  resetBtn.className = "btn btn-secondary btn-block";
  resetBtn.textContent = "Reset";
  section.appendChild(resetBtn);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply";
  section.appendChild(applyBtn);

  const slider = sliderRow.querySelector("input");
  const valEl = sliderRow.querySelector("span[id$='_val']");
  const baseData = state.history[state.historyIndex];

  function preview() {
    valEl.textContent = slider.value + "%";
    applyFilterPreview(baseData, { grayscale: slider.value });
  }
  slider.addEventListener("input", preview);
  resetBtn.addEventListener("click", () => { slider.value = 0; preview(); });
  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying grayscale…", () => commitCurrentCanvas());
    showToast("Grayscale applied.", "success");
  });
}
function applyGrayscale(intensity) { applyFilterPreview(state.history[state.historyIndex], { grayscale: intensity }); }

/* ---- 8.13 Blur ---- */
function buildBlurPanel(section) {
  const sliderRow = sliderField("Blur amount", 0, 20, 0, "px");
  section.appendChild(sliderRow);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Blur";
  section.appendChild(applyBtn);

  const slider = sliderRow.querySelector("input");
  const valEl = sliderRow.querySelector("span[id$='_val']");
  const baseData = state.history[state.historyIndex];

  function preview() {
    valEl.textContent = slider.value + "px";
    const off = document.createElement("canvas");
    off.width = baseData.width; off.height = baseData.height;
    off.getContext("2d").putImageData(baseData, 0, 0);
    ctx.filter = `blur(${slider.value}px)`;
    canvas.width = off.width; canvas.height = off.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0);
    ctx.filter = "none";
  }
  slider.addEventListener("input", preview);
  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying blur…", () => commitCurrentCanvas());
    showToast("Blur applied.", "success");
  });
}
function applyBlur(px) {
  const baseData = state.history[state.historyIndex];
  const off = document.createElement("canvas");
  off.width = baseData.width; off.height = baseData.height;
  off.getContext("2d").putImageData(baseData, 0, 0);
  ctx.filter = `blur(${px}px)`;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(off, 0, 0);
  ctx.filter = "none";
}

/* ---- 8.14 Sharpen (convolution kernel) ---- */
function buildSharpenPanel(section) {
  const sliderRow = sliderField("Sharpen amount", 0, 100, 0, "%");
  section.appendChild(sliderRow);
  const note = document.createElement("p");
  note.className = "tool-panel-desc";
  note.textContent = "Preview updates when you release the slider — sharpening is more processing-intensive than other adjustments.";
  section.appendChild(note);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Sharpen";
  section.appendChild(applyBtn);

  const slider = sliderRow.querySelector("input");
  const valEl = sliderRow.querySelector("span[id$='_val']");
  slider.addEventListener("input", () => { valEl.textContent = slider.value + "%"; });
  slider.addEventListener("change", async () => {
    await runAsync("Sharpening image…", () => applySharpen(slider.value / 100, true));
  });
  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying sharpen…", () => commitCurrentCanvas());
    showToast("Sharpen applied.", "success");
  });
}

function applySharpen(amount, previewOnly) {
  const baseData = previewOnly ? state.history[state.historyIndex] : ctx.getImageData(0, 0, canvas.width, canvas.height);
  const w = baseData.width, h = baseData.height;
  const src = baseData.data;
  const out = new Uint8ClampedArray(src.length);
  const k = amount * 1.0;
  // Unsharp-style 3x3 kernel blended by `amount`.
  const kernel = [0, -k, 0, -k, 1 + 4 * k, -k, 0, -k, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let ki = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const yy = clamp(y + ky, 0, h - 1);
            const xx = clamp(x + kx, 0, w - 1);
            sum += src[(yy * w + xx) * 4 + c] * kernel[ki++];
          }
        }
        out[idx + c] = sum;
      }
      out[idx + 3] = src[idx + 3];
    }
  }
  const resultData = new ImageData(out, w, h);
  canvas.width = w; canvas.height = h;
  ctx.putImageData(resultData, 0, 0);
}

/* ---- 8.15 Add text ---- */
function buildTextPanel(section) {
  const textRow = field("Text", `<input type="text" placeholder="Your text here" value="Sample text">`);
  section.appendChild(textRow);

  const sizeRow = field("Font size (px)", `<input type="number" min="6" max="400" value="32">`);
  const colorRow = field("Color", `<input type="color" value="#1b1f2b">`);
  const inline1 = document.createElement("div");
  inline1.className = "field-inline";
  inline1.append(sizeRow, colorRow);
  section.appendChild(inline1);

  const fontRow = field("Font", `
    <select>
      <option value="Arial, sans-serif">Arial</option>
      <option value="Georgia, serif">Georgia</option>
      <option value="'Courier New', monospace">Courier New</option>
      <option value="'Times New Roman', serif">Times New Roman</option>
      <option value="Verdana, sans-serif">Verdana</option>
    </select>`);
  section.appendChild(fontRow);

  const posRow = field("Position", `
    <select>
      <option value="top-left">Top left</option>
      <option value="top-center">Top center</option>
      <option value="top-right">Top right</option>
      <option value="center" selected>Center</option>
      <option value="bottom-left">Bottom left</option>
      <option value="bottom-center">Bottom center</option>
      <option value="bottom-right">Bottom right</option>
    </select>`);
  section.appendChild(posRow);

  const boldRow = document.createElement("div");
  boldRow.className = "checkbox-row";
  boldRow.innerHTML = `<input type="checkbox" id="textBold"><label for="textBold">Bold</label>`;
  section.appendChild(boldRow);

  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Add Text to Image";
  section.appendChild(applyBtn);

  applyBtn.addEventListener("click", async () => {
    const text = textRow.querySelector("input").value.trim();
    if (!text) { showToast("Please enter some text.", "error"); return; }
    const options = {
      text,
      size: parseInt(sizeRow.querySelector("input").value, 10) || 32,
      color: colorRow.querySelector("input").value,
      font: fontRow.querySelector("select").value,
      position: posRow.querySelector("select").value,
      bold: boldRow.querySelector("input").checked,
    };
    await runAsync("Adding text…", () => addText(options));
    showToast("Text added.", "success");
  });
}

function textPosition(position, textWidth, textHeight, pad) {
  const w = canvas.width, h = canvas.height;
  let x, y;
  if (position.includes("left")) x = pad;
  else if (position.includes("right")) x = w - textWidth - pad;
  else x = (w - textWidth) / 2;

  if (position.includes("top")) y = pad + textHeight;
  else if (position.includes("bottom")) y = h - pad;
  else y = (h + textHeight) / 2;

  return { x, y };
}

function addText({ text, size, color, font, position, bold }) {
  const pad = Math.max(10, size * 0.4);
  ctx.font = `${bold ? "700" : "400"} ${size}px ${font}`;
  const metrics = ctx.measureText(text);
  const { x, y } = textPosition(position, metrics.width, size, pad);
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x, y);
  commitCurrentCanvas();
}

/* ---- 8.16 Watermark ---- */
function buildWatermarkPanel(section) {
  const modeRow = document.createElement("div");
  modeRow.className = "segmented";
  modeRow.innerHTML = `<button type="button" class="active" data-mode="text">Text</button><button type="button" data-mode="image">Image</button>`;
  section.appendChild(modeRow);

  const textInputRow = field("Watermark text", `<input type="text" value="© PixelEase">`);
  section.appendChild(textInputRow);

  const fileRow = field("Watermark image", `<input type="file" accept="image/png,image/jpeg,image/webp">`);
  fileRow.hidden = true;
  section.appendChild(fileRow);

  const opacityRow = sliderField("Opacity", 5, 100, 50, "%");
  section.appendChild(opacityRow);

  const sizeRow = sliderField("Size", 5, 100, 25, "%");
  section.appendChild(sizeRow);

  const posRow = field("Position", `
    <select>
      <option value="top-left">Top left</option>
      <option value="top-right">Top right</option>
      <option value="center">Center</option>
      <option value="bottom-left">Bottom left</option>
      <option value="bottom-right" selected>Bottom right</option>
    </select>`);
  section.appendChild(posRow);

  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Add Watermark";
  section.appendChild(applyBtn);

  let mode = "text";
  modeRow.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      modeRow.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      mode = b.dataset.mode;
      textInputRow.hidden = mode !== "text";
      fileRow.hidden = mode !== "image";
    });
  });

  applyBtn.addEventListener("click", async () => {
    const opacity = opacityRow.querySelector("input").value / 100;
    const sizePct = sizeRow.querySelector("input").value / 100;
    const position = posRow.querySelector("select").value;

    if (mode === "text") {
      const text = textInputRow.querySelector("input").value.trim();
      if (!text) { showToast("Please enter watermark text.", "error"); return; }
      await runAsync("Adding watermark…", () => addWatermark({ type: "text", text, opacity, sizePct, position }));
      showToast("Watermark added.", "success");
    } else {
      const file = fileRow.querySelector("input").files[0];
      if (!file) { showToast("Please choose a watermark image.", "error"); return; }
      const img = await loadImageFromFile(file);
      showProcessing("Adding watermark…");
      addWatermark({ type: "image", image: img, opacity, sizePct, position });
      hideProcessing();
      showToast("Watermark added.", "success");
    }
  });
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

function addWatermark({ type, text, image, opacity, sizePct, position }) {
  ctx.save();
  ctx.globalAlpha = opacity;
  const pad = canvas.width * 0.03;

  if (type === "image") {
    const targetW = canvas.width * sizePct;
    const scale = targetW / image.width;
    const targetH = image.height * scale;
    const { x, y } = boxPosition(position, targetW, targetH, pad);
    ctx.drawImage(image, x, y, targetW, targetH);
  } else {
    const fontSize = Math.round(canvas.width * sizePct * 0.18);
    ctx.font = `700 ${fontSize}px Arial, sans-serif`;
    const metrics = ctx.measureText(text);
    const { x, y } = boxPosition(position, metrics.width, fontSize, pad);
    ctx.fillStyle = "#FFFFFF";
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = Math.max(1, fontSize * 0.04);
    ctx.textBaseline = "top";
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }
  ctx.restore();
  commitCurrentCanvas();
}

function boxPosition(position, w, h, pad) {
  const cw = canvas.width, ch = canvas.height;
  let x, y;
  if (position.includes("left")) x = pad;
  else if (position.includes("right")) x = cw - w - pad;
  else x = (cw - w) / 2;
  if (position.includes("top")) y = pad;
  else if (position.includes("bottom")) y = ch - h - pad;
  else y = (ch - h) / 2;
  return { x, y };
}

/* ---- 8.17 Background color ---- */
function buildBackgroundPanel(section) {
  const colorRow = field("Background color", `<input type="color" value="#ffffff">`);
  section.appendChild(colorRow);
  const note = document.createElement("p");
  note.className = "tool-panel-desc";
  note.textContent = "Fills transparent areas of your image with a solid color — useful before converting a PNG to JPG.";
  section.appendChild(note);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Background Color";
  section.appendChild(applyBtn);

  applyBtn.addEventListener("click", async () => {
    const color = colorRow.querySelector("input").value;
    await runAsync("Applying background…", () => setBackgroundColor(color));
    showToast("Background color applied.", "success");
  });
}

function setBackgroundColor(color) {
  const off = document.createElement("canvas");
  off.width = canvas.width; off.height = canvas.height;
  const offCtx = off.getContext("2d");
  offCtx.fillStyle = color;
  offCtx.fillRect(0, 0, off.width, off.height);
  offCtx.drawImage(canvas, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(off, 0, 0);
  commitCurrentCanvas();
}

/* ---- 8.18 Remove metadata ---- */
function buildMetadataPanel(section) {
  const note = document.createElement("p");
  note.className = "tool-panel-desc";
  note.textContent = "Re-saving through the browser's canvas already excludes camera and file metadata such as EXIF, GPS location and timestamps. Use this to create a fresh, clean copy.";
  section.appendChild(note);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Create Clean Copy";
  section.appendChild(applyBtn);
  const resultBox = document.createElement("div");
  resultBox.className = "result-box";
  resultBox.hidden = true;
  section.appendChild(resultBox);

  applyBtn.addEventListener("click", async () => {
    await runAsync("Removing metadata…", () => removeMetadata());
    resultBox.hidden = false;
    resultBox.innerHTML = `<div class="row"><span>Status</span><span>Metadata removed</span></div>`;
    showToast("Clean copy created.", "success");
  });
}

function removeMetadata() {
  // Re-encoding through canvas strips EXIF/ICC/GPS metadata by nature of the Canvas API.
  commitCurrentCanvas();
  state.metadataRemoved = true;
}

/* ---- 8.19 Image information ---- */
function buildInfoPanel(section) {
  const table = document.createElement("table");
  table.className = "info-table";
  table.id = "infoTable";
  section.appendChild(table);
}

function renderInfoPanel() {
  const table = document.getElementById("infoTable");
  if (!table) return;
  estimateCurrentBlobSize().then((bytes) => {
    const w = canvas.width, h = canvas.height;
    const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
    const divisor = gcd(w, h) || 1;
    const ratio = `${w / divisor}:${h / divisor}`;
    const dpiText = state.dpiHint ? `${state.dpiHint} (set via Resize by CM)` : "Not embedded — browsers cannot read source DPI";
    table.innerHTML = `
      <tr><td>File name</td><td>${state.originalMeta ? state.originalMeta.name : "—"}</td></tr>
      <tr><td>Format</td><td>${state.outputFormat.toUpperCase()}</td></tr>
      <tr><td>File size</td><td>${formatBytes(bytes)}</td></tr>
      <tr><td>Width</td><td>${w} px</td></tr>
      <tr><td>Height</td><td>${h} px</td></tr>
      <tr><td>Aspect ratio</td><td>${ratio}</td></tr>
      <tr><td>Estimated DPI</td><td>${dpiText}</td></tr>
      <tr><td>Color mode</td><td>RGBA (canvas-rendered)</td></tr>
    `;
  });
}

/* ---- 8.20 Presets ---- */
const PRESETS = [
  { id: "signature", name: "Signature", desc: "6 cm × 2 cm", wCm: 6, hCm: 2 },
  { id: "passport", name: "Passport Photo", desc: "3.5 cm × 4.5 cm", wCm: 3.5, hCm: 4.5 },
  { id: "custom", name: "Custom size", desc: "Set your own width and height", wCm: null, hCm: null },
];

function buildPresetsPanel(section) {
  const list = document.createElement("div");
  list.className = "preset-list";
  PRESETS.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset-btn";
    btn.dataset.preset = p.id;
    btn.innerHTML = `<strong>${p.name}</strong><span>${p.desc}</span>`;
    list.appendChild(btn);
  });
  section.appendChild(list);

  const customWrap = document.createElement("div");
  customWrap.className = "field-inline";
  customWrap.hidden = true;
  const cwRow = field("Width (cm)", `<input type="number" min="0.5" step="0.1" value="5">`);
  const chRow = field("Height (cm)", `<input type="number" min="0.5" step="0.1" value="5">`);
  customWrap.append(cwRow, chRow);
  section.appendChild(customWrap);

  const dpiRow = field("DPI", `
    <select>
      <option value="150">150 DPI</option>
      <option value="300" selected>300 DPI (print)</option>
      <option value="600">600 DPI</option>
    </select>`);
  section.appendChild(dpiRow);

  const maxKbRow = field("Maximum file size (KB)", `<input type="number" min="1" value="50">`);
  section.appendChild(maxKbRow);

  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Preset";
  section.appendChild(applyBtn);

  const resultBox = document.createElement("div");
  resultBox.className = "result-box";
  resultBox.hidden = true;
  section.appendChild(resultBox);

  let selected = null;
  list.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      list.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selected = PRESETS.find((p) => p.id === btn.dataset.preset);
      customWrap.hidden = selected.id !== "custom";
    });
  });

  applyBtn.addEventListener("click", async () => {
    if (!selected) { showToast("Choose a preset first.", "error"); return; }
    const dpi = parseInt(dpiRow.querySelector("select").value, 10);
    const maxKb = parseFloat(maxKbRow.querySelector("input").value) || 50;
    const wCm = selected.id === "custom" ? parseFloat(cwRow.querySelector("input").value) : selected.wCm;
    const hCm = selected.id === "custom" ? parseFloat(chRow.querySelector("input").value) : selected.hCm;
    if (!wCm || !hCm) { showToast("Please enter a valid size.", "error"); return; }

    showProcessing("Applying preset…");
    const pxW = cmToPixels(wCm, dpi);
    const pxH = cmToPixels(hCm, dpi);
    resizeByPhysicalSize(pxW, pxH, dpi);
    const result = await compressImage(maxKb * 1024);
    hideProcessing();

    resultBox.hidden = false;
    resultBox.innerHTML = `
      <div class="row"><span>Final dimensions</span><span>${pxW} × ${pxH} px</span></div>
      <div class="row"><span>File size</span><span>${formatBytes(result.size)}</span></div>
      ${!result.reached ? `<div class="result-warning">Unable to reach the requested size without significant quality loss. This is the smallest result achieved.</div>` : ""}
    `;
    showToast("Preset applied.", "success");
  });
}

/* ---- 8.21 Shared live-preview helpers for the extended tool set ---- */

function clampByte(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

// Coalesces rapid slider "input" events to one redraw per animation frame.
function throttleRaf(fn) {
  let scheduled = false;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; fn(...lastArgs); });
    }
  };
}

// Runs `transform` over a fresh copy of baseData's pixels and paints the result to the
// live canvas, without touching history — used for every live-preview slider below.
function livePixelPreview(baseData, transform) {
  const w = baseData.width, h = baseData.height;
  const out = new Uint8ClampedArray(baseData.data);
  transform(out, w, h);
  canvas.width = w; canvas.height = h;
  ctx.putImageData(new ImageData(out, w, h), 0, 0);
}

// Applies a raw CSS filter string to a snapshot and paints it live (fast path for
// filters the browser can do natively, e.g. hue-rotate).
function cssFilterPreview(baseData, filterStr) {
  const off = document.createElement("canvas");
  off.width = baseData.width; off.height = baseData.height;
  off.getContext("2d").putImageData(baseData, 0, 0);
  canvas.width = off.width; canvas.height = off.height;
  ctx.filter = filterStr;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(off, 0, 0);
  ctx.filter = "none";
}

function hexToRgbArr(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hexToRgba(hex, alpha) {
  const [r, g, b] = hexToRgbArr(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}
function roundRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// Generic convolution used by Emboss / Edge Detection (Sharpen has its own copy above).
function convolve3x3(baseData, kernel, bias) {
  const w = baseData.width, h = baseData.height;
  const src = baseData.data;
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0, ki = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const yy = clamp(y + ky, 0, h - 1);
            const xx = clamp(x + kx, 0, w - 1);
            sum += src[(yy * w + xx) * 4 + c] * kernel[ki++];
          }
        }
        out[idx + c] = clampByte(sum + bias);
      }
      out[idx + 3] = src[idx + 3];
    }
  }
  return new ImageData(out, w, h);
}

/* ---- 8.22 Sepia ---- */
function buildSepiaPanel(section) {
  const sliderRow = sliderField("Intensity", 0, 100, 100, "%");
  section.appendChild(sliderRow);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Sepia";
  section.appendChild(applyBtn);

  const slider = sliderRow.querySelector("input");
  const valEl = sliderRow.querySelector("span[id$='_val']");
  const baseData = state.history[state.historyIndex];

  const preview = throttleRaf((amtStr) => {
    const amt = parseInt(amtStr, 10);
    valEl.textContent = amt + "%";
    const f = amt / 100;
    livePixelPreview(baseData, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const sr = clampByte(r * 0.393 + g * 0.769 + b * 0.189);
        const sg = clampByte(r * 0.349 + g * 0.686 + b * 0.168);
        const sb = clampByte(r * 0.272 + g * 0.534 + b * 0.131);
        d[i] = r + (sr - r) * f;
        d[i + 1] = g + (sg - g) * f;
        d[i + 2] = b + (sb - b) * f;
      }
    });
  });
  slider.addEventListener("input", () => preview(slider.value));
  preview(slider.value);
  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying sepia…", () => commitCurrentCanvas());
    showToast("Sepia applied.", "success");
  });
}

/* ---- 8.23 Invert ---- */
function buildInvertPanel(section) {
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Invert Colors";
  section.appendChild(applyBtn);
  applyBtn.addEventListener("click", async () => {
    await runAsync("Inverting colors…", () => {
      livePixelPreview(state.history[state.historyIndex], (d) => {
        for (let i = 0; i < d.length; i += 4) {
          d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2];
        }
      });
      commitCurrentCanvas();
    });
    showToast("Colors inverted.", "success");
  });
}

/* ---- 8.24 Black & white threshold ---- */
function buildThresholdPanel(section) {
  const sliderRow = sliderField("Cutoff", 0, 255, 128);
  section.appendChild(sliderRow);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Threshold";
  section.appendChild(applyBtn);

  const slider = sliderRow.querySelector("input");
  const valEl = sliderRow.querySelector("span[id$='_val']");
  const baseData = state.history[state.historyIndex];

  const preview = throttleRaf((cutStr) => {
    const cutoff = parseInt(cutStr, 10);
    valEl.textContent = cutoff;
    livePixelPreview(baseData, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        const avg = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const v = avg >= cutoff ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    });
  });
  slider.addEventListener("input", () => preview(slider.value));
  preview(slider.value);
  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying threshold…", () => commitCurrentCanvas());
    showToast("Threshold applied.", "success");
  });
}

/* ---- 8.25 Vignette ---- */
function buildVignettePanel(section) {
  const sliderRow = sliderField("Intensity", 0, 100, 50, "%");
  section.appendChild(sliderRow);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Vignette";
  section.appendChild(applyBtn);

  const slider = sliderRow.querySelector("input");
  const valEl = sliderRow.querySelector("span[id$='_val']");
  const baseData = state.history[state.historyIndex];

  const preview = throttleRaf((amtStr) => {
    const amt = parseInt(amtStr, 10);
    valEl.textContent = amt + "%";
    const off = document.createElement("canvas");
    off.width = baseData.width; off.height = baseData.height;
    off.getContext("2d").putImageData(baseData, 0, 0);
    canvas.width = off.width; canvas.height = off.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0);
    const w = canvas.width, h = canvas.height;
    const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.7);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, `rgba(0,0,0,${amt / 100})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  });
  slider.addEventListener("input", () => preview(slider.value));
  preview(slider.value);
  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying vignette…", () => commitCurrentCanvas());
    showToast("Vignette applied.", "success");
  });
}

/* ---- 8.26 Pixelate ---- */
function buildPixelatePanel(section) {
  const sliderRow = sliderField("Block size", 2, 60, 12, "px");
  section.appendChild(sliderRow);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Pixelate";
  section.appendChild(applyBtn);

  const slider = sliderRow.querySelector("input");
  const valEl = sliderRow.querySelector("span[id$='_val']");
  const baseData = state.history[state.historyIndex];

  const preview = throttleRaf((sizeStr) => {
    const size = parseInt(sizeStr, 10);
    valEl.textContent = size + "px";
    const off = document.createElement("canvas");
    off.width = baseData.width; off.height = baseData.height;
    off.getContext("2d").putImageData(baseData, 0, 0);
    const w = baseData.width, h = baseData.height;
    const sw = Math.max(1, Math.round(w / size));
    const sh = Math.max(1, Math.round(h / size));
    const small = document.createElement("canvas");
    small.width = sw; small.height = sh;
    small.getContext("2d").drawImage(off, 0, 0, sw, sh);
    canvas.width = w; canvas.height = h;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(small, 0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
  });
  slider.addEventListener("input", () => preview(slider.value));
  preview(slider.value);
  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying pixelate…", () => commitCurrentCanvas());
    showToast("Pixelate applied.", "success");
  });
}

/* ---- 8.27 Posterize ---- */
function buildPosterizePanel(section) {
  const sliderRow = sliderField("Color levels", 2, 16, 6);
  section.appendChild(sliderRow);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Posterize";
  section.appendChild(applyBtn);

  const slider = sliderRow.querySelector("input");
  const valEl = sliderRow.querySelector("span[id$='_val']");
  const baseData = state.history[state.historyIndex];

  const preview = throttleRaf((levelsStr) => {
    const levels = parseInt(levelsStr, 10);
    valEl.textContent = levels;
    const step = 255 / (levels - 1);
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = clampByte(Math.round(Math.round(i / step) * step));
    livePixelPreview(baseData, (d) => {
      for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
    });
  });
  slider.addEventListener("input", () => preview(slider.value));
  preview(slider.value);
  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying posterize…", () => commitCurrentCanvas());
    showToast("Posterize applied.", "success");
  });
}

/* ---- 8.28 Emboss ---- */
function buildEmbossPanel(section) {
  const sliderRow = sliderField("Strength", 0, 100, 60, "%");
  section.appendChild(sliderRow);
  const note = document.createElement("p");
  note.className = "tool-panel-desc";
  note.textContent = "Preview updates when you release the slider, since this effect is more processing-intensive.";
  section.appendChild(note);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Emboss";
  section.appendChild(applyBtn);

  const slider = sliderRow.querySelector("input");
  const valEl = sliderRow.querySelector("span[id$='_val']");
  const baseData = state.history[state.historyIndex];

  function render(amtStr) {
    const amt = parseInt(amtStr, 10);
    valEl.textContent = amt + "%";
    const f = amt / 100;
    const kernel = [-2 * f, -f, 0, -f, 1, f, 0, f, 2 * f];
    const off = document.createElement("canvas");
    off.width = baseData.width; off.height = baseData.height;
    off.getContext("2d").putImageData(baseData, 0, 0);
    canvas.width = off.width; canvas.height = off.height;
    ctx.putImageData(convolve3x3(baseData, kernel, 128 * f * 0.4), 0, 0);
  }
  slider.addEventListener("input", () => { valEl.textContent = slider.value + "%"; });
  slider.addEventListener("change", () => render(slider.value));
  render(slider.value);
  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying emboss…", () => commitCurrentCanvas());
    showToast("Emboss applied.", "success");
  });
}

/* ---- 8.29 Edge detection ---- */
function buildEdgeDetectPanel(section) {
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Detect Edges";
  section.appendChild(applyBtn);
  applyBtn.addEventListener("click", async () => {
    await runAsync("Detecting edges…", () => {
      const baseData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const gray = new Uint8ClampedArray(baseData.data);
      for (let i = 0; i < gray.length; i += 4) {
        const avg = 0.299 * gray[i] + 0.587 * gray[i + 1] + 0.114 * gray[i + 2];
        gray[i] = gray[i + 1] = gray[i + 2] = avg;
      }
      const grayData = new ImageData(gray, baseData.width, baseData.height);
      const kernel = [0, -1, 0, -1, 4, -1, 0, -1, 0];
      const result = convolve3x3(grayData, kernel, 0);
      canvas.width = result.width; canvas.height = result.height;
      ctx.putImageData(result, 0, 0);
      commitCurrentCanvas();
    });
    showToast("Edges detected.", "success");
  });
}

/* ---- 8.30 Color tint ---- */
function buildTintPanel(section) {
  const colorRow = field("Tint color", `<input type="color" value="#4f63d2">`);
  section.appendChild(colorRow);
  const sliderRow = sliderField("Intensity", 0, 100, 40, "%");
  section.appendChild(sliderRow);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Tint";
  section.appendChild(applyBtn);

  const colorInput = colorRow.querySelector("input");
  const slider = sliderRow.querySelector("input");
  const valEl = sliderRow.querySelector("span[id$='_val']");
  const baseData = state.history[state.historyIndex];

  const preview = throttleRaf(() => {
    valEl.textContent = slider.value + "%";
    const off = document.createElement("canvas");
    off.width = baseData.width; off.height = baseData.height;
    off.getContext("2d").putImageData(baseData, 0, 0);
    canvas.width = off.width; canvas.height = off.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0);
    ctx.save();
    ctx.globalAlpha = slider.value / 100;
    ctx.globalCompositeOperation = "overlay";
    ctx.fillStyle = colorInput.value;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  });
  colorInput.addEventListener("input", preview);
  slider.addEventListener("input", preview);
  preview();
  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying tint…", () => commitCurrentCanvas());
    showToast("Tint applied.", "success");
  });
}

/* ---- 8.31 Color temperature ---- */
function buildTemperaturePanel(section) {
  const sliderRow = sliderField("Temperature", -100, 100, 0);
  section.appendChild(sliderRow);
  const resetBtn = document.createElement("button");
  resetBtn.className = "btn btn-secondary btn-block";
  resetBtn.textContent = "Reset";
  section.appendChild(resetBtn);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply";
  section.appendChild(applyBtn);

  const slider = sliderRow.querySelector("input");
  const valEl = sliderRow.querySelector("span[id$='_val']");
  const baseData = state.history[state.historyIndex];

  const preview = throttleRaf((vStr) => {
    const v = parseInt(vStr, 10);
    valEl.textContent = (v > 0 ? "+" : "") + v;
    livePixelPreview(baseData, (d) => {
      for (let i = 0; i < d.length; i += 4) { d[i] = clampByte(d[i] + v); d[i + 2] = clampByte(d[i + 2] - v); }
    });
  });
  slider.addEventListener("input", () => preview(slider.value));
  resetBtn.addEventListener("click", () => { slider.value = 0; preview(0); });
  preview(slider.value);
  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying temperature…", () => commitCurrentCanvas());
    showToast("Color temperature applied.", "success");
  });
}

/* ---- 8.32 Hue shift ---- */
function buildHuePanel(section) {
  const sliderRow = sliderField("Hue rotate", 0, 360, 0, "°");
  section.appendChild(sliderRow);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Hue Shift";
  section.appendChild(applyBtn);

  const slider = sliderRow.querySelector("input");
  const valEl = sliderRow.querySelector("span[id$='_val']");
  const baseData = state.history[state.historyIndex];

  const preview = throttleRaf((degStr) => {
    valEl.textContent = degStr + "°";
    cssFilterPreview(baseData, `hue-rotate(${degStr}deg)`);
  });
  slider.addEventListener("input", () => preview(slider.value));
  preview(slider.value);
  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying hue shift…", () => commitCurrentCanvas());
    showToast("Hue shift applied.", "success");
  });
}

/* ---- 8.33 Gamma correction ---- */
function buildGammaPanel(section) {
  const sliderRow = sliderField("Gamma", 10, 300, 100);
  section.appendChild(sliderRow);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Gamma";
  section.appendChild(applyBtn);

  const slider = sliderRow.querySelector("input");
  const valEl = sliderRow.querySelector("span[id$='_val']");
  const baseData = state.history[state.historyIndex];

  const preview = throttleRaf((rawStr) => {
    const gamma = parseInt(rawStr, 10) / 100;
    valEl.textContent = gamma.toFixed(2);
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = clampByte(Math.round(255 * Math.pow(i / 255, 1 / gamma)));
    livePixelPreview(baseData, (d) => {
      for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
    });
  });
  slider.addEventListener("input", () => preview(slider.value));
  preview(slider.value);
  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying gamma…", () => commitCurrentCanvas());
    showToast("Gamma correction applied.", "success");
  });
}

/* ---- 8.34 Vibrance ---- */
function buildVibrancePanel(section) {
  const sliderRow = sliderField("Vibrance", 0, 100, 0, "%");
  section.appendChild(sliderRow);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Vibrance";
  section.appendChild(applyBtn);

  const slider = sliderRow.querySelector("input");
  const valEl = sliderRow.querySelector("span[id$='_val']");
  const baseData = state.history[state.historyIndex];

  const preview = throttleRaf((amtStr) => {
    const amt = parseInt(amtStr, 10);
    valEl.textContent = amt + "%";
    const f = amt / 100;
    livePixelPreview(baseData, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const sat = (max - min) / 255;
        const boost = f * (1 - sat) * 1.4;
        const avg = (r + g + b) / 3;
        d[i] = clampByte(r + (r - avg) * boost);
        d[i + 1] = clampByte(g + (g - avg) * boost);
        d[i + 2] = clampByte(b + (b - avg) * boost);
      }
    });
  });
  slider.addEventListener("input", () => preview(slider.value));
  preview(slider.value);
  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying vibrance…", () => commitCurrentCanvas());
    showToast("Vibrance applied.", "success");
  });
}

/* ---- 8.35 Border frame ---- */
function buildBorderPanel(section) {
  const colorRow = field("Border color", `<input type="color" value="#ffffff">`);
  const widthRow = field("Border width (px)", `<input type="number" min="1" max="500" value="20">`);
  const inline = document.createElement("div");
  inline.className = "field-inline";
  inline.append(colorRow, widthRow);
  section.appendChild(inline);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Add Border";
  section.appendChild(applyBtn);

  applyBtn.addEventListener("click", async () => {
    const color = colorRow.querySelector("input").value;
    const bw = parseInt(widthRow.querySelector("input").value, 10) || 20;
    await runAsync("Adding border…", () => {
      const off = document.createElement("canvas");
      off.width = canvas.width; off.height = canvas.height;
      off.getContext("2d").drawImage(canvas, 0, 0);
      const newW = canvas.width + bw * 2, newH = canvas.height + bw * 2;
      canvas.width = newW; canvas.height = newH;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, newW, newH);
      ctx.drawImage(off, bw, bw);
      commitCurrentCanvas();
    });
    showToast("Border added.", "success");
  });
}

/* ---- 8.36 Rounded corners ---- */
function buildRoundedCornersPanel(section) {
  const sliderRow = sliderField("Corner radius", 0, 300, 40, "px");
  section.appendChild(sliderRow);
  const note = document.createElement("p");
  note.className = "tool-panel-desc";
  note.textContent = "Rounded corners become transparent, so this works best with PNG or WEBP.";
  section.appendChild(note);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Rounded Corners";
  section.appendChild(applyBtn);

  const slider = sliderRow.querySelector("input");
  const valEl = sliderRow.querySelector("span[id$='_val']");
  const baseData = state.history[state.historyIndex];

  const preview = throttleRaf((rStr) => {
    const r = parseInt(rStr, 10);
    valEl.textContent = r + "px";
    const off = document.createElement("canvas");
    off.width = baseData.width; off.height = baseData.height;
    off.getContext("2d").putImageData(baseData, 0, 0);
    canvas.width = off.width; canvas.height = off.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    roundRectPath(ctx, 0, 0, canvas.width, canvas.height, Math.min(r, canvas.width / 2, canvas.height / 2));
    ctx.clip();
    ctx.drawImage(off, 0, 0);
    ctx.restore();
  });
  slider.addEventListener("input", () => preview(slider.value));
  preview(slider.value);
  applyBtn.addEventListener("click", async () => {
    if (state.outputFormat === "jpeg") { showToast("Switch to PNG or WEBP first so the rounded corners stay transparent.", "error"); return; }
    await runAsync("Applying rounded corners…", () => commitCurrentCanvas());
    showToast("Rounded corners applied.", "success");
  });
}

/* ---- 8.37 Drop shadow ---- */
function buildDropShadowPanel(section) {
  const offsetRow = field("Offset (px)", `<input type="number" min="0" max="200" value="12">`);
  const blurRow = field("Blur (px)", `<input type="number" min="0" max="200" value="24">`);
  const inline = document.createElement("div");
  inline.className = "field-inline";
  inline.append(offsetRow, blurRow);
  section.appendChild(inline);
  const colorRow = field("Shadow color", `<input type="color" value="#000000">`);
  section.appendChild(colorRow);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Add Drop Shadow";
  section.appendChild(applyBtn);

  applyBtn.addEventListener("click", async () => {
    const offset = parseInt(offsetRow.querySelector("input").value, 10) || 0;
    const blur = parseInt(blurRow.querySelector("input").value, 10) || 0;
    const color = colorRow.querySelector("input").value;
    await runAsync("Adding drop shadow…", () => {
      const pad = offset + blur + 16;
      const off = document.createElement("canvas");
      off.width = canvas.width; off.height = canvas.height;
      off.getContext("2d").drawImage(canvas, 0, 0);
      const newW = canvas.width + pad * 2, newH = canvas.height + pad * 2;
      canvas.width = newW; canvas.height = newH;
      ctx.clearRect(0, 0, newW, newH);
      ctx.save();
      ctx.shadowColor = hexToRgba(color, 0.45);
      ctx.shadowBlur = blur;
      ctx.shadowOffsetX = offset;
      ctx.shadowOffsetY = offset;
      ctx.drawImage(off, pad, pad);
      ctx.restore();
      commitCurrentCanvas();
    });
    showToast("Drop shadow added.", "success");
  });
}

/* ---- 8.38 Mirror effect ---- */
function buildMirrorPanel(section) {
  const axisRow = document.createElement("div");
  axisRow.className = "segmented";
  axisRow.innerHTML = `<button type="button" class="active" data-axis="h">Left → Right</button><button type="button" data-axis="v">Top → Bottom</button>`;
  section.appendChild(axisRow);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Mirror";
  section.appendChild(applyBtn);

  let axis = "h";
  axisRow.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      axisRow.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      axis = b.dataset.axis;
    });
  });

  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying mirror…", () => mirrorImage(axis));
    showToast("Mirror effect applied.", "success");
  });
}

function mirrorImage(axis) {
  const w = canvas.width, h = canvas.height;
  const off = document.createElement("canvas");
  off.width = w; off.height = h;
  off.getContext("2d").drawImage(canvas, 0, 0);
  ctx.save();
  if (axis === "h") {
    ctx.drawImage(off, 0, 0, w / 2, h, 0, 0, w / 2, h);
    ctx.translate(w, 0); ctx.scale(-1, 1);
    ctx.drawImage(off, 0, 0, w / 2, h, 0, 0, w / 2, h);
  } else {
    ctx.drawImage(off, 0, 0, w, h / 2, 0, 0, w, h / 2);
    ctx.translate(0, h); ctx.scale(1, -1);
    ctx.drawImage(off, 0, 0, w, h / 2, 0, 0, w, h / 2);
  }
  ctx.restore();
  commitCurrentCanvas();
}

/* ---- 8.39 Film grain / noise ---- */
function buildNoisePanel(section) {
  const sliderRow = sliderField("Grain amount", 0, 100, 20, "%");
  section.appendChild(sliderRow);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Film Grain";
  section.appendChild(applyBtn);

  const slider = sliderRow.querySelector("input");
  const valEl = sliderRow.querySelector("span[id$='_val']");
  const baseData = state.history[state.historyIndex];

  const preview = throttleRaf((amtStr) => {
    const amt = parseInt(amtStr, 10);
    valEl.textContent = amt + "%";
    const strength = (amt / 100) * 55;
    livePixelPreview(baseData, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        const n = (Math.random() - 0.5) * strength;
        d[i] = clampByte(d[i] + n); d[i + 1] = clampByte(d[i + 1] + n); d[i + 2] = clampByte(d[i + 2] + n);
      }
    });
  });
  slider.addEventListener("input", () => preview(slider.value));
  preview(slider.value);
  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying film grain…", () => commitCurrentCanvas());
    showToast("Film grain applied.", "success");
  });
}

/* ---- 8.40 Duotone ---- */
function buildDuotonePanel(section) {
  const shadowRow = field("Shadow color", `<input type="color" value="#1b1f2b">`);
  const highlightRow = field("Highlight color", `<input type="color" value="#f5c451">`);
  const inline = document.createElement("div");
  inline.className = "field-inline";
  inline.append(shadowRow, highlightRow);
  section.appendChild(inline);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Duotone";
  section.appendChild(applyBtn);

  const shadowInput = shadowRow.querySelector("input");
  const highlightInput = highlightRow.querySelector("input");
  const baseData = state.history[state.historyIndex];

  const preview = throttleRaf(() => {
    const c1 = hexToRgbArr(shadowInput.value);
    const c2 = hexToRgbArr(highlightInput.value);
    livePixelPreview(baseData, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
        d[i] = clampByte(c1[0] + (c2[0] - c1[0]) * lum);
        d[i + 1] = clampByte(c1[1] + (c2[1] - c1[1]) * lum);
        d[i + 2] = clampByte(c1[2] + (c2[2] - c1[2]) * lum);
      }
    });
  });
  shadowInput.addEventListener("input", preview);
  highlightInput.addEventListener("input", preview);
  preview();
  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying duotone…", () => commitCurrentCanvas());
    showToast("Duotone applied.", "success");
  });
}

/* ---- 8.41 Aspect ratio presets ---- */
function buildAspectRatioPanel(section) {
  const ratioRow = document.createElement("div");
  ratioRow.className = "segmented";
  ratioRow.innerHTML = `<button type="button" class="active" data-ratio="1:1">Square</button><button type="button" data-ratio="9:16">Story</button><button type="button" data-ratio="4:5">Post</button>`;
  section.appendChild(ratioRow);

  const modeRow = document.createElement("div");
  modeRow.className = "segmented";
  modeRow.innerHTML = `<button type="button" class="active" data-mode="crop">Fill (crop)</button><button type="button" data-mode="pad">Fit (pad)</button>`;
  section.appendChild(modeRow);

  const colorRow = field("Pad background color", `<input type="color" value="#ffffff">`);
  colorRow.hidden = true;
  section.appendChild(colorRow);

  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Aspect Ratio";
  section.appendChild(applyBtn);

  let ratio = "1:1", mode = "crop";
  ratioRow.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => { ratioRow.querySelectorAll("button").forEach((x) => x.classList.remove("active")); b.classList.add("active"); ratio = b.dataset.ratio; });
  });
  modeRow.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => { modeRow.querySelectorAll("button").forEach((x) => x.classList.remove("active")); b.classList.add("active"); mode = b.dataset.mode; colorRow.hidden = mode !== "pad"; });
  });

  applyBtn.addEventListener("click", async () => {
    await runAsync("Applying aspect ratio…", () => applyAspectRatio(ratio, mode, colorRow.querySelector("input").value));
    showToast("Aspect ratio applied.", "success");
  });
}

function applyAspectRatio(ratioStr, mode, bg) {
  const [rw, rh] = ratioStr.split(":").map(Number);
  const targetRatio = rw / rh;
  const w = canvas.width, h = canvas.height;
  const currentRatio = w / h;

  if (mode === "crop") {
    let cw, ch, cx, cy;
    if (currentRatio > targetRatio) { ch = h; cw = h * targetRatio; cx = (w - cw) / 2; cy = 0; }
    else { cw = w; ch = w / targetRatio; cx = 0; cy = (h - ch) / 2; }
    cropImage({ x: Math.round(cx), y: Math.round(cy), w: Math.round(cw), h: Math.round(ch) });
  } else {
    let newW, newH;
    if (currentRatio > targetRatio) { newW = w; newH = w / targetRatio; } else { newH = h; newW = h * targetRatio; }
    newW = Math.round(newW); newH = Math.round(newH);
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    off.getContext("2d").drawImage(canvas, 0, 0);
    canvas.width = newW; canvas.height = newH;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, newW, newH);
    ctx.drawImage(off, Math.round((newW - w) / 2), Math.round((newH - h) / 2));
    commitCurrentCanvas();
  }
}

/* ---- 8.42 Center on canvas ---- */
function buildCenterCanvasPanel(section) {
  const paddingRow = field("Padding (% of image size)", `<input type="number" min="0" max="200" value="20">`);
  section.appendChild(paddingRow);
  const colorRow = field("Background color", `<input type="color" value="#ffffff">`);
  section.appendChild(colorRow);
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-block";
  applyBtn.textContent = "Apply Padding";
  section.appendChild(applyBtn);

  applyBtn.addEventListener("click", async () => {
    const pct = parseFloat(paddingRow.querySelector("input").value) || 0;
    const bg = colorRow.querySelector("input").value;
    await runAsync("Adding padding…", () => {
      const padX = Math.round(canvas.width * (pct / 100));
      const padY = Math.round(canvas.height * (pct / 100));
      const off = document.createElement("canvas");
      off.width = canvas.width; off.height = canvas.height;
      off.getContext("2d").drawImage(canvas, 0, 0);
      const newW = canvas.width + padX * 2, newH = canvas.height + padY * 2;
      canvas.width = newW; canvas.height = newH;
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, newW, newH);
      ctx.drawImage(off, padX, padY);
      commitCurrentCanvas();
    });
    showToast("Image centered on padded canvas.", "success");
  });
}

/* ---------- 9. CROP INTERACTION ---------- */

function enterCropMode() {
  const overlay = document.getElementById("cropOverlay");
  const wrap = document.querySelector(".preview-canvas-wrap");
  overlay.hidden = false;

  const rectW = Math.round(canvas.width * 0.6);
  const rectH = Math.round(canvas.height * 0.6);
  const rectX = Math.round((canvas.width - rectW) / 2);
  const rectY = Math.round((canvas.height - rectH) / 2);
  state.cropState = { rect: { x: rectX, y: rectY, w: rectW, h: rectH }, mode: "free", customWH: null };

  positionCropBox();
  bindCropEvents();
  wrap._cropResizeObserver && wrap._cropResizeObserver.disconnect();
  wrap._cropResizeObserver = new ResizeObserver(() => positionCropBox());
  wrap._cropResizeObserver.observe(wrap);
}

function exitCropMode() {
  document.getElementById("cropOverlay").hidden = true;
  state.cropState = null;
}

function setCropMode(mode, customWH) {
  if (!state.cropState) return;
  state.cropState.mode = mode;
  const rect = state.cropState.rect;
  if (mode === "square") {
    const side = Math.min(rect.w, rect.h, canvas.width, canvas.height);
    rect.w = side; rect.h = side;
  } else if (mode === "custom" && customWH && customWH.w && customWH.h) {
    rect.w = clamp(customWH.w, 1, canvas.width);
    rect.h = clamp(customWH.h, 1, canvas.height);
  }
  rect.x = clamp(rect.x, 0, canvas.width - rect.w);
  rect.y = clamp(rect.y, 0, canvas.height - rect.h);
  positionCropBox();
}

function canvasToScreenScale() {
  const rect = canvas.getBoundingClientRect();
  return { scaleX: rect.width / canvas.width, scaleY: rect.height / canvas.height, rect };
}

function positionCropBox() {
  if (!state.cropState) return;
  const box = document.getElementById("cropBox");
  const { scaleX, scaleY } = canvasToScreenScale();
  const { x, y, w, h } = state.cropState.rect;
  box.style.left = x * scaleX + "px";
  box.style.top = y * scaleY + "px";
  box.style.width = w * scaleX + "px";
  box.style.height = h * scaleY + "px";
}

function bindCropEvents() {
  const box = document.getElementById("cropBox");
  if (box._bound) return;
  box._bound = true;

  let dragging = null; // 'move' | 'nw' | 'ne' | 'sw' | 'se'
  let startPointer = null;
  let startRect = null;

  function pointerPos(e) {
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX, y: p.clientY };
  }

  function onDown(handle) {
    return (e) => {
      e.preventDefault();
      dragging = handle;
      startPointer = pointerPos(e);
      startRect = { ...state.cropState.rect };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onUp);
    };
  }

  function onMove(e) {
    if (!dragging) return;
    e.preventDefault();
    const { scaleX, scaleY } = canvasToScreenScale();
    const p = pointerPos(e);
    const dxPx = (p.x - startPointer.x) / scaleX;
    const dyPx = (p.y - startPointer.y) / scaleY;
    const rect = state.cropState.rect;
    const cw = canvas.width, ch = canvas.height;

    if (dragging === "move") {
      rect.x = clamp(startRect.x + dxPx, 0, cw - rect.w);
      rect.y = clamp(startRect.y + dyPx, 0, ch - rect.h);
    } else {
      let { x, y, w, h } = startRect;
      const square = state.cropState.mode === "square";
      if (dragging.includes("e")) w = clamp(startRect.w + dxPx, 20, cw - x);
      if (dragging.includes("s")) h = clamp(startRect.h + dyPx, 20, ch - y);
      if (dragging.includes("w")) { const newW = clamp(startRect.w - dxPx, 20, startRect.x + startRect.w); x = startRect.x + startRect.w - newW; w = newW; }
      if (dragging.includes("n")) { const newH = clamp(startRect.h - dyPx, 20, startRect.y + startRect.h); y = startRect.y + startRect.h - newH; h = newH; }
      if (square) { const side = Math.min(w, h); w = side; h = side; }
      rect.x = x; rect.y = y; rect.w = w; rect.h = h;
    }
    positionCropBox();
  }

  function onUp() {
    dragging = null;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onUp);
  }

  box.addEventListener("mousedown", onDown("move"));
  box.addEventListener("touchstart", onDown("move"), { passive: false });
  box.querySelectorAll(".crop-handle").forEach((h) => {
    h.addEventListener("mousedown", (e) => { e.stopPropagation(); onDown(h.dataset.handle)(e); });
    h.addEventListener("touchstart", (e) => { e.stopPropagation(); onDown(h.dataset.handle)(e); }, { passive: false });
  });

  window.addEventListener("resize", () => positionCropBox());
}

/* ---------- 10. DOWNLOAD SYSTEM ---------- */

function buildDownloadPanel() {
  // Rendered permanently at the bottom of the tool panel, outside the per-tool sections.
  const box = document.createElement("div");
  box.className = "download-box";
  box.innerHTML = `
    <hr class="divider">
    <div class="field-row">
      <label for="downloadFilename">Filename</label>
      <input type="text" id="downloadFilename" value="my-image">
    </div>
    <div class="field-row">
      <label for="downloadFormat">Format</label>
      <select id="downloadFormat">
        <option value="jpeg">JPG</option>
        <option value="png">PNG</option>
        <option value="webp">WEBP</option>
      </select>
    </div>
    <div class="result-box" id="downloadPreview"></div>
    <button class="btn btn-primary btn-block" id="downloadBtn">Download Image</button>
  `;
  document.getElementById("toolPanel").appendChild(box);

  const filenameInput = box.querySelector("#downloadFilename");
  const formatSelect = box.querySelector("#downloadFormat");
  const preview = box.querySelector("#downloadPreview");
  formatSelect.value = state.outputFormat;

  async function refreshPreview() {
    const fmt = formatSelect.value;
    const quality = window.__imageQuality || 0.92;
    canvas.toBlob((blob) => {
      const size = blob ? blob.size : 0;
      const dims = state.dpiHint ? ` (${(canvas.width / state.dpiHint * 2.54).toFixed(1)} × ${(canvas.height / state.dpiHint * 2.54).toFixed(1)} cm)` : "";
      preview.innerHTML = `
        <div class="row"><span>Pixels</span><span>${canvas.width} × ${canvas.height} px${dims}</span></div>
        <div class="row"><span>File size</span><span>${formatBytes(size)}</span></div>
      `;
    }, mimeFor(fmt), quality);
  }
  formatSelect.addEventListener("change", refreshPreview);
  const obs = new MutationObserver(refreshPreview);
  obs.observe(canvas, { attributes: true });
  refreshPreview();
  document.getElementById("editorSection").addEventListener("click", () => setTimeout(refreshPreview, 50));

  box.querySelector("#downloadBtn").addEventListener("click", () => {
    const name = (filenameInput.value.trim() || "my-image").replace(/[^a-z0-9-_]+/gi, "-");
    const fmt = formatSelect.value;
    downloadImage(name, fmt);
  });
}

function downloadImage(filename, fmt) {
  const quality = window.__imageQuality || 0.92;
  let sourceCanvas = canvas;
  if (fmt === "jpeg") {
    // Ensure no transparency leaks into JPG output.
    const off = document.createElement("canvas");
    off.width = canvas.width; off.height = canvas.height;
    const offCtx = off.getContext("2d");
    offCtx.fillStyle = "#FFFFFF";
    offCtx.fillRect(0, 0, off.width, off.height);
    offCtx.drawImage(canvas, 0, 0);
    sourceCanvas = off;
  }
  sourceCanvas.toBlob((blob) => {
    if (!blob) { showToast("Something went wrong preparing your download. Please try again.", "error"); return; }
    const ext = fmt === "jpeg" ? "jpg" : fmt;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast(`Downloaded ${filename}.${ext}`, "success");
  }, mimeFor(fmt), quality);
}

/* ---------- 11. INIT ---------- */

function exportImage(fmt, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, mimeFor(fmt), quality));
}

function displayImageInfo() { renderInfoPanel(); }

window.addEventListener("error", (e) => {
  // Never surface raw JS errors to normal users.
  hideProcessing();
  console.error(e.error || e.message);
  showToast("Something went wrong while processing your image. Please try again.", "error");
});

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initNav();
  initUpload();
  initEditorToolbar();
  initToolSearch();
  renderToolsGrid();
  initToolsGridFilter();
  buildDownloadPanel();
  initProjectLinks();
});

// "My Projects" links are placeholders until real URLs are wired in —
// intercept clicks so they don't just jump to the top of the page.
function initProjectLinks() {
  document.querySelectorAll('a[data-project]').forEach((link) => {
    if (link.getAttribute("href") && link.getAttribute("href") !== "#") return;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      showToast("Project link coming soon.");
    });
  });
}

/* ---------- ICONS (inline SVG strings, kept at bottom for readability) ---------- */
function iconResize() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`; }
function iconRuler() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17 17 3l4 4L7 21l-4-4Z"/><path d="M8 12l2 2M11 9l2 2M14 6l2 2"/></svg>`; }
function iconCompress() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v4a1 1 0 0 1-1 1H3M16 3v4a1 1 0 0 0 1 1h4M8 21v-4a1 1 0 0 0-1-1H3M16 21v-4a1 1 0 0 1 1-1h4"/></svg>`; }
function iconCrop() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2"/></svg>`; }
function iconRotate() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>`; }
function iconFlip() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M17 8l3 4-3 4M7 8l-3 4 3 4"/></svg>`; }
function iconConvert() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/></svg>`; }
function iconQuality() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18"/></svg>`; }
function iconBrightness() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/></svg>`; }
function iconContrast() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor" stroke="none"/></svg>`; }
function iconSaturation() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2s7 7.5 7 12a7 7 0 0 1-14 0c0-4.5 7-12 7-12Z"/></svg>`; }
function iconGrayscale() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3v18"/></svg>`; }
function iconBlur() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="7" cy="8" r="1.4"/><circle cx="13" cy="6" r="1.4"/><circle cx="17" cy="11" r="1.4"/><circle cx="8" cy="15" r="1.4"/><circle cx="15" cy="17" r="1.4"/></svg>`; }
function iconSharpen() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z"/></svg>`; }
function iconText() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>`; }
function iconWatermark() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 15l3-4 2 2 3-5 3 7" opacity="0.6"/></svg>`; }
function iconBackground() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>`; }
function iconMetadata() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M9 15l2 2 4-4"/></svg>`; }
function iconInfo() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/></svg>`; }
function iconPreset() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="9" height="12" rx="1"/><rect x="15" y="8" width="5" height="7" rx="1"/><path d="M7 7h3M7 10h3"/></svg>`; }

function iconSepia() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="14" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M3 15l5-4 4 3 4-5 5 6"/></svg>`; }
function iconInvert() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/></svg>`; }
function iconThreshold() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="8" height="18" fill="currentColor" stroke="none"/><rect x="13" y="3" width="8" height="18"/></svg>`; }
function iconVignette() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="3"/><ellipse cx="12" cy="12" rx="5" ry="4" opacity="0.5"/></svg>`; }
function iconPixelate() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="3" y="3" width="6" height="6"/><rect x="10" y="10" width="6" height="6"/><rect x="17" y="3" width="4" height="4" opacity="0.5"/><rect x="3" y="15" width="4" height="4" opacity="0.5"/><rect x="17" y="17" width="4" height="4"/></svg>`; }
function iconPosterize() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3 6 6 1-4.5 4.5L18 20l-6-3-6 3 1.5-6.5L3 9l6-1 3-6Z"/></svg>`; }
function iconEmboss() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 16c1.5-4 3-9 8-9"/></svg>`; }
function iconEdge() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/></svg>`; }
function iconTint() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2s7 7.5 7 12a7 7 0 0 1-14 0c0-4.5 7-12 7-12Z" fill="currentColor" opacity="0.25"/></svg>`; }
function iconExposure() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`; }
function iconTemperature() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 14.76V4a2 2 0 0 0-4 0v10.76a4 4 0 1 0 4 0Z"/></svg>`; }
function iconHue() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9c0-1.5-1-2-2-2s-2 1-3.5 1S13 9.5 13 8s1-2.5 1-3.5S13.5 3 12 3Z"/></svg>`; }
function iconGamma() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l6 9v7M20 4l-6 9"/></svg>`; }
function iconVibrance() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/><circle cx="12" cy="12" r="3"/></svg>`; }
function iconBorder() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><rect x="3" y="3" width="18" height="18" rx="1"/></svg>`; }
function iconRounded() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="7"/></svg>`; }
function iconShadow() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="3" width="13" height="13" rx="2"/><rect x="7" y="6" width="13" height="13" rx="2" opacity="0.35"/></svg>`; }
function iconMirror() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M5 8l2 4-2 4M19 8l-2 4 2 4" opacity="0.6"/></svg>`; }
function iconNoise() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="6" r="1"/><circle cx="11" cy="4" r="1"/><circle cx="17" cy="8" r="1"/><circle cx="7" cy="12" r="1"/><circle cx="14" cy="14" r="1"/><circle cx="19" cy="17" r="1"/><circle cx="4" cy="18" r="1"/><circle cx="10" cy="19" r="1"/></svg>`; }
function iconDuotone() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="9" height="18" fill="currentColor" opacity="0.85" stroke="none"/><rect x="12" y="3" width="9" height="18" opacity="0.3" fill="currentColor" stroke="none"/></svg>`; }
function iconAspect() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="7" width="8" height="8"/><rect x="14" y="4" width="7" height="14"/></svg>`; }
function iconCenter() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2"><rect x="2" y="2" width="20" height="20" rx="2"/><rect x="8" y="8" width="8" height="8" stroke-dasharray="0" fill="currentColor" stroke="none"/></svg>`; }