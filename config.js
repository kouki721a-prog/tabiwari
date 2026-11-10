/* Project settings. Public values only (never any secret key). Leave supabaseUrl empty for local-only mode.
   See docs/SETUP.md. */
window.TABIWARI = {
  supabaseUrl: '',
  supabaseKey: '',
  vapidPublicKey: '',                // Web Push public key (docs/SETUP.md §4). Empty hides the notification switch.
  premiumPriceLabel: '月額400円',     // Shown on the upgrade screen. Must match the Stripe price.
  legalReady: false                  // Set true once terms.html / privacy.html have no 【要記入】 left (node test/launch-check.js). Until then the app does not link to them and the build leaves them out.
};
