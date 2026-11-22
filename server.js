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

// Panggil Ollama (/api/chat)
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

// Coba panggil endpoint /api/tts pada VPS tertentu
async function tryCallTtsEndpoint(vpsUrl, text, model = 'tts', timeoutMs = 60000) {
  const target = cleanUrl(vpsUrl);
  if (!target) return null;

  const res = await fetchWithTimeout(
    `${target}/api/tts`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model })
    },
    timeoutMs
  );

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`TTS (${target}) HTTP ${res.status}: ${txt}`);
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('audio/')) {
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${contentType};base64,${buf.toString('base64')}`;
  }

  const jsonAudio = await res.json().catch(() => ({}));
  if (jsonAudio.audioBase64) return `data:audio/wav;base64,${jsonAudio.audioBase64}`;
  if (jsonAudio.audioUrl) return jsonAudio.audioUrl;
  return null;
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
    '1. Tulis kode/file yang diminta secara lengkap, bersih, dan siap pakai.',
    '2. Jalankan langsung perintah build, syntax check, atau pengujian di workspace bila memungkinkan.',
    '3. Jika ada error atau test gagal, perbaiki kode lalu jalankan ulang pengujian hingga berhasil.',
    '4. Kembalikan kode lengkap, ringkasan hasil pengujian, dan cara menjalankannya.'
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
            content: 'Kamu adalah Hermes Agent coding engineer. Tulis kode lengkap, jalankan pengujian langsung, perbaiki error sampai lolos tes, dan sertakan hasil pengujian serta kode lengkapnya.'
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

// Deteksi niat: gambar, TTS, dan permintaan pembuatan/penulisan/perbaikan kode
function detectIntent(prompt = '', hasImages = false, clientIntent = {}) {
  const p = String(prompt || '').toLowerCase();

  const wantsTts =
    Boolean(clientIntent.tts) ||
    /\b(tts|text[\s-]?to[\s-]?speech|teks ke suara|bacakan suara|ubah jadi suara|buatkan suara|voice)\b/.test(p);

  const wantsCode =
    !wantsTts && (
      /\b(buat(?:kan|in)?|bikin(?:kan|in)?|bangun(?:kan)?|kembangkan|rancang(?:kan)?|tulis(?:kan)?|perbaiki|debug|lanjutkan|tes(?:kan)?|refactor)\b(?:\s+\S+){0,5}?\s+\b(kode|code|coding|project|proyek|aplikasi|app|web|website|landing page|dashboard|bot|api|backend|frontend|game|script|skrip|program|fitur|modul|komponen|fungsi|class|query|sql|css|html|js|ts|python)\b/.test(p) ||
      /\b(coding project|proyek coding|full ?stack|crud|rest api|express|react|next\.?js|vue|python script|bot telegram|bot discord|unit test|source code)\b/.test(p)
    );

  return { hasImages, wantsTts, wantsCode };
}

function normalizeVpsConfig(body = {}) {
  const vps = body.vps || {};
  const vpsConfig = body.vpsConfig || {};

  return {
    vps1Url: vps.vps1?.url || vps.coder?.url || vpsConfig.vps1Url || process.env.VPS1_URL || '',
    vps1Model: vps.vps1?.model || vps.coder?.model || vpsConfig.vps1Model || 'qwen2.5-coder:7b',
    vps2Url: vps.vps2?.url || vps.vision?.url || vpsConfig.vps2Url || process.env.VPS2_URL || '',
    vps2Model: vps.vps2?.model || vps.vision?.model || vpsConfig.vps2Model || 'qwen3.5:4b',
    vps3Url: vps.vps3?.url || vps.hermes?.url || vpsConfig.vps3Url || process.env.VPS3_HERMES_URL || '',
    vps3Model: vps.vps3?.model || vps.hermes?.model || vpsConfig.vps3Model || ''
  };
}

// Alur pembuatan/penulisan kode -> dikirim ke VPS 3 (Hermes), lalu dirapikan lewat VPS 1 / VPS 2 jika tersedia
async function handleCodeWithHermes({
  prompt,
  images = [],
  baseHistory = [],
  numCtx = 8192,
  systemPrompt = '',
  preextractedVisionText = '',
  cfg,
  trace
}) {
  const contextFromVision = preextractedVisionText
    ? `[Hasil Bacaan Gambar/File dari VPS 2]:\n${preextractedVisionText}\n\n`
    : '';

  const tHermes = Date.now();
  const hermesResult = await callHermesVps(
    cfg.vps3Url,
    cfg.vps3Model,
    `${contextFromVision}Permintaan kode pengguna:\n${prompt}`,
    { numCtx: Math.max(numCtx, 8192) }
  );
  trace.push({
    role: 'coder',
    label: 'VPS 3 · Hermes',
    model: cfg.vps3Model || 'hermes-agent',
    ms: Date.now() - tHermes,
    note: 'Menulis & menguji kode secara otomatis di VPS 3'
  });

  const polishUrl = cfg.vps1Url || cfg.vps2Url;
  const polishModel = cfg.vps1Url ? cfg.vps1Model : cfg.vps2Model;
  const polishLabel = cfg.vps1Url ? 'VPS 1' : 'VPS 2';

  if (polishUrl) {
    try {
      const tPolish = Date.now();
      const polished = await callOllamaChat(
        polishUrl,
        polishModel,
        [
          {
            role: 'system',
            content: `${systemPrompt || 'Kamu asisten AI.'}\nRapikan dan sajikan hasil kode + pengujian dari Hermes secara jelas, lengkap, dan mudah diikuti dalam bahasa Indonesia tanpa mengurangi detail kode penting.`
          },
          ...baseHistory,
          {
            role: 'user',
            content: `${contextFromVision}Permintaan pengguna:\n${prompt}\n\nHasil dari VPS 3 (Hermes):\n---\n${hermesResult}\n---`
          }
        ],
        { numCtx, temperature: 0.2, ...(images.length ? { images } : {}) }
      );
      trace.push({
        role: 'coder',
        label: polishLabel,
        model: polishModel,
        ms: Date.now() - tPolish,
        note: 'Merapikan hasil kode dari VPS 3'
      });
      return polished || hermesResult;
    } catch (_) {
      return hermesResult;
    }
  }

  return hermesResult;
}

function writeNdjsonEvent(res, obj) {
  res.write(`${JSON.stringify(obj)}\n`);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'instabox-auto-router' });
});

app.post('/api/route', async (req, res) => {
  const startTime = Date.now();
  const wantsStream = Boolean(req.body.stream);

  if (req.body.ping) {
    return res.status(200).json({ ok: true, service: 'instabox-auto-router' });
  }

  if (wantsStream) {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
  }

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

    const cfg = normalizeVpsConfig(req.body);
    const hasImages = Array.isArray(images) && images.length > 0;
    const intent = detectIntent(prompt, hasImages, clientIntent);
    // Setiap langkah trace langsung dikirim ke UI (NDJSON) begitu ditambahkan
    const trace = [];
    const originalPush = trace.push.bind(trace);
    trace.push = (...steps) => {
      const n = originalPush(...steps);
      if (wantsStream && !res.writableEnded) {
        steps.forEach(step => writeNdjsonEvent(res, { trace: step }));
      }
      return n;
    };
    const notify = (text) => {
      if (wantsStream && !res.writableEnded) writeNdjsonEvent(res, { progress: text });
    };
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

    // 1. Jika ada gambar: VPS 1 tidak membaca gambar -> otomatis oper ke VPS 2
    let extractedVisionText = '';
    if (hasImages) {
      if (!cfg.vps2Url) {
        throw new Error('Gambar terdeteksi: VPS 1 tidak membaca gambar, tetapi URL VPS 2 belum diisi.');
      }
      trace.push({
        role: 'coder',
        label: 'VPS 1',
        model: cfg.vps1Model,
        note: 'Tidak membaca gambar -> otomatis oper ke VPS 2'
      });
      notify('VPS 2 sedang membaca gambar…');
      const tVis = Date.now();
      extractedVisionText = await callOllamaChat(
        cfg.vps2Url,
        cfg.vps2Model,
        [
          {
            role: 'system',
            content: 'Kamu adalah pembaca gambar/file di VPS 2. Ekstrak seluruh teks, kode, error, dan detail visual secara akurat dalam bahasa Indonesia.'
          },
          {
            role: 'user',
            content: prompt || 'Baca gambar ini secara detail.',
            images
          }
        ],
        { numCtx }
      );
      trace.push({
        role: 'vision',
        label: 'VPS 2',
        model: cfg.vps2Model,
        ms: Date.now() - tVis,
        note: 'Membaca gambar/file'
      });
    }

    // 2. Jika permintaan membuat/menulis/memperbaiki kode -> kirim ke VPS 3 (Hermes)
    if (intent.wantsCode) {
      if (!cfg.vps3Url) {
        throw new Error('Permintaan kode terdeteksi, tetapi URL VPS 3 (Hermes) belum diisi di Setelan.');
      }
      notify('VPS 3 (Hermes) sedang menulis & menguji kode — bisa memakan beberapa menit…');
      finalReply = await handleCodeWithHermes({
        prompt,
        images,
        baseHistory,
        numCtx,
        systemPrompt,
        preextractedVisionText: extractedVisionText,
        cfg,
        trace
      });
    }
    // 3. Jika Text-to-Speech (TTS): VPS 1 mengoper ke VPS 2; jika VPS 2 gagal/tidak bisa jawab -> oper ke VPS 3
    else if (intent.wantsTts) {
      let spokenText = String(prompt || '')
        .replace(/^(bacakan|ubah ke suara|teks ke suara|tts)\s*:?/i, '')
        .trim();

      let vps2Answered = false;
      if (cfg.vps2Url) {
        const t2 = Date.now();
        try {
          const v2Out = await callOllamaChat(
            cfg.vps2Url,
            cfg.vps2Model,
            [
              {
                role: 'system',
                content: 'Kamu adalah asisten TTS di VPS 2. Siapkan teks bersih yang siap diucapkan untuk permintaan TTS pengguna. Jika kamu tidak bisa memenuhi permintaan ini, balas dengan "[GAGAL_JAWAB]".'
              },
              ...baseHistory,
              { role: 'user', content: prompt }
            ],
            { numCtx, timeoutMs: 60000 }
          );

          if (!v2Out || v2Out.trim().startsWith('[GAGAL_JAWAB]')) {
            throw new Error('VPS 2 tidak bisa menjawab permintaan TTS');
          }

          spokenText = v2Out.trim();
          vps2Answered = true;
          trace.push({
            role: 'daily',
            label: 'VPS 2',
            model: cfg.vps2Model,
            ms: Date.now() - t2,
            note: 'Menerima operan TTS dari VPS 1'
          });

          try {
            audioUrl = await tryCallTtsEndpoint(cfg.vps2Url, spokenText, 'tts', 45000);
          } catch (_) {
            // Jika VPS 2 tidak punya /api/tts, lanjut ke fallback VPS 3 bila tersedia
          }
        } catch (err2) {
          trace.push({
            role: 'daily',
            label: 'VPS 2',
            model: cfg.vps2Model,
            ms: Date.now() - t2,
            status: 'error',
            note: 'VPS 2 tidak bisa menjawab -> otomatis oper ke VPS 3'
          });
        }
      }

      if ((!vps2Answered || !audioUrl) && cfg.vps3Url) {
        const t3 = Date.now();
        try {
          if (!audioUrl) {
            try {
              audioUrl = await tryCallTtsEndpoint(cfg.vps3Url, spokenText, 'tts', 60000);
            } catch (_) {}
          }
          if (!vps2Answered) {
            const v3Out = await callHermesVps(
              cfg.vps3Url,
              cfg.vps3Model,
              `VPS 2 tidak bisa menjawab permintaan TTS berikut. Tolong jawab dan siapkan teks/hasil terbaik untuk pengguna:\n${prompt}`,
              { numCtx }
            );
            spokenText = v3Out;
          }
          trace.push({
            role: 'coder',
            label: 'VPS 3 · Hermes',
            model: cfg.vps3Model || 'hermes-agent',
            ms: Date.now() - t3,
            note: 'Menangani operan lanjutan TTS dari VPS 2'
          });
        } catch (err3) {
          trace.push({
            role: 'coder',
            label: 'VPS 3 · Hermes',
            model: cfg.vps3Model || 'hermes-agent',
            ms: Date.now() - t3,
            status: 'error',
            note: err3.message
          });
        }
      }

      finalReply = audioUrl
        ? `Audio TTS siap diputar:\n\n> ${spokenText}`
        : spokenText || 'Permintaan TTS telah diproses.';
    }
    // 4. Jika ada gambar (bukan kode & bukan TTS) -> hasil bacaan VPS 2 diteruskan ke VPS 1 (atau langsung dari VPS 2)
    else if (hasImages) {
      if (cfg.vps1Url) {
        const t1 = Date.now();
        try {
          notify('VPS 1 menyusun jawaban dari hasil bacaan VPS 2…');
          finalReply = await callOllamaChat(
            cfg.vps1Url,
            cfg.vps1Model,
            [
              {
                role: 'system',
                content: systemPrompt || 'Kamu adalah asisten AI. Jawab pertanyaan pengguna berdasarkan hasil pembacaan gambar/file dari VPS 2 secara jelas dalam bahasa Indonesia.'
              },
              ...baseHistory,
              {
                role: 'user',
                content: `${prompt || 'Tolong jelaskan isi gambar ini.'}\n\n[Hasil Bacaan VPS 2 (${cfg.vps2Model})]:\n${extractedVisionText}`
              }
            ],
            { numCtx }
          );
          trace.push({
            role: 'coder',
            label: 'VPS 1',
            model: cfg.vps1Model,
            ms: Date.now() - t1,
            note: 'Menjawab berdasarkan hasil bacaan VPS 2'
          });
        } catch (e1) {
          finalReply = extractedVisionText;
          trace.push({
            role: 'coder',
            label: 'VPS 1',
            model: cfg.vps1Model,
            ms: Date.now() - t1,
            status: 'error',
            note: 'VPS 1 gagal -> memakai hasil bacaan VPS 2 langsung'
          });
        }
      } else {
        finalReply = extractedVisionText;
      }
    }
    // 5. Chat / pertanyaan sehari-hari biasa -> VPS 1 (dengan fallback ke VPS 2 jika perlu)
    else {
      let vps1Answered = false;
      if (!cfg.vps1Url && !cfg.vps2Url) {
        throw new Error('URL VPS 1 / VPS 2 belum diisi di Setelan.');
      }
      notify('VPS 1 sedang menjawab…');
      if (cfg.vps1Url) {
        const t1 = Date.now();
        try {
          const r1 = await callOllamaChat(
            cfg.vps1Url,
            cfg.vps1Model,
            [
              {
                role: 'system',
                content: `${systemPrompt || 'Kamu adalah asisten AI sehari-hari yang ramah dan informatif.'}\nJika pertanyaan membutuhkan pembacaan gambar yang belum ada, awali dengan "[OPER_VPS2]".`
              },
              ...baseHistory,
              { role: 'user', content: prompt }
            ],
            { numCtx }
          );
          trace.push({
            role: 'coder',
            label: 'VPS 1',
            model: cfg.vps1Model,
            ms: Date.now() - t1,
            note: 'Menjawab pertanyaan sehari-hari'
          });

          if (r1.startsWith('[OPER_VPS2]') && cfg.vps2Url) {
            const t2 = Date.now();
            finalReply = await callOllamaChat(
              cfg.vps2Url,
              cfg.vps2Model,
              [
                { role: 'system', content: systemPrompt || 'Bantu jawab pertanyaan lanjutan.' },
                { role: 'user', content: `${prompt}\n\nCatatan: ${r1.replace('[OPER_VPS2]', '').trim()}` }
              ],
              { numCtx }
            );
            trace.push({
              role: 'vision',
              label: 'VPS 2',
              model: cfg.vps2Model,
              ms: Date.now() - t2,
              note: 'Menerima operan lanjutan dari VPS 1'
            });
            vps1Answered = true;
          } else {
            finalReply = r1;
            vps1Answered = true;
          }
        } catch (_) {
          trace.push({
            role: 'coder',
            label: 'VPS 1',
            model: cfg.vps1Model,
            ms: Date.now() - t1,
            status: 'error',
            note: 'VPS 1 gagal -> otomatis oper ke VPS 2'
          });
        }
      }

      if (!vps1Answered && cfg.vps2Url) {
        const t2 = Date.now();
        finalReply = await callOllamaChat(
          cfg.vps2Url,
          cfg.vps2Model,
          [
            { role: 'system', content: systemPrompt || 'Kamu adalah asisten AI sehari-hari.' },
            ...baseHistory,
            { role: 'user', content: prompt }
          ],
          { numCtx }
        );
        trace.push({
          role: 'vision',
          label: 'VPS 2',
          model: cfg.vps2Model,
          ms: Date.now() - t2,
          note: 'Menangani operan dari VPS 1'
        });
      }
    }

    const durationMs = Date.now() - startTime;
    await logToFirebase(firebase, {
      mode: 'auto',
      trace,
      durationMs,
      hasImages,
      wantsCode: intent.wantsCode,
      wantsTts: intent.wantsTts
    });

    if (heartbeat) clearInterval(heartbeat);

    if (wantsStream) {
      writeNdjsonEvent(res, {
        message: { content: finalReply },
        trace,
        audioUrl,
        generatedImages,
        durationMs,
        done: true
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
    const errMsg = err.message || 'Terjadi kesalahan saat routing otomatis antar-VPS.';
    if (wantsStream) {
      writeNdjsonEvent(res, { error: errMsg });
      return res.end();
    }
    return res.status(500).json({ error: errMsg });
  }
});

const server = app.listen(PORT, () => {
  console.log(`InstaBox Auto 3-VPS Router berjalan di http://0.0.0.0:${PORT}`);
});

// Timeout panjang agar proses coding & testing VPS 3 (Hermes) tidak terputus
server.requestTimeout = 660000;
server.headersTimeout = 670000;
server.keepAliveTimeout = 660000;
