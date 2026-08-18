/*
 * The guide's behaviour: which chapter you are in, filtering the contents, and enlarging a
 * screenshot.
 *
 * Vanilla, in one file, and every part of it optional — the page is readable with JavaScript off,
 * which is the whole reason the contents list is real markup rather than something built here.
 */

(function () {
  'use strict';

  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  var sections = links
    .map(function (link) {
      return document.querySelector(link.getAttribute('href'));
    })
    .filter(Boolean);

  /* ---------------------------------------------------------- which chapter */

  /**
   * Highlights the chapter you are reading.
   *
   * `IntersectionObserver` rather than a scroll handler: a scroll handler runs on every frame of
   * every scroll and has to measure the document each time, which on a page this long is the one
   * thing that would make it feel heavy.
   */
  if ('IntersectionObserver' in window && sections.length) {
    /**
     * The chapter you are reading is the last one whose top has scrolled past the band.
     *
     * Measured here rather than inferred from which sections the observer reports as intersecting.
     * Set membership gets this wrong at a boundary: two sections that meet exactly at the band's
     * top edge both count as intersecting, with zero area, and the highlight lands on the one you
     * have just left. The first version did that and pointed at chapter 9 while chapter 10 filled
     * the screen.
     *
     * The observer is still what triggers the work, so this costs nothing while nothing is moving
     * — a scroll handler would run this on every frame of every scroll instead.
     */
    var update = function () {
      var threshold = window.innerHeight * 0.3;
      var current = sections[0];
      for (var index = 0; index < sections.length; index += 1) {
        if (sections[index].getBoundingClientRect().top <= threshold) current = sections[index];
      }

      links.forEach(function (link) {
        link.classList.toggle('current', link.getAttribute('href') === '#' + current.id);
      });
    };

    var observer = new IntersectionObserver(update, { rootMargin: '0px 0px -70% 0px' });
    sections.forEach(function (section) {
      observer.observe(section);
    });
    update();
  }

  /* ---------------------------------------------------------- filtering */

  var filter = document.getElementById('filter');
  if (filter) {
    filter.addEventListener('input', function () {
      var needle = filter.value.trim().toLowerCase();
      links.forEach(function (link) {
        var match = !needle || link.textContent.toLowerCase().indexOf(needle) !== -1;
        link.parentNode.classList.toggle('hidden', !match);
      });
      // Group headings are meaningless once their chapters are filtered out.
      Array.prototype.forEach.call(document.querySelectorAll('.toc .part'), function (part) {
        part.style.display = needle ? 'none' : '';
      });
    });

    // `/` focuses the filter, the convention every documentation site shares. Ignored while the
    // reader is already typing somewhere, or a search box would swallow a slash in a path.
    document.addEventListener('keydown', function (event) {
      if (event.key !== '/' || event.metaKey || event.ctrlKey) return;
      var tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      event.preventDefault();
      filter.focus();
      filter.select();
    });
  }

  /* ---------------------------------------------------------- screenshots */

  var lightbox = document.getElementById('lightbox');
  if (lightbox) {
    var full = lightbox.querySelector('img');

    document.addEventListener('click', function (event) {
      var image = event.target.closest && event.target.closest('figure img');
      if (!image) return;
      full.src = image.src;
      full.alt = image.alt;
      lightbox.classList.add('open');
    });

    var close = function () {
      lightbox.classList.remove('open');
      // Released rather than left loaded: these are full-size editor captures, and a dozen of them
      // held in memory for a page nobody is looking at is a page that gets blamed for being heavy.
      full.removeAttribute('src');
    };

    lightbox.addEventListener('click', close);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') close();
    });
  }
})();
