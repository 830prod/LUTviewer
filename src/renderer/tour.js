/*
 * Guided tour hosted by Reel, the 830 Productions film-reel character.
 * A spotlight ring highlights each part of the window while Reel explains it
 * in a speech bubble. Every step can be skipped (Skip tour / Esc).
 */
(function (root) {
  'use strict';

  const FACE = (name) => `lutv://assets/reel/${name}.svg`;
  const FACES = ['neutral', 'happy', 'surprised', 'sleepy', 'suspicious', 'sad', 'focused', 'wink'];

  // Each step: target (CSS selector, or none for a centered card), an optional
  // section to open first, Reel's expression, and what he says.
  const STEPS = [
    {
      face: 'happy',
      title: 'Hi, I’m Reel! 👋',
      text: 'Welcome to LUTviewer. Want a quick tour? It takes about 30 seconds.',
      next: 'Show me around',
    },
    {
      target: '#library > summary',
      section: 'library',
      face: 'focused',
      title: 'Your LUT library',
      text: 'Drag your LUTs in here: .cube or .3dl files, or whole folders of LUT packs. You only do it once, they stay in your library.',
    },
    {
      target: '#stage',
      face: 'surprised',
      title: 'Drop in your footage',
      text: 'Drop a clip or a still anywhere on the window. Every LUT then renders on your actual footage, not a sample picture.',
    },
    {
      target: '[data-section="camera"]',
      section: 'camera',
      face: 'neutral',
      title: 'Tell me your camera',
      text: 'Shooting log? Pick your camera here and I’ll convert it to Rec.709 first, so creative LUTs look the way they were made to.',
    },
    {
      target: '[data-section="adjust"]',
      section: 'adjust',
      face: 'focused',
      title: 'Quick adjustments',
      text: 'Nudge exposure, contrast, temperature and more. Your edits show up on every LUT thumbnail too.',
    },
    {
      target: '#grid',
      section: 'library',
      face: 'wink',
      title: 'Pick a look',
      text: 'Click any thumbnail, or flip through them with the ↑ ↓ arrow keys. Press F to favorite the ones you love.',
    },
    {
      target: '.transport',
      face: 'suspicious',
      title: 'Before vs. after',
      text: 'Use the split button (or press S) to compare, then the export button to make a before / after video you can share.',
    },
    {
      target: '#btnBake',
      section: 'lut',
      face: 'happy',
      title: 'Take it to your editor',
      text: 'Found the one? Export it as a single LUT for Premiere Pro or Final Cut Pro, with your camera conversion and edits baked in.',
    },
    {
      face: 'happy',
      title: 'That’s a wrap! 🎬',
      text: 'Have fun finding your look. You can watch this tour again any time from Help → Take the Tour.',
      next: 'Let’s go',
    },
  ];

  let els = null;
  let index = 0;
  let onDone = null;
  let resizeObs = null;

  function build() {
    const wrap = document.createElement('div');
    wrap.className = 'tour';
    wrap.innerHTML = `
      <div class="tour-shade"></div>
      <div class="tour-ring"></div>
      <div class="tour-card" role="dialog" aria-live="polite" aria-labelledby="tourTitle">
        <img class="tour-reel" alt="Reel, the LUTviewer guide">
        <div class="tour-bubble">
          <b id="tourTitle"></b>
          <p></p>
          <div class="tour-foot">
            <div class="tour-dots"></div>
            <div class="tour-btns">
              <button class="link-btn tour-back">Back</button>
              <button class="btn small tour-next">Next</button>
            </div>
          </div>
        </div>
        <button class="tour-skip">Skip tour</button>
      </div>`;
    document.body.append(wrap);
    // Preload every face so expression changes are instant.
    for (const f of FACES) { const i = new Image(); i.src = FACE(f); }
    const q = (s) => wrap.querySelector(s);
    els = {
      wrap, ring: q('.tour-ring'), card: q('.tour-card'), reel: q('.tour-reel'),
      title: q('.tour-bubble b'), text: q('.tour-bubble p'), dots: q('.tour-dots'),
      back: q('.tour-back'), next: q('.tour-next'), skip: q('.tour-skip'),
    };
    for (let i = 0; i < STEPS.length; i++) els.dots.append(document.createElement('i'));
    els.next.addEventListener('click', () => go(index + 1));
    els.back.addEventListener('click', () => go(index - 1));
    els.skip.addEventListener('click', () => finish(true));
    els.wrap.querySelector('.tour-shade').addEventListener('click', () => go(index + 1));
    // Clicking Reel makes him wink.
    els.reel.addEventListener('click', () => {
      els.reel.src = FACE('wink');
      els.reel.classList.remove('boop');
      void els.reel.offsetWidth;
      els.reel.classList.add('boop');
      setTimeout(() => { els.reel.src = FACE(STEPS[index].face); }, 700);
    });
  }

  function onKey(e) {
    if (!els) return;
    if (e.key === 'Escape') finish(true);
    else if (e.key === 'ArrowRight' || e.key === 'Enter') go(index + 1);
    else if (e.key === 'ArrowLeft') go(index - 1);
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function targetRect(step) {
    if (!step.target) return null;
    const el = document.querySelector(step.target);
    if (!el || !el.getClientRects().length) return null;
    return el.getBoundingClientRect();
  }

  function place() {
    const step = STEPS[index];
    const r = targetRect(step);
    const vw = innerWidth, vh = innerHeight;
    const card = els.card;
    if (!r) {
      els.ring.classList.add('off');
      card.classList.add('center');
      card.style.top = `${Math.max(60, vh / 2 - card.offsetHeight / 2)}px`;
      return;
    }
    card.classList.remove('center');
    const pad = 6;
    const top = Math.max(r.top - pad, 48), bottom = Math.min(r.bottom + pad, vh - 4);
    Object.assign(els.ring.style, {
      left: `${Math.max(4, r.left - pad)}px`, top: `${top}px`,
      width: `${Math.min(vw - 8, r.width + pad * 2)}px`, height: `${Math.max(24, bottom - top)}px`,
    });
    els.ring.classList.remove('off');
    // Put the card on whichever side of the highlight has more room.
    const h = card.offsetHeight;
    const below = vh - bottom, above = top - 48;
    let y = below >= h + 16 || below >= above ? bottom + 14 : top - h - 14;
    y = Math.min(Math.max(52, y), vh - h - 10);
    card.style.top = `${y}px`;
  }

  async function go(next) {
    if (next < 0) return;
    if (next >= STEPS.length) return finish(false);
    const forward = next >= index;
    index = next;
    const step = STEPS[index];
    if (step.section) {
      const d = document.querySelector(`details[data-section="${step.section}"]`);
      if (d && !d.open) d.open = true;
    }
    if (step.target) {
      const el = document.querySelector(step.target);
      if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    els.title.textContent = step.title;
    els.text.textContent = step.text;
    els.next.textContent = step.next || (index === STEPS.length - 2 ? 'Finish' : 'Next');
    els.back.hidden = index === 0;
    els.skip.hidden = index === STEPS.length - 1;
    [...els.dots.children].forEach((d, i) => d.classList.toggle('on', i === index));
    // Reel rolls in from the direction of travel and swaps his expression.
    els.reel.src = FACE(step.face);
    els.reel.classList.remove('roll-l', 'roll-r');
    void els.reel.offsetWidth;
    els.reel.classList.add(forward ? 'roll-r' : 'roll-l');
    els.card.classList.remove('pop');
    void els.card.offsetWidth;
    els.card.classList.add('pop');
    requestAnimationFrame(place);
  }

  function start(done) {
    if (els) return;
    onDone = done;
    build();
    index = 0;
    document.addEventListener('keydown', onKey, true);
    addEventListener('resize', place);
    resizeObs = new ResizeObserver(() => place());
    resizeObs.observe(document.body);
    const main = document.querySelector('main');
    if (main) main.addEventListener('scroll', place);
    requestAnimationFrame(() => { els.wrap.classList.add('in'); go(0); });
  }

  function finish(skipped) {
    if (!els) return;
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('resize', place);
    if (resizeObs) resizeObs.disconnect();
    const main = document.querySelector('main');
    if (main) { main.removeEventListener('scroll', place); main.scrollTo({ top: 0, behavior: 'smooth' }); }
    const w = els.wrap;
    els = null;
    w.classList.remove('in');
    setTimeout(() => w.remove(), 250);
    if (onDone) onDone({ skipped, step: index });
  }

  root.Tour = { start, isOpen: () => !!els, steps: STEPS.length };
})(window);
