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
})();
