// Shared overlay toolkit for the selection and result UIs: a shadow-DOM host
// with the extension stylesheet, an idempotent close lifecycle, Esc-to-close,
// and h(), a tiny element builder.

// h('div', { class: 'fps-card', text: '…', html: '…', onClick: fn, type: 'button' }, ...children)
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'html') element.innerHTML = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else element[key] = value;
  }
  element.append(...children);
  return element;
}

export class Overlay {
  #onClose;
  #keyListener;
  #closed = false;

  constructor({ onClose } = {}) {
    this.#onClose = onClose;
    this.host = h('div');
    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.shadow.append(h('link', { rel: 'stylesheet', href: chrome.runtime.getURL('content/overlay.css') }));
    this.#keyListener = (event) => this.handleKeyDown(event);
  }

  get closed() {
    return this.#closed;
  }

  // Appends the given nodes to the shadow root, mounts the host, and starts
  // listening for keys. Returns this for chaining.
  mount(...nodes) {
    this.shadow.append(...nodes);
    document.documentElement.appendChild(this.host);
    document.addEventListener('keydown', this.#keyListener, true);
    return this;
  }

  // Esc closes (capture phase; the page never sees the key while our overlay
  // is up). Subclasses override to handle more keys first, then delegate to
  // super for Esc.
  handleKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  }

  // Public close path (Esc, backdrop click, cancel/close buttons): teardown +
  // the onClose callback, exactly once.
  close() {
    if (this.#closed) return;
    this.teardown();
    if (this.#onClose) this.#onClose();
  }

  // Removes listeners and the host, idempotently. Subclasses that add their
  // own window/document listeners override and call super.teardown().
  teardown() {
    if (this.#closed) return;
    this.#closed = true;
    document.removeEventListener('keydown', this.#keyListener, true);
    this.host.remove();
  }
}
