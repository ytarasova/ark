// Sidebar navigation for Ark docs
(function() {
  // Determine current page
  const path = window.location.pathname;
  const page = path.split('/').pop() || 'index.html';

  // Mark active link
  document.querySelectorAll('.sidebar a').forEach(a => {
    const href = a.getAttribute('href');
    if (href === page || (page === 'index.html' && href === './')) {
      a.classList.add('active');
    }
  });

  // Mobile hamburger toggle
  const hamburger = document.querySelector('.hamburger');
  const sidebar = document.querySelector('.sidebar');
  if (hamburger && sidebar) {
    hamburger.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
    // Close on link click (mobile)
    sidebar.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => sidebar.classList.remove('open'));
    });
  }
  // Copy-to-clipboard buttons on all <pre> blocks
  document.querySelectorAll('pre').forEach(pre => {
    // Skip if a copy button already exists (e.g. manually added)
    if (pre.querySelector('.copy-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      // Get text content without prompt symbols
      const text = pre.textContent
        .replace(/^Copy\s*/m, '')       // remove button text
        .replace(/^\$\s?/gm, '')        // remove $ prompts
        .trim();
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy', 1500);
      });
    });
    pre.insertBefore(btn, pre.firstChild);
  });
})();
