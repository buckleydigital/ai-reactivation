// The app lives at app.html; the site's root is the homepage. Supabase invite
// and password-reset links, and Stripe's return links, can still arrive at the
// root (they follow the APP_URL / Site URL settings), so send anything meant
// for the app straight there, keeping the token or view in the hash.
(function () {
  var h = location.hash || '';
  if (/access_token=|refresh_token=|type=(invite|recovery|signup|magiclink)|error_description=|^#(billing|inbox|campaigns|clients|users|dnc)\b/.test(h)) {
    location.replace('app.html' + h);
  }
})();
