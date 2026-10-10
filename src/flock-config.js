'use strict';

/*
 * Public Supabase browser configuration for Flock.
 * The publishable key is designed for client use. Flock authenticates with its own sessions;
 * database row access is validated by the x-flock-session header and RLS.
 * Never place a Supabase service_role/secret key in this file.
 */
window.FLOCK_CONFIG = Object.freeze({
  supabaseUrl: 'https://yyyahumvztpkaaxmvqan.supabase.co',
  supabasePublishableKey: 'sb_publishable_zuVBy8JFFI3NlYRB5Mtb5A_O6DVGKi8',
  storageBucket: 'flock-media',
  githubRepo: '43r5fer/JustPlay',
  playStoreUrl: '',
  androidPackageId: 'com.flock.messaging'
});
