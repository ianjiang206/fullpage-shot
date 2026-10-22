// Result overlays: thumbnail + PNG download (multi-part in sequence) + copy
// to clipboard (oversized auto-scaled) + retry/close, and an error variant.
import { Overlay, h } from './overlay.js';
import { fitScale } from './geometry.js';

export class ResultOverlay extends Overlay {
  constructor({ parts, width, totalHeight, dpr, onRetry, onClose }) {
    super({ onClose });

    const title = h('div', { class: 'fps-title', text: chrome.i18n.getMessage('resultTitle') });
    const thumbWrap = h('div', { class: 'fps-thumb-wrap' }, ResultOverlay.#thumbnail(parts[0].canvas));
    const meta = h('div', {
      class: 'fps-meta',
      text: `${width} × ${totalHeight} px` + (parts.length > 1
        ? ' · ' + chrome.i18n.getMessage('resultMetaSplit', String(parts.length))
        : ''),
    });
    const note = h('div', { class: 'fps-note' });
    const downloadButton = h('button', {
      type: 'button', class: 'fps-btn fps-primary',
      text: parts.length > 1
        ? chrome.i18n.getMessage('downloadMany', String(parts.length))
        : chrome.i18n.getMessage('downloadOne'),
      onClick: () => ResultOverlay.downloadAll(parts),
    });
    const copyButton = h('button', {
      type: 'button', class: 'fps-btn', text: chrome.i18n.getMessage('copy'),
    });
    copyButton.addEventListener('click', async () => {
      copyButton.disabled = true;
      try {
        const scaled = fitScale(width, totalHeight) < 1;
        const blob = await ResultOverlay.buildSingleBlob(parts, width, totalHeight, dpr);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        note.textContent = scaled
          ? chrome.i18n.getMessage('copiedScaled')
          : chrome.i18n.getMessage('copied');
      } catch (error) {
        note.textContent = chrome.i18n.getMessage('copyFailed',
          String(error && error.message ? error.message : error));
      } finally {
        copyButton.disabled = false;
      }
    });
    const retryButton = h('button', {
      type: 'button', class: 'fps-btn', text: chrome.i18n.getMessage('reselect'),
      // close() fires onClose (state back to idle) before retry re-enters selecting
      onClick: () => { this.close(); if (onRetry) onRetry(); },
    });
    const closeButton = h('button', {
      type: 'button', class: 'fps-btn', text: chrome.i18n.getMessage('close'),
      onClick: () => this.close(),
    });
    const actions = h('div', { class: 'fps-actions' }, downloadButton, copyButton, retryButton, closeButton);
    const panel = h('div', { class: 'fps-panel' }, title, thumbWrap, meta, note, actions);
    const card = h('div', { class: 'fps-card' }, panel);
    card.addEventListener('click', (event) => { if (event.target === card) this.close(); });
    this.mount(card);
  }

  // First part's thumbnail, scaled into a 480×320 box.
  static #thumbnail(canvas) {
    const thumb = document.createElement('canvas');
    const scale = Math.min(1, 320 / canvas.height, 480 / canvas.width);
    thumb.width = Math.max(1, Math.round(canvas.width * scale));
    thumb.height = Math.max(1, Math.round(canvas.height * scale));
    thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
    return thumb;
  }

  // Stitch parts into a single blob; scale down past MAX_CANVAS_EDGE
  // (the clipboard takes one image only).
  static buildSingleBlob(parts, width, totalHeight, dpr) {
    const scale = fitScale(width, totalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(totalHeight * scale));
    const ctx = canvas.getContext('2d');
    for (const part of parts) {
      const dy = Math.round(part.startY * dpr * scale);
      const dh = Math.round(part.canvas.height * scale);
      ctx.drawImage(part.canvas, 0, 0, part.canvas.width, part.canvas.height, 0, dy, canvas.width, dh);
    }
    return new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob
        ? resolve(blob)
        : reject(new Error(chrome.i18n.getMessage('toBlobFailed')))), 'image/png'));
  }

  static downloadAll(parts) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const hostName = (location.hostname || 'page').replace(/[^\w.-]+/g, '_');
    parts.forEach((part, index) => {
      setTimeout(() => {
        part.canvas.toBlob((blob) => {
          if (!blob) return;
          const link = document.createElement('a');
          const suffix = parts.length > 1 ? `-part${index + 1}` : '';
          link.download = `fullpage-shot-${hostName}-${stamp}${suffix}.png`;
          link.href = URL.createObjectURL(blob);
          link.click();
          setTimeout(() => URL.revokeObjectURL(link.href), 10000);
        }, 'image/png');
      }, index * 400); // stagger multiple downloads so the browser doesn't block them
    });
  }
}

export class ErrorOverlay extends Overlay {
  constructor(message, onClose) {
    super({ onClose });
    const title = h('div', { class: 'fps-title', text: chrome.i18n.getMessage('errorTitle') });
    const text = h('div', { class: 'fps-meta', text: message });
    const closeButton = h('button', {
      type: 'button', class: 'fps-btn', text: chrome.i18n.getMessage('close'),
      onClick: () => this.close(),
    });
    const panel = h('div', { class: 'fps-panel' }, title, text, h('div', { class: 'fps-actions' }, closeButton));
    this.mount(h('div', { class: 'fps-card' }, panel));
  }
}
