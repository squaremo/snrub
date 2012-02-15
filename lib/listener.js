// A listener for PuSH notifications, as middleware for connect,
// through which one can subscribe to topics on PuSH hubs.

// Usage: TBD. Ahem.

var events = require('events');
var crypto = require('crypto');
var url = require('url');
var querystring = require('querystring');
var http = require('http'), https = require('https');

var PROTOCOLS = {
  'http:'  : http,
  'https:' : https
};

// host : for putting in front of URLs
// prefix : for distinguishing requests meant for this (starts with '/')
// callbackPathProvider : an object
// {'create': memo x lease | true -> string, 'lookup': string -> memo | false}
// tokenProvider : an object
// {'create': action x topic -> string,
//  'lookup': string x action x topic -> boolean}
// that will be used to create, then lookup validation tokens.
// NB if this is being load-balanced, verification and delivery may not
// be handled by the same process; hence the providers, which give a
// chance to store things centrally (or use crypto).
function Listener(host, prefix, callbackPathProvider, tokenProvider) {
  events.EventEmitter.call(this);
  this.prefix = prefix;
  this.prefix_test = new RegExp('^' + prefix);
  this.host = host;
  this.tokens = tokenProvider;
  this.paths = callbackPathProvider;
}
exports.createListener = function(host, prefix, paths, tokens) {
  return new Listener(host, prefix, paths, tokens);
}

var proto = Listener.prototype = new events.EventEmitter();

proto.middleware = function() {
  var that = this;
  return function(req, res, next) {
    if (that.prefix_test.test(req.url)) {
      // Either a subscription validation (GET), or an update (POST)
      if (req.method === 'GET') {
        var parsed = url.parse(req.url, true),
          params = parsed.query,
          path = parsed.pathname.substr(that.prefix.length);
        var mode = params['hub.mode'],
          topic = params['hub.topic'],
          challenge = params['hub.challenge'],
          lease = params['hub.lease_seconds'],
          token = params['hub.verify_token'];

        if (!(mode && topic && challenge && token)) {
          return that._respond_error(res, 404, {mode: mode, topic: topic,
                                                reason: "Missing parameters"});
        }

        // There are a few success modes here:

        // 1. 'subscribe': the callback path exists and the token checks
        // out, and we are establishing or renewing (no expiry, or
        // within the expiry) a subscription.

        // 2. 'unsubscribe': the callback path exists and the token checks out

        // TODO: the callback is supposed to allow query parameters,
        // implying that we should supply the whole path to lookup.

        var memo = that.paths.lookup(path);
        if (memo) {

          if (mode === 'subscribe') {
            // We treat lease_seconds as a verification deadline as
            // well, and reject any renewals outside of it. This has the
            // side-efeect that infinite leases, or auto-renewable
            // subscriptions, have no initial verification
            // deadline. Meh.
            if (memo.expiry && memo.expiry < +new Date) {
              return that._respond_error(res, 404,
                                         {mode: mode, topic: topic,
                                          reason: "Expired subscription"});
            }
            else if (that.tokens.lookup(token, mode, topic)) {
              // May be issued more than once, if renewed. This is good
              // since it lets any record of the subscription be
              // updated.
              that.emit('subscribe', memo.user_data);
              return respond(res, 200, challenge);
            }
            else {
              return that._respond_error(res, 404,
                                         {mode: mode, topic: topic,
                                          reason: "Invalid hub.verify_token"});
            }
          }
          else if (mode === 'unsubscribe') {
            if (that.tokens.lookup(token, mode, topic)) {
              that.emit('unsubscribe', memo.user_data);
              return respond(res, 200, challenge);
            }
            else {
              return that._respond_error(res, 404,
                                         {mode: mode, topic: topic,
                                          reason: "Invalid hub.verify_token"});
            }
          }
          else {
            return that._respond_error(res, 404,
                                       {mode: mode, topic: topic,
                                        reason: "Invalid hub.mode"});
          }
        }
        else {
          // No record of this subscription.

          // Possible scenarios: the record was deleted, or never
          // stored. Possibly it was garbage collected after the lease
          // expired (and wasn't expected to be renewed). If the mode is
          // subscribe, let's say we don't agree, so the hub doesn't try
          // to send updates. If the mode is unsubscribe, maybe the
          // subscription record was cleared ahead of time, or partially
          // succeeded and the hub is retrying. But chances are the
          // token will be lost as well. If we return 404 then the hub
          // will leave the subscription as is, and keep posting
          // updates; so, let's just trivially agree, so it stops.
          if (mode === 'unsubscribe') {
            // No memo to emit ..
            return response(res, 200, challenge);
          }
          else {
            return respond(res, 404, "Unknown subscription");
          }
        }
      }
      else if (req.method === 'POST') {
        var parsed = url.parse(req.url, true),
          params = parsed.query,
          path = parsed.pathname.substr(that.prefix.length);
        var memo = that.paths.lookup(path);
        if (memo) {
          console.log({post: memo});
          // TODO Ought to allow for binary data. Maybe check
          // content-type.
          req.setEncoding('utf8');
          var chunks = [];
          req.on('data', function(chunk) { chunks.push(chunk); });
          req.on('end', function() {
            that.emit('update', memo['user_data'],
                      chunks.join(''), req.headers);
            respond(res, 200, "");
          });
          return true;
        }
        else {
          return respond(res, 404, "Unknown subscription");
        }
      }
    }
    else {
      return next();
    }
  }
};

// Subscribe to a topic, at a hub, with options:
// - 'leaseSeconds' lease expiry time as seconds from now,
// - 'noAuto' don't renew the lease after the expiry
// - 'signingKey' a key for the hub to sign POSTs
// - 'data' a value to emit along with events (defaults to the topic)
//   (NB this may get serialised as JSON depending on the callbackUrlProvider)
//
// Calls the callback with the path used in the callback URL, which
// may be used to unsubscribe, or calls the errback with the status
// given by the server. NB the callbacks are not called when the
// subscription or unsubscription has been verified, only when the
// server has given an initial response.
proto.subscribe = function(hubUrl, topic, opts, callback, errback) {
  opts = opts || {};
  var data = opts.data || topic;
  var sub = subscription(data, opts.noAuto, opts.leaseSeconds || 0);
  var path = this.paths.create(sub);
  var callbackUrl = this.host + this.prefix + path;
  var qsobj = {
    'hub.mode': 'subscribe',
    'hub.topic': topic,
    'hub.verify': 'async',
    'hub.verify_token': this.tokens.create('subscribe', topic),
    'hub.callback': callbackUrl};
  if (opts.leaseSeconds) { qsobj['lease_seconds'] = opts.leaseSeconds; }
  if (opts.signingKey) { qsobj['secret'] = opts.signingKey; }
  subscribeRequest(hubUrl, qsobj, path, callback, errback);
}

proto.unsubscribe = function(hubUrl, topic, path, callback, errback) {
  var callbackUrl = this.host + this.prefix + path;
  var qsobj = {
    'hub.mode': 'unsubscribe',
    'hub.topic': topic,
    'hub.verify': 'async',
    'hub.verify_token': this.tokens.create('unsubscribe', topic),
    'hub.callback': callbackUrl};
  subscribeRequest(hubUrl, qsobj, path, callback, errback);
}

proto._respond_error = function(res, status, errorObj) {
  this.emit('error', errorObj);
  respond(res, status, errorObj.reason);
}

function subscribeRequest(hubUrl, qsobj, path, callback, errback) {
  var reqopts = url.parse(hubUrl);
  reqopts.method = 'POST';
  var req = (PROTOCOLS[reqopts.protocol]).request(reqopts);
  var body = querystring.stringify(qsobj);
  req.setHeader('Content-Length', body.length);
  req.end(body, 'utf8');
  req.on('response', function(res) {
    if (res.statusCode === 202 || res.statusCode === 204) {
      callback && callback(path);
    }
    else {
      errback && errback(res.statusCode);
    }
  });
}

// We use aes-256 in cbc mode. Probably a mistake. Someone correct me.
function encryptJson(object, secret) {
  var str = JSON.stringify(object);
  var cipher = crypto.createCipher('aes-256-cbc', secret);
  return cipher.update(str, 'utf8', 'base64') + cipher.final('base64');
}

function decryptJson(ciphertext, secret) {
  var decipher = crypto.createDecipher('aes-256-cbc', secret);
  var str = decipher.update(ciphertext, 'base64', 'utf8') + decipher.final('utf8');
  try {
    return JSON.parse(str);
  }
  catch (e) {
  }
  return false;
}

// Create a verification token by encrypting the
// action+topic+nonce.
function createToken(action, topic, secret) {
  var obj = {};
  obj[action] = {'topic': topic,
                 'nonce': crypto.randomBytes(16).toString('base64')};
  return encryptJson(obj, secret);
}

function parseToken(ciphertext, action, topic, secret) {
  var json, details;
  json = decryptJson(ciphertext, secret);
  return (json && (details = json[action]) &&
          details.topic && details.topic == topic);
}

exports.cryptoPathProvider = function(secret) {
  return {
    'create': function(sub) {return '/' + encodeURIComponent(encryptJson(sub, secret));},
    'lookup': function(path) {
      if (path.charAt(0) == '/') {
        return decryptJson(decodeURIComponent(path.substr(1)), secret);
      }
      return false;
    }
  };
}

function subscription(userValue, noAuto, leaseSeconds) {
  var sub = {'user_data': userValue};
  if (leaseSeconds && noAuto) {
    sub.expiry = +new Date + (leaseSeconds * 1000);
  }
  return sub;
}

// Construct a token provider.
exports.cryptoTokenProvider = function(secret) {
  return {
    'create': function(action, topic) {
      return createToken(action, topic, secret);
    },
    'lookup': function(token, action, topic) {
      return parseToken(token, action, topic, secret); }};
}

function respond(response, status, message) {
  response.statusCode = status;
  response.end(message, 'utf8');
  return true;
}
