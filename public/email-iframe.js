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
 *   - Scale desktop-width email layouts down to fit narrow viewports.
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

  // Shrink-to-fit.
  //
  // Marketing email is authored at a fixed desktop width: 600-800px tables,
  // columns pinned with `min-width`, images sized to the template. None of
  // that reflows, so on a phone the body lays out at its authored width and
  // overflows sideways, and the height we measure belongs to that wide
  // layout. The reader then scrolls through a very tall email of which only
  // the left slice is visible. Scaling the whole body down to the viewport
  // width is what native mail clients do and it leaves the design intact.
  //
  // A transform does not affect layout, so the scaled content keeps its
  // unscaled height in the flow. .fe-email-viewport gets an explicit height
  // so the document, and the height we report, match what is painted.

  // Below this, text would be too small to read; let the email scroll
  // sideways instead of shrinking it into illegibility.
  var FIT_MIN_SCALE = 0.35;
  // Sub-pixel rounding should not trigger a scale.
  var FIT_SLACK_PX = 2;

  function fitToViewport() {
    var viewport = document.querySelector('.fe-email-viewport');
    var content = document.querySelector('.fe-email-content');
    if (!viewport || !content) return;

    // Measure the natural layout, free of any scale applied on a prior pass.
    content.style.transform = '';
    content.style.width = '';
    content.style.maxWidth = '';
    viewport.style.height = '';

    var available = document.documentElement.clientWidth || viewport.clientWidth || 0;
    var natural = Math.max(content.scrollWidth, content.offsetWidth);
    if (available <= 0 || natural <= 0) return;
    if (natural <= available + FIT_SLACK_PX) return;

    var scale = Math.max(available / natural, FIT_MIN_SCALE);

    // Pin the width so the scale is measured against a stable layout rather
    // than against .fe-email-content's own max-width clamp.
    content.style.width = natural + 'px';
    content.style.maxWidth = 'none';
    content.style.transformOrigin = '0 0';
    content.style.transform = 'scale(' + scale + ')';
    viewport.style.height = Math.ceil(content.offsetHeight * scale) + 'px';
  }

  function reportHeight() {
    fitToViewport();
    var box =
      document.querySelector('.fe-email-viewport') || document.querySelector('.fe-email-content');
    var boxHeight = box ? box.getBoundingClientRect().height : 0;
    var height = Math.max(
      boxHeight,
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
    var viewport = document.querySelector('.fe-email-viewport');
    if (viewport) ro.observe(viewport);
  } else {
    setInterval(reportHeight, 500);
  }

  // Rotation and reader-pane resizes change the width we fit against. Each
  // pass forces a reflow, so coalesce the burst a drag or a rotation emits.
  var resizeTimeout = null;
  function reportHeightSoon(delay) {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(reportHeight, delay);
  }

  window.addEventListener('resize', function () {
    reportHeightSoon(100);
  });
  window.addEventListener('orientationchange', function () {
    // The viewport reports its new width a frame or two after the event.
    reportHeightSoon(250);
  });

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
