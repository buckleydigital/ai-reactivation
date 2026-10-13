// Public settings. Both values are meant to be public: they are in every page
// that talks to Supabase, and row level security decides what anyone can read.
window.RX_CONFIG = {
  supabaseUrl: 'https://vcantdssoketpxaybtwh.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZjYW50ZHNzb2tldHB4YXlidHdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4NTk4MTAsImV4cCI6MjEwNzQzNTgxMH0.mqLr-YoG37dyQ9Hc_BZY5PcSVjn11f5AItnvjKYot2g',
  sharedNumber: '+61 485 074 685',
  // Rough cost to you, in cents, for the admin margin view only. Clients never
  // see these. Adjust to your Twilio and OpenAI bills.
  costs: { smsSegmentCents: 6, callMinuteCents: 30 },
  // GST added on top of prices. Display only: the edge function's GST_RATE
  // secret decides what is actually charged, so keep the two the same.
  gstRate: 0.1,
};
