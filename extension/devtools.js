chrome.devtools.panels.create(
  'Perf AI',
  '',
  'panel.html',
  (panel) => {
    panel.onShown.addListener(() => {
    });
  },
);
