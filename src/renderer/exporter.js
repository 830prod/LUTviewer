/*
 * Before / after video export.
 *
 * Frames are rendered by a dedicated WebGL renderer, composited on a 2D canvas
 * (labels + LUTviewer watermark), encoded to H.264 with WebCodecs (hardware
 * accelerated on macOS) and written into an MP4 with mp4-muxer.
 * Video sources are captured in real time while the clip plays; stills are
 * rendered as fast as the encoder accepts frames.
 */
(function (root) {
  'use strict';

  const FPS_STILL = 30;
  // Wipe motion. The split position is the share of the frame showing BEFORE:
  // 0.97 ≈ all before, 0.03 ≈ all after. Each style is one loop of segments
  // [share of the loop, from, to]; a loop starts and ends on the before side.
  const B = 0.97, A = 0.03;
  const WIPE_STYLES = {
    sweep: null, // continuous back-and-forth
    pause: [[0.2, B, B], [0.3, B, A], [0.2, A, A], [0.3, A, B]],
    after: [[0.08, B, B], [0.17, B, A], [0.6, A, A], [0.15, A, B]],
    before: [[0.6, B, B], [0.15, B, A], [0.1, A, A], [0.15, A, B]],
  };
  // Seconds per loop for each speed: the sweep is a simple back-and-forth,
  // the holding styles need a little longer to read.
  const WIPE_PERIODS = {
    sweep: { slow: 8, medium: 4, fast: 2.5 },
    hold: { slow: 10, medium: 6, fast: 4 },
  };
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

  function wipePeriod(style = 'sweep', speed = 'medium') {
    const table = style === 'sweep' ? WIPE_PERIODS.sweep : WIPE_PERIODS.hold;
    return table[speed] || table.medium;
  }

  function wipePosition(t, style = 'sweep', speed = 'medium') {
    const period = wipePeriod(style, speed);
    const phase = (t % period) / period;
    const segments = WIPE_STYLES[style];
    if (!segments) return 0.5 + 0.47 * Math.cos(2 * Math.PI * phase);
    let start = 0;
    for (const [share, from, to] of segments) {
      if (phase <= start + share) return from + (to - from) * ease((phase - start) / share);
      start += share;
    }
    return B;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function pickCodec(width, height, bitrate, framerate) {
    // High, Main, then Baseline profile at a level high enough for 4K-wide frames.
    for (const codec of ['avc1.640033', 'avc1.4d0033', 'avc1.420033']) {
      const config = { codec, width, height, bitrate, framerate, latencyMode: 'quality', avc: { format: 'avc' } };
      try {
        const { supported } = await VideoEncoder.isConfigSupported(config);
        if (supported) return config;
      } catch { /* try the next one */ }
    }
    throw new Error('This Mac cannot encode H.264 video at this size');
  }

  function seek(video, t) {
    return new Promise((resolve) => {
      if (Math.abs(video.currentTime - t) < 0.001) return resolve();
      video.addEventListener('seeked', () => resolve(), { once: true });
      video.currentTime = t;
    });
  }

  /*
   * Builds the frame compositor shared by video and image export: a WebGL renderer
   * for the before / after layout plus a 2D canvas for labels and the watermark.
   * layout: 'wipe' | 'split' | 'side' | 'after'. watermark: 'full' | 'icon' | 'text'.
   */
  async function createCompositor(opts, paneMax) {
    const { source, layout } = opts;
    const el = source.el;
    const srcW = el.videoWidth || el.naturalWidth || el.width;
    const srcH = el.videoHeight || el.naturalHeight || el.height;
    if (!srcW || !srcH) throw new Error('Nothing to export yet');
    const scale = Math.min(1, paneMax / srcW);
    const paneW = even(srcW * scale);
    const H = even(srcH * scale);
    const W = layout === 'side' ? paneW * 2 : paneW;

    const glCanvas = document.createElement('canvas');
    glCanvas.width = W;
    glCanvas.height = H;
    const r = new root.LutRenderer(glCanvas);
    if (opts.lutId && opts.lut) r.addLut(opts.lutId, opts.lut);

    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = out.getContext('2d', { alpha: false });
    const watermark = opts.watermark || 'full';
    const icon = watermark === 'text' ? null : await loadImage('lutv://assets/app-icon.png').catch(() => null);
    const p = { ...opts.params, lutId: opts.lutId, beforeRaw: opts.beforeRaw, showOriginal: false };

    function drawLabel(text, x, y, align) {
      const fs = Math.max(12, Math.round(H * 0.03));
      ctx.font = `600 ${fs}px -apple-system, "SF Pro Text", sans-serif`;
      ctx.letterSpacing = `${(fs * 0.12).toFixed(1)}px`;
      const w = ctx.measureText(text).width;
      const padX = fs * 0.7, padY = fs * 0.45, h = fs + padY * 2;
      const bx = align === 'right' ? x - w - padX * 2 : x;
      ctx.fillStyle = 'rgba(2, 28, 48, 0.62)';
      ctx.beginPath();
      ctx.roundRect(bx, y, w + padX * 2, h, h / 2);
      ctx.fill();
      ctx.fillStyle = '#E9F5FD';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + padX, y + h / 2 + 1);
      ctx.letterSpacing = '0px';
    }

    // Bottom-right mark: icon + name, the .lut icon alone, or just the name.
    function drawWatermark() {
      const m = Math.round(H * 0.03);
      const s = Math.round(H * (watermark === 'icon' ? 0.07 : 0.055));
      const fs = Math.round(s * 0.46);
      const showIcon = watermark !== 'text' && icon;
      const showText = watermark !== 'icon';
      ctx.save();
      ctx.font = `700 ${fs}px -apple-system, "SF Pro Display", sans-serif`;
      const lutW = ctx.measureText('LUT').width;
      ctx.font = `300 ${fs}px -apple-system, "SF Pro Display", sans-serif`;
      const viewerW = ctx.measureText('viewer').width;
      const textW = showText ? lutW + viewerW : 0;
      const gap = showIcon && showText ? s * 0.3 : 0;
      const iconW = showIcon ? s : 0;
      const pad = s * 0.18;
      const padX = showIcon ? pad : s * 0.4;
      const contentW = iconW + gap + textW;
      const x0 = W - m - padX - contentW;
      const y0 = H - m - pad - s;
      ctx.globalAlpha = 0.9;
      // Soft pill behind text so it reads on bright and dark footage alike (the icon tile carries its own).
      if (showText) {
        ctx.fillStyle = 'rgba(2, 28, 48, 0.5)';
        ctx.beginPath();
        ctx.roundRect(x0 - padX, y0 - pad, contentW + padX * (showIcon ? 2.4 : 2), s + pad * 2, (s + pad * 2) / 2.6);
        ctx.fill();
      }
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = s * 0.25;
      if (showIcon) ctx.drawImage(icon, x0, y0, s, s);
      if (showText) {
        const tx = x0 + iconW + gap;
        ctx.fillStyle = '#FFFFFF';
        ctx.textBaseline = 'middle';
        ctx.font = `700 ${fs}px -apple-system, "SF Pro Display", sans-serif`;
        ctx.fillText('LUT', tx, y0 + s / 2);
        ctx.font = `300 ${fs}px -apple-system, "SF Pro Display", sans-serif`;
        ctx.fillText('viewer', tx + lutW, y0 + s / 2);
      }
      ctx.restore();
    }

    function compose(t) {
      if (layout === 'side') {
        r.render({ ...p, split: -1, showOriginal: true }, [0, 0, paneW, H]);
        r.render({ ...p, split: -1 }, [paneW, 0, paneW, H]);
      } else if (layout === 'after') {
        r.render({ ...p, split: -1 });
      } else {
        const pos = layout === 'wipe' ? wipePosition(t, opts.wipeStyle, opts.wipeSpeed) : 0.5;
        r.render({ ...p, split: pos });
      }
      ctx.drawImage(glCanvas, 0, 0);
      if (layout === 'side') {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(paneW - 1, 0, 2, H);
      }
      if (opts.labels) {
        const m = Math.round(H * 0.03);
        const after = opts.lutName ? `AFTER · ${opts.lutName.toUpperCase()}` : 'AFTER';
        if (layout === 'side') {
          drawLabel('BEFORE', m, m, 'left');
          drawLabel(after, paneW + m, m, 'left');
        } else if (layout === 'after') {
          drawLabel(opts.lutName ? opts.lutName.toUpperCase() : 'GRADED', m, m, 'left');
        } else {
          drawLabel('BEFORE', m, m, 'left');
          drawLabel(after, W - m, m, 'right');
        }
      }
      drawWatermark();
    }

    function dispose() {
      const lose = r.gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }

    return { W, H, out, r, compose, dispose };
  }

  /**
   * Still image of the current frame. opts as for exportBeforeAfter, plus
   * format: 'png' | 'jpeg'. Full resolution (up to 3840 px per pane).
   * Resolves with { data: Uint8Array, width, height }.
   */
  async function exportStill(opts) {
    const comp = await createCompositor(opts, 3840);
    try {
      if (!comp.r.upload(opts.source.el)) throw new Error('Nothing to export yet');
      comp.compose(0);
      const type = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const blob = await new Promise((res) => comp.out.toBlob(res, type, 0.93));
      if (!blob) throw new Error('Couldn’t encode the image');
      return { data: new Uint8Array(await blob.arrayBuffer()), width: comp.W, height: comp.H };
    } finally {
      comp.dispose();
    }
  }

  /**
   * opts: {
   *   source: { kind, el }, params (render params incl. camera/tone/…), lutId, lut (parsed table),
   *   lutName, layout: 'wipe'|'split'|'side', beforeRaw, length (seconds or 'full'), labels,
   *   onProgress(fraction), signal: AbortSignal
   * }
   * Resolves with the MP4 file as a Uint8Array.
   */
  async function exportBeforeAfter(opts) {
    const { source, layout, signal } = opts;
    const el = source.el;

    // Output size: panes up to 1920 wide (1280 each when side by side).
    const comp = await createCompositor(opts, layout === 'side' ? 1280 : 1920);
    const { W, H, out, r, compose } = comp;

    const fps = source.kind === 'video' ? 30 : FPS_STILL;
    const bitrate = Math.min(40e6, Math.max(6e6, Math.round(W * H * fps * 0.14)));
    const config = await pickCodec(W, H, bitrate, fps);

    const muxer = new root.Mp4Muxer.Muxer({
      target: new root.Mp4Muxer.ArrayBufferTarget(),
      video: { codec: 'avc', width: W, height: H, frameRate: fps },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
    let encodeError = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { encodeError = e; },
    });
    encoder.configure(config);

    let lastKey = -Infinity;

    function encodeFrame(t, duration) {
      if (encodeError) throw encodeError;
      compose(t);
      const frame = new VideoFrame(out, { timestamp: Math.round(t * 1e6), duration: Math.round(duration * 1e6) });
      const keyFrame = t - lastKey >= 2;
      if (keyFrame) lastKey = t;
      encoder.encode(frame, { keyFrame });
      frame.close();
    }

    const abortError = () => Object.assign(new Error('Export cancelled'), { cancelled: true });

    try {
      if (source.kind === 'video') {
        const v = el;
        const was = { time: v.currentTime, paused: v.paused, loop: v.loop };
        v.pause();
        v.loop = false;
        const dur = v.duration;
        let start = v.currentTime;
        const len = opts.length === 'full' ? dur : Number(opts.length);
        if (opts.length === 'full' || start + 0.5 > dur) start = 0;
        const end = Math.min(dur, start + len);
        await seek(v, start);
        try {
          await new Promise((resolve, reject) => {
            let lastT = -1;
            let finished = false;
            const finish = (err) => {
              if (finished) return;
              finished = true;
              v.pause();
              if (err) reject(err); else resolve();
            };
            const onFrame = (_now, meta) => {
              if (finished) return;
              if (signal && signal.aborted) return finish(abortError());
              const t = meta.mediaTime - start;
              if (meta.mediaTime >= end - 0.001) return finish();
              if (t > lastT) {
                lastT = t;
                r.upload(v);
                try { encodeFrame(Math.max(0, t), 1 / fps); } catch (e) { return finish(e); }
                opts.onProgress && opts.onProgress(Math.min(1, t / (end - start)));
              }
              v.requestVideoFrameCallback(onFrame);
            };
            v.addEventListener('ended', () => finish(), { once: true });
            v.requestVideoFrameCallback(onFrame);
            v.play().catch(finish);
          });
        } finally {
          v.loop = was.loop;
          await seek(v, was.time);
          if (!was.paused) v.play();
        }
      } else {
        r.upload(el);
        const len = opts.length === 'full' ? 8 : Number(opts.length);
        const frames = Math.round(len * FPS_STILL);
        for (let i = 0; i < frames; i++) {
          if (signal && signal.aborted) throw abortError();
          await encodeFrame(i / FPS_STILL, 1 / FPS_STILL);
          while (encoder.encodeQueueSize > 6) await sleep(4);
          if (i % 10 === 0) {
            opts.onProgress && opts.onProgress(i / frames);
            await sleep(0);
          }
        }
      }
      await encoder.flush();
      if (encodeError) throw encodeError;
      muxer.finalize();
      opts.onProgress && opts.onProgress(1);
      return new Uint8Array(muxer.target.buffer);
    } finally {
      if (encoder.state !== 'closed') encoder.close();
      const lose = r.gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
  }

  root.Exporter = { exportBeforeAfter, exportStill, wipePosition, wipePeriod };
})(window);
