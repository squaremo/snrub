var listener = require('./lib/listener');
var scheduler = require('./lib/scheduler');
var dedup = require('./lib/dedup');

function warn(str) {
  console.warn("[snrub] " + str);
}

// Wrap the listener constructor thinly, so there's a safe default if
// you supply no arguments.
// Options:
// `host`: a URL host component on which the middleware will be set to
// listen, e.g., `snrub.cloudfoundry.com`. Defaults to `"localhost:8080"`.
// `prefix`: the prefix of URL paths for which the middleware should
// intercept requests. Should start with `'/'`. If not supplied,
// `'/snrub'` will be used.
// `paths`: a path provider; that is, an object with methods `create`
// and `lookup` that makes URL paths from JavaScript values. If not
// supplied, a provider that simply encrypts the vlaues will be
// used. See also `secret`.
// `tokens`: a token provider; an object with methods `create` and
// `lookup` that makes validation tokens for subscribe and unsubscribe
// requests. If not supplied, tokens will be encrypted values. See
// `secret` below.
// `secret`: if either of `paths` or `tokens` is left to default, a
// secret may be supplied for the encryption to use. In a
// load-balanced configuration, supplying a common secret to all
// servers will make sure each can decrypt the other's paths or
// tokens. If not supplied, a random string will be used.
exports.createSubscriber = function(options) {
  if (arguments.length === 0) {
    // Default-safe
    warn("Creating default subscriber.");
    options = {};
  }
  var host = options.host;
  if (!host) {
    warn("No host supplied");
    warn("-> assuming middleware will be listening on localhost:8080");
    host = 'localhost:8080';
  }
  var prefix = options.prefix
  if (!prefix) {
    warn("No prefix supplied");
    warn("-> using '/snrub'");
    prefix = '/snrub';
  }
  // with respect to the providers: if either isn't provided, use a
  // crypto provider and look for a secret; if no secret, create
  // one and warn.
  var paths = options.paths;
  var tokens = options.tokens;
  if (!paths || !tokens) {
    var secret = options.secret;
    if (!secret) {
      warn("Using generated secret");
      warn("-> may not work in load-balanced configuration");
      secret = require('crypto').randomBytes(16);
    }
    paths = paths || listener.cryptoPathProvider(secret);
    tokens = tokens || listener.cryptoTokenProvider(secret);
  }
  return listener.createListener(host, prefix, paths, tokens);
}

// Go with noddy implementations for now.
exports.createPoller = function() {
  return new scheduler.TimerScheduler();
}
exports.dedup = dedup.create;
