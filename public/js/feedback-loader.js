// Lazy-load the feedback widget after the page finishes loading so it
// never competes with calculator.js for main-thread time.  The preconnect
// hint in index.html keeps the connection warm, so the fetch starts instantly.
addEventListener('load', function () {
  var s = document.createElement('script');
  s.src = 'https://test1.116.202.8.41.feedbackloopai.ovh/unified/feedbackloop.js';
  s.dataset.apiKey = 'fl_61224563e54b34ec31061086516635bd';
  document.head.appendChild(s);
});
