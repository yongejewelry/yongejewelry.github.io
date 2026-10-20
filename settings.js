// Yonge Jewelry website settings
// ---------------------------------------------------------------
// Type each value between the two ' marks. Leave the ' marks in place.
// These four values are safe to be public.
//
// NEVER put the Square ACCESS TOKEN in this file.
// The access token goes only in Cloudflare (as a Secret).
// ---------------------------------------------------------------

window.YONGE_SETTINGS = {

  // From Square: Credentials page, "Application ID"
  squareApplicationId: 'sq0idp-Ct1thJRTmciIm_DrsbXzhQ',

  // From Square: Locations page, "Location ID"
  squareLocationId: 'LV7VEMWQMZHJ6',

  // Type sandbox while testing. Type production when you go live.
  squareEnvironment: 'production',

  // Your Cloudflare worker address, for example https://yonge-payments.yourname.workers.dev
  paymentsAddress: 'https://yonge-payments.lana-muradd.workers.dev/'

};
