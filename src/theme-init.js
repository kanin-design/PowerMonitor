// Runs before body renders — sets initial theme to avoid flash
document.documentElement.setAttribute('data-theme',
  window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
