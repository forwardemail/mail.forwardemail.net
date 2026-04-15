/**
 * Email iframe runtime.
 *
 * Loaded by the sandboxed srcdoc iframe that renders each email body. Served
 * from the parent origin so CSP can authorize it via `script-src 'self'` —
 * no inline-hash/nonce dance required (the hash-based approach raced against
 * Tauri's runtime nonce injection and broke link clicks in debug builds).
 *
 * Responsibilities:
 *   - Strip inline color/background styles that would collide with the app
 *     theme and hide text.
 *   - Report measured body height to the parent via postMessage.
 *   - Intercept link clicks and forward them to the parent (which opens via
 *     the system browser / compose window instead of navigating the iframe).
 *   - Block form submissions.
 *   - Forward horizontal swipe gestures so mobile users can swipe across the
 *     email body.
 *
 * Origin policy: parent always treats the sender as `*` for postMessage and
 * validates `event.source === iframeRef.contentWindow` on receive.
 */
(function () {
  'use strict';

  var TARGET_ORIGIN = '*';

  try {
    parent.postMessage({ type: 'ready', payload: {} }, TARGET_ORIGIN);
  } catch {
    // Parent may not be accessible — continue; later messages will retry.
  }

  var STYLE_PROPS_TO_STRIP = ['color', 'background-color', 'background'];
  var HEIGHT_REPORT_DELAYS = [0, 50, 100, 200, 500, 1000];

  function stripElementStyles(el) {
    if (!el || !el.style) return;
    STYLE_PROPS_TO_STRIP.forEach(function (prop) {
      if (el.style.getPropertyValue(prop)) {
        el.style.removeProperty(prop);
      }
    });
  }

  function stripAllInlineStyles() {
    document.querySelectorAll('*').forEach(stripElementStyles);
  }

  function observeForNewContent() {
    if (typeof MutationObserver === 'undefined') return;
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (node.nodeType === 1) {
            stripElementStyles(node);
            if (node.querySelectorAll) {
              node.querySelectorAll('*').forEach(stripElementStyles);
            }
          }
        });
        if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
          stripElementStyles(mutation.target);
        }
      });
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    });
  }

  function ensureStylesStripped() {
    stripAllInlineStyles();
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(function () {
        stripAllInlineStyles();
        requestAnimationFrame(stripAllInlineStyles);
      });
    }
    setTimeout(stripAllInlineStyles, 10);
  }

  ensureStylesStripped();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      ensureStylesStripped();
      observeForNewContent();
    });
  } else {
    setTimeout(function () {
      ensureStylesStripped();
      observeForNewContent();
    }, 0);
  }

  window.addEventListener('load', ensureStylesStripped);

  function reportHeight() {
    var content = document.querySelector('.fe-email-content');
    var contentHeight = content ? content.getBoundingClientRect().height : 0;
    var height = Math.max(
      contentHeight,
      document.body.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.scrollHeight,
      document.documentElement.offsetHeight,
    );
    height = Math.max(Math.ceil(height), 50);
    parent.postMessage({ type: 'height', payload: { height: height } }, TARGET_ORIGIN);
  }

  HEIGHT_REPORT_DELAYS.forEach(function (delay) {
    setTimeout(reportHeight, delay);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reportHeight);
  }
  window.addEventListener('load', reportHeight);

  if (typeof ResizeObserver !== 'undefined') {
    var ro = new ResizeObserver(function () {
      clearTimeout(ro._timeout);
      ro._timeout = setTimeout(reportHeight, 16);
    });
    ro.observe(document.body);
    var content = document.querySelector('.fe-email-content');
    if (content) ro.observe(content);
  } else {
    setInterval(reportHeight, 500);
  }

  document.querySelectorAll('img').forEach(function (img) {
    if (!img.complete) {
      img.addEventListener('load', reportHeight);
      img.addEventListener('error', reportHeight);
    }
  });

  // Quote toggle — registered before the link handler so a click on the
  // toggle always resolves to a toggle, even when the email HTML wraps the
  // quote section in an anchor.
  document.addEventListener(
    'click',
    function (e) {
      var toggle = e.target.closest ? e.target.closest('.fe-quote-toggle') : null;
      if (!toggle) return;

      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }

      var wrapper = toggle.closest('.fe-quote-wrapper');
      if (!wrapper) return;

      var isCollapsed = wrapper.classList.contains('fe-quote-collapsed');
      wrapper.classList.toggle('fe-quote-collapsed');

      var label = toggle.querySelector('.fe-quote-label');
      if (label) {
        label.textContent = isCollapsed ? 'Hide quoted text' : 'Show quoted text';
      }

      setTimeout(reportHeight, 50);
      setTimeout(reportHeight, 350);
    },
    true,
  );

  // Link click interception. Forwarded to parent for external open / compose.
  document.addEventListener(
    'click',
    function (e) {
      if (e.target.closest && e.target.closest('.fe-quote-toggle')) return;
      var link = e.target.closest('a');
      if (link && link.href) {
        e.preventDefault();
        e.stopPropagation();
        var url = link.href;
        var isMailto = url.toLowerCase().startsWith('mailto:');
        parent.postMessage(
          {
            type: 'link',
            payload: { url: url, isMailto: isMailto },
          },
          TARGET_ORIGIN,
        );
      }
    },
    true,
  );

  // Block form submissions — forward to parent for logging.
  document.addEventListener(
    'submit',
    function (e) {
      e.preventDefault();
      e.stopPropagation();
      var form = e.target;
      var formData = {};
      try {
        new FormData(form).forEach(function (value, key) {
          formData[key] = value;
        });
      } catch {
        // Ignore FormData errors
      }
      parent.postMessage(
        {
          type: 'form',
          payload: {
            action: form.action || '',
            method: form.method || 'get',
            data: formData,
          },
        },
        TARGET_ORIGIN,
      );
    },
    true,
  );

  // Horizontal swipe forwarding for mobile navigation.
  (function () {
    var swipeStartX = 0;
    var swipeStartY = 0;
    var swipeActive = false;
    var swipeDirection = null;

    document.addEventListener(
      'touchstart',
      function (e) {
        if (!e.touches || e.touches.length !== 1) return;
        swipeStartX = e.touches[0].clientX;
        swipeStartY = e.touches[0].clientY;
        swipeActive = false;
        swipeDirection = null;
        parent.postMessage(
          { type: 'swipe', payload: { phase: 'start', x: swipeStartX, y: swipeStartY } },
          TARGET_ORIGIN,
        );
      },
      { passive: true },
    );

    document.addEventListener(
      'touchmove',
      function (e) {
        if (!e.touches || e.touches.length !== 1 || !swipeStartX) return;
        var dx = e.touches[0].clientX - swipeStartX;
        var dy = e.touches[0].clientY - swipeStartY;
        if (!swipeActive && Math.abs(dx) > 15 && Math.abs(dx) > Math.abs(dy) * 2) {
          swipeActive = true;
          swipeDirection = dx > 0 ? 'right' : 'left';
        }
        if (swipeActive) {
          parent.postMessage(
            { type: 'swipe', payload: { phase: 'move', dx: dx, dy: dy } },
            TARGET_ORIGIN,
          );
        }
      },
      { passive: true },
    );

    document.addEventListener(
      'touchend',
      function () {
        parent.postMessage(
          {
            type: 'swipe',
            payload: { phase: 'end', active: swipeActive, direction: swipeDirection },
          },
          TARGET_ORIGIN,
        );
        swipeStartX = 0;
        swipeStartY = 0;
        swipeActive = false;
        swipeDirection = null;
      },
      { passive: true },
    );
  })();
})();
