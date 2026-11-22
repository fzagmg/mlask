const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static(__dirname));

function cleanUrl(url = '') {
  return String(url || '').trim().replace(/\/+$/, '');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Panggil Ollama (/api/chat) di VPS 1 atau VPS 2
async function callOllamaChat(baseUrl, model, messages, options = {}) {
  const target = cleanUrl(baseUrl);
  if (!target) throw new Error('URL VPS Ollama belum diisi.');

  const res = await fetchWithTimeout(
    `${target}/api/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          num_ctx: options.numCtx || 8192,
          temperature: options.temperature ?? 0.2
        }
      })
    },
    options.timeoutMs || 180000
  );

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Ollama (${target}) HTTP ${res.status}: ${txt}`);
  }

  const data = await res.json();
  return data?.message?.content || '';
}

// Panggil Hermes Agent di VPS 3 untuk menulis kode, menjalankan tes, dan memperbaiki error
async function callHermesVps(hermesUrl, hermesModel, taskPrompt, options = {}) {
  const target = cleanUrl(hermesUrl);
  if (!target) {
    throw new Error('URL VPS 3 (Hermes) belum diisi.');
  }

  const structuredTaskPrompt = [
    taskPrompt,
    '',
    'INSTRUKSI EKSEKUSI & PENGUJIAN LANGSUNG:',
    '1. Buat/perbarui seluruh file proyek yang diperlukan secara lengkap dan rapi.',
    '2. Jalankan langsung perintah build, syntax check, atau unit test/eksekusi di workspace sebelum menyimpulkan.',
    '3. Jika ditemukan error atau test gagal, perbaiki kode lalu jalankan ulang pengujian hingga berhasil tanpa error.',
    '4. Kembalikan laporan hasil akhir yang mencakup: (a) daftar file & isi kode utama, (b) perintah & hasil pengujian langsung (stdout/stderr), serta (c) catatan cara menjalankan proyek.'
  ].join('\n');

  const endpoints = [
    {
      path: '/api/hermes',
      body: {
        prompt: structuredTaskPrompt,
        model: hermesModel || undefined,
        workDir: options.workDir || `project_${Date.now()}`,
        runTests: true,
        num_ctx: Math.max(options.numCtx || 8192, 8192)
      }
    },
    {
      path: '/v1/chat/completions',
      body: {
        model: hermesModel || 'hermes',
        messages: [
          {
            role: 'system',
            content: 'Kamu adalah Hermes Agent coding engineer. Tulis kode proyek yang lengkap, jalankan pengujian langsung, perbaiki error sampai lolos tes, dan sertakan hasil pengujian serta kode lengkapnya.'
          },
          { role: 'user', content: structuredTaskPrompt }
        ],
        stream: false
      }
    }
  ];

  let lastErr = null;
  for (const ep of endpoints) {
    try {
      // Timeout 10 menit agar Hermes punya cukup waktu untuk menulis, mengetes, dan memperbaiki loop error
      const res = await fetchWithTimeout(
        `${target}${ep.path}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ep.body)
        },
        options.timeoutMs || 600000
      );

      if ([404, 405].includes(res.status)) {
        lastErr = new Error(`Endpoint ${ep.path} mengembalikan HTTP ${res.status}`);
        continue;
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Hermes VPS (${target}${ep.path}) HTTP ${res.status}: ${txt}`);
      }

      const data = await res.json();
      const output =
        data?.reply ||
        data?.output ||
        data?.result ||
        data?.message?.content ||
        data?.choices?.[0]?.message?.content ||
        '';

      if (!output) {
        throw new Error('Respons dari VPS Hermes kosong.');
      }
      return String(output);
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('Proses coding & testing di VPS Hermes melebihi batas waktu (10 menit).');
      }
      lastErr = err;
    }
  }

  throw lastErr || new Error('Gagal menghubungi layanan Hermes di VPS 3.');
}

// Log ke Firebase Realtime Database (opsional)
async function logToFirebase(firebaseConfig, payload) {
  const dbUrl = cleanUrl(firebaseConfig?.dbUrl || firebaseConfig?.databaseURL || '');
  if (!firebaseConfig?.enabled || !dbUrl) return;
  try {
    const secret = firebaseConfig.authSecret || firebaseConfig.secret || '';
    const secretQuery = secret ? `?auth=${encodeURIComponent(secret)}` : '';
    await fetchWithTimeout(
      `${dbUrl}/routing_logs.json${secretQuery}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, timestamp: Date.now() })
      },
      10000
    );
  } catch (e) {
    console.warn('Firebase log skipped:', e.message);
  }
}

// Deteksi niat gambar, TTS, dan permintaan pembuatan/pengembangan/perbaikan coding project
function detectIntent(prompt = '', hasImages = false, clientIntent = {}) {
  const p = String(prompt || '').toLowerCase();

  const wantsImageGenOrEdit =
    Boolean(clientIntent.image_gen || clientIntent.image_edit) ||
    /\b(buatkan? gambar|bikin gambar|generate image|edit gambar|ubah gambar|ganti background|lukis|ilustrasi)\b/.test(p);

  const wantsTts =
    Boolean(clientIntent.tts) ||
    /\b(teks ke suara|text to speech|bacakan suara|ubah jadi suara|buatkan suara|voice|tts)\b/.test(p);

  const wantsCodingProject =
    /\b(buat(?:kan|in)?|bikin(?:kan|in)?|bangun(?:kan)?|kembangkan|rancang(?:kan)?|perbaiki|debug|lanjutkan|tes(?:kan)?)\b(?:\s+\S+){0,5}?\s+\b(project|proyek|aplikasi|app|web|website|landing page|dashboard|bot|api|backend|frontend|game|script|skrip|program|fitur|modul|komponen|kode|coding)\b/.test(p) ||
    /\b(coding project|proyek coding|full ?stack|crud|rest api|express|react|next\.?js|vue|python script|bot telegram|bot discord|unit test)\b/.test(p);

  return { hasImages, wantsImageGenOrEdit, wantsTts, wantsCodingProject };
}

// Normalisasi konfigurasi VPS dari payload `index.html` (`mode` + `vps`) maupun format lama (`optionMode` + `vpsConfig`)
function normalizeRequestConfig(body = {}) {
  const rawMode = body.mode || body.optionMode || 'opt1';
  const modeMap = {
    option1: 'opt1',
    option2: 'opt2',
    option3: 'opt3'
  };
  const mode = modeMap[rawMode] || rawMode;

  const vps = body.vps || {};
  const vpsConfig = body.vpsConfig || {};

  const vps1Url =
    vps.coder?.url ||
    vps.daily?.url ||
    vpsConfig.opt1CoderUrl ||
    vpsConfig.opt2DailyUrl ||
    vpsConfig.opt3DailyUrl ||
    process.env.VPS1_URL ||
    '';
  const vps1Model =
    vps.coder?.model ||
    vps.daily?.model ||
    vpsConfig.opt1CoderModel ||
    vpsConfig.opt2DailyModel ||
    vpsConfig.opt3DailyModel ||
    'qwen2.5-coder:7b';

  const vps2Url =
    vps.vision?.url ||
    vps.image?.url ||
    vpsConfig.opt1VisionUrl ||
    vpsConfig.opt2ImageUrl ||
    process.env.VPS2_URL ||
    '';
  const vps2Model =
    vps.vision?.model ||
    vps.image?.model ||
    vpsConfig.opt1VisionModel ||
    vpsConfig.opt2ImageModel ||
    'qwen3.5:4b';

  const vps3Url =
    vps.hermes?.url ||
    vpsConfig.hermesUrl ||
    vpsConfig.opt3VoiceUrl ||
    process.env.VPS3_HERMES_URL ||
    '';
  const vps3Model =
    vps.hermes?.model ||
    vpsConfig.hermesModel ||
    process.env.VPS3_HERMES_MODEL ||
    '';

  return {
    mode,
    vps1Url,
    vps1Model,
    vps2Url,
    vps2Model,
    vps3Url,
    vps3Model
  };
}

// Alur handoff: AI Sebelumnya -> VPS 3 (Hermes) menulis & menguji kode -> kembali ke AI Sebelumnya -> Pengguna
async function handleCodingProjectWithHermes({
  prompt,
  images = [],
  baseHistory = [],
  numCtx = 8192,
  systemPrompt = '',
  preextractedVisionText = '',
  leadUrl,
  leadModel,
  leadRoleLabel,
  hermesUrl,
  hermesModel,
  trace
}) {
  const contextFromPrevAi = preextractedVisionText
    ? `[Hasil Bacaan Gambar/File dari VPS 2]:\n${preextractedVisionText}\n\n`
    : '';

  // 1. AI sebelumnya menyusun spesifikasi/brief teknis yang terstruktur sebelum dioper ke VPS 3 (Hermes)
  let brief = prompt;
  if (leadUrl) {
    const tBriefStart = Date.now();
    const briefText = await callOllamaChat(
      leadUrl,
      leadModel,
      [
        {
          role: 'system',
          content: `${systemPrompt || 'Kamu asisten AI.'}\nSusun spesifikasi teknis yang jelas dan ringkas untuk diserahkan ke Hermes Agent agar Hermes menulis kode proyek dan menjalankan pengujian langsung. Cantumkan: tujuan utama, fitur inti, stack/bahasa, struktur file, dan skenario uji/verifikasi.`
        },
        ...baseHistory,
        {
          role: 'user',
          content: `${contextFromPrevAi}Permintaan pengguna:\n${prompt}`
        }
      ],
      { numCtx, temperature: 0.2 }
    );
    if (briefText.trim()) {
      brief = `${briefText.trim()}\n\nPermintaan asli pengguna:\n${prompt}`;
    }
    trace.push({
      role: 'coder',
      label: leadRoleLabel,
      model: leadModel,
      ms: Date.now() - tBriefStart,
      note: 'Menyusun spesifikasi teknis & mengoper ke VPS 3 (Hermes)'
    });
  }

  // 2. VPS 3 (Hermes) menulis kode, menjalankan pengujian langsung, dan memperbaiki error
  const tHermesStart = Date.now();
  let hermesResult = '';
  let hermesFailed = false;
  try {
    hermesResult = await callHermesVps(
      hermesUrl,
      hermesModel,
      `${contextFromPrevAi}${brief}`,
      { numCtx: Math.max(numCtx, 8192) }
    );
    trace.push({
      role: 'coder',
      label: 'VPS 3 · Hermes',
      model: hermesModel || 'hermes-agent',
      ms: Date.now() - tHermesStart,
      note: 'Menulis kode, menjalankan test langsung & mengembalikan hasil'
    });
  } catch (err) {
    hermesFailed = true;
    trace.push({
      role: 'coder',
      label: 'VPS 3 · Hermes',
      model: hermesModel || 'hermes-agent',
      ms: Date.now() - tHermesStart,
      status: 'error',
      note: err.message
    });
  }

  // 3. Hasil dari Hermes dikembalikan ke AI sebelumnya untuk dirapikan & diverifikasi sebelum dikirim ke pengguna
  if (leadUrl) {
    const tFinalStart = Date.now();
    const reviewPrompt = hermesFailed
      ? `${contextFromPrevAi}Pengguna meminta:\n${prompt}\n\nCatatan: Pemanggilan ke VPS 3 (Hermes) mengalami kendala. Tolong tetap bantu berikan kode proyek yang lengkap dan langkah pengujiannya agar bisa langsung dijalankan.`
      : `${contextFromPrevAi}Pengguna meminta:\n${prompt}\n\nBerikut hasil pengerjaan dan pengujian langsung dari VPS 3 (Hermes Agent):\n---\n${hermesResult}\n---\nTugasmu: periksa kelengkapan hasil dari Hermes, rapikan penyajiannya agar mudah dibaca seperti asisten coding tingkat lanjut, sertakan kode utama/struktur file, ringkasan hasil pengujian langsung, serta cara menjalankan/mengujinya dalam bahasa Indonesia.`;

    const finalReply = await callOllamaChat(
      leadUrl,
      leadModel,
      [
        {
          role: 'system',
          content: systemPrompt || 'Kamu adalah asisten AI coding yang merapikan hasil implementasi dan pengujian kode secara jelas, akurat, dan siap pakai.'
        },
        ...baseHistory,
        { role: 'user', content: reviewPrompt }
      ],
      { numCtx, temperature: 0.2, ...(images.length ? { images } : {}) }
    );

    trace.push({
      role: 'coder',
      label: leadRoleLabel,
      model: leadModel,
      ms: Date.now() - tFinalStart,
      note: 'Merapikan hasil pengujian & kode untuk pengguna'
    });
    return finalReply;
  }

  if (hermesFailed) {
    throw new Error('VPS 3 (Hermes) gagal memproses permintaan dan tidak ada AI cadangan untuk merespons.');
  }
  return hermesResult;
}

// Helper menulis event NDJSON bila klien meminta stream: true
function writeNdjsonEvent(res, obj) {
  res.write(`${JSON.stringify(obj)}\n`);
}

app.post('/api/route', async (req, res) => {
  const startTime = Date.now();
  const wantsStream = Boolean(req.body.stream);

  // Mendukung ping pengecekan router dari index.html
  if (req.body.ping) {
    return res.status(200).json({ ok: true, service: 'instabox-4vps-router' });
  }

  if (wantsStream) {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
  }

  // Jaga koneksi tetap hidup (keep-alive) saat VPS 3 sedang menulis & mengetes proyek lama
  const heartbeat = wantsStream
    ? setInterval(() => {
        try { res.write('\n'); } catch (_) {}
      }, 15000)
    : null;

  try {
    const {
      prompt = '',
      images = [],
      history = [],
      messages = [],
      numCtx = 8192,
      systemPrompt = '',
      intent: clientIntent = {},
      firebase = null
    } = req.body;

    const cfg = normalizeRequestConfig(req.body);
    const hasImages = Array.isArray(images) && images.length > 0;
    const intent = detectIntent(prompt, hasImages, clientIntent);
    const trace = [];
    let finalReply = '';
    let audioUrl = null;
    let generatedImages = [];

    const sourceHistory = Array.isArray(history) && history.length > 0
      ? history
      : (Array.isArray(messages) ? messages.filter(m => m.role !== 'system') : []);

    const baseHistory = sourceHistory.slice(-10).map(m => ({
      role: m.role,
      content: m.content,
      ...(Array.isArray(m.images) && m.images.length ? { images: m.images } : {})
    }));

    // Jika ada gambar/screenshot/dokumen -> baca dulu di VPS 2 (qwen3.5:4b)
    let extractedVisionText = '';
    if (hasImages && cfg.vps2Url) {
      const tVis = Date.now();
      extractedVisionText = await callOllamaChat(
        cfg.vps2Url,
        cfg.vps2Model,
        [
          {
            role: 'system',
            content: 'Kamu adalah pembaca gambar/screenshot/dokumen di VPS 2. Ekstrak seluruh teks, baris kode, pesan error, dan detail visual secara akurat dalam bahasa Indonesia.'
          },
          {
            role: 'user',
            content: prompt || 'Baca gambar ini secara detail.',
            images
          }
        ],
        { numCtx }
      );
      const visStep = {
        role: 'vision',
        label: 'VPS 2 · Vision',
        model: cfg.vps2Model,
        ms: Date.now() - tVis,
        note: 'Membaca gambar/file'
      };
      trace.push(visStep);
      if (wantsStream) writeNdjsonEvent(res, { trace: visStep });
    }

    // Jika permintaan berupa proyek/kode/debugging -> oper ke VPS 3 (Hermes) lalu balik ke AI sebelumnya
    if (intent.wantsCodingProject && cfg.vps3Url) {
      const leadUrl = hasImages && cfg.vps2Url ? cfg.vps2Url : cfg.vps1Url;
      const leadModel = hasImages && cfg.vps2Url ? cfg.vps2Model : cfg.vps1Model;
      const leadRoleLabel = hasImages && cfg.vps2Url ? 'VPS 2 · Harian' : 'VPS 1 · Coder';

      const prevTraceLen = trace.length;
      finalReply = await handleCodingProjectWithHermes({
        prompt,
        images,
        baseHistory,
        numCtx,
        systemPrompt,
        preextractedVisionText: extractedVisionText,
        leadUrl,
        leadModel,
        leadRoleLabel,
        hermesUrl: cfg.vps3Url,
        hermesModel: cfg.vps3Model,
        trace
      });
      if (wantsStream) {
        trace.slice(prevTraceLen).forEach(step => writeNdjsonEvent(res, { trace: step }));
      }
    }
    // Jika ada gambar (bukan proyek kode) -> teruskan hasil bacaan VPS 2 ke VPS 1
    else if (hasImages) {
      if (cfg.vps1Url) {
        const tC = Date.now();
        finalReply = await callOllamaChat(
          cfg.vps1Url,
          cfg.vps1Model,
          [
            {
              role: 'system',
              content: systemPrompt || 'Kamu adalah asisten AI yang menjawab pertanyaan dan membantu coding berdasarkan hasil pembacaan gambar/file.'
            },
            ...baseHistory,
            {
              role: 'user',
              content: `${prompt || 'Tolong bantu analisis gambar ini.'}\n\n[Hasil Bacaan VPS 2 (${cfg.vps2Model})]:\n${extractedVisionText}`
            }
          ],
          { numCtx }
        );
        const cStep = {
          role: 'coder',
          label: 'VPS 1 · Coder',
          model: cfg.vps1Model,
          ms: Date.now() - tC,
          note: 'Menjawab berdasarkan hasil bacaan VPS 2'
        };
        trace.push(cStep);
        if (wantsStream) writeNdjsonEvent(res, { trace: cStep });
      } else {
        finalReply = extractedVisionText;
      }
    }
    // Pertanyaan / chat sehari-hari
    else {
      const primaryUrl = cfg.vps1Url || cfg.vps2Url;
      const primaryModel = cfg.vps1Url ? cfg.vps1Model : cfg.vps2Model;
      const primaryRole = cfg.vps1Url ? 'coder' : 'daily';
      const primaryLabel = cfg.vps1Url ? 'VPS 1 · Coder' : 'VPS 2 · Harian';

      const t1 = Date.now();
      const firstReply = await callOllamaChat(
        primaryUrl,
        primaryModel,
        [
          {
            role: 'system',
            content: `${systemPrompt || 'Kamu adalah asisten AI sehari-hari.'}\nJika pertanyaan membutuhkan pembacaan gambar/visual yang belum tersedia, awali dengan "[OPER_VPS2]". Jika bisa kamu jawab langsung, jawab langsung.`
          },
          ...baseHistory,
          { role: 'user', content: prompt }
        ],
        { numCtx }
      );
      const step1 = {
        role: primaryRole,
        label: primaryLabel,
        model: primaryModel,
        ms: Date.now() - t1,
        note: 'Memproses pertanyaan sehari-hari'
      };
      trace.push(step1);
      if (wantsStream) writeNdjsonEvent(res, { trace: step1 });

      if (firstReply.startsWith('[OPER_VPS2]') && cfg.vps2Url) {
        const t2 = Date.now();
        finalReply = await callOllamaChat(
          cfg.vps2Url,
          cfg.vps2Model,
          [
            { role: 'system', content: systemPrompt || 'Bantu jawab pertanyaan lanjutan.' },
            { role: 'user', content: `${prompt}\n\nCatatan: ${firstReply.replace('[OPER_VPS2]', '').trim()}` }
          ],
          { numCtx }
        );
        const step2 = {
          role: 'vision',
          label: 'VPS 2 · Harian',
          model: cfg.vps2Model,
          ms: Date.now() - t2,
          note: 'Menerima operan lanjutan'
        };
        trace.push(step2);
        if (wantsStream) writeNdjsonEvent(res, { trace: step2 });
      } else {
        finalReply = firstReply;
      }
    }

    const durationMs = Date.now() - startTime;
    await logToFirebase(firebase, {
      mode: cfg.mode,
      trace,
      durationMs,
      hasImages,
      wantsCodingProject: intent.wantsCodingProject
    });

    if (heartbeat) clearInterval(heartbeat);

    if (wantsStream) {
      writeNdjsonEvent(res, {
        message: { content: finalReply },
        trace,
        audioUrl,
        generatedImages,
        durationMs
      });
      return res.end();
    }

    return res.json({
      reply: finalReply,
      trace,
      audioUrl,
      generatedImages,
      durationMs
    });
  } catch (err) {
    if (heartbeat) clearInterval(heartbeat);
    const errMsg = err.message || 'Terjadi kesalahan saat routing antar-VPS.';
    if (wantsStream) {
      writeNdjsonEvent(res, { error: errMsg });
      return res.end();
    }
    return res.status(500).json({ error: errMsg });
  }
});

const server = app.listen(PORT, () => {
  console.log(`InstaBox 4-VPS AI Router berjalan di http://0.0.0.0:${PORT}`);
});

// Perpanjang batas waktu koneksi HTTP agar proses coding & testing di Hermes tidak terpotong timeout
server.requestTimeout = 660000;
server.headersTimeout = 670000;
server.keepAliveTimeout = 660000;