/* Project settings. Public values only (never any secret key). Leave supabaseUrl empty for local-only mode.
   See docs/SETUP.md. */
window.TABIWARI = {
  supabaseUrl: '',
  supabaseKey: '',
  vapidPublicKey: '',                // Web Push public key (docs/SETUP.md §4). Empty hides the notification switch.
  premiumPriceLabel: '月額400円'      // Shown on the upgrade screen. Must match the Stripe price.
};
